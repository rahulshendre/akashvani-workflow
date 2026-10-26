export const BACKEND_STEP_IDS = ['compress', 'copy', 'upload-gdrive'] as const;
type BackendStepId = (typeof BACKEND_STEP_IDS)[number];

export function isBackendStep(stepId: string): stepId is BackendStepId {
  return BACKEND_STEP_IDS.includes(stepId as BackendStepId);
}

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
}

export interface UploadSessionData {
  files: UploadedFile[];
  episodeCount: number;
  folderName: string | null;
}

export interface AuthStatus {
  authenticated: boolean;
  configured: boolean;
  email?: string;
  name?: string;
  authUrl?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until Vite proxy can reach the backend (avoids ECONNREFUSED right after `npm run dev:full`). */
export async function waitForBackendReady(maxMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await checkBackendHealth()) return;
    await sleep(400);
  }
  throw new Error('Backend did not become ready in time. Is port 3001 free? Try: npm run dev:full');
}

export interface UploadResult {
  files: UploadedFile[];
  /** Drive episode folder name, derived server-side from the first video. */
  parentName: string | null;
}

/** Thrown when an episode already exists for the chosen folder. */
export class DuplicateFolderError extends Error {
  existing: { sessionId: string; code: string | null; folderName: string | null } | null;
  constructor(message: string, existing: DuplicateFolderError['existing']) {
    super(message);
    this.name = 'DuplicateFolderError';
    this.existing = existing;
  }
}

export async function uploadFiles(
  files: File[],
  sessionId: string,
  episodeCount: number,
  folderName: string,
  onProgress?: (percent: number, sentBytes: number, totalBytes: number) => void,
): Promise<UploadResult> {
  await waitForBackendReady();

  const form = new FormData();
  form.append('sessionId', sessionId);
  form.append('episodeCount', String(episodeCount));
  form.append('folderName', folderName);
  files.forEach(f => form.append('files', f));
  files.forEach((f) => form.append('relativePaths', (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name));

  // XMLHttpRequest rather than fetch: fetch cannot report upload progress, and a
  // multi-gigabyte folder copying with no feedback looks like a frozen app.
  const send = () => new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
      }
    };

    xhr.onload = () => {
      let body: { files?: UploadedFile[]; parentName?: string; error?: string; duplicateFolder?: boolean; existing?: DuplicateFolderError['existing'] } = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON error page */ }

      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100, 1, 1);
        return resolve({ files: body.files ?? [], parentName: body.parentName ?? null });
      }
      if (xhr.status === 409 && body.duplicateFolder) {
        return reject(new DuplicateFolderError(body.error || 'That folder already has an episode.', body.existing ?? null));
      }
      reject(new Error(body.error || `Upload failed (${xhr.status})`));
    };

    xhr.onerror = () => reject(new Error('Upload failed — lost connection to the app backend.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.send(form);
  });

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await send();
    } catch (e) {
      // A duplicate folder is the user's decision, not a transient fault.
      if (e instanceof DuplicateFolderError) throw e;
      lastErr = e;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Upload failed after retries');
}

export interface PipelineState {
  sessionId: string;
  code: string | null;
  leUploads: Record<string, { fileName: string; at: string }>;
  stepStates: Record<string, string>;
  selectedSteps: string[] | null;
  parentName: string | null;
  driveFolderId: string | null;
  folderName: string | null;
  episodeCount: number;
  updatedAt: string | null;
}

/**
 * What the local backend knows about this session, read from disk. This is the
 * authoritative record of work done on THIS machine and survives restarts,
 * unlike the in-memory upload session.
 */
export async function fetchPipelineState(sessionId: string): Promise<PipelineState> {
  const res = await fetch(`/api/pipeline/state/${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error('Failed to fetch pipeline state');
  return res.json();
}

/**
 * Record a step the frontend completed. Backend-driven steps persist themselves,
 * but simulated and "Mark as Done" steps only exist in the browser until this
 * is called — without it they are lost when the app closes.
 */
export async function recordStepComplete(sessionId: string, stepId: string): Promise<void> {
  await fetch('/api/pipeline/complete-step', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, stepId }),
  });
}

/**
 * Hide an episode locally. The list reads local disk as well as the sync server,
 * so deleting only the cloud row left the episode reappearing on every refresh.
 */
export async function deleteLocalSession(sessionId: string): Promise<void> {
  const res = await fetch(`/api/pipeline/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Could not remove the episode from this computer');
}

export interface LogInfo {
  logDir: string;
  appLog: string;
  installLog: string;
}

/** Where this machine keeps its logs — shown in the app so support can ask for it. */
export async function fetchLogInfo(): Promise<LogInfo> {
  const res = await fetch('/api/pipeline/log-info');
  if (!res.ok) throw new Error('Failed to read log location');
  return res.json();
}

export interface LocalSession {
  sessionId: string;
  code: string | null;
  folderName: string | null;
  episodeCount: number;
  selectedSteps: string[] | null;
  stepStates: Record<string, string>;
  driveFolderId: string | null;
  parentName: string | null;
  leUploads: Record<string, { fileName: string; at: string }>;
  updatedAt: string | null;
}

/**
 * Episodes on this machine, straight from disk. Lets the home screen work with
 * no internet — the sync server going down must not hide the editor's own work.
 */
export async function fetchLocalSessions(): Promise<LocalSession[]> {
  const res = await fetch('/api/pipeline/sessions');
  if (!res.ok) throw new Error('Failed to list local sessions');
  return (await res.json()).sessions;
}

export async function fetchUploadSession(sessionId: string): Promise<UploadSessionData> {
  const res = await fetch(`/api/upload/session/${encodeURIComponent(sessionId)}`);
  if (!res.ok) throw new Error('Failed to fetch upload session');
  return res.json();
}

export async function startPipeline(
  sessionId: string,
  fileIds: string[],
  selectedStepIds?: string[],
  driveFolderId?: string | null,
  code?: string | null,
): Promise<void> {
  const res = await fetch('/api/pipeline/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, fileIds, steps: selectedStepIds, driveFolderId, code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to start pipeline');
  }
}

/**
 * Halt a running pipeline. Kills any in-flight FFmpeg encode on the backend —
 * without this, Stop would only change the UI while the encode ran to completion.
 * Finished steps stay recorded, so resuming continues rather than restarting.
 */
export async function stopPipeline(sessionId: string): Promise<{ encodesKilled: number }> {
  const res = await fetch('/api/pipeline/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to stop the pipeline');
  }
  return res.json();
}

/** After Google OAuth — only runs the Drive upload step using existing compressed outputs. */
export async function resumeDrivePipeline(sessionId: string): Promise<void> {
  const res = await fetch('/api/pipeline/resume-drive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to resume Google Drive step');
  }
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status');
  if (!res.ok) throw new Error('Failed to fetch auth status');
  return res.json();
}

export async function uploadPrproj(sessionId: string, file: File): Promise<void> {
  const form = new FormData();
  form.append('sessionId', sessionId);
  form.append('prprojFile', file);
  const res = await fetch('/api/pipeline/upload-prproj', { method: 'POST', body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Premiere Pro project upload failed');
  }
}

/**
 * Where a review file must land on Google Drive.
 *
 * The editor's machine can work this out locally, but a Language Expert on a
 * different machine has no local session — their app reads these two values
 * from the shared session and passes them along, which is what makes the
 * upload reach the same Drive folder.
 */
export interface DriveContext {
  driveFolderId?: string | null;
  parentName?: string | null;
}

/** Thrown when a review file could not be saved to Drive. */
export class DriveUploadError extends Error {
  needsAuth: boolean;
  authUrl: string | null;
  reason: string | null;

  constructor(message: string, needsAuth = false, authUrl: string | null = null, reason: string | null = null) {
    super(message);
    this.name = 'DriveUploadError';
    this.needsAuth = needsAuth;
    this.authUrl = authUrl;
    this.reason = reason;
  }
}

async function postReviewFile(
  endpoint: string,
  fieldName: string,
  sessionId: string,
  file: File,
  drive: DriveContext | undefined,
  fallbackMessage: string,
): Promise<void> {
  const form = new FormData();
  form.append('sessionId', sessionId);
  form.append(fieldName, file);
  if (drive?.driveFolderId) form.append('driveFolderId', drive.driveFolderId);
  if (drive?.parentName) form.append('parentName', drive.parentName);
  // Where to come back to if Google authorization is needed. Without this the
  // OAuth redirect lands on a bare /pipeline and the reviewer loses their
  // session code, role and step filter.
  form.append('returnTo', `${window.location.pathname}${window.location.search}`);

  const res = await fetch(endpoint, { method: 'POST', body: form });
  if (res.ok) return;

  const err = await res.json().catch(() => ({ error: res.statusText }));
  if (err.driveBlocked) {
    throw new DriveUploadError(
      err.error || fallbackMessage,
      !!err.needsAuth,
      err.authUrl ?? null,
      err.driveBlocked,
    );
  }
  throw new Error(err.error || fallbackMessage);
}

export function uploadSourceSrt(sessionId: string, file: File, drive?: DriveContext): Promise<void> {
  return postReviewFile('/api/pipeline/upload-srt', 'srtFile', sessionId, file, drive, 'SRT upload failed');
}

export interface TranscribeStatus {
  configured: boolean;
  model: string;
}

/** Whether this machine can generate subtitles, so the UI can offer the right control. */
export function fetchTranscribeStatus(): Promise<TranscribeStatus> {
  return fetch('/api/pipeline/transcribe-status')
    .then(r => (r.ok ? r.json() : { configured: false, model: '' }))
    .catch(() => ({ configured: false, model: '' }));
}

export interface TranscribeResult {
  files: { srt: string; docx: string; cues: number; entries: number }[];
}

/**
 * Generate this episode's subtitles from its own video.
 *
 * No timeout on purpose: a full episode is hundreds of API calls and can run
 * for many minutes. Progress arrives separately over the pipeline's SSE stream,
 * so the step's bar moves while this is still in flight.
 */
export async function transcribeEpisode(
  sessionId: string,
  drive?: DriveContext,
): Promise<TranscribeResult> {
  const res = await fetch('/api/pipeline/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      driveFolderId: drive?.driveFolderId,
      parentName: drive?.parentName,
      returnTo: `${window.location.pathname}${window.location.search}`,
    }),
  });

  if (res.ok) return res.json();

  const err = await res.json().catch(() => ({ error: res.statusText }));
  if (err.driveBlocked) {
    throw new DriveUploadError(
      err.error || 'Subtitle generation failed',
      !!err.needsAuth,
      err.authUrl ?? null,
      err.driveBlocked,
    );
  }
  throw new Error(err.error || 'Subtitle generation failed');
}

export function uploadLE1Word(sessionId: string, file: File, drive?: DriveContext): Promise<void> {
  return postReviewFile('/api/pipeline/upload-le1-word', 'wordFile', sessionId, file, drive, 'LE1 Word upload failed');
}

export function uploadLE2Word(sessionId: string, file: File, drive?: DriveContext): Promise<void> {
  return postReviewFile('/api/pipeline/upload-le2-word', 'wordFile', sessionId, file, drive, 'LE2 Word upload failed');
}

export function uploadLE3Srt(sessionId: string, file: File, drive?: DriveContext): Promise<void> {
  return postReviewFile('/api/pipeline/upload-le3-srt', 'srtFile', sessionId, file, drive, 'LE3 SRT upload failed');
}

// ── Roman script ────────────────────────────────────────────────────────────

export interface DictionaryInfo {
  language: string;
  configured: boolean;
  docId: string | null;
  /** Where the link came from: this machine, or config.env. */
  source: string | null;
  name: string | null;
}

export interface RomanizeStatus {
  configured: boolean;
  languages: string[];
  defaultLanguage: string;
  dictionaries: DictionaryInfo[];
}

export interface RomanizeStats {
  language: string;
  dictionary: string | null;
  lines: number;
  blocks: number;
  /** Lines kept in the original script — these need a human. */
  refused: number;
  refusedSubtitles: string[];
  missing: number;
  cached: boolean;
  corrections: number;
  preReplaced: number;
  inconsistencies: string[];
  issues: { code: string; count: number; note: string }[];
  timecodes: number;
}

export function fetchRomanizeStatus(): Promise<RomanizeStatus> {
  return fetch('/api/pipeline/romanize-status')
    .then(r => (r.ok ? r.json() : null))
    .then(d => d ?? { configured: false, languages: [], defaultLanguage: 'Hindi', dictionaries: [] })
    .catch(() => ({ configured: false, languages: [], defaultLanguage: 'Hindi', dictionaries: [] }));
}

/** Point a language at its dictionary in Google Docs. A blank link clears it. */
export async function setDictionaryLink(
  language: string,
  link: string,
): Promise<DictionaryInfo[]> {
  const res = await fetch('/api/pipeline/dictionary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language, link }),
  });
  if (res.ok) return (await res.json()).dictionaries;
  const err = await res.json().catch(() => ({ error: res.statusText }));
  throw new Error(err.error || 'Could not save that dictionary link');
}

export interface DictionaryCheck {
  name: string;
  spellings: number;
  nativeWords: number;
  pairs: number;
}

/** Download and parse a dictionary now, to confirm it reads before an episode. */
export async function checkDictionary(language: string): Promise<DictionaryCheck> {
  const res = await fetch('/api/pipeline/dictionary/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language }),
  });
  if (res.ok) return res.json();
  const err = await res.json().catch(() => ({ error: res.statusText }));
  throw new Error(err.error || 'Could not read that dictionary');
}

export interface RomanizeResult {
  savedAs: string;
  reviewSavedAs: string;
  stats: RomanizeStats;
}

/**
 * Convert this episode's final subtitles to Roman script.
 *
 * No timeout on purpose: a full episode is many API calls. Progress arrives
 * over the pipeline's SSE stream while this request is still in flight.
 */
export async function romanizeEpisode(
  sessionId: string,
  language: string,
  drive?: DriveContext,
): Promise<RomanizeResult> {
  const res = await fetch('/api/pipeline/romanize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      language,
      driveFolderId: drive?.driveFolderId,
      parentName: drive?.parentName,
      returnTo: `${window.location.pathname}${window.location.search}`,
    }),
  });

  if (res.ok) return res.json();

  const err = await res.json().catch(() => ({ error: res.statusText }));
  if (err.driveBlocked) {
    throw new DriveUploadError(
      err.error || 'Roman-script conversion failed',
      !!err.needsAuth,
      err.authUrl ?? null,
      err.driveBlocked,
    );
  }
  throw new Error(err.error || 'Roman-script conversion failed');
}

export function checkBackendHealth(): Promise<boolean> {
  return fetch('/api/health', { signal: AbortSignal.timeout(2000) })
    .then(r => r.ok)
    .catch(() => false);
}

export interface DriveInfo {
  /** Windows only: the drive letter. macOS entries have none. */
  letter?: string;
  /** What to call it in the list: "D:\" on Windows, a volume name on macOS. */
  name: string;
  root: string;
  total: number;
  free: number;
  used: number;
  suggestedPath: string;
}

export async function fetchSetupStatus(): Promise<{ isFirstRun: boolean; currentDataDir: string }> {
  const res = await fetch('/api/setup/status');
  if (!res.ok) throw new Error('Failed to fetch setup status');
  return res.json();
}

export async function fetchDrives(): Promise<DriveInfo[]> {
  const res = await fetch('/api/setup/drives');
  if (!res.ok) throw new Error('Failed to list drives');
  const data = await res.json();
  return data.drives;
}

// ── Google Drive destination ────────────────────────────────────────────────

export interface DriveFolder {
  id: string;
  name: string;
}

export interface DriveTarget {
  folderId: string;
  folderName: string;
}

/** Thrown when a Drive call needs the user to connect their Google account. */
export class DriveAuthError extends Error {
  authUrl: string | null;
  constructor(message: string, authUrl: string | null) {
    super(message);
    this.name = 'DriveAuthError';
    this.authUrl = authUrl;
  }
}

async function driveJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.ok) return res.json();

  const err = await res.json().catch(() => ({ error: res.statusText }));
  if (res.status === 401 || err.needsAuth) {
    throw new DriveAuthError(err.error || 'Connect Google Drive to continue.', err.authUrl ?? null);
  }
  throw new Error(err.error || 'Google Drive request failed');
}

/** The destination this machine last picked, if any. */
export async function fetchDriveTarget(): Promise<DriveTarget | null> {
  const data = await driveJson<{ target: DriveTarget | null }>('/api/drive/target');
  return data.target;
}

export async function saveDriveTarget(folderId: string, folderName: string): Promise<void> {
  await driveJson('/api/drive/target', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId, folderName }),
  });
}

/**
 * Pull the folder ID out of whatever the editor pasted. Purely local — no
 * network, no Google auth — so pasting a link always works immediately.
 *
 *   https://drive.google.com/drive/folders/<ID>?usp=sharing
 *   https://drive.google.com/drive/u/0/folders/<ID>
 *   https://drive.google.com/open?id=<ID>
 *   <ID>
 */
export function parseDriveFolderId(input: string): string | null {
  const raw = (input || '').trim();
  if (!raw) return null;

  const fromPath = raw.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (fromPath) return fromPath[1];

  const fromQuery = raw.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (fromQuery) return fromQuery[1];

  if (/^[A-Za-z0-9_-]{10,}$/.test(raw)) return raw;

  return null;
}

/** Validate a pasted Drive folder link or ID. */
export async function resolveDriveFolder(input: string): Promise<{ id: string; name: string; url: string }> {
  const data = await driveJson<{ folder: { id: string; name: string; url: string } }>('/api/drive/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  return data.folder;
}

export async function configureDataDir(basePath: string): Promise<void> {
  const res = await fetch('/api/setup/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ basePath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Configuration failed');
  }
}
