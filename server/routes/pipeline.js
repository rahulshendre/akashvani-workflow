import { Router } from 'express';
import multer from 'multer';
import { join, basename, extname } from 'path';
import { mkdir, copyFile, readdir, readFile, writeFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { convertSrtToDocx } from '../services/srtToDocx.js';
import { convertDocxToSrt } from '../services/docxToSrt.js';
import { compressVideos, killActiveEncodes } from '../services/compress.js';
import {
  generateSrtForVideo,
  isTranscriptionConfigured,
  killActiveTranscriptions,
  DEFAULT_MODEL,
} from '../services/transcribe.js';
import { romanizeSrtFile, LANGUAGES, DEFAULT_LANGUAGE } from '../services/romanize/index.js';
import { isRomanizeConfigured } from '../services/romanize/claude.js';
import {
  listDictionaries, setDictionary, fetchDictionary,
} from '../services/romanize/dictionarySource.js';
import { ensureDriveEpisodeFolders, uploadFilesToEpisodeSubtitles, uploadFilesToEpisodeLEFolder, isAuthenticated, isConfigured, getAuthUrl, assertFolderAccessible } from '../services/gdrive.js';
import { uploadedFiles, uploadSessions } from './upload.js';
import { withUtf8Names } from '../uploadNames.js';
import { UPLOADS_DIR, WORKFLOWS_DIR, CONFIG_FILE_HINT } from '../paths.js';
import { logUploadFailure, logError, logWarn, logInfo, LOG_FILE, INSTALL_LOG_FILE, LOG_DIR, readLogTail } from '../services/logger.js';
import { encodeReturnTo } from './auth.js';
import {
  markStepComplete,
  updateSessionState,
  readSessionState,
  getResumeState,
  listLocalSessions,
  markSessionDeleted,
  recordLeUpload,
} from '../services/sessionState.js';

const router = Router();
const sseClients = new Map();

/**
 * Sessions the user has asked to stop. Checked between steps and after each
 * await, so a stop takes effect at the next boundary instead of letting the
 * whole pipeline run to completion in the background.
 */
const stopRequested = new Set();

/**
 * Local subtitle folder for a session. Episodes created before the rename have
 * a "Feltiv SRT" directory; keep writing there so their files stay together.
 */
const SUBTITLE_DIR = 'AI Subtitles';
const LEGACY_SUBTITLE_DIR = 'Feltiv SRT';

function subtitleDirFor(sessionId) {
  const root = join(WORKFLOWS_DIR, sessionId, 'akashwani-structure');
  const legacy = join(root, LEGACY_SUBTITLE_DIR);
  return existsSync(legacy) ? legacy : join(root, SUBTITLE_DIR);
}

function throwIfStopped(sessionId) {
  if (stopRequested.has(sessionId)) {
    const err = new Error('Pipeline stopped by user');
    err.stopped = true;
    throw err;
  }
}

const srtUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => cb(null, `srt-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: withUtf8Names((_req, file, cb) => {
    if (/\.srt$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only .srt files are accepted'));
  }),
});

const wordUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => cb(null, `word-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: withUtf8Names((_req, file, cb) => {
    if (/\.(doc|docx)$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only .doc or .docx files are accepted'));
  }),
});

const le3SrtUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => cb(null, `le3-srt-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: withUtf8Names((_req, file, cb) => {
    if (/\.srt$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only .srt files are accepted'));
  }),
});

const prprojUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => cb(null, `prproj-${Date.now()}-${file.originalname}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB
  fileFilter: withUtf8Names((_req, file, cb) => {
    if (/\.prproj$/i.test(file.originalname)) return cb(null, true);
    cb(new Error('Only .prproj files are accepted'));
  }),
});

function send(sessionId, event, data = {}) {
  // Persist completion BEFORE checking for a listener. The record must survive
  // even if the browser is closed or the SSE stream has dropped — otherwise a
  // step that really finished is lost and the editor is sent back to redo it.
  if (event === 'step_complete' && data.stepId) {
    markStepComplete(sessionId, data.stepId).catch(() => {});
  }

  const res = sseClients.get(sessionId);
  if (!res) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function log(sessionId, stepId, message) {
  send(sessionId, 'log', { stepId, message });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForSSEClient(sessionId, timeoutMs = 3000) {
  const start = Date.now();
  while (!sseClients.has(sessionId)) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(80);
  }
  return true;
}

router.get('/events', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseClients.set(sessionId, res);
  const hb = setInterval(() => res.write(':heartbeat\n\n'), 15000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(sessionId);
  });
});

router.post('/start', async (req, res) => {
  const { sessionId, fileIds, steps, driveFolderId, code } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  const sseReady = await waitForSSEClient(sessionId, 3000);
  if (!sseReady) {
    return res.status(400).json({ error: 'Open /api/pipeline/events first' });
  }

  const files = (fileIds || []).map((id) => uploadedFiles.get(id)).filter(Boolean);
  if (files.length === 0) {
    return res.status(400).json({ error: 'No valid files. Upload folder first.' });
  }

  // Persist selected steps + Drive destination so resume-drive can reference them later
  const sessionMeta = uploadSessions.get(sessionId);
  if (sessionMeta) {
    sessionMeta.selectedSteps = Array.isArray(steps) && steps.length ? steps : null;
    if (driveFolderId) sessionMeta.driveFolderId = driveFolderId;
    uploadSessions.set(sessionId, sessionMeta);
  }

  // Same thing on disk — this is what survives shutting the machine off.
  const firstFile = files[0];
  await updateSessionState(sessionId, {
    // Remember the shared code so this episode stays resumable and shareable
    // even when listed purely from local disk.
    ...(code ? { code } : {}),
    selectedSteps: Array.isArray(steps) && steps.length ? steps : null,
    driveFolderId: driveFolderId || sessionMeta?.driveFolderId || null,
    // Only write these when we actually have a value. uploadSessions is in-memory
    // and empty after a restart, so writing `null` here would wipe the episode
    // name that the upload route already persisted.
    ...(sessionMeta?.folderName ? { folderName: sessionMeta.folderName } : {}),
    ...(sessionMeta?.episodeCount ? { episodeCount: sessionMeta.episodeCount } : {}),
    ...(firstFile?.name ? { parentName: basename(firstFile.name, extname(firstFile.name)) } : {}),
  });

  // A fresh run clears any earlier stop request.
  stopRequested.delete(sessionId);

  res.json({ ok: true, fileCount: files.length });
  runPipeline(sessionId, files, steps).catch((err) => {
    if (err.stopped) {
      logInfo('pipeline stopped by user', { sessionId });
      send(sessionId, 'pipeline_stopped', {});
      return;
    }
    // Record it. Previously this only went out over SSE, so if nothing was
    // listening the run vanished with no trace and the UI span forever.
    logError('pipeline failed', { sessionId, error: err.message, stack: err.stack });
    send(sessionId, 'pipeline_error', { error: err.message, stepId: err.stepId ?? null });
  });
});

/**
 * POST /api/pipeline/stop   { sessionId }
 *
 * Halts a running pipeline. Kills any in-flight ffmpeg encode immediately and
 * flags the session so the run aborts at the next step boundary. Work already
 * finished stays recorded, so Resume continues from the first unfinished step
 * rather than starting over.
 */
router.post('/stop', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  stopRequested.add(sessionId);
  const killed = killActiveEncodes() + killActiveTranscriptions();
  logInfo('stop requested', { sessionId, encodesKilled: killed });

  send(sessionId, 'pipeline_stopped', {});
  res.json({ ok: true, encodesKilled: killed });
});

/**
 * POST /api/pipeline/complete-step   { sessionId, stepId }
 *
 * Records a step the FRONTEND finished. Steps driven by this backend already
 * persist themselves, but simulated ones (word-to-srt, sls, slc, roman-script)
 * and plain "Mark as Done" steps (final-qc) complete entirely in the browser.
 * Without this they were forgotten on restart and resume sent the editor back
 * to the first of them.
 */
router.post('/complete-step', async (req, res) => {
  const { sessionId, stepId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  if (!stepId) return res.status(400).json({ error: 'stepId is required' });

  try {
    const state = await markStepComplete(sessionId, stepId);
    res.json({ ok: true, stepStates: state?.stepStates ?? {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/pipeline/log?lines=200
 *
 * Tail of the on-disk error log. The packaged app has no console, so this is how
 * a Language Expert on another machine can hand over the real reason an upload
 * failed instead of paraphrasing an error they half-remember.
 */
router.get('/log', async (req, res) => {
  const lines = Math.min(Math.max(parseInt(req.query.lines, 10) || 300, 1), 5000);
  const which = req.query.file === 'install' ? INSTALL_LOG_FILE : LOG_FILE;
  res.type('text/plain').send(
    `# Akashvani log
# folder : ${LOG_DIR}
# file   : ${which}

` +
    readLogTail(which, lines)
  );
});

/** Where the logs live on this machine, for the in-app "View logs" link. */
router.get('/log-info', (_req, res) => {
  res.json({ logDir: LOG_DIR, appLog: LOG_FILE, installLog: INSTALL_LOG_FILE });
});

/**
 * GET /api/pipeline/sessions
 *
 * Every episode on this machine, read from disk. The editor's home screen uses
 * this so it still works when the sync server is unreachable — their episodes
 * and progress are local, and being offline must not hide their own work.
 */
router.get('/sessions', async (_req, res) => {
  try {
    res.json({ sessions: await listLocalSessions() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/pipeline/session/:sessionId
 *
 * Hides an episode from the list. Flags the session rather than deleting its
 * folder — that folder holds the copied footage and compressed output, and
 * removing a list row must not destroy video. Without this the row reappeared on
 * every refresh, because the list also reads local disk.
 */
router.delete('/session/:sessionId', async (req, res) => {
  try {
    await markSessionDeleted(req.params.sessionId);
    logInfo('session hidden from list', { sessionId: req.params.sessionId });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/pipeline/state/:sessionId
 *
 * Authoritative resume state for this machine: which steps are finished, plus
 * the episode's Drive destination. Survives app and machine restarts because it
 * is read from disk, not from the in-memory upload session.
 */
router.get('/state/:sessionId', async (req, res) => {
  try {
    const state = await getResumeState(req.params.sessionId);
    res.json({
      sessionId: req.params.sessionId,
      // The shared code, so resuming reuses it instead of minting a second one.
      code: state.code ?? null,
      stepStates: state.stepStates,
      selectedSteps: state.selectedSteps,
      parentName: state.parentName,
      driveFolderId: state.driveFolderId,
      folderName: state.folderName,
      episodeCount: state.episodeCount,
      leUploads: state.leUploads ?? {},
      updatedAt: state.updatedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** After Google OAuth: only upload to Drive — copy + compress already ran. */
router.post('/resume-drive', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  const sseReady = await waitForSSEClient(sessionId, 3000);
  if (!sseReady) {
    return res.status(400).json({ error: 'Open /api/pipeline/events first' });
  }

  const errMsg = await validateDriveResume(sessionId);
  if (errMsg) {
    return res.status(400).json({ error: errMsg });
  }

  res.json({ ok: true, resumed: true });
  runDriveResume(sessionId).catch((err) => {
    send(sessionId, 'pipeline_error', { error: err.message });
  });
});

async function collectCompressedSourcePaths(sessionId) {
  const sourceDir = join(WORKFLOWS_DIR, sessionId, 'akashwani-structure', 'source file');
  let names;
  try {
    names = await readdir(sourceDir);
  } catch {
    return {
      compressedPaths: [],
      error: 'No workflow folder found for this session — start the pipeline from Setup first.',
    };
  }
  const compressedPaths = names
    .filter((n) => /_compressed\.[a-z0-9]+$/i.test(n))
    .map((n) => join(sourceDir, n))
    .sort();
  if (compressedPaths.length === 0) {
    return {
      compressedPaths: [],
      error:
        'No compressed videos in source file — run Copy and Compress first, or restart the full pipeline from Setup.',
    };
  }
  return { compressedPaths, error: null };
}

async function validateDriveResume(sessionId) {
  const sessionMeta = uploadSessions.get(sessionId);
  if (!sessionMeta?.fileIds?.length) {
    return 'Upload session expired or missing — upload again from Setup.';
  }
  const files = sessionMeta.fileIds.map((id) => uploadedFiles.get(id)).filter(Boolean);
  if (!files.length) return 'No files in session — upload again from Setup.';
  const compressWasSelected = !sessionMeta?.selectedSteps || sessionMeta.selectedSteps.includes('compress');
  if (compressWasSelected) {
    const { error } = await collectCompressedSourcePaths(sessionId);
    return error || null;
  }
  return null;
}

/**
 * Create the Drive folders and upload the episode's videos.
 *
 * Returns what the caller should do next, rather than ending the run itself:
 * transcription follows this phase, so only the caller knows whether the
 * pipeline is actually finished.
 *
 * @returns {Promise<'complete'|'paused'|'error'>} 'paused' = waiting on Google
 *          OAuth; the user resumes via /resume-drive without re-encoding.
 */
async function runDriveUploadPhase(sessionId, firstVideoName, episodeCount, compressedPaths) {
  if (!isConfigured()) {
    log(sessionId, 'upload-gdrive', 'Google API credentials not configured — skipping Drive folder creation');
    log(sessionId, 'upload-gdrive', 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server/.env');
    send(sessionId, 'step_complete', { stepId: 'upload-gdrive' });
    return 'complete';
  }

  if (!isAuthenticated()) {
    let authUrl;
    try {
      authUrl = getAuthUrl(sessionId);
    } catch {
      authUrl = null;
    }
    log(sessionId, 'upload-gdrive', 'Google Drive authentication required');
    log(sessionId, 'upload-gdrive', 'Pipeline paused — complete authorization; you will resume at Drive without re-running copy or compress.');
    send(sessionId, 'auth_required', { authUrl });
    return 'paused';
  }

  log(sessionId, 'upload-gdrive', `Creating Google Drive directory "${firstVideoName}"...`);
  log(sessionId, 'upload-gdrive', `Creating subfolders: episode - 1 ... episode - ${episodeCount}`);
  try {
    await ensureDriveEpisodeFolders(
      firstVideoName,
      episodeCount,
      compressedPaths,
      (p) => send(sessionId, 'progress', { stepId: 'upload-gdrive', progress: p }),
      (msg) => log(sessionId, 'upload-gdrive', msg),
      uploadSessions.get(sessionId)?.driveFolderId
    );
  } catch (err) {
    send(sessionId, 'step_error', { stepId: 'upload-gdrive', error: err.message });
    return 'error';
  }

  log(sessionId, 'upload-gdrive', 'Drive structure ready');
  send(sessionId, 'step_complete', { stepId: 'upload-gdrive' });
  return 'complete';
}

/**
 * Generate the AI subtitles for this episode and file them, replacing the old
 * round trip out to a third-party transcription tool.
 *
 * Deliberately NOT fatal. If the API key is missing, the network is down or
 * Drive is not ready, this logs the reason and returns false WITHOUT marking
 * the step complete or errored — which leaves the step running and its panel
 * on screen, so the editor can press Generate again or upload an .srt by hand.
 * Erroring the step would hide those controls and strand them.
 *
 * @returns {Promise<boolean>} true only when the subtitles are generated AND
 *          filed on Drive, because the Language Expert reads them from there.
 */
async function runTranscriptionPhase(sessionId, videoPaths) {
  const stepId = 'upload-feltiv-srt';

  if (!isTranscriptionConfigured()) {
    log(sessionId, stepId, 'No Sarvam API key on this machine — automatic subtitles are off.');
    log(sessionId, stepId, `Add SARVAM_API_KEY to ${CONFIG_FILE_HINT}, or upload an .srt below.`);
    logWarn('transcription skipped: no API key', { sessionId });
    return false;
  }
  if (!videoPaths?.length) {
    log(sessionId, stepId, 'No video found to transcribe — run Copy and Compress first.');
    return false;
  }

  const { parentName, driveFolderId } = await resolveDriveContext(sessionId, {});
  if (!canUploadToDrive(parentName, driveFolderId)) {
    log(sessionId, stepId, 'Subtitles were not generated: there is nowhere on Drive to put them yet.');
    log(sessionId, stepId, 'Connect Google Drive and set the episode folder in Setup, then press Generate.');
    logWarn('transcription skipped: Drive not ready', { sessionId, parentName, driveFolderId });
    return false;
  }

  try {
    const produced = await transcribeToSubtitleFolder(sessionId, videoPaths, {
      parentName,
      driveFolderId,
      onProgress: (p) => send(sessionId, 'progress', { stepId, progress: p }),
      onLog: (msg) => log(sessionId, stepId, msg),
      throwIfStopped: () => throwIfStopped(sessionId),
    });
    log(sessionId, stepId, `Subtitles ready: ${produced.map((f) => f.srt).join(', ')}`);
    send(sessionId, 'step_complete', { stepId });
    return true;
  } catch (err) {
    if (err.stopped) throw err;
    logError('automatic transcription failed', { sessionId, error: err.message, stack: err.stack });
    log(sessionId, stepId, `Automatic subtitles failed: ${err.message}`);
    log(sessionId, stepId, 'You can press Generate to try again, or upload an .srt below.');
    return false;
  }
}

/**
 * Everything the backend still owns once the Drive upload is done. Shared by a
 * fresh run and by a post-OAuth resume so both end the same way — otherwise
 * resuming after authorising would silently skip transcription.
 */
async function runPostDriveSteps(sessionId, active, videoPaths) {
  throwIfStopped(sessionId);
  if (active.has('upload-feltiv-srt')) {
    await runTranscriptionPhase(sessionId, videoPaths);
  }
  send(sessionId, 'backend_complete', {});
}

async function runDriveResume(sessionId) {
  const sessionMeta = uploadSessions.get(sessionId);
  const files = (sessionMeta?.fileIds || []).map((id) => uploadedFiles.get(id)).filter(Boolean);
  const firstVideoName = files[0]?.name ? basename(files[0].name, extname(files[0].name)) : 'episode-batch';
  const episodeCount = Math.max(1, sessionMeta?.episodeCount || 1);
  const compressWasSelected = !sessionMeta?.selectedSteps || sessionMeta.selectedSteps.includes('compress');

  let uploadPaths;
  if (compressWasSelected) {
    const { compressedPaths, error } = await collectCompressedSourcePaths(sessionId);
    if (error) {
      send(sessionId, 'step_error', { stepId: 'upload-gdrive', error });
      return;
    }
    uploadPaths = compressedPaths;
    log(sessionId, 'upload-gdrive', 'Resuming — using existing compressed files in source file.');
  } else {
    // compress was skipped — upload the raw footage files directly
    const rawDir = join(WORKFLOWS_DIR, sessionId, 'akashwani-structure', 'raw footage');
    try {
      const names = await readdir(rawDir);
      uploadPaths = names.map((n) => join(rawDir, n)).sort();
    } catch {
      uploadPaths = files.map((f) => f.path);
    }
    log(sessionId, 'upload-gdrive', 'Resuming — compress was skipped, uploading raw footage files.');
  }

  const outcome = await runDriveUploadPhase(sessionId, firstVideoName, episodeCount, uploadPaths);
  if (outcome !== 'complete') return;

  const active = new Set(
    Array.isArray(sessionMeta?.selectedSteps) && sessionMeta.selectedSteps.length
      ? sessionMeta.selectedSteps
      : ['copy', 'compress', 'upload-gdrive']
  );
  await runPostDriveSteps(sessionId, active, uploadPaths);
}

async function runPipeline(sessionId, files, selectedSteps) {
  const active = new Set(Array.isArray(selectedSteps) && selectedSteps.length ? selectedSteps : ['copy', 'compress', 'upload-gdrive']);
  const sessionMeta = uploadSessions.get(sessionId);
  const episodeCount = Math.max(1, sessionMeta?.episodeCount || 1);
  const firstVideoName = files[0]?.name ? basename(files[0].name, extname(files[0].name)) : 'episode-batch';

  const workflowRoot = join(WORKFLOWS_DIR, sessionId, 'akashwani-structure');
  const sourceDir = join(workflowRoot, 'source file');
  const rawDir = join(workflowRoot, 'raw footage');
  const subtitleDir = subtitleDirFor(sessionId);
  const editorDir = join(workflowRoot, 'Editor');

  await mkdir(sourceDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  await mkdir(subtitleDir, { recursive: true });
  await mkdir(editorDir, { recursive: true });

  // rawPaths: either copied into raw footage, or the original upload paths if copy is skipped
  let rawPaths = files.map((f) => f.path);

  throwIfStopped(sessionId);

  if (active.has('copy')) {
    log(sessionId, 'copy', `Created akashwani-structure folders: source file, raw footage, ${basename(subtitleDir)}, Editor`);
    log(sessionId, 'copy', `Copying ${files.length} uploaded file(s) to raw footage...`);
    rawPaths = [];
    for (let i = 0; i < files.length; i++) {
      throwIfStopped(sessionId);
      const dest = join(rawDir, files[i].name);
      await copyFile(files[i].path, dest);
      rawPaths.push(dest);
      send(sessionId, 'progress', { stepId: 'copy', progress: Math.round(((i + 1) / files.length) * 100) });
      log(sessionId, 'copy', `✓ ${files[i].name} copied`);
    }
    send(sessionId, 'step_complete', { stepId: 'copy' });
    await sleep(400);
  }

  // uploadPaths: either compressed outputs, or raw paths if compress is skipped
  let uploadPaths = rawPaths;

  throwIfStopped(sessionId);

  if (active.has('compress')) {
    log(sessionId, 'compress', `Scanning ${rawPaths.length} file(s) from raw footage...`);
    log(sessionId, 'compress', `Found: ${rawPaths.map((p) => basename(p)).join(', ')}`);
    try {
      uploadPaths = await compressVideos(
        rawPaths,
        sourceDir,
        (p) => send(sessionId, 'progress', { stepId: 'compress', progress: p }),
        (msg) => log(sessionId, 'compress', msg)
      );
    } catch (err) {
      if (err.stopped) throw err;
      send(sessionId, 'step_error', { stepId: 'compress', error: err.message });
      return;
    }
    log(sessionId, 'compress', 'Compression + watermark complete (saved to source file)');
    send(sessionId, 'step_complete', { stepId: 'compress' });
    await sleep(400);
  }

  throwIfStopped(sessionId);

  if (active.has('upload-gdrive')) {
    const outcome = await runDriveUploadPhase(sessionId, firstVideoName, episodeCount, uploadPaths);
    // 'paused' is waiting on Google OAuth and 'error' has already told the
    // user; either way, do not transcribe into a half-built Drive structure.
    if (outcome !== 'complete') return;
  }

  await runPostDriveSteps(sessionId, active, uploadPaths);
}

/**
 * Resolve which Drive folder a review upload belongs to.
 *
 * The EDITOR's machine holds the upload session in memory, so the episode
 * folder name can be derived locally from the first video's filename.
 *
 * A LANGUAGE EXPERT working on a DIFFERENT machine has no such session — their
 * device reads `parentName` and `driveFolderId` from the shared Fly.io record
 * and sends them in the request body. Body values therefore win, which is what
 * makes a cross-machine LE upload land in the right Drive folder.
 */
async function resolveDriveContext(sessionId, body) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const bodyParent   = pick(body?.parentName);
  const bodyFolderId = pick(body?.driveFolderId);

  const sessionMeta = uploadSessions.get(sessionId);
  const files = (sessionMeta?.fileIds || []).map((id) => uploadedFiles.get(id)).filter(Boolean);
  const memoryParent = files[0]?.name ? basename(files[0].name, extname(files[0].name)) : null;

  // uploadSessions is in-memory and empty after a restart, so fall back to the
  // record on disk before giving up.
  const saved = await readSessionState(sessionId);

  return {
    parentName: bodyParent || memoryParent || saved.parentName,
    driveFolderId: bodyFolderId || sessionMeta?.driveFolderId || saved.driveFolderId || null,
  };
}

/**
 * Cheap precheck for the unattended path, where there is no request to answer
 * with. Deliberately does not call Drive — this only rules out the cases we
 * can see locally; the real write still has to succeed.
 */
function canUploadToDrive(parentName, driveFolderId) {
  return isConfigured() && isAuthenticated() && !!parentName && !!driveFolderId;
}

/**
 * Transcribe the episode's videos and file the results the same way a manual
 * .srt upload would: .srt plus a Word copy in the local subtitle folder, and
 * both on Drive under "AI Subtitles".
 *
 * The Word copy matters — it is the file the Language Expert actually corrects,
 * so generating the .srt alone would leave LE 1 with nothing to open.
 *
 * One video per SRT, named after the video, so a multi-video episode does not
 * end up with its subtitles overwriting each other.
 */
async function transcribeToSubtitleFolder(sessionId, videoPaths, opts) {
  const { parentName, driveFolderId, onProgress = () => {}, onLog = () => {}, throwIfStopped: stop } = opts;

  const subtitleTargetDir = subtitleDirFor(sessionId);
  await mkdir(subtitleTargetDir, { recursive: true });

  const produced = [];
  for (let i = 0; i < videoPaths.length; i++) {
    stop?.();
    const video = videoPaths[i];
    // Strip the suffix compress adds, so "ep1_compressed.mp4" yields "ep1.srt".
    const baseName = basename(video, extname(video)).replace(/_compressed$/i, '');
    const srtDest = join(subtitleTargetDir, `${baseName}.srt`);
    const docxDest = join(subtitleTargetDir, `${baseName}.docx`);

    if (videoPaths.length > 1) onLog(`Video ${i + 1} of ${videoPaths.length}: ${basename(video)}`);

    const { cues } = await generateSrtForVideo(video, srtDest, {
      // Share the step's progress bar out across the videos.
      onProgress: (p) => onProgress(Math.round(((i + p / 100) / videoPaths.length) * 100)),
      onLog,
      throwIfStopped: stop,
    });

    const { entries } = await convertSrtToDocx(await readFile(srtDest, 'utf8'), docxDest, baseName);
    onLog(`Saved ${baseName}.srt and ${baseName}.docx (${entries} subtitles)`);

    produced.push({ srt: `${baseName}.srt`, docx: `${baseName}.docx`, cues, entries, srtDest, docxDest });
  }

  stop?.();
  onLog('Uploading subtitles to Google Drive...');
  await uploadFilesToEpisodeSubtitles(
    parentName,
    0,
    produced.flatMap((f) => [f.srtDest, f.docxDest]),
    onLog,
    driveFolderId
  );

  await markStepComplete(sessionId, 'upload-feltiv-srt');
  return produced;
}

/**
 * Decide whether a Drive upload can proceed, and if not, answer with a
 * response the UI can act on. Returns true only when it is safe to upload.
 *
 * Review files exist so the next person in the chain can pick them up from
 * Drive, so a silent skip is never acceptable here — it looks like success
 * while the file goes nowhere.
 */
async function ensureDriveUploadPossible(res, parentName, driveFolderId, returnTo) {
  // Every rejection below is logged. These return a clean 4xx rather than
  // throwing, so without this they would leave no trace on disk — and a blocked
  // upload is the most likely thing to need diagnosing remotely.
  const blocked = (reason, extra) =>
    logWarn(`Drive upload blocked: ${reason}`, { parentName, driveFolderId, ...extra });

  if (!isConfigured()) {
    blocked('not-configured');
    res.status(503).json({
      error: 'Google Drive is not configured on this machine, so the file cannot be uploaded.',
      driveBlocked: 'not-configured',
    });
    return false;
  }
  if (!isAuthenticated()) {
    blocked('needs-auth');
    let authUrl = null;
    try {
      // Encode where to come back to, so authorizing does not dump the user on a
      // bare /pipeline stripped of their code, role and step filter.
      authUrl = getAuthUrl(returnTo ? encodeReturnTo(returnTo) : undefined);
    } catch { /* no client id configured */ }
    res.status(401).json({
      error: 'Connect Google Drive before uploading — the file must be saved to Drive for the next reviewer.',
      driveBlocked: 'needs-auth',
      needsAuth: true,
      authUrl,
    });
    return false;
  }
  if (!parentName) {
    blocked('no-episode-folder');
    res.status(400).json({
      error: "Couldn't work out which Drive episode folder this belongs to. Ask the editor to re-share the session code.",
      driveBlocked: 'no-episode-folder',
    });
    return false;
  }
  // Refuse to guess. Without an explicit destination the resolver would fall
  // back to creating "Akashvani Episodes" in whichever Drive happens to be
  // signed in — on a Language Expert's machine that is their own Drive, and the
  // upload would look successful while the editor never receives the file.
  if (!driveFolderId) {
    blocked('no-drive-folder');
    res.status(400).json({
      error: "No Google Drive destination is set for this episode, so there is nowhere safe to upload. The editor should open Setup and paste the Drive folder link, then re-share the code.",
      driveBlocked: 'no-drive-folder',
    });
    return false;
  }
  // Confirm this account can actually write there before claiming success.
  try {
    await assertFolderAccessible(driveFolderId);
  } catch (err) {
    blocked(err.driveBlocked || 'drive-error', { error: err.message, code: err.code });
    res.status(err.driveBlocked ? 403 : 500).json({
      error: err.message,
      driveBlocked: err.driveBlocked || 'drive-error',
    });
    return false;
  }
  return true;
}

/**
 * GET /api/pipeline/transcribe-status
 *
 * Whether this machine can generate subtitles at all. The UI asks first so it
 * can offer the manual .srt upload instead of showing a Generate button that
 * is guaranteed to fail.
 */
router.get('/transcribe-status', (_req, res) => {
  res.json({
    configured: isTranscriptionConfigured(),
    model: (process.env.SARVAM_MODEL || DEFAULT_MODEL).trim(),
  });
});

/**
 * POST /api/pipeline/transcribe   { sessionId, parentName?, driveFolderId? }
 *
 * Generate this episode's subtitles on demand. The unattended run does this by
 * itself, so this exists for the cases where it could not: the key was added
 * after the run, Drive was authorised late, the API was down, or the editor is
 * resuming an episode that stopped at this step.
 *
 * Long-running by nature. Progress goes out over the session's SSE stream, the
 * same channel compress uses, so the step's bar moves while this request is
 * still open.
 */
router.post('/transcribe', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  if (!isTranscriptionConfigured()) {
    logWarn('transcribe requested without an API key', { sessionId });
    return res.status(503).json({
      error:
        'This machine has no Sarvam API key, so subtitles cannot be generated here. ' +
        `Add SARVAM_API_KEY to ${CONFIG_FILE_HINT} and restart the app, or upload an .srt yourself.`,
      notConfigured: true,
    });
  }

  // Transcribe the compressed copies — same files the Language Expert reviews
  // against on Drive, so the cue timings match what they are watching.
  const { compressedPaths, error } = await collectCompressedSourcePaths(sessionId);
  let videoPaths = compressedPaths;
  if (error) {
    // compress may have been skipped for this episode; raw footage still works.
    const rawDir = join(WORKFLOWS_DIR, sessionId, 'akashwani-structure', 'raw footage');
    try {
      videoPaths = (await readdir(rawDir))
        .filter((n) => /\.(mp4|mov|avi|mkv|mxf)$/i.test(n))
        .sort()
        .map((n) => join(rawDir, n));
    } catch {
      videoPaths = [];
    }
    if (!videoPaths.length) return res.status(400).json({ error });
  }

  const { parentName, driveFolderId } = await resolveDriveContext(sessionId, req.body);
  if (!await ensureDriveUploadPossible(res, parentName, driveFolderId, req.body?.returnTo)) return;

  const stepId = 'upload-feltiv-srt';
  try {
    logInfo('transcription requested', { sessionId, videos: videoPaths.length });
    const produced = await transcribeToSubtitleFolder(sessionId, videoPaths, {
      parentName,
      driveFolderId,
      onProgress: (p) => send(sessionId, 'progress', { stepId, progress: p }),
      onLog: (msg) => log(sessionId, stepId, msg),
      throwIfStopped: () => throwIfStopped(sessionId),
    });

    res.json({
      ok: true,
      files: produced.map(({ srt, docx, cues, entries }) => ({ srt, docx, cues, entries })),
      driveUploaded: true,
    });
  } catch (err) {
    if (err.stopped) return res.status(409).json({ error: 'Stopped before the subtitles were finished.' });
    logUploadFailure(stepId, {
      sessionId,
      parentName,
      driveFolderId,
      fileName: videoPaths.map((p) => basename(p)).join(', '),
    }, err);
    log(sessionId, stepId, `Subtitle generation failed: ${err.message}`);
    // Deliberately no step_error: the panel gates its controls on the step
    // being 'running', so erroring it would take away the retry and the manual
    // upload. The message below is what the UI shows instead.
    res.status(500).json({ error: err.message });
  }
});

// ── Roman script ────────────────────────────────────────────────────────────

/**
 * The subtitle the Roman-script step transliterates: the FINAL approved file
 * from the last Language Expert pass.
 *
 * Preferred source is the session record, which names the exact file LE 3
 * uploaded. The newest .srt in Editor is the fallback, for episodes recorded
 * before that was tracked or where the step was done out of order.
 */
async function resolveFinalSrt(sessionId) {
  const editorDir = join(WORKFLOWS_DIR, sessionId, 'akashwani-structure', 'Editor');

  const state = await readSessionState(sessionId);
  const named = state?.leUploads?.le3?.fileName;
  if (named && /\.srt$/i.test(named)) {
    const path = join(editorDir, named);
    if (existsSync(path)) return { path, from: 'LE 3' };
  }

  let names;
  try {
    names = await readdir(editorDir);
  } catch {
    return { path: null, error: 'No workflow folder for this episode yet.' };
  }

  const srts = names.filter((n) => /\.srt$/i.test(n));
  if (!srts.length) {
    return {
      path: null,
      error:
        'No subtitle file found for this episode. The Roman-script step converts the ' +
        'final .srt from the last Language Expert pass, so that pass has to be done first.',
    };
  }

  // newest wins — the later pass is the more corrected one
  const withTimes = await Promise.all(srts.map(async (n) => {
    const p = join(editorDir, n);
    const { mtimeMs } = await stat(p);
    return { path: p, mtimeMs };
  }));
  withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { path: withTimes[0].path, from: 'newest subtitle in Editor' };
}

/**
 * GET /api/pipeline/romanize-status
 *
 * What this machine can do before anyone presses anything: whether the API key
 * is present, and which languages have a dictionary.
 */
router.get('/romanize-status', async (_req, res) => {
  try {
    res.json({
      configured: isRomanizeConfigured(),
      languages: Object.keys(LANGUAGES),
      defaultLanguage: DEFAULT_LANGUAGE,
      dictionaries: await listDictionaries(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/pipeline/dictionary   { language, link }
 *
 * Point a language at its dictionary in Google Docs. A blank link clears it.
 *
 * The link is NOT a secret here: the doc is read through this machine's Google
 * sign-in, so it can stay private to the team. That is the whole reason this is
 * ordinary settings rather than a credential.
 */
router.post('/dictionary', async (req, res) => {
  const { language, link } = req.body || {};
  if (!language) return res.status(400).json({ error: 'language is required' });
  try {
    const saved = await setDictionary(language, link);
    res.json({ ok: true, language, dictionary: saved, dictionaries: await listDictionaries() });
  } catch (err) {
    logWarn('could not set dictionary', { language, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

/** Download a language's dictionary now, to check it parses before an episode. */
router.post('/dictionary/check', async (req, res) => {
  const { language } = req.body || {};
  if (!language) return res.status(400).json({ error: 'language is required' });
  try {
    const fetched = await fetchDictionary(language, { force: true });
    if (!fetched) return res.status(404).json({ error: `No dictionary is set for ${language}.` });

    const { Dictionary } = await import('../services/romanize/dictionary.js');
    const dict = Dictionary.fromDocx(fetched.bytes, language);
    res.json({
      ok: true,
      name: fetched.name,
      spellings: dict.size,
      nativeWords: Object.keys(dict.nativeMap).length,
      pairs: dict.pairs.length,
    });
  } catch (err) {
    logWarn('dictionary check failed', { language, error: err.message });
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/pipeline/romanize   { sessionId, language }
 *
 * Transliterate the episode's final subtitles into Roman script and file the
 * results. Long-running; progress goes out over the session's SSE stream.
 */
router.post('/romanize', async (req, res) => {
  const { sessionId, language = DEFAULT_LANGUAGE } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  if (!isRomanizeConfigured()) {
    logWarn('romanize requested without an API key', { sessionId });
    return res.status(503).json({
      error:
        'This machine has no Anthropic API key, so subtitles cannot be converted to Roman ' +
        `script. Add ANTHROPIC_API_KEY to ${CONFIG_FILE_HINT} and restart the app.`,
      notConfigured: true,
    });
  }

  const { path: srtPath, error, from } = await resolveFinalSrt(sessionId);
  if (!srtPath) return res.status(400).json({ error });

  const { parentName, driveFolderId } = await resolveDriveContext(sessionId, req.body);
  if (!await ensureDriveUploadPossible(res, parentName, driveFolderId, req.body?.returnTo)) return;

  const stepId = 'roman-script';
  try {
    logInfo('romanization requested', { sessionId, language, srtPath, from });
    log(sessionId, stepId, `Converting ${basename(srtPath)} (${from}) to Roman script...`);

    const { romanizedText, reviewDocx, stats } = await romanizeSrtFile(srtPath, {
      language,
      onProgress: (p) => send(sessionId, 'progress', { stepId, progress: p }),
      onLog: (msg) => log(sessionId, stepId, msg),
      throwIfStopped: () => throwIfStopped(sessionId),
    });

    const baseName = basename(srtPath, extname(srtPath));
    const targetDir = subtitleDirFor(sessionId);
    await mkdir(targetDir, { recursive: true });

    const srtDest = join(targetDir, `${baseName}_roman.srt`);
    const docxDest = join(targetDir, `${baseName}_roman_review.docx`);
    await writeFile(srtDest, romanizedText, 'utf8');
    await writeFile(docxDest, reviewDocx);

    log(sessionId, stepId, 'Uploading the Roman-script files to Google Drive...');
    await uploadFilesToEpisodeSubtitles(
      parentName, 0, [srtDest, docxDest], (m) => log(sessionId, stepId, m), driveFolderId
    );

    await markStepComplete(sessionId, stepId);
    send(sessionId, 'progress', { stepId, progress: 100 });

    res.json({
      ok: true,
      savedAs: `${baseName}_roman.srt`,
      reviewSavedAs: `${baseName}_roman_review.docx`,
      stats,
      driveUploaded: true,
    });
  } catch (err) {
    if (err.stopped) return res.status(409).json({ error: 'Stopped before romanization finished.' });
    logUploadFailure(stepId, {
      sessionId, parentName, driveFolderId, fileName: basename(srtPath),
    }, err);
    log(sessionId, stepId, `Roman-script conversion failed: ${err.message}`);
    // No step_error on purpose: the panel gates its controls on the step being
    // 'running', so erroring it would take away the retry.
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload-srt', srtUpload.single('srtFile'), async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!req.file) return res.status(400).json({ error: 'srtFile required' });

    const subtitleTargetDir = subtitleDirFor(sessionId);
    await mkdir(subtitleTargetDir, { recursive: true });

    // 1 — save the original .srt locally
    const srtDest = join(subtitleTargetDir, req.file.originalname);
    await copyFile(req.file.path, srtDest);

    // 2 — convert to .docx and save alongside the .srt locally
    const srtContent = await readFile(req.file.path, 'utf8');
    const baseName = req.file.originalname.replace(/\.srt$/i, '');
    const docxDest = join(subtitleTargetDir, `${baseName}.docx`);
    const { entries } = await convertSrtToDocx(srtContent, docxDest, baseName);

    // 3 — upload both files to the Drive subtitles folder
    const { parentName, driveFolderId } = await resolveDriveContext(sessionId, req.body);
    if (!await ensureDriveUploadPossible(res, parentName, driveFolderId, req.body?.returnTo)) return;

    await uploadFilesToEpisodeSubtitles(parentName, 0, [srtDest, docxDest], () => {}, driveFolderId);

    await markStepComplete(sessionId, 'upload-feltiv-srt');

    res.json({
      ok: true,
      savedAs: req.file.originalname,
      docxSavedAs: `${baseName}.docx`,
      entries,
      driveUploaded: true,
    });
  } catch (err) {
    logUploadFailure('upload-feltiv-srt', {
      sessionId: req.body?.sessionId,
      parentName: req.body?.parentName,
      driveFolderId: req.body?.driveFolderId,
      fileName: req.file?.originalname,
    }, err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload-prproj', prprojUpload.single('prprojFile'), async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!req.file) return res.status(400).json({ error: 'prprojFile required' });

    const editorDir = join(WORKFLOWS_DIR, sessionId, 'akashwani-structure', 'Editor');
    await mkdir(editorDir, { recursive: true });

    const dest = join(editorDir, req.file.originalname);
    await copyFile(req.file.path, dest);

    await markStepComplete(sessionId, 'upload-prproj');

    res.json({ ok: true, savedAs: req.file.originalname });
  } catch (err) {
    logUploadFailure('upload-prproj', {
      sessionId: req.body?.sessionId,
      parentName: req.body?.parentName,
      driveFolderId: req.body?.driveFolderId,
      fileName: req.file?.originalname,
    }, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * LE 1 — upload corrected Word file:
 *   1. Save Word to Editor dir (local)
 *   2. Convert Word → SRT, save SRT to Editor dir (local)
 *   3. Upload Word + SRT to Google Drive LE 1 folder
 */
router.post('/upload-le1-word', wordUpload.single('wordFile'), async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!req.file) return res.status(400).json({ error: 'wordFile required' });

    const editorDir = join(WORKFLOWS_DIR, sessionId, 'akashwani-structure', 'Editor');
    await mkdir(editorDir, { recursive: true });

    // 1 — save Word file to Editor dir
    const wordDest = join(editorDir, req.file.originalname);
    await copyFile(req.file.path, wordDest);

    // 2 — try to derive an SRT, but never let that stop the upload. Any .docx is
    // accepted; if it isn't in SRT layout we just don't produce a .srt.
    const baseName = req.file.originalname.replace(/\.(doc|docx)$/i, '');
    const srtContent = await convertDocxToSrt(req.file.path);
    let srtDest = null;
    if (srtContent) {
      srtDest = join(editorDir, `${baseName}.srt`);
      await writeFile(srtDest, srtContent, 'utf8');
    }

    // 3 — upload to the Drive LE 1 folder.
    // Works from the LE's own machine: parentName + driveFolderId arrive in the
    // request body, sourced from the shared session, so no local upload session
    // is needed here.
    const { parentName, driveFolderId } = await resolveDriveContext(sessionId, req.body);
    if (!await ensureDriveUploadPossible(res, parentName, driveFolderId, req.body?.returnTo)) return;

    const filesForDrive = srtDest ? [wordDest, srtDest] : [wordDest];
    logInfo('review-pass1 uploading to Drive', {
      sessionId, parentName, driveFolderId,
      files: filesForDrive.map((f) => basename(f)),
      srtConverted: !!srtContent,
    });
    await uploadFilesToEpisodeLEFolder(parentName, 0, 'LE 1', filesForDrive, () => {}, driveFolderId);
    logInfo('review-pass1 Drive upload OK', { sessionId, parentName });

    // align-srt is auto-completed by this conversion, so record both.
    await markStepComplete(sessionId, 'review-pass1');
    await markStepComplete(sessionId, 'align-srt');
    await recordLeUpload(sessionId, 'le1', req.file.originalname);

    res.json({
      ok: true,
      wordSavedAs: req.file.originalname,
      srtSavedAs: srtDest ? `${baseName}.srt` : null,
      srtConverted: !!srtContent,
      driveUploaded: true,
    });
  } catch (err) {
    logUploadFailure('review-pass1', {
      sessionId: req.body?.sessionId,
      parentName: req.body?.parentName,
      driveFolderId: req.body?.driveFolderId,
      fileName: req.file?.originalname,
    }, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * LE 2 — upload corrected Word file:
 *   1. Save Word to Editor dir (local)
 *   2. Convert Word → SRT, save SRT to Editor dir (local)
 *   3. Create LE 2 folder on Drive and upload Word + SRT there
 */
router.post('/upload-le2-word', wordUpload.single('wordFile'), async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!req.file) return res.status(400).json({ error: 'wordFile required' });

    const editorDir = join(WORKFLOWS_DIR, sessionId, 'akashwani-structure', 'Editor');
    await mkdir(editorDir, { recursive: true });

    // 1 — save Word file to Editor dir
    const wordDest = join(editorDir, req.file.originalname);
    await copyFile(req.file.path, wordDest);

    // 2 — best-effort SRT conversion; a plain corrected .docx is still valid.
    const baseName = req.file.originalname.replace(/\.(doc|docx)$/i, '');
    const srtContent = await convertDocxToSrt(req.file.path);
    let srtDest = null;
    if (srtContent) {
      srtDest = join(editorDir, `${baseName}-le2.srt`);
      await writeFile(srtDest, srtContent, 'utf8');
    }

    // 3 — upload to Drive LE 2 folder (creates it if it doesn't exist)
    const { parentName, driveFolderId } = await resolveDriveContext(sessionId, req.body);
    if (!await ensureDriveUploadPossible(res, parentName, driveFolderId, req.body?.returnTo)) return;

    const filesForDrive = srtDest ? [wordDest, srtDest] : [wordDest];
    await uploadFilesToEpisodeLEFolder(parentName, 0, 'LE 2', filesForDrive, () => {}, driveFolderId);

    await markStepComplete(sessionId, 'review-pass2');
    await recordLeUpload(sessionId, 'le2', req.file.originalname);

    res.json({
      ok: true,
      wordSavedAs: req.file.originalname,
      srtSavedAs: srtDest ? `${baseName}-le2.srt` : null,
      srtConverted: !!srtContent,
      driveUploaded: true,
    });
  } catch (err) {
    logUploadFailure('review-pass2', {
      sessionId: req.body?.sessionId,
      parentName: req.body?.parentName,
      driveFolderId: req.body?.driveFolderId,
      fileName: req.file?.originalname,
    }, err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * LE 3 — upload final corrected SRT file.
 * Saves to the Editor directory and uploads to the Drive LE 3 folder.
 */
router.post('/upload-le3-srt', le3SrtUpload.single('srtFile'), async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (!req.file) return res.status(400).json({ error: 'srtFile required' });

    const editorDir = join(WORKFLOWS_DIR, sessionId, 'akashwani-structure', 'Editor');
    await mkdir(editorDir, { recursive: true });

    const dest = join(editorDir, req.file.originalname);
    await copyFile(req.file.path, dest);

    const { parentName, driveFolderId } = await resolveDriveContext(sessionId, req.body);
    if (!await ensureDriveUploadPossible(res, parentName, driveFolderId, req.body?.returnTo)) return;

    await uploadFilesToEpisodeLEFolder(parentName, 0, 'LE 3', [dest], () => {}, driveFolderId);

    await markStepComplete(sessionId, 'review-pass3');
    await recordLeUpload(sessionId, 'le3', req.file.originalname);

    res.json({ ok: true, savedAs: req.file.originalname, driveUploaded: true });
  } catch (err) {
    logUploadFailure('review-pass3', {
      sessionId: req.body?.sessionId,
      parentName: req.body?.parentName,
      driveFolderId: req.body?.driveFolderId,
      fileName: req.file?.originalname,
    }, err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
