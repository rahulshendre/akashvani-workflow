/**
 * The app as people use it, in a real browser (the Google Chrome on this Mac, headless).
 *
 * An editor sets up an episode on one Mac; Language Experts review it from another Mac. The
 * built app runs on both, Google is a stand-in, and the session service is the repo's real one
 * on a throwaway PostgreSQL. See ui-fixture.mjs.
 *
 * Needs: the built app, Google Chrome, ffmpeg/ffprobe on PATH, and PostgreSQL server programs
 * plus `npm ci` in fly-service/. Anything missing skips the suite with the reason.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { makeVideo, tempDir, removeTree, waitFor, listeners, sleep } from './harness.mjs';
import { startUi, connectDrive, uiSkipReason, DEST } from './ui-fixture.mjs';

const skip = uiSkipReason();
const SHOT_DIR = process.env.SMOKE_SCREENSHOTS;

const SRT = `1
00:00:01,000 --> 00:00:03,000
नमस्ते, यह पहला वाक्य है।

2
00:00:03,500 --> 00:00:06,000
This is the second line.
`;

const STEP = {
  copy: 'Copy videos into the workspace',
  compress: 'Compress and add the watermark',
  drive: 'Upload the videos to Google Drive',
  subtitles: 'Generate the AI subtitles',
  le1: 'Language Expert review — first pass',
  align: 'Align the subtitles in Premiere Pro',
  prproj: 'Add the Premiere Pro project file',
  wordToSrt: 'Turn the Word file back into subtitles',
  qc: 'Final quality check',
  le3: 'Language Expert review — final pass',
  sls: 'SLS — subtitle language processing',
  slc: 'SLC — compliance check',
  roman: 'Convert to Roman script',
};

/** The sidebar row for a step. */
const row = (page, name) => page.locator('button', { hasText: name }).first();
/** What the row says about the step: DONE, PROCESSING..., AWAITING ACTION, MANUAL, AUTO. */
async function status(page, name) {
  const text = await row(page, name).innerText();
  return /DONE|PROCESSING|AWAITING ACTION|MANUAL|AUTO|ERROR/.exec(text)?.[0] ?? text;
}
const stepIs = (page, name, want) => waitFor(async () => (await status(page, name)) === want, { timeout: 60000, what: `"${name}" to be ${want}` });

async function shot(page, name) {
  if (SHOT_DIR) { mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: true }); }
}

/** Welcome -> storage choice -> sign in again after the restart -> the editor's home screen. */
async function firstRun(page, origin, { email, office }) {
  await connectDrive(page, origin, { email, office });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/drive-setup/);
  await page.getByText('Home folder').click();
  await page.getByRole('button', { name: /confirm location/i }).click();
  await page.waitForURL((u) => !u.pathname.includes('drive-setup'), { timeout: 30000 });
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.waitForURL(/auth_success/);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/editor/);
}

describe('first launch, in a browser', { skip }, () => {
  let ui; let person;
  before(async () => { ui = await startUi(); person = await ui.newPerson(); });
  after(async () => { await ui?.stop(); });

  it('asks for details, and says what is wrong with them', async () => {
    const { page } = person;
    await page.goto(ui.origin + '/');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('Please fill in all fields.').waitFor();

    await page.getByPlaceholder('you@example.com').fill('not-an-email');
    await page.getByPlaceholder('e.g. Mumbai Office').fill('Test Office');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('Enter a valid email address.').waitFor();

    await page.getByPlaceholder('you@example.com').fill('Editor@Example.com');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText(/Connect Google Drive first/).waitFor();
    await shot(page, '01-welcome-errors');
  });

  it('connects Google Drive through the consent screen and comes back signed in', async () => {
    const { page } = person;
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.waitForURL(/auth_success/);
    await page.getByText('Connected as tester@example.com').waitFor();
    assert.deepEqual(ui.fake.tokenCodes, ['fake-code']);
    // what was typed before leaving for Google is still there
    assert.equal(await page.getByPlaceholder('you@example.com').inputValue(), 'editor@example.com');
    assert.equal(await page.getByPlaceholder('e.g. Mumbai Office').inputValue(), 'Test Office');
  });

  it('signs the person in, registers them with the session service, and starts with the storage choice', async () => {
    const { page } = person;
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(/drive-setup/);
    assert.equal(ui.sessions.sql("select email || '|' || office_name || '|' || role from users"), 'editor@example.com|Test Office|editor', 'email is stored lower-case');
    await page.getByText('Choose a storage location').waitFor();
    await shot(page, '02-storage');
  });

  it('offers the home folder with its real path and free space, and will not continue without a choice', async () => {
    const { page } = person;
    await page.getByText('Home folder').waitFor();
    const confirm = page.getByRole('button', { name: /confirm location/i });
    assert.equal(await confirm.isDisabled(), true);
    await page.getByText('Home folder').click();
    assert.equal(await confirm.isDisabled(), false);
    await page.getByText(/will be created at/).waitFor();
    assert.match(await page.locator('body').innerText(), new RegExp(`${ui.app.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/Documents/Akashvani Workflow`));
    assert.match(await page.locator('body').innerText(), /GB free/);
  });

  it('saves the choice, restarts the app, and asks for Google again because the sign-in lives in memory', async () => {
    const { page } = person;
    const before = listeners(ui.port);
    await page.getByRole('button', { name: /confirm location/i }).click();
    await page.getByText('Location saved!').waitFor();
    await page.waitForURL((u) => !u.pathname.includes('drive-setup'), { timeout: 30000 });
    const after = listeners(ui.port);
    assert.equal(after.length, 1);
    assert.notEqual(after[0], before[0], 'the app restarted itself');
    await page.getByText('One more thing').waitFor();
    await page.getByText(/Connect Google Drive to carry on/).waitFor();
    assert.equal(person.errors.length, 0, person.errors.join('\n'));
  });

  it('lands on the editor home after signing in again, showing who is signed in and where the logs are', async () => {
    const { page } = person;
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.waitForURL(/auth_success/);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(/\/editor/);
    await page.getByText('Test Office · editor@example.com').waitFor();
    await page.getByText('No episodes yet.').waitFor();
    await page.getByText('View application log').waitFor();
    const text = await page.locator('body').innerText();
    assert.ok(text.includes(join(ui.app.home, 'Library', 'Logs', 'Akashvani Workflow')), 'shows the Mac log folder');
    await shot(page, '03-editor-home');
  });

  it('shows the log, and does not make a fuss about the install log that only Windows has', async () => {
    const log = await (await fetch(`${ui.origin}/api/pipeline/log?lines=20`)).text();
    assert.match(log, /Akashvani starting/);
    const install = await (await fetch(`${ui.origin}/api/pipeline/log?file=install`)).text();
    assert.ok(install.length > 0 && !/Error|undefined/.test(install.split('\n').slice(0, 3).join(' ')), `install log answer: ${install.slice(0, 120)}`);
  });

  it('logs out and shows the welcome form again', async () => {
    const { page } = person;
    await page.getByRole('button', { name: 'Log out' }).click();
    await page.waitForURL(/switch=1/);
    await page.getByText('Welcome').first().waitFor();
    // signing in with the same details gets back to the editor without another storage choice
    await page.getByPlaceholder('you@example.com').fill('editor@example.com');
    await page.getByPlaceholder('e.g. Mumbai Office').fill('Test Office');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(/\/editor/);
  });
});

describe('setting up an episode, in a browser', { skip }, () => {
  let ui; let person; let media;
  before(async () => {
    ui = await startUi();
    person = await ui.newPerson();
    media = tempDir('ui-media');
    mkdirSync(join(media, 'My Show'));
    makeVideo(join(media, 'My Show', 'Episode 1.mp4'), { seconds: 3 });
    mkdirSync(join(media, 'No Videos'));
    writeFileSync(join(media, 'No Videos', 'notes.txt'), 'nothing to see');
    await firstRun(person.page, ui.origin, { email: 'editor@example.com', office: 'Test Office' });
    await person.page.getByRole('button', { name: 'New Episode' }).click();
    await person.page.waitForURL(/\/setup/);
  });
  after(async () => { await ui?.stop(); removeTree(media); });

  const fileInput = () => person.page.locator('input[type=file]').first();

  it('explains what is missing before anything is uploaded', async () => {
    const { page } = person;
    await page.getByRole('button', { name: 'Automate' }).click();
    await page.getByText('Please select or drop a folder first.').waitFor();
  });

  it('refuses a folder with no videos in it', async () => {
    const { page } = person;
    await fileInput().setInputFiles(join(media, 'No Videos'));
    await page.getByText('Folder should contain video files (.mp4, .mov, .avi, .mkv, .mxf)').waitFor();
  });

  it('counts the videos in a folder it accepts', async () => {
    const { page } = person;
    await fileInput().setInputFiles(join(media, 'My Show'));
    await page.getByText('My Show', { exact: true }).waitFor();
    await page.getByText(/1 video/).waitFor();
    assert.equal(await page.locator('input[type=number]').first().inputValue(), '1');
  });

  it('starts with all 13 steps chosen, and the All and None buttons change that', async () => {
    const { page } = person;
    await page.getByText('13 of 13 steps selected').waitFor();
    await page.getByRole('button', { name: 'None', exact: true }).click();
    await page.getByText('0 of 13 steps selected').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Automate' }).isDisabled(), true);
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.getByText('13 of 13 steps selected').waitFor();
  });

  it('wants the Drive folder when a step needs Drive', async () => {
    const { page } = person;
    await page.getByRole('button', { name: 'Automate' }).click();
    await page.getByText('Paste the Google Drive folder link where this episode should be stored.').waitFor();
  });

  it('recognises a Drive folder link as it is typed, and says when it is not one', async () => {
    const { page } = person;
    const field = page.getByPlaceholder('https://drive.google.com/drive/folders/...');
    await field.fill('not a link');
    await page.getByText('That link does not look like a Drive folder.').waitFor();
    await field.fill(`https://drive.google.com/drive/folders/${DEST}?usp=sharing`);
    await waitFor(async () => (await page.locator('svg.text-success').count()) > 0, { timeout: 10000, what: 'the green tick' });
    assert.equal(await page.getByText('That link does not look like a Drive folder.').count(), 0);
    await shot(page, '04-setup-ready');
  });
});

describe('working offline, in a browser', { skip }, () => {
  let ui; let person; let media;
  before(async () => {
    ui = await startUi();
    person = await ui.newPerson();
    media = tempDir('ui-media');
    mkdirSync(join(media, 'Offline Show'));
    makeVideo(join(media, 'Offline Show', 'Offline 1.mp4'), { seconds: 2 });
    await firstRun(person.page, ui.origin, { email: 'editor@example.com', office: 'Test Office' });
  });
  after(async () => { await ui?.stop(); removeTree(media); });

  it('still copies and compresses when the session service cannot be reached', async () => {
    const { page, context } = person;
    // from here on the sync service is unreachable, as on a Mac with no internet
    await context.unroute(/akashvani-session\.fly\.dev/);
    await context.route(/akashvani-session\.fly\.dev/, (route) => route.abort('internetdisconnected'));

    await page.getByRole('button', { name: 'New Episode' }).click();
    await page.waitForURL(/\/setup/);
    await page.locator('input[type=file]').first().setInputFiles(join(media, 'Offline Show'));
    await page.getByText(/1 video/).waitFor();
    await page.getByRole('button', { name: 'None', exact: true }).click();
    // the first two checkboxes are Copy and Compress
    await page.locator('input[type=checkbox]').nth(0).check();
    await page.locator('input[type=checkbox]').nth(1).check();
    await page.getByText('2 of 13 steps selected').waitFor();
    await page.getByRole('button', { name: 'Automate' }).click();
    await page.waitForURL(/\/pipeline/);
    assert.ok(!/code=AK-/.test(page.url()), 'no share code was made');
    await stepIs(page, STEP.compress, 'DONE');
    const out = join(ui.app.home, 'Documents', 'Akashvani Workflow', 'workflows');
    await waitFor(() => existsSync(out), { what: 'the workflow folder' });
    assert.equal(ui.sessions.sql('select count(*) from sessions'), '0', 'nothing reached the session service');
  });
});

describe('the whole workflow, an editor and two Language Experts on two Macs', { skip }, () => {
  let ui; let editor; let reviewer; let mac2; let media; let code; let sessionId;
  const drivePath = (rel) => `Dest/Episode 1/episode - 1/${rel}`;
  const driveFile = (rel) => ui.fake.findByPath(drivePath(rel));

  before(async () => {
    ui = await startUi();
    media = tempDir('ui-media');
    mkdirSync(join(media, 'Show'));
    makeVideo(join(media, 'Show', 'Episode 1.mp4'), { seconds: 3 });
    writeFileSync(join(media, 'ep.srt'), SRT);
    writeFileSync(join(media, 'Show.prproj'), '<PremiereData/>');
    writeFileSync(join(media, 'final.srt'), SRT.replace('second line', 'second line, corrected'));

    editor = await ui.newPerson();
    await firstRun(editor.page, ui.origin, { email: 'editor@example.com', office: 'Mumbai Office' });
    mac2 = await ui.addMac();
    reviewer = await ui.newPerson();
  });
  after(async () => { await ui?.stop(); removeTree(media); });

  it('editor: sets up the episode and runs it; copy, compress and the Drive upload finish by themselves', async () => {
    const { page } = editor;
    await page.getByRole('button', { name: 'New Episode' }).click();
    await page.waitForURL(/\/setup/);
    await page.locator('input[type=file]').first().setInputFiles(join(media, 'Show'));
    await page.getByText(/1 video/).waitFor();
    await page.getByPlaceholder('https://drive.google.com/drive/folders/...').fill(`https://drive.google.com/drive/folders/${DEST}`);
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Automate' }).click();
    await page.waitForURL(/\/pipeline/);
    code = /code=(AK-[A-Z0-9]{4})/.exec(page.url())?.[1];
    sessionId = /sessionId=([^&]+)/.exec(page.url())?.[1];
    assert.ok(code, 'a share code was made');

    await stepIs(page, STEP.compress, 'DONE');
    await stepIs(page, STEP.drive, 'DONE');
    await stepIs(page, STEP.subtitles, 'AWAITING ACTION');
    assert.ok(driveFile('Source Video/Episode 1_compressed.mp4'), 'the video is on Drive');
    assert.equal(ui.sessions.sql(`select drive_folder_id || '|' || drive_parent_name || '|' || editor_email from sessions where code='${code}'`), `${DEST}|Episode 1|editor@example.com`);
    await shot(page, '10-editor-running');
  });

  it('editor: with no Sarvam key, says so and takes an .srt by hand, which goes to Drive with a Word copy', async () => {
    const { page } = editor;
    await page.getByText(/Automatic subtitles are switched off on this computer/).waitFor();
    assert.match(await page.locator('body').innerText(), /Application Support\/Akashvani Workflow/, 'names the Mac settings file');
    await page.locator('summary', { hasText: 'Or upload an .srt yourself' }).click();
    await page.locator('input[type=file][accept*=".srt"]').first().setInputFiles(join(media, 'ep.srt'));
    await page.getByRole('button', { name: 'Upload SRT' }).click();
    await stepIs(page, STEP.subtitles, 'DONE');
    assert.equal(driveFile('AI Subtitles/ep.srt').content.toString('utf8'), SRT);
    assert.equal(driveFile('AI Subtitles/ep.docx').content.subarray(0, 2).toString(), 'PK');
  });

  it('Language Expert 1, on another Mac: joins with the code and uploads the corrected Word file', async () => {
    const { page } = reviewer;
    await connectDrive(page, mac2.origin, { email: 'le1@example.com', office: 'Review Office', role: 'le' });
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(/\/join/);

    await page.getByPlaceholder('AK-XXXX').fill('AK-ZZZZ');
    await page.getByRole('button', { name: /LE 1/ }).click();
    await page.getByRole('button', { name: 'Join Session' }).click();
    await page.getByText(/not found|Session not found|Failed/i).first().waitFor({ timeout: 10000 });

    await page.getByPlaceholder('AK-XXXX').fill(code.toLowerCase());
    assert.equal(await page.getByPlaceholder('AK-XXXX').inputValue(), code, 'the code is upper-cased as typed');
    await page.getByRole('button', { name: 'Join Session' }).click();
    await page.waitForURL(/\/pipeline/);
    await page.getByText('Viewing as LE 1').waitFor();
    assert.match(page.url(), new RegExp(`driveFolderId=${DEST}`));
    assert.match(page.url(), /driveParentName=Episode\+1/);
    assert.equal(ui.sessions.sql(`select le1_email from sessions where code='${code}'`), 'le1@example.com');

    const word = join(media, 'ep-corrected.docx');
    writeFileSync(word, driveFile('AI Subtitles/ep.docx').content);
    await page.locator('input[type=file][accept*=".doc"]').first().setInputFiles(word);
    await page.getByRole('button', { name: 'Upload Word File' }).click();
    await stepIs(page, STEP.le1, 'DONE');
    assert.ok(driveFile('LE 1/ep-corrected.docx'));
    const srtBack = driveFile('LE 1/ep-corrected.srt');
    assert.ok(srtBack, 'the Word file was turned back into an .srt');
    assert.equal(srtBack.content.toString('utf8').replace(/\r/g, '').trim(), SRT.trim());
    await shot(page, '11-le1-done');
  });

  it('editor: sees the review arrive (the page checks the shared session every 15 seconds)', async () => {
    const { page } = editor;
    await waitFor(async () => (await status(page, STEP.le1)) === 'DONE', { timeout: 60000, what: 'LE 1 done on the editor page' });
    assert.equal(await status(page, STEP.align), 'DONE', 'alignment is ticked off with it');
    assert.equal(ui.sessions.sql(`select step_states->>'review-pass1' from sessions where code='${code}'`), 'complete');
  });

  it('editor: adds the Premiere project, the Word-to-subtitles step runs by itself, then marks the quality check done', async () => {
    const { page } = editor;
    await row(page, STEP.prproj).click();
    await page.locator('input[type=file][accept*=".prproj"]').first().setInputFiles(join(media, 'Show.prproj'));
    await page.getByRole('button', { name: 'Upload Project' }).click();
    await stepIs(page, STEP.prproj, 'DONE');
    assert.ok(existsSync(join(ui.app.home, 'Documents', 'Akashvani Workflow', 'workflows', sessionId, 'akashwani-structure', 'Editor', 'Show.prproj')));

    await stepIs(page, STEP.wordToSrt, 'DONE');
    await row(page, STEP.qc).click();
    await page.getByRole('button', { name: /mark as done/i }).click();
    await stepIs(page, STEP.qc, 'DONE');
  });

  it('Language Expert 3: joins for the final pass and uploads the final .srt', async () => {
    const final = await ui.newPerson();
    const { page } = final;
    await connectDrive(page, mac2.origin, { email: 'le3@example.com', office: 'Review Office', role: 'le' });
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(/\/join/);
    await page.getByPlaceholder('AK-XXXX').fill(code);
    await page.getByRole('button', { name: /LE 3/ }).click();
    await page.getByRole('button', { name: 'Join Session' }).click();
    await page.waitForURL(/\/pipeline/);
    await page.getByText('Viewing as LE 3').waitFor();
    await page.locator('input[type=file][accept*=".srt"]').first().setInputFiles(join(media, 'final.srt'));
    await page.getByRole('button', { name: 'Upload Final SRT' }).click();
    await stepIs(page, STEP.le3, 'DONE');
    assert.match(driveFile('LE 3/final.srt').content.toString('utf8'), /second line, corrected/);
    assert.equal(ui.sessions.sql(`select le3_email from sessions where code='${code}'`), 'le3@example.com');
  });

  it('editor: the final pass arrives, the automatic steps finish, and only the Roman script step is left, waiting for its key', async () => {
    const { page } = editor;
    await waitFor(async () => (await status(page, STEP.le3)) === 'DONE', { timeout: 60000, what: 'LE 3 done on the editor page' });
    await stepIs(page, STEP.sls, 'DONE');
    await stepIs(page, STEP.slc, 'DONE');
    const left = [];
    for (const [key, name] of Object.entries(STEP)) if ((await status(page, name)) !== 'DONE') left.push(key);
    assert.deepEqual(left, ['roman'], 'every step except the Roman script is done');
    await row(page, STEP.roman).click();
    await page.getByText(/ANTHROPIC_API_KEY|Roman script/).first().waitFor();
    assert.equal(editor.errors.length, 0, editor.errors.join('\n'));
    await shot(page, '12-editor-almost-done');
  });

  it('editor: closing and reopening the page keeps the progress', async () => {
    const { page } = editor;
    await page.reload();
    await row(page, STEP.compress).waitFor();
    await waitFor(async () => (await status(page, STEP.le3)) === 'DONE' && (await status(page, STEP.drive)) === 'DONE', { timeout: 30000, what: 'finished steps to come back after a reload' });
  });

  it('editor: the episode is on the home screen with its progress, and can be reopened', async () => {
    const { page } = editor;
    await page.goto(ui.origin + '/editor');
    await page.getByText('Show', { exact: true }).first().waitFor();
    const body = await page.locator('body').innerText();
    assert.match(body, /AK-[A-Z0-9]{4}/);
    await shot(page, '13-editor-list');
  });
});
