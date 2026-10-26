/**
 * Google sign-in and the Drive steps, run in the built app against a stand-in for
 * Google (fake-google.mjs), so no Google account or network is needed.
 * Needs the app built (npm run build:mac) and ffmpeg/ffprobe on PATH.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import {
  BIN, startApp, freePort, openSse, uploadFiles, postFile, hasFfmpeg, makeVideo, tempDir, removeTree, waitFor,
} from './harness.mjs';
import { startFakeGoogle } from './fake-google.mjs';

const skip = !existsSync(BIN) ? `no server binary at ${BIN}; run npm run build:mac`
  : !hasFfmpeg() ? 'ffmpeg and ffprobe must be on PATH to make test videos'
  : false;

const DEST = 'DestFolderId1234567890';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const dataDir = (app) => join(app.home, 'Documents', 'Akashvani Workflow');
const workflow = (app, id) => join(dataDir(app), 'workflows', id, 'akashwani-structure');

const SRT = `1
00:00:01,000 --> 00:00:03,000
नमस्ते, यह पहला वाक्य है।

2
00:00:03,500 --> 00:00:06,000
This is the second line.
`;

async function appWithGoogle(fake, { env = {}, port } = {}) {
  port ??= await freePort();
  return startApp({
    port,
    env: {
      HTTPS_PROXY: fake.proxyUrl,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      GOOGLE_CLIENT_ID: 'fake-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'fake-client-secret',
      GOOGLE_REDIRECT_URI: `http://localhost:${port}/api/auth/google/callback`,
      ...env,
    },
  });
}

const manual = (app, path) => fetch(app.url + path, { redirect: 'manual' });
const encodeReturnTo = (p) => `r:${Buffer.from(p, 'utf8').toString('base64url')}`;

/** Sign in through the callback the way the browser does after Google's consent screen. */
async function signIn(app, state) {
  const res = await manual(app, `/api/auth/google/callback?code=fake-code${state ? `&state=${encodeURIComponent(state)}` : ''}`);
  assert.equal(res.status, 302);
  return res.headers.get('location');
}

describe('Google not set up on this Mac', { skip }, () => {
  let app;
  before(async () => { app = await startApp(); });
  after(async () => { await app?.stop(); app?.cleanup(); });

  it('says so, and offers no sign-in link', async () => {
    const { body } = await app.json('/api/auth/status');
    assert.deepEqual(body, { authenticated: false, configured: false });
  });

  it('refuses Drive calls with a clear message', async () => {
    const res = await app.post('/api/drive/resolve', { input: 'https://drive.google.com/drive/folders/abcdefghij12345' });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /not configured/);
    assert.equal((await app.get('/api/auth/google')).status, 500);
  });

  it('skips the Drive step and still completes the run', async () => {
    const dir = tempDir('media');
    try {
      makeVideo(join(dir, 'clip.mp4'), { seconds: 2 });
      const up = await uploadFiles(app, { sessionId: 'nog-1', folderName: 'No Google', files: [{ path: join(dir, 'clip.mp4'), name: 'clip.mp4' }] });
      const sse = await openSse(app, 'nog-1');
      await app.post('/api/pipeline/start', { sessionId: 'nog-1', fileIds: up.body.files.map((f) => f.id), steps: ['copy', 'compress', 'upload-gdrive'] });
      await sse.waitFor((e) => e.event === 'backend_complete', { timeout: 60000 });
      assert.match(sse.logs('upload-gdrive').join('\n'), /Google API credentials not configured/);
      assert.deepEqual(sse.of('step_complete').map((e) => e.data.stepId), ['copy', 'compress', 'upload-gdrive']);
      sse.close();
    } finally { removeTree(dir); }
  });
});

describe('signing in', { skip }, () => {
  let fake; let app; const retired = [];
  before(async () => { fake = await startFakeGoogle(); fake.seedFolder(DEST, 'Dest'); app = await appWithGoogle(fake); });
  after(async () => { await app?.stop(); app?.cleanup(); retired.forEach((r) => r.cleanup()); await fake?.stop(); });

  it('offers a Google consent link built from the client id and redirect address', async () => {
    const { body } = await app.json('/api/auth/status');
    assert.equal(body.configured, true);
    assert.equal(body.authenticated, false);
    const url = new URL(body.authUrl);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('client_id'), 'fake-client-id.apps.googleusercontent.com');
    assert.equal(url.searchParams.get('redirect_uri'), `http://localhost:${app.port}/api/auth/google/callback`);
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.match(url.searchParams.get('scope'), /auth\/drive/);
    assert.match(url.searchParams.get('scope'), /userinfo\.email/);
  });

  it('redirects /api/auth/google to Google and passes the state along', async () => {
    const res = await manual(app, '/api/auth/google?state=session-42');
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get('location')).searchParams.get('state'), 'session-42');
  });

  it('answers a callback with no code, and one where Google reported an error', async () => {
    assert.equal((await manual(app, '/api/auth/google/callback')).status, 400);
    const denied = await manual(app, '/api/auth/google/callback?error=access_denied&state=sess-1');
    assert.equal(denied.status, 302);
    const to = new URL(denied.headers.get('location'));
    assert.equal(to.origin, `http://localhost:${app.port}`);
    assert.equal(to.pathname, '/pipeline');
    assert.equal(to.searchParams.get('auth_error'), 'access_denied');
    assert.equal(to.searchParams.get('sessionId'), 'sess-1');
  });

  it('never redirects somewhere other than its own pages', async () => {
    for (const evil of ['//evil.example/steal', 'https://evil.example/']) {
      const res = await manual(app, `/api/auth/google/callback?error=x&state=${encodeURIComponent(encodeReturnTo(evil))}`);
      const to = new URL(res.headers.get('location'));
      assert.equal(to.origin, `http://localhost:${app.port}`, `state ${evil}`);
    }
  });

  it('is not signed in yet, and Drive calls ask for sign-in with a link', async () => {
    assert.equal((await app.json('/api/auth/status')).body.authenticated, false);
    const res = await app.post('/api/drive/resolve', { input: `https://drive.google.com/drive/folders/${DEST}` });
    assert.equal(res.status, 401);
    assert.equal(res.body.needsAuth, true);
    assert.match(res.body.authUrl, /^https:\/\/accounts\.google\.com\//);
  });

  it('finishes the editor sign-in, returning to the pipeline page ready to resume the Drive step', async () => {
    const location = new URL(await signIn(app, 'sess-9'));
    assert.equal(location.pathname, '/pipeline');
    assert.equal(location.searchParams.get('auth_success'), '1');
    assert.equal(location.searchParams.get('sessionId'), 'sess-9');
    assert.equal(location.searchParams.get('resume_drive'), '1');
    assert.deepEqual(fake.tokenCodes, ['fake-code']);

    const { body } = await app.json('/api/auth/status');
    assert.deepEqual(body, { authenticated: true, configured: true, email: 'tester@example.com', name: 'Test Editor' });
  });

  it('brings a reviewer back to the exact page they left, without the resume flag', async () => {
    const back = new URL(await signIn(app, encodeReturnTo('/join?code=AK-ABCD&role=le1&resume_drive=1')));
    assert.equal(back.pathname, '/join');
    assert.equal(back.searchParams.get('code'), 'AK-ABCD');
    assert.equal(back.searchParams.get('role'), 'le1');
    assert.equal(back.searchParams.get('auth_success'), '1');
    assert.equal(back.searchParams.has('resume_drive'), false);
  });

  it('checks a pasted Drive folder link against the account', async () => {
    const ok = await app.post('/api/drive/resolve', { input: `https://drive.google.com/drive/folders/${DEST}?usp=sharing` });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.folder.name, 'Dest');
    assert.equal(ok.body.folder.url, `https://drive.google.com/drive/folders/${DEST}`);

    const bare = await app.post('/api/drive/resolve', { input: DEST });
    assert.equal(bare.status, 200);

    const notFolder = await app.post('/api/drive/resolve', { input: 'not a link' });
    assert.equal(notFolder.status, 400);

    const missing = await app.post('/api/drive/resolve', { input: 'https://drive.google.com/drive/folders/NoSuchFolder123456' });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /Couldn't open that folder/);
  });

  it('remembers the chosen Drive destination, including across a restart', async () => {
    assert.equal((await app.json('/api/drive/target')).body.target, null);
    assert.equal((await app.post('/api/drive/target', {})).status, 400);
    assert.equal((await app.post('/api/drive/target', { folderId: DEST, folderName: 'Dest' })).status, 200);
    assert.deepEqual((await app.json('/api/drive/target')).body.target, { folderId: DEST, folderName: 'Dest' });

    const old = app;
    await old.stop();
    retired.push(old);
    app = await startApp({
      home: old.home, port: old.port,
      env: {
        HTTPS_PROXY: fake.proxyUrl, NODE_TLS_REJECT_UNAUTHORIZED: '0',
        GOOGLE_CLIENT_ID: 'fake-client-id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fake-client-secret',
      },
    });
    assert.deepEqual((await app.json('/api/drive/target')).body.target, { folderId: DEST, folderName: 'Dest' });
    assert.equal((await app.json('/api/auth/status')).body.authenticated, false, 'sign-in is not remembered across a restart');
  });
});

describe('Drive steps of the pipeline', { skip }, () => {
  let fake; let app; let media;
  before(async () => {
    fake = await startFakeGoogle();
    fake.seedFolder(DEST, 'Dest');
    app = await appWithGoogle(fake);
    media = tempDir('media');
    makeVideo(join(media, 'clip.mp4'), { seconds: 2 });
    await signIn(app);
  });
  after(async () => { await app?.stop(); app?.cleanup(); await fake?.stop(); removeTree(media); });

  async function start(sessionId, { name, files, folderName, steps = ['copy', 'compress', 'upload-gdrive'], episodeCount = 1, driveFolderId = DEST }) {
    const up = await uploadFiles(app, {
      sessionId, folderName: folderName ?? `Episode ${sessionId}`, episodeCount,
      files: (files ?? [name ?? 'clip.mp4']).map((n) => ({ path: join(media, 'clip.mp4'), name: n })),
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const sse = await openSse(app, sessionId);
    const res = await app.post('/api/pipeline/start', { sessionId, fileIds: up.body.files.map((f) => f.id), steps, driveFolderId });
    assert.equal(res.status, 200);
    return { sse, up };
  }
  const finished = (sse) => sse.waitFor((e) => ['backend_complete', 'pipeline_error', 'step_error'].includes(e.event), { timeout: 120000, what: 'the run to end' });

  it('builds the episode folders on Drive and uploads the compressed video into Source Video', async () => {
    const { sse } = await start('d-basic', { name: 'My Episode.mp4' });
    const end = await finished(sse);
    assert.equal(end.event, 'backend_complete', JSON.stringify(end.data) + sse.logs().join('\n'));

    const base = 'Dest/My Episode';
    for (const folder of ['episode - 1', 'episode - 1/Source Video', 'episode - 1/AI Subtitles', 'episode - 1/LE 1']) {
      assert.ok(fake.findByPath(`${base}/${folder}`), `${folder} exists on Drive`);
    }
    const video = fake.findByPath(`${base}/episode - 1/Source Video/My Episode_compressed.mp4`);
    assert.ok(video, 'the compressed video is on Drive');
    const local = join(workflow(app, 'd-basic'), 'source file', 'My Episode_compressed.mp4');
    assert.equal(sha(video.content), sha(readFileSync(local)), 'Drive holds exactly the bytes compress produced');

    assert.deepEqual(sse.of('step_complete').map((e) => e.data.stepId), ['copy', 'compress', 'upload-gdrive']);
    const progress = sse.of('progress').filter((e) => e.data.stepId === 'upload-gdrive').map((e) => e.data.progress);
    assert.equal(Math.max(...progress), 100);
    assert.match(sse.logs('upload-gdrive').join('\n'), /File link: https:\/\/drive\.google\.com\/file\/d\//);
  });

  it('reuses folders that already exist instead of creating copies', async () => {
    const before = fake.paths().filter((p) => p.path === 'Dest/My Episode').length;
    const { sse } = await start('d-again', { name: 'My Episode.mp4', folderName: 'Second run' });
    await finished(sse);
    assert.equal(fake.paths().filter((p) => p.path === 'Dest/My Episode').length, before, 'no second "My Episode" folder');
    assert.equal(fake.paths().filter((p) => p.path === 'Dest/My Episode/episode - 1').length, 1);
  });

  it('copes with apostrophes and Hindi in the episode name, which end up in Drive queries and folder names', async () => {
    for (const [id, name, folder] of [['d-apos', "Mowgli's Day.mp4", "Dest/Mowgli's Day"], ['d-hindi', 'नमस्ते दुनिया.mp4', 'Dest/नमस्ते दुनिया']]) {
      const { sse } = await start(id, { name });
      const end = await finished(sse);
      assert.equal(end.event, 'backend_complete', sse.logs().join('\n'));
      const found = fake.paths().map((p) => p.path.normalize('NFC'));
      assert.ok(found.includes(folder.normalize('NFC') + '/episode - 1/Source Video'), `${folder} on Drive: ${found.filter((f) => f.startsWith('Dest/')).join(' | ')}`);
    }
    const rerun = (await start('d-apos2', { name: "Mowgli's Day.mp4", folderName: 'apostrophe again' }));
    await finished(rerun.sse);
    assert.equal(fake.paths().filter((p) => p.path === "Dest/Mowgli's Day").length, 1, 'the folder with an apostrophe was found again, not duplicated');
  });

  it('spreads files across episode folders when an episode count is given', async () => {
    const { sse } = await start('d-two', { files: ['Show Ep1.mp4', 'Show Ep2.mp4'], episodeCount: 2, folderName: 'Two episodes' });
    const end = await finished(sse);
    assert.equal(end.event, 'backend_complete', sse.logs().join('\n'));
    assert.ok(fake.findByPath('Dest/Show Ep1/episode - 1/Source Video/Show Ep1_compressed.mp4'));
    assert.ok(fake.findByPath('Dest/Show Ep1/episode - 2/Source Video/Show Ep2_compressed.mp4'));
  });

  it('pauses and asks for sign-in when the session has expired, then resumes at Drive without re-encoding', async () => {
    // A restarted app has lost its sign-in. Use a second app on the same fake Google, not signed in.
    const second = await appWithGoogle(fake);
    try {
      const up = await uploadFiles(second, { sessionId: 'd-resume', folderName: 'Resume at Drive', files: [{ path: join(media, 'clip.mp4'), name: 'Resume Show.mp4' }] });
      const sse = await openSse(second, 'd-resume');
      await second.post('/api/pipeline/start', { sessionId: 'd-resume', fileIds: up.body.files.map((f) => f.id), steps: ['copy', 'compress', 'upload-gdrive'], driveFolderId: DEST });
      const auth = await sse.waitFor((e) => e.event === 'auth_required', { timeout: 60000, what: 'auth_required' });
      assert.match(auth.data.authUrl, /^https:\/\/accounts\.google\.com\//);
      assert.ok(!sse.of('step_complete').some((e) => e.data.stepId === 'upload-gdrive'), 'the Drive step is not marked done');
      assert.equal(fake.findByPath('Dest/Resume Show'), null, 'nothing was created on Drive yet');

      const back = new URL(await signIn(second, 'd-resume'));
      assert.equal(back.searchParams.get('resume_drive'), '1');

      const compressRuns = () => sse.logs('compress').filter((m) => /Source :/.test(m)).length;
      const encodesBefore = compressRuns();
      const resume = await second.post('/api/pipeline/resume-drive', { sessionId: 'd-resume' });
      assert.equal(resume.status, 200, JSON.stringify(resume.body));
      await sse.waitFor((e) => e.event === 'backend_complete', { timeout: 60000 });
      assert.ok(fake.findByPath('Dest/Resume Show/episode - 1/Source Video/Resume Show_compressed.mp4'));
      assert.equal(compressRuns(), encodesBefore, 'the video was not encoded again');
      sse.close();
    } finally { await second.stop(); second.cleanup(); }
  });

  it('refuses to resume an episode the app has forgotten', async () => {
    const sse = await openSse(app, 'never-uploaded');
    const res = await app.post('/api/pipeline/resume-drive', { sessionId: 'never-uploaded' });
    sse.close();
    assert.equal(res.status, 400);
    assert.match(res.body.error, /expired or missing/);
  });
});

describe('subtitle and review uploads to Drive', { skip }, () => {
  let fake; let app;
  const body = (extra = {}) => ({ sessionId: 'rev-1', parentName: 'Review Show', driveFolderId: DEST, ...extra });
  before(async () => { fake = await startFakeGoogle(); fake.seedFolder(DEST, 'Dest'); app = await appWithGoogle(fake); });
  after(async () => { await app?.stop(); app?.cleanup(); await fake?.stop(); });

  const uploadSrt = (fields = body(), name = 'ep.srt', content = SRT) =>
    postFile(app, '/api/pipeline/upload-srt', { field: 'srtFile', file: Buffer.from(content), name, fields });

  it('asks for sign-in before uploading, and says where to go', async () => {
    const res = await uploadSrt();
    assert.equal(res.status, 401);
    assert.equal(res.body.driveBlocked, 'needs-auth');
    assert.match(res.body.authUrl, /^https:\/\/accounts\.google\.com\//);
    assert.equal(fake.paths().filter((p) => p.path.startsWith('Dest/Review Show')).length, 0, 'nothing reached Drive');
  });

  it('puts the .srt and a Word copy in AI Subtitles once signed in', async () => {
    await signIn(app);
    const res = await uploadSrt();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.entries, 2);
    const srt = fake.findByPath('Dest/Review Show/episode - 1/AI Subtitles/ep.srt');
    const docx = fake.findByPath('Dest/Review Show/episode - 1/AI Subtitles/ep.docx');
    assert.equal(srt.content.toString('utf8'), SRT, 'the Hindi text arrives intact');
    assert.equal(docx.content.subarray(0, 2).toString(), 'PK', 'the Word file is a real .docx (a zip)');
    assert.equal((await app.json('/api/pipeline/state/rev-1')).body.stepStates['upload-feltiv-srt'], 'complete');
  });

  it('refuses a file that is not an .srt', async () => {
    const res = await uploadSrt(body(), 'notes.txt');
    assert.ok(res.status >= 400);
  });

  it('refuses to guess where to upload when no Drive folder is set', async () => {
    const res = await uploadSrt({ sessionId: 'rev-2', parentName: 'Review Show' });
    assert.equal(res.status, 400);
    assert.equal(res.body.driveBlocked, 'no-drive-folder');
    const noParent = await uploadSrt({ sessionId: 'rev-3', driveFolderId: DEST });
    assert.equal(noParent.status, 400);
    assert.equal(noParent.body.driveBlocked, 'no-episode-folder');
  });

  it('tells a reviewer who cannot see the folder, or can only view it, what to do', async () => {
    fake.seedFolder('ViewOnlyFolder12345', 'Read Only');
    fake.viewOnly.add('ViewOnlyFolder12345');
    const viewOnly = await uploadSrt(body({ driveFolderId: 'ViewOnlyFolder12345' }));
    assert.equal(viewOnly.status, 403);
    assert.equal(viewOnly.body.driveBlocked, 'no-write-access');
    assert.match(viewOnly.body.error, /view-only/);

    const unknown = await uploadSrt(body({ driveFolderId: 'NobodyShared1234567' }));
    assert.equal(unknown.status, 403);
    assert.equal(unknown.body.driveBlocked, 'no-folder-access');
  });

  it('turns the Word file a reviewer corrected back into subtitles, and files both under LE 1', async () => {
    const docxPath = join(workflow(app, 'rev-1'), 'AI Subtitles', 'ep.docx');
    assert.ok(existsSync(docxPath), 'the app wrote ep.docx next to ep.srt');
    const word = readFileSync(docxPath);
    const res = await postFile(app, '/api/pipeline/upload-le1-word', { field: 'wordFile', file: word, name: 'ep.docx', fields: body() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.srtConverted, true);
    assert.equal(res.body.srtSavedAs, 'ep.srt');

    const filedSrt = fake.findByPath('Dest/Review Show/episode - 1/LE 1/ep.srt');
    assert.ok(filedSrt && fake.findByPath('Dest/Review Show/episode - 1/LE 1/ep.docx'));
    // the round trip srt -> docx -> srt keeps the cues and their timings
    const normalise = (t) => t.replace(/\r/g, '').trim();
    assert.equal(normalise(filedSrt.content.toString('utf8')), normalise(SRT));

    const state = (await app.json('/api/pipeline/state/rev-1')).body;
    assert.equal(state.stepStates['review-pass1'], 'complete');
    assert.equal(state.stepStates['align-srt'], 'complete');
    assert.equal(state.leUploads.le1.fileName, 'ep.docx');
  });

  it('still files a .docx that is not in subtitle layout, without a converted .srt', async () => {
    const plain = readFileSync(join(workflow(app, 'rev-1'), 'AI Subtitles', 'ep.docx'));
    // not valid as a table of cues: truncate to a few bytes of a zip header
    const res = await postFile(app, '/api/pipeline/upload-le2-word', { field: 'wordFile', file: plain.subarray(0, 40), name: 'notes.docx', fields: body() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.srtConverted, false);
    assert.ok(fake.findByPath('Dest/Review Show/episode - 1/LE 2/notes.docx'));
    assert.equal(fake.findByPath('Dest/Review Show/episode - 1/LE 2/notes-le2.srt'), null);
    assert.equal((await app.json('/api/pipeline/state/rev-1')).body.leUploads.le2.fileName, 'notes.docx');
  });

  it('files the final .srt under LE 3 and remembers who sent what', async () => {
    const res = await postFile(app, '/api/pipeline/upload-le3-srt', { field: 'srtFile', file: Buffer.from(SRT), name: 'final.srt', fields: body() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(fake.findByPath('Dest/Review Show/episode - 1/LE 3/final.srt').content.toString('utf8'), SRT);
    const state = (await app.json('/api/pipeline/state/rev-1')).body;
    assert.equal(state.stepStates['review-pass3'], 'complete');
    assert.equal(state.leUploads.le3.fileName, 'final.srt');
  });

  it('saves a Premiere project locally, with no Drive involved', async () => {
    const res = await postFile(app, '/api/pipeline/upload-prproj', { field: 'prprojFile', file: Buffer.from('<PremiereData/>'), name: 'Show.prproj', fields: { sessionId: 'rev-1' } });
    assert.equal(res.status, 200);
    assert.ok(existsSync(join(workflow(app, 'rev-1'), 'Editor', 'Show.prproj')));
    assert.equal((await app.json('/api/pipeline/state/rev-1')).body.stepStates['upload-prproj'], 'complete');
    const wrong = await postFile(app, '/api/pipeline/upload-prproj', { field: 'prprojFile', file: Buffer.from('x'), name: 'Show.txt', fields: { sessionId: 'rev-1' } });
    assert.ok(wrong.status >= 400);
  });

  it('keeps a file name with Hindi letters intact all the way to Drive', async () => {
    const res = await postFile(app, '/api/pipeline/upload-le3-srt', { field: 'srtFile', file: Buffer.from(SRT), name: 'अंतिम.srt', fields: body() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(fake.paths().some((p) => p.path.normalize('NFC') === 'Dest/Review Show/episode - 1/LE 3/अंतिम.srt'.normalize('NFC')), 'the Hindi file name is right on Drive');
    assert.ok(readdirSync(join(workflow(app, 'rev-1'), 'Editor')).some((n) => n.normalize('NFC') === 'अंतिम.srt'.normalize('NFC')), 'and on disk');
  });
});
