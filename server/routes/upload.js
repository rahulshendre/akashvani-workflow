import { Router } from 'express';
import multer from 'multer';
import { randomBytes } from 'crypto';
import { basename, extname } from 'path';
import { UPLOADS_DIR } from '../paths.js';
import { findSessionByFolderName, updateSessionState } from '../services/sessionState.js';

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const id = randomBytes(8).toString('hex');
    cb(null, `${id}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 * 1024 }, // 20 GB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/') || /\.(mp4|mov|avi|mkv|mxf)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are accepted (.mp4, .mov, .avi, .mkv, .mxf)'));
    }
  },
});

// Shared store: fileId -> { path, name, size, sessionId, relativePath }
export const uploadedFiles = new Map();
// Shared store: sessionId -> { fileIds: string[], episodeCount: number, folderName: string }
export const uploadSessions = new Map();

const router = Router();

router.post('/', upload.array('files'), async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
  const sessionId = req.body.sessionId;
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  const episodeCount = Math.max(1, parseInt(req.body.episodeCount || '1', 10));
  const folderName = String(req.body.folderName || 'input-folder').trim() || 'input-folder';
  const relativePathsRaw = req.body.relativePaths;
  const relativePaths = Array.isArray(relativePathsRaw)
    ? relativePathsRaw
    : typeof relativePathsRaw === 'string'
      ? [relativePathsRaw]
      : [];

  // Refuse a second episode for a folder that already has one. The workflow
  // folder for that name already exists, so accepting this would silently fork
  // the same footage into two half-finished episodes.
  const clash = await findSessionByFolderName(folderName);
  if (clash && clash.sessionId !== sessionId) {
    return res.status(409).json({
      error: `An episode for the folder "${folderName}" already exists. Resume it from Your Episodes, or rename the folder to start a separate episode.`,
      duplicateFolder: true,
      existing: {
        sessionId: clash.sessionId,
        code: clash.code,
        folderName: clash.folderName,
        updatedAt: clash.updatedAt,
      },
    });
  }

  const result = files.map(f => {
    const id = f.filename.split('-')[0];
    const relativePath = relativePaths.find((rp) => rp.endsWith(f.originalname)) || f.originalname;
    uploadedFiles.set(id, {
      path: f.path,
      name: f.originalname,
      size: f.size,
      sessionId,
      relativePath,
    });
    return { id, name: f.originalname, size: f.size };
  });

  const existing = uploadSessions.get(sessionId);
  const allFileIds = [...(existing?.fileIds || []), ...result.map((f) => f.id)];
  uploadSessions.set(sessionId, {
    ...existing,
    fileIds: allFileIds,
    episodeCount,
    folderName,
  });

  // The Drive episode folder is named after the first video. Return it so the
  // editor can store it on the shared session — an LE on another machine needs
  // this name to upload into the same Drive folder.
  const firstFile = uploadedFiles.get(allFileIds[0]);
  const parentName = firstFile?.name
    ? basename(firstFile.name, extname(firstFile.name))
    : null;

  // Persist immediately so the duplicate-folder guard and the episode list see
  // this name even if the pipeline is never started.
  await updateSessionState(sessionId, { folderName, episodeCount, parentName });

  res.json({ files: result, parentName });
});

router.get('/session/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const data = uploadSessions.get(sessionId);
  if (!data) return res.json({ files: [], episodeCount: 1, folderName: null });

  const files = data.fileIds
    .map((id) => {
      const f = uploadedFiles.get(id);
      if (!f) return null;
      return { id, name: f.name, size: f.size };
    })
    .filter(Boolean);

  return res.json({
    files,
    episodeCount: data.episodeCount,
    folderName: data.folderName,
  });
});

export default router;
