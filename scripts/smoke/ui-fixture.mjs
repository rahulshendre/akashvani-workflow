/**
 * Everything the browser tests need, in one place: the built app, a stand-in for Google,
 * the real session service on a throwaway PostgreSQL, and Chrome wired to them.
 *
 *   - Chrome is the one installed on this Mac (Playwright channel "chrome"), headless.
 *   - Requests to akashvani-session.fly.dev go to the local session service instead.
 *   - Google's consent screen is answered at once: the browser is sent straight back to the
 *     app's own callback with a code and the same state, as it would be after a real approval.
 *
 * Pages use http://localhost:<port> (not 127.0.0.1) because the app's OAuth redirect does.
 */

import { chromium } from 'playwright';
import { existsSync } from 'fs';
import { BIN, startApp, freePort, which } from './harness.mjs';
import { startFakeGoogle } from './fake-google.mjs';
import { startSessionService, sessionServiceAvailable } from './session-service.mjs';

export const CHROME = '/Applications/Google Chrome.app';
export const DEST = 'DestFolderId1234567890';

export function uiSkipReason() {
  if (!existsSync(BIN)) return `no server binary at ${BIN}; run npm run build:mac`;
  if (!existsSync(CHROME)) return 'Google Chrome is not installed';
  if (!which('ffmpeg') || !which('ffprobe')) return 'ffmpeg and ffprobe must be on PATH to make test videos';
  const svc = sessionServiceAvailable();
  return svc || false;
}

export async function startUi({ appEnv = {}, defaults = '' } = {}) {
  const fake = await startFakeGoogle();
  fake.seedFolder(DEST, 'Dest');
  const sessions = await startSessionService();
  const macs = [];

  /** Another copy of the app on its own port and home folder: a second Mac, for example a Language Expert's. */
  async function addMac(extraEnv = {}) {
    const port = await freePort();
    const app = await startApp({
      port,
      defaults,
      env: {
        HTTPS_PROXY: fake.proxyUrl,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        GOOGLE_CLIENT_ID: 'fake-client-id.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'fake-client-secret',
        GOOGLE_REDIRECT_URI: `http://localhost:${port}/api/auth/google/callback`,
        ...appEnv,
        ...extraEnv,
      },
    });
    const mac = { app, port, origin: `http://localhost:${port}` };
    macs.push(mac);
    return mac;
  }

  const first = await addMac();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });

  /** A fresh browser profile: its own storage, so it is its own person. */
  async function newPerson() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route(/akashvani-session\.fly\.dev/, async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const res = await fetch(sessions.url + u.pathname + u.search, {
        method: req.method(),
        headers: { 'Content-Type': 'application/json' },
        body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postData() ?? undefined,
      });
      await route.fulfill({
        status: res.status,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: await res.text(),
      });
    });
    await context.route(/accounts\.google\.com\/o\/oauth2/, async (route) => {
      const u = new URL(route.request().url());
      const back = new URL(u.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'fake-code');
      if (u.searchParams.get('state')) back.searchParams.set('state', u.searchParams.get('state'));
      await route.fulfill({ status: 302, headers: { Location: back.toString() } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    return { context, page, errors };
  }

  return {
    app: first.app, origin: first.origin, port: first.port,
    fake, sessions, browser, newPerson, addMac,
    async stop() {
      await browser.close();
      for (const mac of macs) { await mac.app.stop(); mac.app.cleanup(); }
      await sessions.stop();
      await fake.stop();
    },
  };
}

/** Sign in on the Welcome screen through the (fake) Google consent screen. Leaves the person on Welcome, connected. */
export async function connectDrive(page, origin, { email, office, role = 'editor' }) {
  await page.goto(origin + '/');
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('e.g. Mumbai Office').fill(office);
  if (role === 'le') await page.getByText('Language Expert').click();
  // a Mac that is already signed in to Google (another person used it first) shows "Connected as" at once
  await page.getByText(/Connected as|^Connect$/).first().waitFor();
  if (await page.getByRole('button', { name: 'Connect' }).count()) {
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.waitForURL(/auth_success/);
  }
  await page.getByText(/Connected as/).waitFor();
}
