import { google } from 'googleapis';
import { createReadStream, statSync } from 'fs';
import { basename, extname } from 'path';
import { loadDriveTarget } from '../paths.js';

// Full `drive` scope is required — not `drive.file`. The editor picks an
// EXISTING Drive folder as the destination, and `drive.file` only grants access
// to files this app itself created, so it can neither list the user's folders
// nor upload into one of them.
const SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/userinfo.email'];

// In-memory token store (restart loses auth; acceptable for this workflow tool)
let storedTokens = null;

export function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback'
  );
}

export function getAuthUrl(state) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID not set in .env');
  }
  return createOAuth2Client().generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    ...(state ? { state } : {}),
  });
}

export async function handleAuthCallback(code) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  storedTokens = tokens;
  client.setCredentials(tokens);
  return client;
}

export function isAuthenticated() {
  return !!storedTokens;
}

export function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export async function getAuthenticatedClient() {
  if (!storedTokens) throw new Error('Not authenticated with Google Drive');
  const client = createOAuth2Client();
  client.setCredentials(storedTokens);

  if (storedTokens.expiry_date && Date.now() > storedTokens.expiry_date - 60000) {
    const { credentials } = await client.refreshAccessToken();
    storedTokens = credentials;
    client.setCredentials(credentials);
  }

  return client;
}

/** Escape a value for safe interpolation into a Drive `q` query string. */
function q(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function getOrCreateFolderByName(drive, folderName, parentId) {
  const parentQuery = parentId ? `'${q(parentId)}' in parents and ` : '';
  const search = await drive.files.list({
    q: `${parentQuery}name='${q(folderName)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (search.data.files?.length) return search.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  return created.data.id;
}

/**
 * Where the AI-generated subtitles live inside an episode.
 *
 * Episodes created before this was renamed still have a "Feltiv SRT" folder, so
 * reuse that when it exists rather than stranding their files in a second
 * folder. New episodes get the neutral name.
 */
const SUBTITLE_FOLDER = 'AI Subtitles';
const LEGACY_SUBTITLE_FOLDER = 'Feltiv SRT';

async function findExistingFolder(drive, name, parentId) {
  const { data } = await drive.files.list({
    q: `'${q(parentId)}' in parents and name='${q(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return data.files?.[0]?.id ?? null;
}

/** The subtitle folder for an episode, preferring one that already exists. */
async function getSubtitleFolderId(drive, episodeFolderId) {
  const legacy = await findExistingFolder(drive, LEGACY_SUBTITLE_FOLDER, episodeFolderId);
  if (legacy) return legacy;
  return getOrCreateFolderByName(drive, SUBTITLE_FOLDER, episodeFolderId);
}

function folderUrl(folderId) {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

/**
 * Resolve the Drive root folder that episode folders are created under.
 *
 * Precedence:
 *   1. explicitFolderId — the destination the editor picked for THIS episode.
 *      This is what makes cross-machine uploads work: the LE's device passes
 *      the same id, so it never needs any local session state.
 *   2. The destination saved by the picker on this machine.
 *   3. GOOGLE_DRIVE_FOLDER_ID from config.env.
 *   4. A folder named GOOGLE_DRIVE_FOLDER_NAME, created at Drive root.
 */
async function getOrCreateFolder(drive, explicitFolderId) {
  if (explicitFolderId) return explicitFolderId;

  const saved = loadDriveTarget();
  if (saved?.folderId) return saved.folderId;

  if (process.env.GOOGLE_DRIVE_FOLDER_ID) return process.env.GOOGLE_DRIVE_FOLDER_ID;

  const folderName = process.env.GOOGLE_DRIVE_FOLDER_NAME || 'Akashvani Episodes';
  return getOrCreateFolderByName(drive, folderName);
}

/**
 * Confirm the signed-in account can actually reach a folder before uploading
 * into it.
 *
 * A Language Expert signs in with their OWN Google account, which may have no
 * access to the editor's episode folder. Drive's `files.list` returns an empty
 * result rather than an error in that case, so without this check the code
 * would happily create a duplicate folder tree somewhere else and report
 * success while the editor sees nothing arrive.
 */
export async function assertFolderAccessible(folderId) {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: 'v3', auth });

  try {
    const { data } = await drive.files.get({
      fileId: folderId,
      fields: 'id,name,capabilities(canAddChildren)',
      supportsAllDrives: true,
    });

    if (data.capabilities && data.capabilities.canAddChildren === false) {
      const err = new Error(
        `You have view-only access to the Drive folder "${data.name}". Ask the editor to give you edit access.`
      );
      err.driveBlocked = 'no-write-access';
      throw err;
    }

    return { id: data.id, name: data.name };
  } catch (err) {
    if (err.driveBlocked) throw err;

    const status = err?.code ?? err?.response?.status;
    if (status === 404 || status === 403) {
      const e = new Error(
        "This Google account can't open the episode's Drive folder. Ask the editor to share that folder with the account you signed in with."
      );
      e.driveBlocked = 'no-folder-access';
      throw e;
    }
    throw err;
  }
}

/**
 * Fetch a folder's name/parents — used to validate a pasted folder link or ID
 * and to render breadcrumbs in the picker.
 */
export async function getDriveFolderMeta(folderId) {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: 'v3', auth });

  const { data } = await drive.files.get({
    fileId: folderId === 'root' ? 'root' : folderId,
    fields: 'id,name,mimeType,parents',
    supportsAllDrives: true,
  });

  if (data.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('That link points to a file, not a folder. Pick a folder instead.');
  }

  return { id: data.id, name: data.name, parents: data.parents || [], url: folderUrl(data.id) };
}

function fmtBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export async function ensureDriveEpisodeFolders(parentName, episodeCount, filePaths, onProgress, onLog, driveFolderId) {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: 'v3', auth });

  // ── 1. Root (editor-chosen destination) → parent (video name) ───────────
  const rootFolderId = await getOrCreateFolder(drive, driveFolderId);
  onLog(`Drive root folder: ${folderUrl(rootFolderId)}`);

  const parentFolderId = await getOrCreateFolderByName(drive, parentName, rootFolderId);
  onLog(`Drive parent folder ready: ${parentName}`);
  onLog(`Open parent folder: ${folderUrl(parentFolderId)}`);

  // ── 2. For every episode create:  episode - N / Source Video
  //                                              / AI Subtitles
  //                                              / LE 1         ────────────
  const sourceVideoFolderIds = [];

  for (let i = 1; i <= episodeCount; i++) {
    const episodeFolderId = await getOrCreateFolderByName(drive, `episode - ${i}`, parentFolderId);

    const sourceVideoId = await getOrCreateFolderByName(drive, 'Source Video', episodeFolderId);
    sourceVideoFolderIds.push(sourceVideoId);

    await getSubtitleFolderId(drive, episodeFolderId);
    await getOrCreateFolderByName(drive, 'LE 1', episodeFolderId);

    onLog(`episode - ${i}: sub-folders ready (Source Video, ${SUBTITLE_FOLDER}, LE 1)`);
  }

  // ── 3. Upload each compressed file into its episode's Source Video folder ─
  const results = [];

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    const name = basename(filePath);
    const fileSize = statSync(filePath).size;

    // Distribute files across episodes by index; wrap if more files than episodes
    const episodeIdx = i % episodeCount;
    const targetFolderId = sourceVideoFolderIds[episodeIdx];

    onLog(`Uploading ${name} (${fmtBytes(fileSize)}) → episode - ${episodeIdx + 1}/Source Video...`);

    let uploaded = 0;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      uploaded += chunk.length;
      const fileProgress = (uploaded / fileSize) * 100;
      const overall = ((i / filePaths.length) + (fileProgress / 100 / filePaths.length)) * 100;
      onProgress(Math.round(overall));
    });

    const res = await drive.files.create({
      requestBody: { name, parents: [targetFolderId] },
      media: { mimeType: 'video/mp4', body: stream },
      fields: 'id,webViewLink',
    });

    onLog(`✓ ${name} uploaded to episode - ${episodeIdx + 1}/Source Video`);
    if (res.data.webViewLink) onLog(`File link: ${res.data.webViewLink}`);
    results.push({ fileId: res.data.id, name, link: res.data.webViewLink });
  }

  onProgress(100);
  return results;
}

/**
 * Upload files into an episode's LE subfolder on Drive (LE 1 or LE 2).
 * Creates the subfolder if it doesn't already exist.
 *
 * @param {string}   parentName    - Parent folder name (derived from the video filename)
 * @param {number}   episodeIndex  - 0-based (0 → "episode - 1")
 * @param {string}   leFolderName  - 'LE 1' or 'LE 2'
 * @param {string[]} filePaths     - Absolute local paths of files to upload
 * @param {Function} onLog         - Log callback
 */
export async function uploadFilesToEpisodeLEFolder(parentName, episodeIndex = 0, leFolderName, filePaths, onLog = () => {}, driveFolderId) {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: 'v3', auth });

  const rootFolderId    = await getOrCreateFolder(drive, driveFolderId);
  const parentFolderId  = await getOrCreateFolderByName(drive, parentName, rootFolderId);
  const episodeFolderId = await getOrCreateFolderByName(drive, `episode - ${episodeIndex + 1}`, parentFolderId);
  const leFolderId      = await getOrCreateFolderByName(drive, leFolderName, episodeFolderId);

  const results = [];

  for (const filePath of filePaths) {
    const name = basename(filePath);
    const ext  = extname(filePath).toLowerCase();
    const mimeType =
      ext === '.srt'  ? 'text/plain' :
      ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' :
      ext === '.doc'  ? 'application/msword' :
                        'application/octet-stream';

    onLog(`Uploading ${name} to Drive → episode - ${episodeIndex + 1}/${leFolderName}...`);

    const res = await drive.files.create({
      requestBody: { name, parents: [leFolderId] },
      media: { mimeType, body: createReadStream(filePath) },
      fields: 'id,webViewLink',
    });

    onLog(`✓ ${name} uploaded to ${leFolderName}`);
    if (res.data.webViewLink) onLog(`File link: ${res.data.webViewLink}`);
    results.push({ fileId: res.data.id, name, link: res.data.webViewLink });
  }

  return results;
}

/**
 * Upload files (SRT + DOCX) into an episode's AI Subtitles folder on Drive.
 * The folder hierarchy must already exist (created by ensureDriveEpisodeFolders).
 *
 * @param {string}   parentName   - The parent folder name (derived from the video filename)
 * @param {number}   episodeIndex - 0-based episode index (0 → "episode - 1")
 * @param {string[]} filePaths    - Absolute local paths of files to upload
 * @param {Function} onLog        - Log callback
 */
export async function uploadFilesToEpisodeSubtitles(parentName, episodeIndex = 0, filePaths, onLog = () => {}, driveFolderId) {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: 'v3', auth });

  // Navigate to the subtitle sub-folder (reusing a legacy one if present)
  const rootFolderId     = await getOrCreateFolder(drive, driveFolderId);
  const parentFolderId   = await getOrCreateFolderByName(drive, parentName, rootFolderId);
  const episodeFolderId  = await getOrCreateFolderByName(drive, `episode - ${episodeIndex + 1}`, parentFolderId);
  const subtitleFolderId = await getSubtitleFolderId(drive, episodeFolderId);

  const results = [];

  for (const filePath of filePaths) {
    const name = basename(filePath);
    const ext  = extname(filePath).toLowerCase();
    const mimeType =
      ext === '.srt'   ? 'text/plain' :
      ext === '.docx'  ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' :
                         'application/octet-stream';

    onLog(`Uploading ${name} to Drive → episode - ${episodeIndex + 1}/${SUBTITLE_FOLDER}...`);

    const res = await drive.files.create({
      requestBody: { name, parents: [subtitleFolderId] },
      media: { mimeType, body: createReadStream(filePath) },
      fields: 'id,webViewLink',
    });

    onLog(`✓ ${name} uploaded to subtitles folder`);
    if (res.data.webViewLink) onLog(`File link: ${res.data.webViewLink}`);
    results.push({ fileId: res.data.id, name, link: res.data.webViewLink });
  }

  return results;
}
