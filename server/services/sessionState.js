/**
 * Durable per-session pipeline state.
 *
 * The in-memory `uploadSessions` map is lost the moment the server restarts —
 * which is exactly what happens when an editor shuts their machine off for two
 * days while a Language Expert reviews. Everything needed to resume an episode
 * therefore lives on disk next to the session's own files:
 *
 *   <WORKFLOWS_DIR>/<sessionId>/session-state.json
 *
 * This file is the authoritative record of which steps are finished on THIS
 * machine. The shared Fly.io record is authoritative for work done on OTHER
 * machines (a Language Expert's uploads); the frontend merges both on resume.
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { WORKFLOWS_DIR } from '../paths.js';

function stateDir(sessionId) {
  return join(WORKFLOWS_DIR, sessionId);
}

function statePath(sessionId) {
  return join(stateDir(sessionId), 'session-state.json');
}

const EMPTY = {
  sessionId: null,
  /** Shared AK-XXXX code, so a local session can still be resumed and shared. */
  code: null,
  /**
   * Hidden from the episode list. Set by delete instead of removing the folder,
   * because that folder holds the copied footage and compressed output — a list
   * row disappearing must not destroy gigabytes of video.
   */
  deleted: false,
  /** What each Language Expert submitted, so any machine can show their history. */
  leUploads: {},
  folderName: null,
  episodeCount: 1,
  selectedSteps: null,
  parentName: null,
  driveFolderId: null,
  stepStates: {},
  updatedAt: null,
};

/** Read a session's persisted state. Returns defaults when nothing is saved. */
export async function readSessionState(sessionId) {
  if (!sessionId) return { ...EMPTY };
  try {
    const raw = await readFile(statePath(sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    return { ...EMPTY, ...parsed, stepStates: parsed.stepStates || {} };
  } catch {
    return { ...EMPTY, sessionId };
  }
}

/**
 * Merge a patch into a session's state and persist it.
 * `stepStates` merges key-by-key; every other field overwrites when provided.
 */
export async function updateSessionState(sessionId, patch) {
  if (!sessionId) return { ...EMPTY };

  const current = await readSessionState(sessionId);
  const next = {
    ...current,
    ...patch,
    sessionId,
    stepStates: { ...current.stepStates, ...(patch.stepStates || {}) },
    updatedAt: new Date().toISOString(),
  };

  try {
    await mkdir(stateDir(sessionId), { recursive: true });
    await writeFile(statePath(sessionId), JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // Disk unavailable — resume degrades to the shared record rather than failing
    // the request the caller is in the middle of serving.
  }

  return next;
}

/** Record a single step as finished. Completion is monotonic — never unset. */
export function markStepComplete(sessionId, stepId) {
  if (!sessionId || !stepId) return Promise.resolve();
  return updateSessionState(sessionId, { stepStates: { [stepId]: 'complete' } });
}

/**
 * Infer completion for older sessions saved before this file existed, by
 * looking at what is actually on disk. Only fills gaps — never contradicts
 * a step already recorded as complete.
 */
export async function inferStepStatesFromDisk(sessionId) {
  const base = join(WORKFLOWS_DIR, sessionId, 'akashwani-structure');
  const inferred = {};

  const listing = async (sub) => {
    try {
      return await readdir(join(base, sub));
    } catch {
      return [];
    }
  };

  const [raw, source, subtitlesNew, subtitlesLegacy, editor] = await Promise.all([
    listing('raw footage'),
    listing('source file'),
    listing('AI Subtitles'),
    listing('Feltiv SRT'),   // episodes created before the rename
    listing('Editor'),
  ]);

  const videoRe = /\.(mp4|mov|avi|mkv|mxf)$/i;

  if (raw.some((n) => videoRe.test(n))) inferred.copy = 'complete';
  if (source.some((n) => /_compressed\.[a-z0-9]+$/i.test(n))) inferred.compress = 'complete';
  const subtitles = [...subtitlesNew, ...subtitlesLegacy];
  if (subtitles.some((n) => /\.srt$/i.test(n))) inferred['upload-feltiv-srt'] = 'complete';
  if (editor.some((n) => /\.prproj$/i.test(n))) inferred['upload-prproj'] = 'complete';
  if (editor.some((n) => /\.(doc|docx)$/i.test(n))) inferred['review-pass1'] = 'complete';

  return inferred;
}

/**
 * Every session this machine knows about, newest first.
 *
 * The editor's home screen must work when the sync server is unreachable — the
 * episodes and their progress live here on disk, so being offline should never
 * lock someone out of their own work.
 */
export async function listLocalSessions() {
  let dirs;
  try {
    dirs = await readdir(WORKFLOWS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions = await Promise.all(
    dirs
      .filter((d) => d.isDirectory())
      .map(async (d) => {
        const state = await getResumeState(d.name);
        if (state.deleted) return null;
        return {
          sessionId: d.name,
          code: state.code ?? null,
          folderName: state.folderName,
          episodeCount: state.episodeCount ?? 1,
          selectedSteps: state.selectedSteps,
          stepStates: state.stepStates,
          driveFolderId: state.driveFolderId,
          parentName: state.parentName,
          leUploads: state.leUploads ?? {},
          updatedAt: state.updatedAt,
        };
      })
  );

  return sessions
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}

/**
 * Hide a session from the episode list.
 *
 * Deliberately a flag rather than an `rm -rf`: the session folder holds the
 * copied raw footage and the compressed output. Removing a row from a list must
 * never delete gigabytes of video.
 */
export function markSessionDeleted(sessionId) {
  return updateSessionState(sessionId, { deleted: true });
}

/** Record what a Language Expert submitted, so their history is visible anywhere. */
export async function recordLeUpload(sessionId, leRole, fileName) {
  if (!sessionId || !leRole || !fileName) return null;
  const current = await readSessionState(sessionId);
  return updateSessionState(sessionId, {
    leUploads: { ...current.leUploads, [leRole]: { fileName, at: new Date().toISOString() } },
  });
}

/**
 * What two folder names are compared by. NFC, because macOS often returns the
 * decomposed form of an accented letter ("e" plus a combining accent) where
 * Windows gives the single composed character: the same name must not look
 * like two different episodes.
 */
const folderKey = (name) => String(name ?? '').normalize('NFC').trim().toLowerCase();

/**
 * Find a live (non-deleted) session already using this episode folder name.
 * Used to refuse a second upload of the same folder — for the editor that folder
 * already exists, so a duplicate would silently fork the episode in two.
 */
export async function findSessionByFolderName(folderName) {
  if (!folderName) return null;
  const wanted = folderKey(folderName);
  const sessions = await listLocalSessions();
  return sessions.find((s) => folderKey(s.folderName) === wanted) ?? null;
}

/**
 * Everything the frontend needs to restore an episode: recorded step states,
 * backfilled from disk for sessions predating this file.
 */
export async function getResumeState(sessionId) {
  const saved = await readSessionState(sessionId);
  const inferred = await inferStepStatesFromDisk(sessionId);
  return {
    ...saved,
    // Recorded state wins; inference only fills gaps.
    stepStates: { ...inferred, ...saved.stepStates },
  };
}
