/**
 * The built app starting up on a Mac, the first-run storage choice, and how it
 * finds its files. Needs the app built first: npm run build:mac
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync, chmodSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  BIN, startApp, waitFor, listeners, copyServerDir, removeTree, sarvamKey,
} from './harness.mjs';

const built = existsSync(BIN);
const skip = built ? false : `no server binary at ${BIN}; run npm run build:mac`;

describe('first launch', { skip }, () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app?.stop(); app?.cleanup(); });

  it('answers the health check', async () => {
    const { status, body } = await app.json('/api/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  it('asks macOS to open the browser at its own address', async () => {
    await waitFor(() => app.openCalls().length > 0, { what: 'the open call' });
    assert.deepEqual(app.openCalls(), [`http://localhost:${app.port}`]);
  });

  it('keeps settings in Application Support, logs in Library/Logs, and work in Documents', () => {
    assert.ok(existsSync(app.configEnv), 'config.env is in Application Support');
    assert.ok(existsSync(app.logFile), 'the log is in ~/Library/Logs/Akashvani Workflow');
    assert.match(app.appLog(), /Akashvani starting/);
    const work = join(app.home, 'Documents', 'Akashvani Workflow');
    for (const sub of ['uploads', 'workflows', 'system-intake']) assert.ok(existsSync(join(work, sub)), `${sub} exists`);
  });

  it('keeps config.env readable by the signed-in user only', () => {
    assert.equal(statSync(app.configEnv).mode & 0o077, 0);
  });

  it('reports a first run and where work will go by default', async () => {
    const { body } = await app.json('/api/setup/status');
    assert.equal(body.isFirstRun, true);
    assert.equal(body.currentDataDir, join(app.home, 'Documents', 'Akashvani Workflow'));
  });

  it('writes the real log location in its startup banner', () => {
    assert.ok(app.stdout().includes(join(app.home, 'Library', 'Logs', 'Akashvani Workflow', 'akashvani.log')));
  });

  it('serves the built frontend, and the app shell for client-side routes', async () => {
    const root = await app.get('/');
    assert.equal(root.status, 200);
    const html = await root.text();
    assert.match(html, /<div id="root">/);

    for (const route of ['/drive-setup', '/pipeline', '/join', '/no-such-page']) {
      const res = await app.get(route);
      assert.equal(res.status, 200, route);
      assert.match(await res.text(), /<div id="root">/, route);
    }

    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    assert.ok(script, 'index.html references its script');
    const asset = await app.get(script);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
  });

  it('answers an unknown API path with 404, not the app shell', async () => {
    const res = await app.get('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /<div id="root">/);
  });

  it('offers the home folder as a storage choice, with no drive letters', async () => {
    const { body } = await app.json('/api/setup/drives');
    assert.ok(body.drives.length >= 1);
    const [home] = body.drives;
    assert.equal(home.name, 'Home folder');
    assert.equal(home.root, app.home);
    assert.equal(home.suggestedPath, join(app.home, 'Documents', 'Akashvani Workflow'));
    assert.equal(home.letter, undefined);
    assert.ok(home.total > 0 && home.free >= 0 && home.used === home.total - home.free);
    assert.ok(body.drives.every((d) => !/^[A-Z]:\\/.test(d.root)), 'no Windows-style roots');
  });

  it('serves the log and its location', async () => {
    const info = await app.json('/api/pipeline/log-info');
    assert.equal(info.body.appLog, app.logFile);
    const log = await (await app.get('/api/pipeline/log?lines=50')).text();
    assert.match(log, /^# Akashvani log/);
    assert.ok(log.includes('Akashvani starting'));
  });

  it('starts with no episodes', async () => {
    const { body } = await app.json('/api/pipeline/sessions');
    assert.deepEqual(body.sessions, []);
  });
});

describe('first-run storage choice', { skip }, () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app?.stop(); app?.cleanup(); });

  it('refuses a request with no usable path', async () => {
    for (const body of [{}, { basePath: '' }, { basePath: '   ' }, { basePath: 42 }]) {
      const res = await app.post('/api/setup/configure', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const { body } = await app.json('/api/setup/status');
    assert.equal(body.isFirstRun, true, 'still first run');
  });

  it('reports a folder it cannot create, and keeps running', async () => {
    const res = await app.post('/api/setup/configure', { basePath: '/System/Akashvani Workflow' });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /Failed to create directory/);
    const { body } = await app.json('/api/setup/status');
    assert.equal(body.isFirstRun, true);
  });

  it('saves a path with spaces and non-Latin letters, restarts itself, and remembers it', async () => {
    const chosen = join(app.home, 'फुटेज डिस्क', 'Akashvani Workflow');
    const before = listeners(app.port);
    assert.equal(before.length, 1);

    const res = await app.post('/api/setup/configure', { basePath: chosen });
    assert.equal(res.status, 200);
    assert.equal(res.body.dataDir, chosen);

    // The page polls /api/health until the new copy answers, so the same must work here.
    await waitFor(() => {
      const now = listeners(app.port);
      return now.length === 1 && now[0] !== before[0];
    }, { timeout: 20000, what: 'a new process on the same port' });
    await waitFor(async () => (await fetch(app.url + '/api/health')).ok, { what: 'the restarted app' });

    const { body } = await app.json('/api/setup/status');
    assert.equal(body.isFirstRun, false);
    assert.equal(body.currentDataDir, chosen);
    for (const sub of ['uploads', 'workflows', 'system-intake']) assert.ok(existsSync(join(chosen, sub)), sub);
    assert.equal(readFileSync(join(app.supportDir, 'user-data-path.txt'), 'utf8'), chosen);
    assert.doesNotMatch(app.appLog(), /already in use/, 'the new copy did not lose the race for the port');
  });

  it('keeps the choice after a full stop and start', async () => {
    const chosen = join(app.home, 'फुटेज डिस्क', 'Akashvani Workflow');
    await app.stop();
    const again = await startApp({ home: app.home, port: app.port });
    try {
      const { body } = await again.json('/api/setup/status');
      assert.equal(body.isFirstRun, false);
      assert.equal(body.currentDataDir, chosen);
    } finally {
      await again.stop();
      again.cleanup();
    }
  });
});

describe('two copies at once', { skip }, () => {
  it('leaves the running one alone and says why the second one stopped', async () => {
    const first = await startApp();
    const second = await startApp({ port: first.port, expectBoot: false });
    try {
      await waitFor(() => second.exited, { what: 'the second copy to exit' });
      assert.equal(second.exited.code, 1);
      assert.match(second.appLog(), /already in use/);
      const { status } = await first.json('/api/health');
      assert.equal(status, 200);
    } finally {
      await first.stop();
      first.cleanup();
      second.cleanup();
    }
  });
});

describe('settings shipped inside the app', { skip }, () => {
  let copy;
  before(() => { copy = copyServerDir('seed'); });
  after(() => removeTree(join(copy.dir, '..')));

  it('creates config.env from the template and fills the baked-in keys', async () => {
    writeFileSync(join(copy.dir, 'config.defaults.env'), 'SARVAM_API_KEY=baked-sarvam-key\nGOOGLE_CLIENT_ID=baked-client-id\n');
    const app = await startApp({ binary: copy.binary });
    try {
      const text = readFileSync(app.configEnv, 'utf8');
      assert.match(text, /^SARVAM_API_KEY=baked-sarvam-key$/m);
      assert.match(text, /^GOOGLE_CLIENT_ID=baked-client-id$/m);
      assert.match(text, /^PORT=3001$/m, 'the rest of the template is there');
      const status = await app.json('/api/pipeline/transcribe-status');
      assert.equal(status.body.configured, true, 'the app uses the baked-in key');
      const auth = await app.json('/api/auth/status');
      assert.equal(auth.body.configured, false, 'a client id alone is not enough for Drive');
    } finally {
      await app.stop();
      app.cleanup();
    }
  });

  it('on a later launch fills only blanks and never overwrites what was typed', async () => {
    const home = join(copy.dir, '..', 'home');
    writeFileSync(join(copy.dir, 'config.defaults.env'), 'SARVAM_API_KEY=baked-sarvam-key\nGOOGLE_CLIENT_SECRET=baked-secret\n');
    const first = await startApp({ binary: copy.binary, home });
    const typed = readFileSync(first.configEnv, 'utf8')
      .replace(/^SARVAM_API_KEY=.*$/m, 'SARVAM_API_KEY=typed-by-hand')
      .replace(/^GOOGLE_CLIENT_SECRET=.*$/m, 'GOOGLE_CLIENT_SECRET=');
    await first.stop();
    writeFileSync(first.configEnv, typed);

    const second = await startApp({ binary: copy.binary, home });
    try {
      const text = readFileSync(second.configEnv, 'utf8');
      assert.match(text, /^SARVAM_API_KEY=typed-by-hand$/m, 'a typed value is kept');
      assert.match(text, /^GOOGLE_CLIENT_SECRET=baked-secret$/m, 'a blank is filled');
    } finally {
      await second.stop();
      second.cleanup();
    }
  });

  it('runs from a read-only app folder, as it does when macOS runs it from a download', async () => {
    const ro = copyServerDir('readonly');
    const before = readdirSync(ro.dir).sort();
    chmodSync(ro.dir, 0o555);
    const app = await startApp({ binary: ro.binary });
    try {
      assert.equal((await app.json('/api/health')).status, 200);
      assert.ok(existsSync(app.configEnv));
      assert.ok(existsSync(app.logFile));
      chmodSync(ro.dir, 0o755);
      assert.deepEqual(readdirSync(ro.dir).sort(), before, 'nothing was written into the app folder');
    } finally {
      await app.stop();
      app.cleanup();
      removeTree(join(ro.dir, '..'));
    }
  });
});

describe('Sarvam key availability', { skip }, () => {
  it('has no key unless one is configured', async () => {
    const app = await startApp();
    try {
      const { body } = await app.json('/api/pipeline/transcribe-status');
      assert.equal(body.configured, false);
      assert.equal(body.model, 'saaras:v3');
    } finally {
      await app.stop();
      app.cleanup();
    }
  });

  it('picks up SARVAM_API_KEY from the environment or config.env', { skip: sarvamKey() ? false : 'no key in server/.env' }, async () => {
    const app = await startApp({ env: { SARVAM_API_KEY: sarvamKey() } });
    try {
      const { body } = await app.json('/api/pipeline/transcribe-status');
      assert.equal(body.configured, true);
    } finally {
      await app.stop();
      app.cleanup();
    }
  });
});
