/**
 * The macOS app and disk image as built by `npm run build:mac`: what is inside, how it
 * is signed, what it links against, and that it works after being installed from the
 * DMG. Nothing here runs the bundled FFmpeg by hand; the app does that in the other suites.
 *
 * The launcher test is opt-in (SMOKE_LAUNCHER=1) because the app, started by macOS the way a
 * double-click does it, opens your real browser.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, lstatSync, readlinkSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { execFileSync, spawnSync, spawn } from 'child_process';
import { join } from 'path';
import { ROOT, startApp, waitFor, listeners, tempDir, removeTree } from './harness.mjs';

const APP = join(ROOT, 'dist-mac', 'Akashvani Workflow.app');
const DMG = join(ROOT, 'dist-mac', 'AkashvaniWorkflow.dmg');
const SERVER = join(APP, 'Contents', 'Resources', 'server');
const skip = existsSync(APP) && existsSync(DMG) ? false : 'the app has not been built; run npm run build:mac';

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const plist = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(APP, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 29 });

describe('what is inside the app', { skip }, () => {
  it('is named, versioned and identified as intended', () => {
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    assert.equal(plist('CFBundleIdentifier'), 'com.akashvani.workflow');
    assert.equal(plist('CFBundleName'), 'Akashvani Workflow');
    assert.equal(plist('CFBundleDisplayName'), 'Akashvani Workflow');
    assert.equal(plist('CFBundleShortVersionString'), version);
    assert.equal(plist('CFBundleVersion'), version);
    assert.equal(plist('LSMinimumSystemVersion'), '13.0');
    assert.equal(plist('OSAAppletStayOpen'), 'true', 'stays open, so it has a Dock icon and Quit');
    assert.equal(plist('NSHighResolutionCapable'), 'true');
  });

  it('has the server and everything it reads, next to each other as paths.js expects', () => {
    for (const rel of [
      'Akashvani', 'frontend/index.html', 'ffmpeg/ffmpeg', 'ffmpeg/ffprobe', 'resources/watermark.png',
      'config.env.template', 'config.defaults.env',
    ]) assert.ok(existsSync(join(SERVER, rel)), `Contents/Resources/server/${rel}`);
    assert.ok(existsSync(join(APP, 'Contents', 'MacOS', 'applet')), 'the launcher');
    for (const exe of ['Akashvani', 'ffmpeg/ffmpeg', 'ffmpeg/ffprobe']) {
      assert.ok(statSync(join(SERVER, exe)).mode & 0o111, `${exe} is executable`);
    }
  });

  it('has a frontend that points at files it ships', () => {
    const html = readFileSync(join(SERVER, 'frontend', 'index.html'), 'utf8');
    for (const ref of html.match(/\/assets\/[^"']+/g) ?? []) {
      assert.ok(existsSync(join(SERVER, 'frontend', ref)), ref);
    }
  });

  it('has a config template that matches the one in the repo', () => {
    assert.equal(readFileSync(join(SERVER, 'config.env.template'), 'utf8'), readFileSync(join(ROOT, 'installer', 'config.env.template'), 'utf8'));
  });

  it('does not contain an API key that was only exported in the environment', () => {
    // The first Mac build once baked in ANTHROPIC_API_KEY from the shell. Keys now come from
    // server/.env, or from the environment only with --from-env.
    for (const name of ['ANTHROPIC_API_KEY', 'SARVAM_API_KEY', 'GOOGLE_CLIENT_SECRET']) {
      const value = (process.env[name] || '').trim();
      if (value.length < 12) continue;
      const hit = run('/usr/bin/grep', ['-rlF', '--', value, APP]);
      const defaults = readFileSync(join(SERVER, 'config.defaults.env'), 'utf8');
      const deliberate = defaults.includes(`${name}=${value}`);
      assert.ok(hit.status !== 0 || deliberate, `${name} from the environment is inside the app (${hit.stdout.trim().split('\n').length} file(s))`);
    }
  });
});

describe('signature, architecture and libraries', { skip }, () => {
  it('has a valid ad hoc signature, not a developer identity', () => {
    const verify = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', APP]);
    assert.equal(verify.status, 0, verify.stderr);
    const info = run('/usr/bin/codesign', ['-dv', APP]).stderr;
    assert.match(info, /Signature=adhoc/);
    assert.match(info, /Identifier=com\.akashvani\.workflow/);
  });

  it('is built for Apple silicon: server, FFmpeg and FFprobe are arm64, the launcher includes arm64', () => {
    for (const rel of ['Akashvani', 'ffmpeg/ffmpeg', 'ffmpeg/ffprobe']) {
      const out = run('/usr/bin/file', [join(SERVER, rel)]).stdout;
      assert.match(out, /Mach-O 64-bit executable arm64/, rel);
    }
    assert.match(run('/usr/bin/lipo', ['-archs', join(APP, 'Contents', 'MacOS', 'applet')]).stdout, /arm64/);
  });

  it('links only against what macOS itself provides, so it runs on a Mac with nothing installed', () => {
    for (const rel of ['Akashvani', 'ffmpeg/ffmpeg', 'ffmpeg/ffprobe']) {
      const libs = run('/usr/bin/otool', ['-L', join(SERVER, rel)]).stdout.split('\n').slice(1)
        .map((l) => l.trim().split(' ')[0]).filter(Boolean);
      assert.ok(libs.length > 0, `${rel} has libraries`);
      const foreign = libs.filter((l) => !/^(\/usr\/lib\/|\/System\/Library\/)/.test(l));
      assert.deepEqual(foreign, [], `${rel} loads libraries from outside macOS: ${foreign.join(', ')}`);
    }
  });

  it('carries the encoders and filters the app uses in its FFmpeg build', () => {
    // read from the binary's own text, without running it
    const text = run('/usr/bin/strings', ['-a', join(SERVER, 'ffmpeg', 'ffmpeg')]).stdout;
    assert.match(text, /--enable-libx264/);
    assert.match(text, /--enable-gpl/);
    for (const name of ['overlay', 'rotate', 'silencedetect', 'colorchannelmixer', 'drawtext']) {
      assert.ok(new RegExp(`^${name}$`, 'm').test(text), `${name} filter`);
    }
    assert.match(text, /Compute and apply a lookup table to the RGB\/YUV input video/, 'the lut filter');
  });
});

describe('installing from the disk image', { skip }, () => {
  let mount; let work;
  before(() => {
    work = tempDir('dmg');
    mount = join(work, 'mount');
    mkdirSync(mount);
    const r = run('/usr/bin/hdiutil', ['attach', DMG, '-nobrowse', '-readonly', '-noverify', '-mountpoint', mount]);
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => {
    run('/usr/bin/hdiutil', ['detach', mount, '-force']);
    removeTree(work);
  });

  it('shows the app, a shortcut to Applications, and the instructions', () => {
    assert.ok(existsSync(join(mount, 'Akashvani Workflow.app')));
    assert.ok(lstatSync(join(mount, 'Applications')).isSymbolicLink());
    assert.equal(readlinkSync(join(mount, 'Applications')), '/Applications');
    assert.equal(readFileSync(join(mount, 'READ ME FIRST.txt'), 'utf8'), readFileSync(join(ROOT, 'installer', 'mac', 'First-run-setup-mac.txt'), 'utf8'));
  });

  it('holds the same app that is in dist-mac', () => {
    for (const rel of ['Akashvani', 'frontend/index.html', 'config.env.template']) {
      assert.equal(sha(join(mount, 'Akashvani Workflow.app', 'Contents', 'Resources', 'server', rel)), sha(join(SERVER, rel)), rel);
    }
  });

  it('stays validly signed after being dragged to another folder, and runs from there', async () => {
    const dest = join(work, 'My Apps', 'Akashvani Workflow.app');
    mkdirSync(join(work, 'My Apps'));
    execFileSync('/usr/bin/ditto', [join(mount, 'Akashvani Workflow.app'), dest]);
    const verify = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', dest]);
    assert.equal(verify.status, 0, verify.stderr);

    const app = await startApp({ binary: join(dest, 'Contents', 'Resources', 'server', 'Akashvani') });
    try {
      assert.equal((await app.json('/api/health')).status, 200);
      assert.equal((await app.get('/')).status, 200, 'the frontend is found next to the copied binary');
    } finally {
      await app.stop();
      app.cleanup();
    }
  });
});

describe('the launcher, started the way a double-click starts it', { skip: skip || (process.env.SMOKE_LAUNCHER === '1' ? false : 'opt in with SMOKE_LAUNCHER=1: it opens your real browser') }, () => {
  let proc;
  after(() => { try { proc?.kill(); } catch { /* gone */ } });

  it('starts the server, and Quit stops the server and the launcher', async () => {
    assert.deepEqual(listeners(3001), [], 'port 3001 must be free for this test');
    proc = spawn(join(APP, 'Contents', 'MacOS', 'applet'), [], { stdio: 'ignore' });
    await waitFor(async () => (await fetch('http://127.0.0.1:3001/api/health')).ok, { timeout: 30000, what: 'the launcher to start the server' });

    const servers = () => run('/usr/bin/pgrep', ['-f', 'Contents/Resources/serve[r]/Akashvani']).stdout.split('\n').filter(Boolean);
    assert.equal(servers().length, 1);

    const quit = run('/usr/bin/osascript', ['-e', `tell application "${APP}" to quit`]);
    assert.equal(quit.status, 0, quit.stderr);
    await waitFor(() => servers().length === 0 && listeners(3001).length === 0, { timeout: 15000, what: 'the server to stop' });
    await waitFor(() => proc.exitCode !== null || proc.signalCode, { timeout: 15000, what: 'the launcher to exit' });
  });
});
