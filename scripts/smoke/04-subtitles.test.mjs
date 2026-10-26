/**
 * Automatic subtitles in the built app: the shipped FFmpeg cuts the audio at the
 * pauses, each phrase goes to the real Sarvam API, and the .srt and Word files are
 * filed locally and on (fake) Drive.
 *
 * Needs: the built app, ffmpeg/ffprobe on PATH, the macOS `say` command with a Hindi
 * voice, and SARVAM_API_KEY in server/.env. This spends a little Sarvam credit
 * (a few short clips). Without the key the Sarvam tests are skipped.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { join } from 'path';
import {
  BIN, startApp, freePort, openSse, uploadFiles, hasFfmpeg, makeSpeechVideo, tempDir, removeTree, waitFor, sarvamKey, sleep,
} from './harness.mjs';
import { startFakeGoogle } from './fake-google.mjs';

const base = !existsSync(BIN) ? `no server binary at ${BIN}; run npm run build:mac`
  : !hasFfmpeg() ? 'ffmpeg and ffprobe must be on PATH to make test videos'
  : false;
const KEY = sarvamKey();
const skip = base;
const skipSarvam = base || (KEY ? false : 'no SARVAM_API_KEY in server/.env');

const DEST = 'DestFolderId1234567890';
const DEVANAGARI = /[ऀ-ॿ]/;
const dataDir = (app) => join(app.home, 'Documents', 'Akashvani Workflow');
const workflow = (app, id) => join(dataDir(app), 'workflows', id, 'akashwani-structure');

const HINDI_TEXT = 'नमस्ते। मेरा नाम लेखा है। आज हम एक नई फिल्म देखेंगे। यह बहुत अच्छी कहानी है।';

async function appWith(fake, env = {}) {
  const port = await freePort();
  return startApp({
    port,
    env: {
      HTTPS_PROXY: fake.proxyUrl, NODE_TLS_REJECT_UNAUTHORIZED: '0',
      GOOGLE_CLIENT_ID: 'fake-client-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fake-client-secret',
      GOOGLE_REDIRECT_URI: `http://localhost:${port}/api/auth/google/callback`,
      ...env,
    },
  });
}
const signIn = (app) => fetch(`${app.url}/api/auth/google/callback?code=fake-code`, { redirect: 'manual' });

/** Upload a video and run copy + compress, so the episode is ready to transcribe. */
async function prepared(app, sessionId, videoPath, name) {
  const up = await uploadFiles(app, { sessionId, folderName: `Episode ${sessionId}`, files: [{ path: videoPath, name }] });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const sse = await openSse(app, sessionId);
  await app.post('/api/pipeline/start', { sessionId, fileIds: up.body.files.map((f) => f.id), steps: ['copy', 'compress'], driveFolderId: DEST });
  await sse.waitFor((e) => e.event === 'backend_complete', { timeout: 60000, what: 'copy and compress' });
  return sse;
}

function parseSrt(text) {
  return text.replace(/\r/g, '').trim().split(/\n\n+/).map((block) => {
    const [index, time, ...lines] = block.split('\n');
    const m = /(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)/.exec(time);
    const secs = (h, mi, s, ms) => +h * 3600 + +mi * 60 + +s + +ms / 1000;
    return { index: +index, start: secs(...m.slice(1, 5)), end: secs(...m.slice(5, 9)), text: lines.join('\n') };
  });
}

describe('no Sarvam key', { skip }, () => {
  let fake; let app; let media;
  before(async () => {
    fake = await startFakeGoogle(); fake.seedFolder(DEST, 'Dest');
    app = await appWith(fake);
    media = tempDir('media');
    makeSpeechVideo(join(media, 'speech.mp4'), { text: 'नमस्ते', voice: 'Lekha' });
    await signIn(app);
  });
  after(async () => { await app?.stop(); app?.cleanup(); await fake?.stop(); removeTree(media); });

  it('says subtitles cannot be generated here, and where to add the key on a Mac', async () => {
    const status = await app.json('/api/pipeline/transcribe-status');
    assert.equal(status.body.configured, false);

    const res = await app.post('/api/pipeline/transcribe', { sessionId: 'nk-1' });
    assert.equal(res.status, 503);
    assert.equal(res.body.notConfigured, true);
    assert.match(res.body.error, /Application Support\/Akashvani Workflow/, 'names the Mac settings file');
    assert.doesNotMatch(res.body.error, /Akashvani\.exe/);
  });

  it('leaves the subtitle step open in the unattended run, with the same advice', async () => {
    const sse = await prepared(app, 'nk-2', join(media, 'speech.mp4'), 'speech.mp4');
    const up = await app.json('/api/upload/session/nk-2');
    const run = await app.post('/api/pipeline/start', { sessionId: 'nk-2', fileIds: up.body.files.map((f) => f.id), steps: ['upload-feltiv-srt'], driveFolderId: DEST });
    assert.equal(run.status, 200);
    await waitFor(() => sse.of('backend_complete').length >= 2, { timeout: 30000, what: 'the second run to end' });
    const logs = sse.logs('upload-feltiv-srt').join('\n');
    assert.match(logs, /No Sarvam API key on this machine/);
    assert.match(logs, /Application Support\/Akashvani Workflow/);
    assert.ok(!sse.of('step_complete').some((e) => e.data.stepId === 'upload-feltiv-srt'));
    sse.close();
  });
});

describe('a video with nothing to transcribe', { skip }, () => {
  let fake; let app; let media;
  before(async () => {
    fake = await startFakeGoogle(); fake.seedFolder(DEST, 'Dest');
    // a key that is only syntactically present: this test must not reach the Sarvam API at all
    app = await appWith(fake, { SARVAM_API_KEY: 'not-a-real-key' });
    media = tempDir('media');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=4:r=24', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(media, 'silent.mp4')]);
    await signIn(app);
  });
  after(async () => { await app?.stop(); app?.cleanup(); await fake?.stop(); removeTree(media); });

  it('reports that no speech was found', async () => {
    const sse = await prepared(app, 'sil-1', join(media, 'silent.mp4'), 'silent.mp4');
    const res = await app.post('/api/pipeline/transcribe', { sessionId: 'sil-1', driveFolderId: DEST });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /No speech found/);
    // the log line travels on the event stream, a different connection from this response
    await waitFor(() => /Subtitle generation failed: No speech found/.test(sse.logs('upload-feltiv-srt').join('\n')), { what: 'the failure in the log' });
    assert.equal((await app.json('/api/health')).status, 200);
    sse.close();
  });
});

describe('a Sarvam key that is wrong', { skip }, () => {
  let fake; let app; let media;
  before(async () => {
    fake = await startFakeGoogle(); fake.seedFolder(DEST, 'Dest');
    app = await appWith(fake, { SARVAM_API_KEY: 'definitely-not-valid' });
    media = tempDir('media');
    makeSpeechVideo(join(media, 'speech.mp4'), { text: HINDI_TEXT, voice: 'Lekha' });
    await signIn(app);
  });
  after(async () => { await app?.stop(); app?.cleanup(); await fake?.stop(); removeTree(media); });

  it('fails the request with a message, uploads nothing, and the app carries on', async () => {
    const sse = await prepared(app, 'bad-1', join(media, 'speech.mp4'), 'speech.mp4');
    const res = await app.post('/api/pipeline/transcribe', { sessionId: 'bad-1', driveFolderId: DEST });
    assert.equal(res.status, 500);
    assert.ok(res.body.error.length > 5, `error: ${res.body.error}`);
    assert.equal(fake.paths().filter((p) => p.path.includes('AI Subtitles')).length, 0, 'nothing was filed on Drive');
    const state = await app.json('/api/pipeline/state/bad-1');
    assert.notEqual(state.body.stepStates['upload-feltiv-srt'], 'complete');
    assert.equal((await app.json('/api/health')).status, 200);
    sse.close();
  });
});

describe('subtitles from real speech', { skip: skipSarvam }, () => {
  let fake; let app; let media; let speech;
  before(async () => {
    fake = await startFakeGoogle(); fake.seedFolder(DEST, 'Dest');
    app = await appWith(fake, { SARVAM_API_KEY: KEY });
    media = tempDir('media');
    speech = makeSpeechVideo(join(media, 'speech.mp4'), { text: HINDI_TEXT, voice: 'Lekha' });
    await signIn(app);
  });
  after(async () => { await app?.stop(); app?.cleanup(); await fake?.stop(); removeTree(media); });

  it('reports the key as configured', async () => {
    const { body } = await app.json('/api/pipeline/transcribe-status');
    assert.equal(body.configured, true);
  });

  it('turns Hindi speech into timed cues, saves .srt and .docx, and files both on Drive', { timeout: 180000 }, async () => {
    const sse = await prepared(app, 'sub-1', join(media, 'speech.mp4'), 'Hindi Speech.mp4');
    const res = await app.post('/api/pipeline/transcribe', { sessionId: 'sub-1', driveFolderId: DEST });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.files.length, 1);
    assert.equal(res.body.files[0].srt, 'Hindi Speech.srt', 'named after the video, without _compressed');

    const dir = join(workflow(app, 'sub-1'), 'AI Subtitles');
    const srtText = readFileSync(join(dir, 'Hindi Speech.srt'), 'utf8');
    const cues = parseSrt(srtText);
    assert.ok(cues.length >= 1, `at least one cue, got ${cues.length}`);
    cues.forEach((c, i) => {
      assert.equal(c.index, i + 1, 'numbered in order');
      assert.ok(c.end > c.start, `cue ${c.index} ends after it starts`);
      assert.ok(c.text.trim().length > 0, `cue ${c.index} has text`);
      if (i > 0) assert.ok(c.start >= cues[i - 1].start, 'cues are in time order');
      assert.ok(c.end <= speech.seconds + 1, `cue ${c.index} ends within the video (${c.end} vs ${speech.seconds})`);
    });
    assert.match(srtText, DEVANAGARI, 'the text is in Devanagari');
    assert.ok(existsSync(join(dir, 'Hindi Speech.docx')));
    assert.ok(!readdirSync(dir).some((n) => n.endsWith('.segments')), 'scratch audio was cleaned up');

    const onDrive = fake.findByPath('Dest/Hindi Speech/episode - 1/AI Subtitles/Hindi Speech.srt');
    assert.ok(onDrive, 'the .srt is on Drive');
    assert.equal(onDrive.content.toString('utf8'), srtText);
    assert.ok(fake.findByPath('Dest/Hindi Speech/episode - 1/AI Subtitles/Hindi Speech.docx'));

    await sleep(500); // let the last events arrive on the stream
    const logs = sse.logs('upload-feltiv-srt').join('\n');
    assert.match(logs, /Extracting audio/);
    assert.match(logs, /Detecting silences/);
    assert.equal(Math.max(...sse.of('progress').filter((e) => e.data.stepId === 'upload-feltiv-srt').map((e) => e.data.progress)), 100);
    assert.equal((await app.json('/api/pipeline/state/sub-1')).body.stepStates['upload-feltiv-srt'], 'complete');
    console.log(`      transcript: ${cues.map((c) => c.text.replace(/\n/g, ' ')).join(' | ')}`);
    sse.close();
  });

  it('runs on its own as the last step of a full run: copy, compress, Drive, subtitles', { timeout: 240000 }, async () => {
    const up = await uploadFiles(app, { sessionId: 'sub-2', folderName: 'Full run', files: [{ path: join(media, 'speech.mp4'), name: 'Full Run.mp4' }] });
    const sse = await openSse(app, 'sub-2');
    await app.post('/api/pipeline/start', {
      sessionId: 'sub-2', fileIds: up.body.files.map((f) => f.id), driveFolderId: DEST,
      steps: ['copy', 'compress', 'upload-gdrive', 'upload-feltiv-srt'],
    });
    const end = await sse.waitFor((e) => ['backend_complete', 'pipeline_error', 'step_error'].includes(e.event), { timeout: 200000 });
    assert.equal(end.event, 'backend_complete', sse.logs().join('\n'));
    assert.deepEqual(sse.of('step_complete').map((e) => e.data.stepId), ['copy', 'compress', 'upload-gdrive', 'upload-feltiv-srt']);
    assert.ok(fake.findByPath('Dest/Full Run/episode - 1/Source Video/Full Run_compressed.mp4'));
    assert.ok(fake.findByPath('Dest/Full Run/episode - 1/AI Subtitles/Full Run.srt'));
    assert.match(sse.logs('upload-feltiv-srt').join('\n'), /Subtitles ready: Full Run\.srt/);
    sse.close();
  });

  it('does not call Sarvam, and says why, when there is nowhere on Drive to put the result', { timeout: 60000 }, async () => {
    const up = await uploadFiles(app, { sessionId: 'sub-3', folderName: 'No Drive folder', files: [{ path: join(media, 'speech.mp4'), name: 'No Folder.mp4' }] });
    const sse = await openSse(app, 'sub-3');
    await app.post('/api/pipeline/start', { sessionId: 'sub-3', fileIds: up.body.files.map((f) => f.id), steps: ['copy', 'compress', 'upload-feltiv-srt'] });
    await sse.waitFor((e) => e.event === 'backend_complete', { timeout: 50000 });
    assert.match(sse.logs('upload-feltiv-srt').join('\n'), /nowhere on Drive to put them/);
    assert.ok(!sse.logs('upload-feltiv-srt').some((m) => /Extracting audio/.test(m)), 'no audio work was started');
    sse.close();
  });

  it('refuses to transcribe an episode that has no video yet', async () => {
    const res = await app.post('/api/pipeline/transcribe', { sessionId: 'sub-none', driveFolderId: DEST });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /No workflow folder|No compressed videos/);
  });
});

describe('Stop during subtitles', { skip: skipSarvam }, () => {
  let fake; let app; let media;
  before(async () => {
    fake = await startFakeGoogle(); fake.seedFolder(DEST, 'Dest');
    app = await appWith(fake, { SARVAM_API_KEY: KEY });
    media = tempDir('media');
    makeSpeechVideo(join(media, 'long.mp4'), { text: Array(10).fill(HINDI_TEXT).join(' '), voice: 'Lekha' });
    await signIn(app);
  });
  after(async () => { await app?.stop(); app?.cleanup(); await fake?.stop(); removeTree(media); });

  const ffmpegs = () => spawnSync('/usr/bin/pgrep', ['-f', `${app.serverDir}/ffmpeg/ffmpeg`], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

  it('ends the work, answers 409, files nothing, and leaves nothing running', { timeout: 180000 }, async () => {
    const sse = await prepared(app, 'stop-sub', join(media, 'long.mp4'), 'Long Speech.mp4');
    const pending = app.post('/api/pipeline/transcribe', { sessionId: 'stop-sub', driveFolderId: DEST });
    await sse.waitFor((e) => e.event === 'log' && /Detecting silences|Transcribing|segment/i.test(e.data.message), { timeout: 60000, what: 'audio work to start' });
    const stop = await app.post('/api/pipeline/stop', { sessionId: 'stop-sub' });
    assert.equal(stop.status, 200);

    const res = await pending;
    assert.ok([409, 500].includes(res.status), `status ${res.status}`);
    await waitFor(() => ffmpegs().length === 0, { timeout: 10000, what: 'FFmpeg to be gone' });
    assert.equal(fake.paths().filter((p) => p.path.includes('AI Subtitles')).length, 0, 'nothing was filed on Drive');
    assert.notEqual((await app.json('/api/pipeline/state/stop-sub')).body.stepStates['upload-feltiv-srt'], 'complete');
    sse.close();
  });
});
