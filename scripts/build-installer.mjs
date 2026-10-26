/**
 * Locate an installed Inno Setup 6 (ISCC.exe) and compile installer\akashvani.iss
 * into dist-installer\AkashvaniSetup.exe.
 *
 *   Prereqs:
 *     1. Inno Setup 6 installed on this machine
 *          → https://jrsoftware.org/isinfo.php  (free)
 *     2. `npm run build:installer` has produced dist-server\Akashvani.exe,
 *        dist-server\frontend\, dist-server\ffmpeg\.
 *
 *   Run: node scripts/build-installer.mjs
 *    or: npm run build:installer:setup
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const ISS_FILE  = join(ROOT, 'installer', 'akashvani.iss');
const OUT_DIR   = join(ROOT, 'dist-installer');

// Default Inno Setup 6 install locations on Windows.
// winget installs per-user under %LocalAppData%\Programs\, the official
// installer defaults to Program Files (x86).
const ISCC_CANDIDATES = [
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
];

function findIscc() {
  if (process.env.ISCC) return process.env.ISCC; // explicit override
  return ISCC_CANDIDATES.find(existsSync);
}

function checkPrereqs() {
  const required = [
    join(ROOT, 'dist-server', 'Akashvani.exe'),
    join(ROOT, 'dist-server', 'frontend', 'index.html'),
    join(ROOT, 'dist-server', 'ffmpeg', 'ffmpeg.exe'),
    join(ROOT, 'dist-server', 'ffmpeg', 'ffprobe.exe'),
  ];
  const missing = required.filter((p) => !existsSync(p));
  if (missing.length) {
    console.error('Missing prerequisites in dist-server\\ :');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('\nRun  npm run build:installer  first to produce them.');
    process.exit(1);
  }
}

/**
 * Minimal KEY=VALUE reader. Tolerates spaces around '=' and surrounding quotes,
 * which is how the key is written in the research folder's .env.
 */
function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/**
 * Secrets the installer needs baked in, resolved at build time.
 *
 * They are NOT kept in installer\config.env.template, because that file is
 * tracked in git — a metered API key there would land in the repository history
 * and in every clone. Reading them here means a key lives only on the machine
 * that builds, and in the installer it produces.
 *
 *   SARVAM_API_KEY    — generating subtitles from the episode audio
 *   ANTHROPIC_API_KEY — converting the finished subtitles to Roman script
 */
const INJECTED_KEYS = [
  { env: 'GOOGLE_CLIENT_ID', define: 'GoogleClientId', feature: 'Google Drive' },
  { env: 'GOOGLE_CLIENT_SECRET', define: 'GoogleClientSecret', feature: 'Google Drive' },
  { env: 'SARVAM_API_KEY', define: 'SarvamApiKey', feature: 'automatic subtitles' },
  { env: 'ANTHROPIC_API_KEY', define: 'AnthropicApiKey', feature: 'Roman script' },
];

function resolveKey(name) {
  const fromEnv = (process.env[name] || '').trim();
  if (fromEnv) return { value: fromEnv, source: `${name} environment variable` };

  const devEnv = readEnvFile(join(ROOT, 'server', '.env'));
  const fromFile = (devEnv[name] || '').trim();
  if (fromFile) return { value: fromFile, source: 'server\\.env' };

  return null;
}

/** Last four characters only — the build output must not print the key. */
function mask(value) {
  return `${'*'.repeat(Math.max(0, Math.min(8, value.length - 4)))}${value.slice(-4)}`;
}

function main() {
  checkPrereqs();

  const iscc = findIscc();
  if (!iscc) {
    console.error('\nInno Setup 6 not found on this machine.');
    console.error('Install it from https://jrsoftware.org/isinfo.php (free), then re-run this script.');
    console.error('Looked in:');
    for (const c of ISCC_CANDIDATES) console.error(`  - ${c}`);
    console.error('\nTip: if you installed Inno Setup to a non-standard location, set the ISCC env var:');
    console.error('     set ISCC=D:\\Tools\\Inno Setup 6\\ISCC.exe');
    process.exit(2);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const defines = [];
  const found = [];
  const missing = [];

  for (const key of INJECTED_KEYS) {
    const resolved = resolveKey(key.env);
    if (!resolved) {
      missing.push(key);
      continue;
    }
    // A key with whitespace or quotes would be truncated by ISCC's /D parsing
    // and ship broken — which only shows up as a confusing API failure on an
    // office machine. Refuse the build instead.
    if (/[\s"']/.test(resolved.value)) {
      console.error(`\nThe ${key.env} from ${resolved.source} contains whitespace or quotes.`);
      console.error('Strip them and rebuild — ISCC would otherwise bake in a truncated key.');
      process.exit(3);
    }
    defines.push(`/D${key.define}=${resolved.value}`);
    found.push({ key, resolved });
  }

  console.log(`Compiling installer with ${iscc} ...`);
  console.log(`  Script: ${ISS_FILE}`);
  console.log(`  Output: ${OUT_DIR}\\AkashvaniSetup.exe`);
  for (const { key, resolved } of found) {
    console.log(`  ${key.env}: ${mask(resolved.value)} (from ${resolved.source}) — baked into the installer`);
  }
  if (missing.length) {
    console.log('');
    for (const key of missing) {
      console.log(`  !! No ${key.env} found — ${key.feature} will be OFF in this installer.`);
    }
    console.log('     Every machine it installs would need config.env edited by hand.');
    console.log('     Set the key(s) in the environment or in server\\.env and rebuild.');
  }
  console.log('');

  // ISCC's relative paths in the .iss are resolved from the .iss file's dir,
  // so we don't need to mess with cwd. We do want to inherit stdio so the
  // user sees progress. Defines come before the script path.
  const result = spawnSync(iscc, [...defines, ISS_FILE], { stdio: 'inherit', shell: false });

  if (result.status !== 0) {
    console.error(`\nISCC exited with code ${result.status}.`);
    process.exit(result.status ?? 1);
  }

  console.log('\n✓ Installer built. Find it in dist-installer\\AkashvaniSetup.exe');
}

main();
