/**
 * Disk log for the whole app.
 *
 * The packaged exe has no visible console, so without this a failure leaves no
 * trace anywhere — the only clue is whatever the user happened to read on screen
 * before clicking away. That makes supporting several offices remotely close to
 * impossible.
 *
 * Location is deliberately NOT the user-chosen data drive: that varies per
 * machine and may be missing, and support needs one path that is the same
 * everywhere. Packaged builds always log to
 *
 *   %LOCALAPPDATA%\Akashvani Workflow\logs\
 *
 * which is guaranteed to exist and be writable for the signed-in user.
 */

import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import os from 'os';
import { IS_PACKAGED, APP_ROOT } from '../paths.js';

function resolveLogDir() {
  if (IS_PACKAGED) {
    const base = process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local');
    return join(base, 'Akashvani Workflow', 'logs');
  }
  return join(APP_ROOT, 'logs');
}

export const LOG_DIR = resolveLogDir();
export const LOG_FILE = join(LOG_DIR, 'akashvani.log');
/** Written by the installer, so install problems are visible in the same place. */
export const INSTALL_LOG_FILE = join(LOG_DIR, 'install.log');

const MAX_BYTES = 5 * 1024 * 1024; // one 5 MB file plus a single rotation

function rotateIfNeeded() {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch {
    /* rotation is best-effort */
  }
}

/** Append a line. Never throws — logging must not break what it records. */
export function logLine(level, message, detail) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded();

    let line = `[${new Date().toISOString()}] ${level} ${message}`;
    if (detail !== undefined && detail !== null) {
      const text = detail instanceof Error
        ? `${detail.message}\n${detail.stack ?? ''}`
        : typeof detail === 'string' ? detail : JSON.stringify(detail);
      line += `\n    ${String(text).split('\n').join('\n    ')}`;
    }
    appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    /* disk unavailable — carry on */
  }
}

export const logInfo  = (message, detail) => logLine('INFO ', message, detail);
export const logWarn  = (message, detail) => logLine('WARN ', message, detail);
export const logError = (message, detail) => logLine('ERROR', message, detail);

/**
 * Record a failed upload with the context needed to diagnose it remotely:
 * which step, which session, and where it was meant to go on Drive.
 */
export function logUploadFailure(route, { sessionId, parentName, driveFolderId, fileName }, err) {
  logError(`${route} failed`, {
    sessionId,
    fileName,
    parentName,
    driveFolderId,
    error: err?.message,
    googleErrors: err?.errors ?? err?.response?.data?.error ?? undefined,
    code: err?.code ?? err?.response?.status,
    stack: err?.stack,
  });
}

/**
 * Banner written once per launch. Gives a support request its anchor: which
 * build, which machine, which paths, and where the data actually lives.
 */
export function logStartup(extra = {}) {
  logLine('INFO ', '='.repeat(60));
  logInfo('Akashvani starting', {
    version: process.env.npm_package_version || 'packaged',
    mode: IS_PACKAGED ? 'packaged' : 'dev',
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    hostname: os.hostname(),
    user: os.userInfo().username,
    pid: process.pid,
    logDir: LOG_DIR,
    ...extra,
  });
}

/**
 * Catch anything that would otherwise kill the process silently. In a packaged
 * exe an uncaught error closes the window with nothing written down.
 */
export function installCrashHandlers() {
  process.on('uncaughtException', (err) => {
    logError('UNCAUGHT EXCEPTION — process will exit', err);
  });
  process.on('unhandledRejection', (reason) => {
    logError('UNHANDLED PROMISE REJECTION', reason instanceof Error ? reason : String(reason));
  });
  process.on('exit', (code) => {
    logInfo('Akashvani exiting', { code });
  });
}

/** Tail of a log file, for the in-app viewer. */
export function readLogTail(file, lines = 200) {
  try {
    const text = readFileSync(file, 'utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch {
    return `No log yet at ${file}`;
  }
}
