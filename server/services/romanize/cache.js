/**
 * On-disk cache: the same file + language never costs a second API call.
 *
 * Keyed on the EXACT source bytes rather than the filename, so an edited
 * subtitle is automatically a different key and a stale result can never be
 * served for changed input.
 */

import { createHash } from 'crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { USER_DATA_DIR } from '../../paths.js';
import { CACHE_VERSION } from './config.js';
import { logWarn } from '../logger.js';

export const ROMANIZE_CACHE_DIR = join(USER_DATA_DIR, '.romanize-cache');

export class RomanizationCache {
  constructor(directory = ROMANIZE_CACHE_DIR, version = CACHE_VERSION) {
    this.directory = directory;
    this.version = version;
  }

  key(text, language) {
    return createHash('sha256')
      .update(this.version, 'utf8').update('\0')
      .update(language, 'utf8').update('\0')
      .update(text, 'utf8')          // exact source — any edit is a different key
      .digest('hex');
  }

  async load(key) {
    try {
      return JSON.parse(await readFile(join(this.directory, `${key}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  async store(key, romanizedText, stats) {
    try {
      await mkdir(this.directory, { recursive: true });
      const path = join(this.directory, `${key}.json`);
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify({ romanizedText, stats }), 'utf8');
      await rename(tmp, path);   // atomic — never leaves a half-written cache file
    } catch (err) {
      logWarn('Could not write romanization cache', { error: err.message });
    }
  }

  /** Delete every cached romanization. Returns how many were removed. */
  async clear() {
    let n = 0;
    try {
      for (const name of await readdir(this.directory)) {
        if (name.endsWith('.json')) {
          await unlink(join(this.directory, name));
          n += 1;
        }
      }
    } catch { /* nothing cached yet */ }
    return n;
  }
}
