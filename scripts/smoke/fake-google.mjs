/**
 * A stand-in for the Google endpoints the app talks to: OAuth token exchange,
 * the signed-in user's profile, and the parts of the Drive v3 API the pipeline
 * uses (list, get, create folder, multipart upload).
 *
 * It lets the packaged app go through the whole Drive flow with no Google account
 * and no network. Start it, then run the app with
 *
 *   HTTPS_PROXY=<proxyUrl>  NODE_TLS_REJECT_UNAUTHORIZED=0
 *   GOOGLE_CLIENT_ID=fake   GOOGLE_CLIENT_SECRET=fake
 *
 * The app's Google client (googleapis, via gaxios) honours HTTPS_PROXY. The proxy
 * sends every googleapis.com and google.com connection to the fake server below
 * and lets anything else (for example the Sarvam API) through to the real host.
 * The certificate is self-signed, hence NODE_TLS_REJECT_UNAUTHORIZED=0 for the
 * app under test only.
 *
 * The Drive tree is kept in memory so a test can check exactly what was created
 * and what bytes were uploaded.
 */

import http from 'http';
import https from 'https';
import net from 'net';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

const FOLDER = 'application/vnd.google-apps.folder';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Drive's `q` escapes backslash and single quote with a backslash. */
function unescapeQ(s) {
  return s.replace(/\\(['\\])/g, '$1');
}

/** Parse a multipart/related upload into its JSON metadata and the file bytes. */
function parseMultipartRelated(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary) throw new Error('no multipart boundary');
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = body.indexOf(delimiter);
  while (pos !== -1) {
    const next = body.indexOf(delimiter, pos + delimiter.length);
    if (next === -1) break;
    // skip the CRLF after the delimiter and the CRLF before the next one
    parts.push(body.subarray(pos + delimiter.length + 2, next - 2));
    pos = next;
  }
  const split = (part) => {
    const at = part.indexOf('\r\n\r\n');
    return { headers: part.subarray(0, at).toString('utf8'), content: part.subarray(at + 4) };
  };
  if (parts.length < 2) throw new Error('multipart body has fewer than two parts');
  const meta = split(parts[0]);
  const media = split(parts[1]);
  return { metadata: JSON.parse(meta.content.toString('utf8')), media: media.content };
}

export async function startFakeGoogle({ email = 'tester@example.com', name = 'Test Editor' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-google-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '2', '-subj', '/CN=fake-google',
  ], { stdio: 'ignore' });

  /** id -> { id, name, mimeType, parents, content? } */
  const files = new Map();
  /** every request the fake served: { method, host, path, query } */
  const requests = [];
  /** ids that answer 404 / are view only, so tests can check the app's handling */
  const hidden = new Set();
  const viewOnly = new Set();
  const tokenCodes = [];
  let nextId = 1;

  const newId = () => `fake${String(nextId++).padStart(4, '0')}${randomBytes(6).toString('hex')}`;
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // Google repeats the message inside errors[]; the Google client builds its error text from there.
  const notFound = (res) => json(res, 404, {
    error: { code: 404, message: 'File not found.', errors: [{ message: 'File not found.', domain: 'global', reason: 'notFound' }] },
  });

  const meta = (f) => ({
    id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents,
    capabilities: { canAddChildren: !viewOnly.has(f.id) },
  });

  function list(q) {
    const parent = /'((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
    const nameMatch = /name='((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
    const wantFolder = q.includes(`mimeType='${FOLDER}'`);
    return [...files.values()].filter((f) =>
      !hidden.has(f.id)
      && (parent === undefined || f.parents?.includes(unescapeQ(parent)))
      && (nameMatch === undefined || f.name === unescapeQ(nameMatch))
      && (!wantFolder || f.mimeType === FOLDER));
  }

  const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, async (req, res) => {
    const url = new URL(req.url, 'https://fake');
    const record = { method: req.method, host: req.headers.host, path: url.pathname, query: Object.fromEntries(url.searchParams) };
    requests.push(record);
    try {
      const { pathname } = url;

      if (req.method === 'POST' && pathname === '/token') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        tokenCodes.push(form.get('code'));
        return json(res, 200, {
          access_token: `fake-access-${randomBytes(4).toString('hex')}`,
          refresh_token: 'fake-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email',
        });
      }

      if (req.method === 'GET' && pathname === '/oauth2/v2/userinfo') {
        return json(res, 200, { id: '1', email, name });
      }

      if (req.method === 'GET' && pathname === '/drive/v3/files') {
        return json(res, 200, { files: list(url.searchParams.get('q') || '').map((f) => ({ id: f.id })) });
      }

      const one = /^\/drive\/v3\/files\/([^/]+)$/.exec(pathname);
      if (req.method === 'GET' && one) {
        const f = files.get(decodeURIComponent(one[1]));
        if (!f || hidden.has(f.id)) return notFound(res);
        return json(res, 200, meta(f));
      }

      if (req.method === 'POST' && pathname === '/drive/v3/files') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const f = { id: newId(), name: body.name, mimeType: body.mimeType || 'application/octet-stream', parents: body.parents || [] };
        files.set(f.id, f);
        return json(res, 200, { id: f.id });
      }

      if (req.method === 'POST' && pathname === '/upload/drive/v3/files') {
        const raw = await readBody(req);
        const { metadata, media } = parseMultipartRelated(raw, req.headers['content-type'] || '');
        const f = {
          id: newId(), name: metadata.name, mimeType: metadata.mimeType || 'application/octet-stream',
          parents: metadata.parents || [], content: media,
        };
        files.set(f.id, f);
        return json(res, 200, { id: f.id, webViewLink: `https://drive.google.com/file/d/${f.id}/view` });
      }

      return json(res, 404, { error: { code: 404, message: `fake-google: no route for ${req.method} ${pathname}` } });
    } catch (err) {
      return json(res, 500, { error: { code: 500, message: `fake-google: ${err.message}` } });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const fakePort = server.address().port;

  const isGoogle = (host) => /(^|\.)(googleapis\.com|google\.com)$/i.test(host);
  const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end('this proxy only tunnels HTTPS'); });
  const sockets = new Set();
  proxy.on('connect', (req, client, head) => {
    const [host, port] = req.url.split(':');
    const upstream = isGoogle(host) ? net.connect(fakePort, '127.0.0.1') : net.connect(Number(port) || 443, host);
    sockets.add(client).add(upstream);
    const done = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', done);
    client.on('error', done);
    client.on('close', done);
    upstream.on('close', done);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));

  /** Create a folder directly, e.g. the Drive destination the editor pastes in Setup. */
  function seedFolder(id, folderName, parents = []) {
    files.set(id, { id, name: folderName, mimeType: FOLDER, parents });
    return id;
  }

  return {
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    files,
    requests,
    tokenCodes,
    hidden,
    viewOnly,
    seedFolder,
    /** All items whose name matches, with their path from the root, e.g. "Dest/clip/episode - 1/Source Video/clip.mp4". */
    paths() {
      const pathOf = (f) => {
        const chain = [f.name];
        let cur = f;
        while (cur.parents?.length && files.has(cur.parents[0])) {
          cur = files.get(cur.parents[0]);
          chain.unshift(cur.name);
        }
        return chain.join('/');
      };
      return [...files.values()].map((f) => ({ path: pathOf(f), file: f }));
    },
    findByPath(path) {
      return this.paths().find((p) => p.path === path)?.file ?? null;
    },
    async stop() {
      for (const s of sockets) s.destroy();
      await Promise.all([
        new Promise((r) => proxy.close(r)),
        new Promise((r) => server.close(r)),
      ]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
