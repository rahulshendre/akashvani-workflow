/**
 * The parts of the pipeline that need no Google account, run in the built app with
 * the FFmpeg it ships: upload, copy, compress with the watermark, Stop, resume.
 * Needs the app built (npm run build:mac) and ffmpeg/ffprobe on PATH to make test
 * videos and inspect the results.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { join } from 'path';
import {
  BIN, startApp, waitFor, openSse, uploadFiles, hasFfmpeg, makeVideo, probe, tempDir, removeTree, sleep,
} from './harness.mjs';

const skip = !existsSync(BIN) ? `no server binary at ${BIN}; run npm run build:mac`
  : !hasFfmpeg() ? 'ffmpeg and ffprobe must be on PATH to make test videos'
  : false;

const DONE = new Set(['backend_complete', 'pipeline_error', 'step_error', 'pipeline_stopped']);

const dataDir = (app) => join(app.home, 'Documents', 'Akashvani Workflow');
const workflow = (app, sessionId) => join(dataDir(app), 'workflows', sessionId, 'akashwani-structure');

/** Upload files, run the given steps, wait until the run ends one way or another. */
async function run(app, { sessionId, files, steps, folderName }) {
  const up = await uploadFiles(app, { sessionId, folderName: folderName ?? `Episode ${sessionId}`, files });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const sse = await openSse(app, sessionId);
  const start = await app.post('/api/pipeline/start', { sessionId, fileIds: up.body.files.map((f) => f.id), steps });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const end = await sse.waitFor((e) => DONE.has(e.event), { timeout: 120000, what: 'the run to end' });
  return { up, sse, end };
}

/** Mean absolute luma difference between two videos at one moment, from ffmpeg's own signalstats. */
function frameDiff(a, b, at = 2) {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', a, '-ss', String(at), '-i', b,
    '-lavfi', '[0:v]scale=640:360,setsar=1[a];[1:v]scale=640:360,setsar=1[b];[a][b]blend=all_mode=difference,signalstats,metadata=mode=print:file=-',
    '-frames:v', '1', '-f', 'null', '-',
  ], { encoding: 'utf8' });
  return parseFloat(/lavfi\.signalstats\.YAVG=([\d.]+)/.exec(r.stdout)?.[1]);
}

describe('uploading', { skip }, () => {
  let app; let media;
  before(async () => {
    app = await startApp();
    media = tempDir('media');
    makeVideo(join(media, 'clip.mp4'), { seconds: 2 });
    writeFileSync(join(media, 'notes.txt'), 'not a video');
  });
  after(async () => { await app?.stop(); app?.cleanup(); removeTree(media); });

  it('needs a session id', async () => {
    const res = await uploadFiles(app, { sessionId: '', files: [{ path: join(media, 'clip.mp4'), name: 'clip.mp4' }] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /sessionId/);
  });

  it('refuses a file that is not a video', async () => {
    const res = await uploadFiles(app, { sessionId: 'u-text', files: [{ path: join(media, 'notes.txt'), name: 'notes.txt', type: 'text/plain' }] });
    assert.ok(res.status >= 400, `status ${res.status}`);
    const stored = readdirSync(join(dataDir(app), 'uploads'));
    assert.ok(!stored.some((n) => n.endsWith('notes.txt')), 'nothing was kept');
  });

  it('accepts a video and names the Drive episode folder after it', async () => {
    const res = await uploadFiles(app, { sessionId: 'u-one', folderName: 'One', files: [{ path: join(media, 'clip.mp4'), name: 'My Episode 01.mp4' }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.parentName, 'My Episode 01');
    assert.equal(res.body.files[0].size, statSync(join(media, 'clip.mp4')).size);

    const session = await app.json('/api/upload/session/u-one');
    assert.equal(session.body.files.length, 1);
    assert.equal(session.body.folderName, 'One');
  });

  it('keeps the session id out of the way of other sessions', async () => {
    const none = await app.json('/api/upload/session/never-seen');
    assert.deepEqual(none.body.files, []);
  });

  it('refuses a second episode for a folder name that is already in use', async () => {
    const files = [{ path: join(media, 'clip.mp4'), name: 'a.mp4' }];
    assert.equal((await uploadFiles(app, { sessionId: 'dup-1', folderName: 'Monsoon Diaries', files })).status, 200);
    const clash = await uploadFiles(app, { sessionId: 'dup-2', folderName: ' monsoon diaries ', files });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.duplicateFolder, true);
    assert.equal(clash.body.existing.sessionId, 'dup-1');
    // the same session adding more files is not a clash
    assert.equal((await uploadFiles(app, { sessionId: 'dup-1', folderName: 'Monsoon Diaries', files })).status, 200);
  });

  it('treats a folder name typed with composed and decomposed accents as the same name', async () => {
    // macOS often hands back the decomposed form of an accented letter ("e" + a combining accent).
    const composed = 'Café Nights';
    const decomposed = 'Café Nights';
    assert.notEqual(composed, decomposed);
    const files = [{ path: join(media, 'clip.mp4'), name: 'a.mp4' }];
    assert.equal((await uploadFiles(app, { sessionId: 'nfc-1', folderName: composed, files })).status, 200);
    const clash = await uploadFiles(app, { sessionId: 'nfc-2', folderName: decomposed, files });
    assert.equal(clash.status, 409, 'the same name in a different Unicode form is still a duplicate');
  });
});

describe('copy and compress', { skip }, () => {
  let app; let media;
  before(async () => {
    app = await startApp();
    media = tempDir('media');
    makeVideo(join(media, 'clip.mp4'), { seconds: 6 });
  });
  after(async () => { await app?.stop(); app?.cleanup(); removeTree(media); });

  it('copies the footage, compresses it with the shipped FFmpeg, and burns in the bundled watermark', async () => {
    const source = join(media, 'clip.mp4');
    const { sse, end } = await run(app, { sessionId: 'c-basic', steps: ['copy', 'compress'], files: [{ path: source, name: 'clip.mp4' }] });
    assert.equal(end.event, 'backend_complete', JSON.stringify(end.data));

    const steps = sse.of('step_complete').map((e) => e.data.stepId);
    assert.deepEqual(steps, ['copy', 'compress']);

    const raw = join(workflow(app, 'c-basic'), 'raw footage', 'clip.mp4');
    const out = join(workflow(app, 'c-basic'), 'source file', 'clip_compressed.mp4');
    assert.equal(statSync(raw).size, statSync(source).size, 'raw footage is an exact copy');
    assert.ok(statSync(out).size > 10_000);

    const info = probe(out);
    assert.equal(info.video.codec, 'h264');
    assert.equal(info.video.profile, 'High');
    assert.equal(info.video.width, 1280);
    assert.equal(info.video.height, 720);
    assert.equal(info.video.fps, '24/1');
    assert.equal(info.audio.codec, 'aac');
    assert.ok(Math.abs(info.duration - 6) < 0.3, `duration ${info.duration}`);

    const logs = sse.logs('compress').join('\n');
    assert.match(logs, /Using bundled watermark: .*\/server\/resources\/watermark\.png/);
    assert.match(logs, /Watermark: image-as-is@1\.50/);
    assert.match(logs, /Source : 1280×720 @ 24\.00 fps, 6 s/, 'the bundled ffprobe read the clip');

    // The watermark is really in the picture: the output differs from the source by clearly more
    // than a plain re-encode at the same bitrate does.
    const control = join(media, 'control.mp4');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', source, '-c:v', 'libx264', '-b:v', '3000k', '-an', control]);
    const noise = frameDiff(source, control);
    const marked = frameDiff(source, out);
    assert.ok(marked > noise * 1.5 + 0.3, `watermark difference ${marked} should clearly exceed plain re-encode noise ${noise}`);

    const state = await app.json('/api/pipeline/state/c-basic');
    assert.equal(state.body.stepStates.copy, 'complete');
    assert.equal(state.body.stepStates.compress, 'complete');
  });

  it('reports progress that reaches 100 for each step', async () => {
    const { sse } = await run(app, { sessionId: 'c-progress', steps: ['copy', 'compress'], files: [{ path: join(media, 'clip.mp4'), name: 'clip.mp4' }] });
    for (const stepId of ['copy', 'compress']) {
      const seen = sse.of('progress').filter((e) => e.data.stepId === stepId).map((e) => e.data.progress);
      assert.ok(seen.length > 0, `${stepId} reported progress`);
      // copy reports 100; compress stops at 99 and the step_complete event is what finishes the bar
      assert.equal(Math.max(...seen), stepId === 'copy' ? 100 : 99, `${stepId} reached its last value`);
      assert.deepEqual([...seen].sort((a, b) => a - b), seen, `${stepId} never went backwards`);
    }
  });

  it('handles several files in one episode', async () => {
    const a = join(media, 'one.mp4'); const b = join(media, 'two.mp4');
    makeVideo(a, { seconds: 2 }); makeVideo(b, { seconds: 3 });
    const { end } = await run(app, { sessionId: 'c-multi', steps: ['copy', 'compress'], files: [{ path: a, name: 'one.mp4' }, { path: b, name: 'two.mp4' }] });
    assert.equal(end.event, 'backend_complete');
    const out = readdirSync(join(workflow(app, 'c-multi'), 'source file')).sort();
    assert.deepEqual(out, ['one_compressed.mp4', 'two_compressed.mp4']);
    assert.ok(Math.abs(probe(join(workflow(app, 'c-multi'), 'source file', 'two_compressed.mp4')).duration - 3) < 0.3);
  });

  it('copes with names a Mac editor will really have: spaces, quotes, # and &, accents, Hindi', async () => {
    const names = ["Ep 01 (final) #2 & more's.mp4", 'Café.mp4', 'नमस्ते दुनिया.mp4', '日本語.mp4'];
    const src = join(media, 'names.mp4');
    makeVideo(src, { seconds: 2 });
    const { end, sse } = await run(app, { sessionId: 'c-names', steps: ['copy', 'compress'], files: names.map((name) => ({ path: src, name })) });
    assert.equal(end.event, 'backend_complete', JSON.stringify(end.data) + sse.logs().join('\n'));
    const out = readdirSync(join(workflow(app, 'c-names'), 'source file'));
    assert.equal(out.length, names.length);
    for (const name of names) {
      assert.ok(out.some((o) => o.normalize('NFC') === name.replace(/\.mp4$/, '_compressed.mp4').normalize('NFC')), `${name} -> ${out.join(' | ')}`);
    }
    for (const o of out) assert.equal(probe(join(workflow(app, 'c-names'), 'source file', o)).video.codec, 'h264', o);
  });

  it('handles other shapes and containers: 1080p, portrait, no audio, .mov, .mkv', async () => {
    const cases = [
      { name: 'wide.mp4', opts: { seconds: 2, size: '1920x1080' }, expect: { width: 1920, height: 1080 } },
      { name: 'tall.mp4', opts: { seconds: 2, size: '720x1280' }, expect: { width: 720, height: 1280 } },
    ];
    const files = [];
    for (const c of cases) { makeVideo(join(media, c.name), c.opts); files.push({ path: join(media, c.name), name: c.name }); }

    const silent = join(media, 'silent.mp4');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=640x360:rate=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
    files.push({ path: silent, name: 'silent.mp4' });
    for (const ext of ['mov', 'mkv']) {
      const p = join(media, `box.${ext}`);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(media, 'wide.mp4'), '-c', 'copy', p]);
      files.push({ path: p, name: `box.${ext}`, type: ext === 'mov' ? 'video/quicktime' : 'video/x-matroska' });
    }

    const { end, sse } = await run(app, { sessionId: 'c-shapes', steps: ['copy', 'compress'], files });
    assert.equal(end.event, 'backend_complete', JSON.stringify(end.data) + sse.logs().join('\n'));
    const dir = join(workflow(app, 'c-shapes'), 'source file');
    for (const c of cases) {
      const info = probe(join(dir, c.name.replace('.mp4', '_compressed.mp4')));
      assert.equal(info.video.width, c.expect.width, c.name);
      assert.equal(info.video.height, c.expect.height, c.name);
    }
    assert.equal(probe(join(dir, 'silent_compressed.mp4')).audio, undefined, 'a silent video stays silent');
    for (const f of ['box_compressed.mov', 'box_compressed.mkv']) assert.equal(probe(join(dir, f)).video.codec, 'h264', f);
  });

  it('reports a file that is not really a video, and keeps working afterwards', async () => {
    const bad = join(media, 'broken.mp4');
    writeFileSync(bad, Buffer.from('this is not a video at all'.repeat(100)));
    const { end } = await run(app, { sessionId: 'c-bad', steps: ['copy', 'compress'], files: [{ path: bad, name: 'broken.mp4' }] });
    assert.ok(['step_error', 'pipeline_error'].includes(end.event), `got ${end.event}`);
    assert.equal((await app.json('/api/health')).status, 200, 'the app is still up');

    const good = await run(app, { sessionId: 'c-after-bad', steps: ['copy', 'compress'], files: [{ path: join(media, 'clip.mp4'), name: 'clip.mp4' }] });
    assert.equal(good.end.event, 'backend_complete');
  });

  it('runs only the steps that were chosen', async () => {
    const { sse, end } = await run(app, { sessionId: 'c-copy-only', steps: ['copy'], files: [{ path: join(media, 'clip.mp4'), name: 'clip.mp4' }] });
    assert.equal(end.event, 'backend_complete');
    assert.deepEqual(sse.of('step_complete').map((e) => e.data.stepId), ['copy']);
    assert.ok(!existsSync(join(workflow(app, 'c-copy-only'), 'source file', 'clip_compressed.mp4')));
  });

  it('will not start without an event stream or without valid files', async () => {
    const noStream = await app.post('/api/pipeline/start', { sessionId: 'nobody-listening', fileIds: ['x'] });
    assert.equal(noStream.status, 400);
    assert.match(noStream.body.error, /events/);

    const sse = await openSse(app, 'no-files');
    const noFiles = await app.post('/api/pipeline/start', { sessionId: 'no-files', fileIds: ['nope'] });
    sse.close();
    assert.equal(noFiles.status, 400);
    assert.match(noFiles.body.error, /No valid files/);

    assert.equal((await app.post('/api/pipeline/start', {})).status, 400);
  });
});

describe('episode list and resume', { skip }, () => {
  let app; let media; const retired = [];
  before(async () => {
    app = await startApp();
    media = tempDir('media');
    makeVideo(join(media, 'clip.mp4'), { seconds: 2 });
  });
  after(async () => {
    await app?.stop();
    app?.cleanup();
    for (const old of retired) old.cleanup();
    removeTree(media);
  });

  it('lists an episode with its progress, and still has it after the app is closed and opened again', async () => {
    const { end } = await run(app, { sessionId: 'r-one', folderName: 'Resume Me', steps: ['copy', 'compress'], files: [{ path: join(media, 'clip.mp4'), name: 'clip.mp4' }] });
    assert.equal(end.event, 'backend_complete');

    const list = await app.json('/api/pipeline/sessions');
    const row = list.body.sessions.find((s) => s.sessionId === 'r-one');
    assert.equal(row.folderName, 'Resume Me');
    assert.equal(row.stepStates.compress, 'complete');

    // close the app and open it again on the same data; the later tests carry on with the new copy
    const closed = app;
    await closed.stop();
    retired.push(closed);
    app = await startApp({ home: closed.home, port: closed.port });

    const state = await app.json('/api/pipeline/state/r-one');
    assert.equal(state.body.stepStates.copy, 'complete');
    assert.equal(state.body.stepStates.compress, 'complete');
    assert.equal(state.body.folderName, 'Resume Me');
    assert.equal(state.body.parentName, 'clip');
    assert.deepEqual(state.body.selectedSteps, ['copy', 'compress']);
  });

  it('records a step the browser finished, and rejects a request that does not say which', async () => {
    const ok = await app.post('/api/pipeline/complete-step', { sessionId: 'r-one', stepId: 'final-qc' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.stepStates['final-qc'], 'complete');
    assert.equal((await app.post('/api/pipeline/complete-step', { sessionId: 'r-one' })).status, 400);
    assert.equal((await app.post('/api/pipeline/complete-step', { stepId: 'x' })).status, 400);
  });

  it('hides a deleted episode from the list but keeps its video on disk', async () => {
    const del = await app.json('/api/pipeline/session/r-one', { method: 'DELETE' });
    assert.equal(del.status, 200);
    const list = await app.json('/api/pipeline/sessions');
    assert.ok(!list.body.sessions.some((s) => s.sessionId === 'r-one'));
    assert.ok(existsSync(join(workflow(app, 'r-one'), 'source file', 'clip_compressed.mp4')), 'the footage is still there');
  });

  it('gives an empty state, not an error, for an episode it has never seen', async () => {
    const res = await app.json('/api/pipeline/state/never-existed');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stepStates, {});
  });
});

describe('Stop', { skip }, () => {
  let app; let media;
  before(async () => {
    // a slow preset makes a short clip take long enough to stop part way
    app = await startApp({ env: { X264_PRESET: 'veryslow' } });
    media = tempDir('media');
    makeVideo(join(media, 'long.mp4'), { seconds: 40, size: '1920x1080' });
  });
  after(async () => { await app?.stop(); app?.cleanup(); removeTree(media); });

  const encoders = () => spawnSync('/usr/bin/pgrep', ['-f', `${app.serverDir}/ffmpeg/ffmpeg`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

  it('ends an encode that is under way, leaves no FFmpeg behind, and allows a fresh run', async () => {
    const sessionId = 'stop-1';
    const up = await uploadFiles(app, { sessionId, folderName: 'Stop Me', files: [{ path: join(media, 'long.mp4'), name: 'long.mp4' }] });
    const sse = await openSse(app, sessionId);
    await app.post('/api/pipeline/start', { sessionId, fileIds: up.body.files.map((f) => f.id), steps: ['copy', 'compress'] });

    await sse.waitFor((e) => e.event === 'log' && /Encoding at/.test(e.data.message), { timeout: 60000, what: 'the encode to start' });
    await waitFor(() => encoders().length > 0, { timeout: 10000, what: 'an FFmpeg process' });
    await sleep(1000);
    const stop = await app.post('/api/pipeline/stop', { sessionId });
    assert.equal(stop.status, 200);
    assert.ok(stop.body.encodesKilled >= 1, `killed ${stop.body.encodesKilled}`);

    await sse.waitFor((e) => e.event === 'pipeline_stopped', { what: 'pipeline_stopped' });
    await waitFor(() => encoders().length === 0, { timeout: 10000, what: 'FFmpeg to be gone' });

    const state = await app.json(`/api/pipeline/state/${sessionId}`);
    assert.equal(state.body.stepStates.copy, 'complete', 'finished work is kept');
    assert.notEqual(state.body.stepStates.compress, 'complete', 'the stopped step is not marked done');
    assert.ok(!sse.of('step_complete').some((e) => e.data.stepId === 'compress'));
    const sourceDir = join(workflow(app, sessionId), 'source file');
    const left = existsSync(sourceDir) ? readdirSync(sourceDir) : [];
    assert.deepEqual(left, [], `a stopped encode leaves nothing half-written behind, found: ${left.join(', ')}`);
    sse.close();
  });

  it('refuses a stop request that names no session', async () => {
    assert.equal((await app.post('/api/pipeline/stop', {})).status, 400);
  });
});

describe('two-pass encoding', { skip }, () => {
  let app; let media;
  before(async () => {
    app = await startApp({ env: { ENCODE_MODE: '2pass' } });
    media = tempDir('media');
    makeVideo(join(media, 'clip.mp4'), { seconds: 4 });
  });
  after(async () => { await app?.stop(); app?.cleanup(); removeTree(media); });

  it('runs both passes against the null device and leaves no pass logs behind', async () => {
    const { sse, end } = await run(app, { sessionId: 'p-two', steps: ['copy', 'compress'], files: [{ path: join(media, 'clip.mp4'), name: 'clip.mp4' }] });
    assert.equal(end.event, 'backend_complete', JSON.stringify(end.data) + sse.logs().join('\n'));
    const logs = sse.logs('compress').join('\n');
    assert.match(logs, /Pass 1\/2/);
    assert.match(logs, /Pass 2\/2/);
    const dir = join(workflow(app, 'p-two'), 'source file');
    assert.deepEqual(readdirSync(dir).sort(), ['clip_compressed.mp4'], 'no .passlog files are left');
    assert.equal(probe(join(dir, 'clip_compressed.mp4')).video.codec, 'h264');
    assert.ok(!readdirSync(app.root).some((n) => n.startsWith('ffmpeg2pass')), 'no stray pass files in the working folder');
  });
});

describe('watermark choices', { skip }, () => {
  let media;
  before(() => { media = tempDir('media'); makeVideo(join(media, 'clip.mp4'), { seconds: 3 }); });
  after(() => removeTree(media));

  it('uses a watermark image from WATERMARK_FILE_PATH, including a path with spaces and quotes around it', async () => {
    const dir = tempDir('wm');
    const png = join(dir, 'my mark.png');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red@0.8:s=300x120,format=rgba', '-frames:v', '1', png]);
    const app = await startApp({ env: { WATERMARK_FILE_PATH: `"${png}"`, WATERMARK_OPACITY: '1' } });
    try {
      const { sse, end } = await run(app, { sessionId: 'w-file', steps: ['copy', 'compress'], files: [{ path: join(media, 'clip.mp4'), name: 'clip.mp4' }] });
      assert.equal(end.event, 'backend_complete', sse.logs().join('\n'));
      assert.match(sse.logs('compress').join('\n'), new RegExp(`Using watermark override: ${png.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    } finally {
      await app.stop(); app.cleanup(); removeTree(dir);
    }
  });

  it('falls back to the bundled watermark when the override file is missing', async () => {
    const app = await startApp({ env: { WATERMARK_FILE_PATH: '/no/such/watermark.png' } });
    try {
      const { sse, end } = await run(app, { sessionId: 'w-missing', steps: ['copy', 'compress'], files: [{ path: join(media, 'clip.mp4'), name: 'clip.mp4' }] });
      assert.equal(end.event, 'backend_complete');
      assert.match(sse.logs('compress').join('\n'), /not found — using bundled watermark/);
    } finally {
      await app.stop(); app.cleanup();
    }
  });

  it('draws the text watermark when there is no image at all', async () => {
    // a copy of the app folder without the watermark image, so the text fallback is the only option
    const { copyServerDir } = await import('./harness.mjs');
    const copy = copyServerDir('no-watermark');
    execFileSync('/bin/rm', ['-rf', join(copy.dir, 'resources')]);
    const app = await startApp({ binary: copy.binary });
    try {
      const { sse, end } = await run(app, { sessionId: 'w-text', steps: ['copy', 'compress'], files: [{ path: join(media, 'clip.mp4'), name: 'clip.mp4' }] });
      const logs = sse.logs('compress').join('\n');
      assert.match(logs, /No image watermark available — text-only watermark/);
      assert.equal(end.event, 'backend_complete', `${JSON.stringify(end.data)}\n${logs}`);
      assert.match(logs, /Watermark: text-diagonal/);
    } finally {
      await app.stop(); app.cleanup(); removeTree(join(copy.dir, '..'));
    }
  });
});
