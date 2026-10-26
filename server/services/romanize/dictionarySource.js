/**
 * Where a language's dictionary comes from, and how it is fetched.
 *
 * The language experts maintain ONE dictionary doc PER LANGUAGE in Google Docs
 * and edit them often, so the app pulls the live copy for whichever language is
 * selected rather than asking for an upload. That also removes a correctness
 * trap: a committed or emailed copy silently drifts out of sync with the doc
 * the experts are actually editing.
 *
 * WHY THIS IS DIFFERENT FROM THE PROTOTYPE
 * The Streamlit version had no Google login, so each doc had to be shared as
 * "Anyone with the link" — which made the LINK ITSELF the credential, and meant
 * links could never be stored anywhere a person might read them.
 *
 * Akashvani is already signed in to Google Drive with full `drive` scope, so it
 * downloads the doc AS THE EDITOR. The dictionaries can stay private to the
 * team, and the link stops being a secret — which is why the doc IDs below live
 * in ordinary settings next to the Drive destination, with no special handling.
 */

import { google } from 'googleapis';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { USER_DATA_DIR } from '../../paths.js';
import { getAuthenticatedClient, isAuthenticated, isConfigured } from '../gdrive.js';
import { DICT_CACHE_TTL_MS, LANGUAGES } from './config.js';
import { logInfo, logWarn } from '../logger.js';

/** Settings file: { "Hindi": { docId, name, setAt }, ... } */
export const DICTIONARIES_FILE = join(USER_DATA_DIR, 'dictionaries.json');

const GDOC_ID_RE = /\/d\/([A-Za-z0-9_-]{20,})/;
const BARE_ID_RE = /^[A-Za-z0-9_-]{20,}$/;

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The config.env key holding a language's doc, e.g. Hindi -> DICTIONARY_DOC_URL_HINDI. */
export function envVarFor(language) {
  return `DICTIONARY_DOC_URL_${language.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Pull the file ID out of a Drive/Docs link, or accept a bare ID. */
export function parseDocId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = GDOC_ID_RE.exec(s);
  if (m) return m[1];
  if (BARE_ID_RE.test(s)) return s;
  const alt = /[?&]id=([A-Za-z0-9_-]{20,})/.exec(s);
  return alt ? alt[1] : null;
}

async function readSettings() {
  try {
    const parsed = JSON.parse(await readFile(DICTIONARIES_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSettings(settings) {
  await mkdir(dirname(DICTIONARIES_FILE), { recursive: true });
  await writeFile(DICTIONARIES_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

/**
 * The doc ID for a language.
 *
 * Resolution order, most specific first:
 *   1. what this machine's editor saved (dictionaries.json)
 *   2. DICTIONARY_DOC_URL_<LANGUAGE> from config.env — lets head office ship
 *      installers with every office's dictionaries already set
 *   3. DICTIONARY_DOC_URL — one doc for every language; a testing escape hatch
 *
 * A language with nothing set simply has no dictionary: the step says so and
 * romanizes without corrections, rather than silently loading another
 * language's doc.
 */
export async function resolveDocId(language, settings = null) {
  const saved = settings || await readSettings();
  const fromSettings = parseDocId(saved[language]?.docId);
  if (fromSettings) return { docId: fromSettings, source: 'this machine' };

  const fromEnv = parseDocId(process.env[envVarFor(language)]);
  if (fromEnv) return { docId: fromEnv, source: 'config.env' };

  const fallback = parseDocId(process.env.DICTIONARY_DOC_URL);
  if (fallback) return { docId: fallback, source: 'config.env (all languages)' };

  return null;
}

/** Save (or clear, with a blank link) one language's dictionary. */
export async function setDictionary(language, linkOrId, name = null) {
  if (!LANGUAGES[language]) throw new Error(`Unknown language: ${language}`);
  const settings = await readSettings();

  if (!String(linkOrId || '').trim()) {
    delete settings[language];
    await writeSettings(settings);
    logInfo('dictionary cleared', { language });
    return null;
  }

  const docId = parseDocId(linkOrId);
  if (!docId) {
    throw new Error(
      "That doesn't look like a Google Docs link. Open the dictionary in Google Docs, " +
      'copy the address from the browser bar, and paste the whole thing.'
    );
  }

  // Confirm this account can actually open it before saving, so a typo surfaces
  // now rather than halfway through an episode.
  const meta = await describeDoc(docId);
  settings[language] = { docId, name: name || meta.name, setAt: new Date().toISOString() };
  await writeSettings(settings);
  logInfo('dictionary set', { language, docId, name: meta.name });
  return settings[language];
}

/** Name and type of a doc, used to validate a pasted link. */
export async function describeDoc(docId) {
  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: 'v3', auth });
  try {
    const { data } = await drive.files.get({
      fileId: docId,
      fields: 'id,name,mimeType',
      supportsAllDrives: true,
    });
    return { id: data.id, name: data.name, mimeType: data.mimeType };
  } catch (err) {
    const status = err?.code ?? err?.response?.status;
    if (status === 404) {
      throw new Error(
        'No document exists at that link, or this Google account cannot see it. ' +
        'Check the link, and that the dictionary is shared with the account signed in here.'
      );
    }
    if (status === 403) {
      throw new Error(
        'This Google account does not have permission to open that document. ' +
        'Ask whoever owns the dictionary to share it with the account signed in here.'
      );
    }
    throw err;
  }
}

/** Downloaded copies, so an episode doesn't re-fetch the dictionary per run. */
const cache = new Map();   // docId -> { bytes, at, name }

/**
 * Download a language's dictionary as .docx bytes.
 *
 * A native Google Doc is EXPORTED to .docx; an uploaded .docx is downloaded
 * as-is. Both go through the authenticated client, so neither needs the doc to
 * be publicly shared.
 *
 * @returns {Promise<{bytes: Buffer, name: string, docId: string, source: string, cached: boolean}|null>}
 *   null when this language has no dictionary configured.
 */
export async function fetchDictionary(language, { force = false } = {}) {
  const resolved = await resolveDocId(language);
  if (!resolved) return null;

  if (!isConfigured()) throw new Error('Google Drive is not configured on this machine.');
  if (!isAuthenticated()) {
    throw new Error(
      'Connect Google Drive first — the dictionary is read from Google Docs using that sign-in.'
    );
  }

  const { docId, source } = resolved;
  const hit = cache.get(docId);
  if (!force && hit && Date.now() - hit.at < DICT_CACHE_TTL_MS) {
    return { bytes: hit.bytes, name: hit.name, docId, source, cached: true };
  }

  const auth = await getAuthenticatedClient();
  const drive = google.drive({ version: 'v3', auth });
  const meta = await describeDoc(docId);

  let data;
  if (meta.mimeType === GOOGLE_DOC_MIME) {
    ({ data } = await drive.files.export(
      { fileId: docId, mimeType: DOCX_MIME },
      { responseType: 'arraybuffer' }
    ));
  } else {
    ({ data } = await drive.files.get(
      { fileId: docId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    ));
  }

  const bytes = Buffer.from(data);
  if (!bytes.subarray(0, 2).equals(Buffer.from('PK'))) {
    throw new Error(
      `"${meta.name}" did not come back as a Word document. If it is a plain file ` +
      'rather than a Google Doc, make sure it is a .docx.'
    );
  }

  cache.set(docId, { bytes, at: Date.now(), name: meta.name });
  logInfo('dictionary fetched', { language, docId, name: meta.name, kb: Math.round(bytes.length / 1024) });
  return { bytes, name: meta.name, docId, source, cached: false };
}

/** What this machine has configured, for the settings screen. Never throws. */
export async function listDictionaries() {
  const settings = await readSettings();
  const out = [];
  for (const language of Object.keys(LANGUAGES)) {
    let resolved = null;
    try {
      resolved = await resolveDocId(language, settings);
    } catch (err) {
      logWarn('could not resolve dictionary', { language, error: err.message });
    }
    out.push({
      language,
      configured: !!resolved,
      docId: resolved?.docId ?? null,
      source: resolved?.source ?? null,
      name: settings[language]?.name ?? null,
    });
  }
  return out;
}
