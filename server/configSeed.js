/**
 * config.env handling for the macOS app.
 *
 * On Windows the installer puts config.env next to the exe and fills the
 * build-time API keys into it (see EnsureApiKeys in installer/akashvani.iss).
 * A macOS app has no installer step, and the .app folder is sealed by code
 * signing, so the file lives in the user's Application Support folder instead
 * and is created and topped up here, on every launch.
 *
 *   config.env.template  - the blank starting file, shipped inside the app
 *   config.defaults.env  - the keys baked in at build time, shipped inside the app
 *   config.env           - the user's copy; the only file anyone edits
 *
 * The rule is the same as the Windows installer's: a key is only ever written
 * into a blank slot. A value somebody typed is left alone, and so is every
 * other line in the file.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/** KEY=VALUE lines to an object. Comments and blank lines are skipped. */
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/**
 * Fill blank keys from `defaults` and return the new text. A key that is not in
 * the file at all (a config.env older than the setting) is appended.
 */
export function fillBlankKeys(text, defaults) {
  const lines = text === '' ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let changed = false;
  const appended = [];

  for (const [name, value] of Object.entries(defaults)) {
    if (!value || !value.trim()) continue;
    const prefix = `${name}=`;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed.startsWith(prefix)) continue;
      found = true;
      if (trimmed.slice(prefix.length).trim() === '') {
        lines[i] = prefix + value;
        changed = true;
      }
    }
    if (!found) appended.push(prefix + value);
  }

  if (appended.length) {
    lines.push('', ...appended);
    changed = true;
  }
  return changed ? lines.join('\n') + '\n' : text;
}

/** Create config.env from the template if it is missing, then fill blank keys. */
export function seedConfig({ configPath, templatePath, defaultsPath }) {
  const exists = existsSync(configPath);
  let text = '';
  if (exists) text = readFileSync(configPath, 'utf8');
  else if (existsSync(templatePath)) text = readFileSync(templatePath, 'utf8');

  const defaults = existsSync(defaultsPath) ? parseEnv(readFileSync(defaultsPath, 'utf8')) : {};
  const next = fillBlankKeys(text, defaults);

  if (!exists || next !== text) {
    mkdirSync(dirname(configPath), { recursive: true });
    // Holds API keys, so readable by the signed-in user only.
    writeFileSync(configPath, next, { mode: 0o600 });
  }
}
