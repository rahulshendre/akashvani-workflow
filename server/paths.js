/**
 * Central path / mode resolver for the Akashvani backend.
 *
 * The server runs in two modes:
 *   1. DEV — launched via `npm run dev:server`. Source files live under server/,
 *      data dirs live under server/uploads, server/workflows, etc.
 *   2. PACKAGED — bundled into Akashvani.exe by `@yao-pkg/pkg`. process.pkg is
 *      truthy. Binaries / static frontend live next to the .exe, while user data
 *      lives in %LocalAppData%\Akashvani Workflow so it survives upgrades.
 *
 * Every other server module should import paths from here — never compute them
 * itself with __dirname tricks. This is the only place that knows about the
 * packaged-vs-dev distinction.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import os from 'os';
import { supportDir, logDir } from './appDirs.js';

/** True when running inside a pkg-bundled binary. */
export const IS_PACKAGED = !!process.pkg;

/**
 * Root the installer creates (where Akashvani.exe sits), or the server/ source
 * directory in dev. All sibling assets (ffmpeg/, frontend/, config.env) are
 * resolved relative to this.
 */
export const APP_ROOT = IS_PACKAGED
  ? dirname(process.execPath)
  : dirname(fileURLToPath(import.meta.url));

/**
 * Where the user's workflows, uploads, and OAuth tokens are persisted.
 *
 *   PACKAGED — reads user-data-path.txt next to Akashvani.exe (set by the
 *              drive-picker on first run). Falls back to Documents\Akashvani
 *              Workflow if the file doesn't exist yet.
 *   DEV      — server/   (legacy layout, no change)
 */

/**
 * Per-user folder that is always writable, even when the app itself sits
 * somewhere read-only: %LOCALAPPDATA%\Akashvani Workflow on Windows,
 * ~/Library/Application Support/Akashvani Workflow on macOS.
 */
export const SUPPORT_DIR = supportDir(process.platform, process.env, os.homedir());

/**
 * Path to the preference file that stores the user-chosen data directory.
 * Stored in SUPPORT_DIR — always writable by the current user even when the
 * exe lives in C:\Program Files\.
 */
export const DATA_DIR_PREF_FILE = IS_PACKAGED
  ? join(SUPPORT_DIR, 'user-data-path.txt')
  : null;

function resolveUserDataDir() {
  if (!IS_PACKAGED) return APP_ROOT;
  // If the user has already picked a location, use it.
  if (DATA_DIR_PREF_FILE && existsSync(DATA_DIR_PREF_FILE)) {
    const saved = readFileSync(DATA_DIR_PREF_FILE, 'utf8').trim();
    if (saved) return saved;
  }
  // Default fallback: Documents\Akashvani Workflow
  const docs = join(os.homedir(), 'Documents');
  if (existsSync(docs)) return join(docs, 'Akashvani Workflow');
  return SUPPORT_DIR;
}

export const USER_DATA_DIR = resolveUserDataDir();

/**
 * True on the very first packaged launch before the user has picked a
 * storage location. Always false in dev mode.
 */
export function isFirstRun() {
  return IS_PACKAGED && DATA_DIR_PREF_FILE != null && !existsSync(DATA_DIR_PREF_FILE);
}

/**
 * Persist the user-chosen data directory. Called by the setup route after
 * the user picks a drive. Takes effect on the next launch.
 */
export function saveUserDataDir(newDir) {
  if (DATA_DIR_PREF_FILE) {
    mkdirSync(dirname(DATA_DIR_PREF_FILE), { recursive: true });
    writeFileSync(DATA_DIR_PREF_FILE, newDir, 'utf8');
  }
}

/**
 * Where the editor's chosen Google Drive destination folder is remembered, so
 * the picker pre-fills on the next episode instead of asking again.
 * Shape: { folderId: string, folderName: string }
 */
export const DRIVE_TARGET_FILE = join(USER_DATA_DIR, 'drive-target.json');

/** Read the saved Drive destination, or null if the user hasn't picked one. */
export function loadDriveTarget() {
  try {
    if (!existsSync(DRIVE_TARGET_FILE)) return null;
    const parsed = JSON.parse(readFileSync(DRIVE_TARGET_FILE, 'utf8'));
    return parsed?.folderId ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist the Drive destination the editor picked. */
export function saveDriveTarget(target) {
  mkdirSync(dirname(DRIVE_TARGET_FILE), { recursive: true });
  writeFileSync(DRIVE_TARGET_FILE, JSON.stringify(target, null, 2), 'utf8');
}

/** Multer temp storage + the per-session compressed output staging area. */
export const UPLOADS_DIR = join(USER_DATA_DIR, 'uploads');

/** Per-session workflow trees (raw footage / source file / AI Subtitles / Editor). */
export const WORKFLOWS_DIR = join(USER_DATA_DIR, 'workflows');

/** Where compressed videos get copied for downstream tools (legacy). */
export const SYSTEM_INTAKE_DIR = join(USER_DATA_DIR, 'system-intake');

/**
 * Where dotenv loads from.
 *
 *   PACKAGED — config.env sits NEXT TO Akashvani.exe so users can edit it
 *              without Admin rights only if installed under their profile,
 *              but the .env file itself is owned by Akashvani.exe's folder.
 *   PACKAGED, macOS — config.env lives in SUPPORT_DIR. The .app is sealed by
 *              code signing, so nothing may be written inside it. configSeed.js
 *              creates the file on launch.
 *   DEV      — server/.env (existing behavior).
 */
export const CONFIG_IN_SUPPORT_DIR = IS_PACKAGED && process.platform === 'darwin';

export const CONFIG_ENV_PATH = CONFIG_IN_SUPPORT_DIR
  ? join(SUPPORT_DIR, 'config.env')
  : IS_PACKAGED
    ? join(APP_ROOT, 'config.env')
    : join(APP_ROOT, '.env');

/** How error messages tell people where config.env is. */
export const CONFIG_FILE_HINT = CONFIG_IN_SUPPORT_DIR
  ? 'config.env in ~/Library/Application Support/Akashvani Workflow'
  : 'config.env next to Akashvani.exe';

/**
 * Built Vite frontend (HTML/JS/CSS). Express serves this with `express.static`
 * in packaged mode. In dev, Vite owns the frontend on :8080 so this is null.
 */
export const FRONTEND_DIR = IS_PACKAGED ? join(APP_ROOT, 'frontend') : null;

/**
 * Resolve a bundled binary (ffmpeg / ffprobe). Looks for
 *   <APP_ROOT>\ffmpeg\<name>.exe
 * If found, returns the absolute path. Otherwise returns the bare name so
 * spawn() falls back to the system PATH (useful in dev).
 */
function resolveBundledBin(name) {
  if (!IS_PACKAGED) return name; // dev: rely on system PATH
  const ext = process.platform === 'win32' ? '.exe' : '';
  const candidate = join(APP_ROOT, 'ffmpeg', `${name}${ext}`);
  return existsSync(candidate) ? candidate : name;
}

export const FFMPEG_BIN = resolveBundledBin('ffmpeg');
export const FFPROBE_BIN = resolveBundledBin('ffprobe');

/**
 * Bundled watermark image, used by compress.js when the user hasn't supplied
 * their own via WATERMARK_FILE_PATH.
 *
 *   PACKAGED — <APP_ROOT>\resources\watermark.png  (shipped by installer)
 *   DEV      — server\assets\watermark.png         (in-repo source asset)
 */
function resolveBundledWatermark() {
  const candidate = IS_PACKAGED
    ? join(APP_ROOT, 'resources', 'watermark.png')
    : join(APP_ROOT, 'assets', 'watermark.png');
  return existsSync(candidate) ? candidate : null;
}

export const WATERMARK_PATH = resolveBundledWatermark();

/** One-shot diagnostic dump — handy to log at server startup. */
export function describePaths() {
  return {
    mode: IS_PACKAGED ? 'packaged' : 'dev',
    appRoot: APP_ROOT,
    userData: USER_DATA_DIR,
    configEnv: CONFIG_ENV_PATH,
    frontend: FRONTEND_DIR,
    ffmpeg: FFMPEG_BIN,
    ffprobe: FFPROBE_BIN,
    watermark: WATERMARK_PATH,
    logFile: IS_PACKAGED
      ? join(logDir(process.platform, process.env, os.homedir()), 'akashvani.log')
      : join(USER_DATA_DIR, 'logs', 'akashvani.log'),
  };
}
