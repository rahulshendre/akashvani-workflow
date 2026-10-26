/**
 * Helpers for the smoke tests that run the BUILT app (the pkg binary inside the
 * .app, or any other Akashvani server binary) the way an editor would, with a
 * throwaway home folder so nothing touches the real one.
 *
 *   node --test --test-concurrency=1 scripts/smoke/
 *   AKASHVANI_BIN=/path/to/Akashvani node --test --test-concurrency=1 scripts/smoke/
 *
 * The app is started with a minimal environment of its own: no Homebrew on PATH
 * (so it can only use the FFmpeg it ships with), no inherited API keys, and a stub
 * `open` so the browser is not launched. The tests themselves use the FFmpeg on
 * your PATH only to make test videos and to inspect outputs.
 */

import { spawn, execFileSync, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, rmSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..', '..');
export const DEFAULT_BIN = join(ROOT, 'dist-mac', 'Akashvani Workflow.app', 'Contents', 'Resources', 'server', 'Akashvani');
export const BIN = process.env.AKASHVANI_BIN || DEFAULT_BIN;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 15000, interval = 150, what = 'condition' } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`timed out after ${timeout} ms waiting for ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export function which(cmd) {
  const r = spawnSync('/usr/bin/which', [cmd], { encoding: 'utf8', env: process.env });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** PIDs listening on a TCP port (empty when nothing is). */
export function listeners(port) {
  const r = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean).map(Number);
}

/**
 * Start the server binary. Resolves once /api/health answers.
 *
 *   home    - becomes the app's HOME. A fresh temp folder by default.
 *   port    - PORT for the app. A free port by default.
 *   env     - extra environment variables.
 *   binary  - which executable to run.
 */
export async function startApp({ home, port, env = {}, binary, defaults = '', expectBoot = true } = {}) {
  if (!existsSync(BIN) && !binary) throw new Error(`no server binary at ${BIN}. Build it first (npm run build:mac).`);
  const root = mkdtempSync(join(tmpdir(), 'akashvani-smoke-'));
  // By default run from a clone of the app's server folder with its own (by default empty)
  // config.defaults.env, so a key baked into the build never leaks into a test.
  let clone = null;
  if (!binary) {
    clone = copyServerDir('run');
    writeFileSync(join(clone.dir, 'config.defaults.env'), defaults);
    binary = clone.binary;
  }
  home ??= join(root, 'home');
  mkdirSync(join(home, 'Documents'), { recursive: true });
  port ??= await freePort();

  const stub = join(root, 'bin');
  mkdirSync(stub, { recursive: true });
  const openLog = join(root, 'open-calls.txt');
  writeFileSync(join(stub, 'open'), `#!/bin/sh\necho "$@" >> '${openLog}'\n`);
  chmodSync(join(stub, 'open'), 0o755);

  const outFile = join(root, 'server.out');
  const out = openSync(outFile, 'a');
  const proc = spawn(binary, [], {
    cwd: root,
    env: {
      HOME: home,
      PATH: `${stub}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: 'en_US.UTF-8',
      TMPDIR: process.env.TMPDIR || '/tmp',
      PORT: String(port),
      ...env,
    },
    stdio: ['ignore', out, out],
  });
  let exited = null;
  proc.on('exit', (code, signal) => { exited = { code, signal }; });

  const app = {
    root, home, port, proc, outFile, serverDir: clone?.dir ?? dirname(binary),
    url: `http://127.0.0.1:${port}`,
    get exited() { return exited; },
    openCalls: () => (existsSync(openLog) ? readFileSync(openLog, 'utf8').split('\n').filter(Boolean) : []),
    stdout: () => readFileSync(outFile, 'utf8'),
    logFile: join(home, 'Library', 'Logs', 'Akashvani Workflow', 'akashvani.log'),
    appLog: () => (existsSync(join(home, 'Library', 'Logs', 'Akashvani Workflow', 'akashvani.log'))
      ? readFileSync(join(home, 'Library', 'Logs', 'Akashvani Workflow', 'akashvani.log'), 'utf8') : ''),
    supportDir: join(home, 'Library', 'Application Support', 'Akashvani Workflow'),
    configEnv: join(home, 'Library', 'Application Support', 'Akashvani Workflow', 'config.env'),
    async stop() {
      for (const pid of listeners(port)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      try { proc.kill('SIGTERM'); } catch { /* gone */ }
      await waitFor(() => listeners(port).length === 0, { timeout: 8000, what: 'the server to stop' }).catch(() => {
        for (const pid of listeners(port)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      });
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      if (clone) removeTree(dirname(clone.dir));
    },
    get: (path, init) => fetch(app.url + path, init),
    async json(path, init) {
      const res = await fetch(app.url + path, init);
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      return { status: res.status, body, headers: res.headers };
    },
    post(path, body) {
      return app.json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    },
  };

  if (expectBoot) {
    try {
      await waitFor(async () => (await fetch(app.url + '/api/health')).ok, { timeout: 20000, what: 'the server to answer /api/health' });
    } catch (err) {
      await app.stop();
      throw new Error(`${err.message}\n--- server output ---\n${app.stdout()}\n--- app log ---\n${app.appLog()}`);
    }
  }
  return app;
}

/** Listen to a session's server-sent events. */
export async function openSse(app, sessionId) {
  const events = [];
  const controller = new AbortController();
  const res = await fetch(`${app.url}/api/pipeline/events?sessionId=${encodeURIComponent(sessionId)}`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at;
        while ((at = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event) events.push({ event, data: data ? JSON.parse(data) : null });
        }
      }
    } catch { /* aborted */ }
  })();
  return {
    events,
    of: (name) => events.filter((e) => e.event === name),
    logs: (stepId) => events.filter((e) => e.event === 'log' && (!stepId || e.data.stepId === stepId)).map((e) => e.data.message),
    waitFor: (predicate, opts) => waitFor(() => events.find(predicate), { what: 'an event', ...opts }),
    close: () => controller.abort(),
  };
}

/** POST /api/upload with real files. */
export async function uploadFiles(app, { sessionId, folderName = 'Smoke Episode', episodeCount = 1, files }) {
  const form = new FormData();
  form.set('sessionId', sessionId);
  form.set('folderName', folderName);
  form.set('episodeCount', String(episodeCount));
  for (const f of files) {
    const bytes = readFileSync(f.path);
    form.append('files', new Blob([bytes], { type: f.type || 'video/mp4' }), f.name);
    form.append('relativePaths', `${folderName}/${f.name}`);
  }
  return app.json('/api/upload', { method: 'POST', body: form });
}

/** POST a multipart form with one file field plus text fields. */
export async function postFile(app, path, { field, file, name, type = 'application/octet-stream', fields = {} }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.append(field, new Blob([typeof file === 'string' ? readFileSync(file) : file], { type }), name);
  return app.json(path, { method: 'POST', body: form });
}

export const hasFfmpeg = () => !!which('ffmpeg');

/** A test video made with the FFmpeg on PATH (not the app's own). */
export function makeVideo(path, { seconds = 6, size = '1280x720', fps = 24 } = {}) {
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=duration=${seconds}:size=${size}:rate=${fps}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path,
  ]);
  return path;
}

/** Facts about a media file, read with the ffprobe on PATH. */
export function probe(path) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { encoding: 'utf8' });
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return {
    duration: parseFloat(j.format.duration),
    video: v && { codec: v.codec_name, profile: v.profile, width: v.width, height: v.height, fps: v.r_frame_rate },
    audio: a && { codec: a.codec_name },
  };
}

/** A video whose audio is speech, made with the macOS `say` command. */
export function makeSpeechVideo(path, { text, voice = 'Lekha' }) {
  const dir = mkdtempSync(join(tmpdir(), 'akashvani-say-'));
  const aiff = join(dir, 'speech.aiff');
  execFileSync('/usr/bin/say', ['-v', voice, '-o', aiff, text]);
  const seconds = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', aiff], { encoding: 'utf8' })) + 0.5;
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=0x203040:s=640x360:d=${seconds.toFixed(2)}:r=24`,
    '-i', aiff,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path,
  ]);
  rmSync(dir, { recursive: true, force: true });
  return { path, seconds };
}

/** The Sarvam key from server/.env, if there is one. Never printed. */
export function sarvamKey() {
  const file = join(ROOT, 'server', '.env');
  if (!existsSync(file)) return null;
  const m = /^SARVAM_API_KEY\s*=\s*['"]?([^'"\r\n]+)['"]?\s*$/m.exec(readFileSync(file, 'utf8'));
  return m ? m[1].trim() : null;
}

export function tempDir(label = 'smoke') {
  return mkdtempSync(join(tmpdir(), `akashvani-${label}-`));
}

/** A copy of the folder the binary lives in (frontend, ffmpeg, config files), made with APFS clones so it costs no disk. */
export function copyServerDir(label = 'server-copy') {
  const dest = join(tempDir(label), 'server');
  execFileSync('/bin/cp', ['-Rc', dirname(BIN), dest]);
  return { dir: dest, binary: join(dest, 'Akashvani') };
}

export function removeTree(path) {
  spawnSync('/bin/chmod', ['-R', 'u+w', path]);
  rmSync(path, { recursive: true, force: true });
}
