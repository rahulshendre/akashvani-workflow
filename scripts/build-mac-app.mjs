/**
 * Builds dist-mac/Akashvani Workflow.app and dist-mac/AkashvaniWorkflow.dmg from
 * the pieces `npm run build:mac` has put in dist-server/.
 *
 * Run with:  node scripts/build-mac-app.mjs
 *      or:   npm run build:mac:app      (the earlier steps: npm run build:mac)
 *
 * The app is a small AppleScript launcher (installer/mac/launcher.applescript,
 * compiled with osacompile) around the same Node server the Windows exe runs:
 *
 *   Akashvani Workflow.app/Contents/
 *     MacOS/applet                        the launcher: Dock icon, Quit, reopen
 *     Resources/server/Akashvani          the server (pkg binary)
 *     Resources/server/frontend/          the built React app
 *     Resources/server/ffmpeg/            ffmpeg and ffprobe
 *     Resources/server/resources/         the watermark image
 *     Resources/server/config.env.template, config.defaults.env
 *
 * The layout inside Resources/server matches the Windows install folder, so
 * server/paths.js finds everything next to the binary on both platforms.
 *
 * The result is signed ad hoc, not with an Apple Developer ID. macOS asks the
 * person to allow it once (see installer/mac/First-run-setup-mac.txt).
 *
 * API keys are baked in like the Windows installer does it, and written to
 * config.defaults.env inside the app. They are never written into a tracked
 * file. They are read from server/.env only. The environment is ignored unless
 * the script is run with --from-env, because variables such as ANTHROPIC_API_KEY
 * are often exported for other tools, and a key picked up that way would end up
 * inside an app that gets handed to someone else. Pass --no-keys to bake in none
 * at all, for a build that is going to be shared or tested.
 */

import { execFileSync } from 'child_process';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const DIST      = join(ROOT, 'dist-mac');

const APP_NAME  = 'Akashvani Workflow';
const BUNDLE_ID = 'com.akashvani.workflow';
const MIN_MACOS = '13.0';
const APP       = join(DIST, `${APP_NAME}.app`);
const SERVER    = join(APP, 'Contents', 'Resources', 'server');
const STAGING   = join(DIST, 'dmg-staging');
const DMG       = join(DIST, 'AkashvaniWorkflow.dmg');

const INJECTED_KEYS = [
  { env: 'GOOGLE_CLIENT_ID', feature: 'Google Drive' },
  { env: 'GOOGLE_CLIENT_SECRET', feature: 'Google Drive' },
  { env: 'SARVAM_API_KEY', feature: 'automatic subtitles' },
  { env: 'ANTHROPIC_API_KEY', feature: 'Roman script' },
];

const INPUTS = {
  server:    join(ROOT, 'dist-server', 'Akashvani-mac'),
  frontend:  join(ROOT, 'dist-server', 'frontend'),
  ffmpeg:    join(ROOT, 'dist-server', 'ffmpeg-mac'),
  resources: join(ROOT, 'dist-server', 'resources'),
  template:  join(ROOT, 'installer', 'config.env.template'),
  launcher:  join(ROOT, 'installer', 'mac', 'launcher.applescript'),
  readme:    join(ROOT, 'installer', 'mac', 'First-run-setup-mac.txt'),
};

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

function plist(...commands) {
  for (const c of commands) run('/usr/libexec/PlistBuddy', ['-c', c, join(APP, 'Contents', 'Info.plist')]);
}

function fmtMB(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Minimal KEY=VALUE reader; tolerates spaces around '=' and surrounding quotes. */
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

const FROM_ENV = process.argv.includes('--from-env');
const NO_KEYS = process.argv.includes('--no-keys');

function resolveKey(name, devEnv) {
  const fromEnv = FROM_ENV ? (process.env[name] || '').trim() : '';
  if (fromEnv) return { value: fromEnv, source: `${name} environment variable` };
  const fromFile = (devEnv[name] || '').trim();
  if (fromFile) return { value: fromFile, source: 'server/.env' };
  return null;
}

/** Last four characters only: the build output must not print the key. */
function mask(value) {
  return `${'*'.repeat(Math.max(0, Math.min(8, value.length - 4)))}${value.slice(-4)}`;
}

function checkPrereqs() {
  if (process.platform !== 'darwin') {
    console.error('This script builds a Mac app and has to run on a Mac (it needs osacompile, codesign and hdiutil).');
    process.exit(1);
  }
  const required = [
    INPUTS.server, join(INPUTS.frontend, 'index.html'),
    join(INPUTS.ffmpeg, 'ffmpeg'), join(INPUTS.ffmpeg, 'ffprobe'),
    join(INPUTS.resources, 'watermark.png'),
    INPUTS.template, INPUTS.launcher, INPUTS.readme,
  ];
  const missing = required.filter((p) => !existsSync(p));
  if (missing.length) {
    console.error('Missing prerequisites:');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('\nRun  npm run build:mac  to produce them.');
    process.exit(1);
  }
}

/** Writes the baked-in keys to config.defaults.env inside the app. Returns the lines to report. */
function writeDefaults() {
  const devEnv = readEnvFile(join(ROOT, 'server', '.env'));
  const lines = [];
  const report = [];
  if (NO_KEYS) report.push('  Built with --no-keys: no API key is baked into this app.');
  for (const key of NO_KEYS ? [] : INJECTED_KEYS) {
    const resolved = resolveKey(key.env, devEnv);
    if (!resolved) {
      report.push(`  !! No ${key.env} in server/.env: ${key.feature} will be OFF until config.env is edited on the Mac.`);
      continue;
    }
    if (/[\s"']/.test(resolved.value)) {
      console.error(`\nThe ${key.env} from ${resolved.source} contains whitespace or quotes. Strip them and rebuild.`);
      process.exit(3);
    }
    lines.push(`${key.env}=${resolved.value}`);
    report.push(`  ${key.env}: ${mask(resolved.value)} (from ${resolved.source}), baked into the app`);
  }
  writeFileSync(join(SERVER, 'config.defaults.env'), lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  return report;
}

function main() {
  checkPrereqs();
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

  rmSync(APP, { recursive: true, force: true });
  rmSync(STAGING, { recursive: true, force: true });
  rmSync(DMG, { force: true });
  mkdirSync(DIST, { recursive: true });

  console.log(`Building ${APP_NAME}.app ${version} ...`);
  run('/usr/bin/osacompile', ['-s', '-o', APP, INPUTS.launcher]);
  plist(
    `Set :CFBundleName ${APP_NAME}`,
    `Add :CFBundleDisplayName string ${APP_NAME}`,
    `Add :CFBundleIdentifier string ${BUNDLE_ID}`,
    `Add :CFBundleShortVersionString string ${version}`,
    `Add :CFBundleVersion string ${version}`,
    `Add :LSMinimumSystemVersion string ${MIN_MACOS}`,
    'Add :NSHighResolutionCapable bool true',
  );

  mkdirSync(SERVER, { recursive: true });
  copyFileSync(INPUTS.server, join(SERVER, 'Akashvani'));
  chmodSync(join(SERVER, 'Akashvani'), 0o755);
  cpSync(INPUTS.frontend, join(SERVER, 'frontend'), { recursive: true });
  cpSync(INPUTS.ffmpeg, join(SERVER, 'ffmpeg'), { recursive: true });
  cpSync(INPUTS.resources, join(SERVER, 'resources'), { recursive: true });
  copyFileSync(INPUTS.template, join(SERVER, 'config.env.template'));
  const keyReport = writeDefaults();

  // The launcher was signed by osacompile before the plist and Resources changed,
  // so sign the finished bundle. Ad hoc: no Apple Developer ID is involved.
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', APP]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', APP]);

  console.log('Making the disk image ...');
  mkdirSync(STAGING, { recursive: true });
  run('/usr/bin/ditto', [APP, join(STAGING, `${APP_NAME}.app`)]);
  symlinkSync('/Applications', join(STAGING, 'Applications'));
  copyFileSync(INPUTS.readme, join(STAGING, 'READ ME FIRST.txt'));
  run('/usr/bin/hdiutil', ['create', '-volname', APP_NAME, '-srcfolder', STAGING, '-ov', '-format', 'UDZO', DMG]);
  rmSync(STAGING, { recursive: true, force: true });

  console.log('');
  for (const line of keyReport) console.log(line);
  console.log('');
  console.log(`App:  ${APP}`);
  console.log(`DMG:  ${DMG} (${fmtMB(statSync(DMG).size)})`);
  console.log('The app is not signed by Apple. The first open needs  System Settings > Privacy & Security > Open Anyway.');
}

main();
