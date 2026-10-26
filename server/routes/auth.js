import { Router } from 'express';
import { getAuthUrl, handleAuthCallback, isAuthenticated, isConfigured, getAuthenticatedClient } from '../services/gdrive.js';
import { google } from 'googleapis';
import { IS_PACKAGED } from '../paths.js';

const router = Router();

function frontendBase() {
  // Read at request time so dotenv values are already loaded and PORT is known.
  // Packaged exe: frontend is served by Express on the same port as the backend.
  // Dev: Vite serves the frontend on 8080.
  return process.env.FRONTEND_URL || (
    IS_PACKAGED
      ? `http://localhost:${process.env.PORT || '3001'}`
      : 'http://localhost:8080'
  );
}

function buildFrontendRedirect(extraParams = {}) {
  const url = new URL(frontendBase());
  url.pathname = '/pipeline';
  Object.entries(extraParams).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  return url.toString();
}

/**
 * OAuth `state` carries where to come back to.
 *
 * Two shapes, because two flows need different things:
 *   "r:<base64url of /path?query>" — return the user to the exact page they left.
 *       Used by review uploads. Without it a Language Expert came back to a bare
 *       /pipeline with no code, role or step filter, which looked like a
 *       completely different session.
 *   "<sessionId>" — the editor's Drive step, which resumes at the Drive upload.
 */
export function encodeReturnTo(pathWithQuery) {
  return `r:${Buffer.from(pathWithQuery, 'utf8').toString('base64url')}`;
}

function decodeState(state) {
  if (typeof state !== 'string' || !state) return { returnTo: null, sessionId: undefined };

  if (state.startsWith('r:')) {
    try {
      const decoded = Buffer.from(state.slice(2), 'base64url').toString('utf8');
      // Only accept same-origin relative paths — never redirect somewhere arbitrary.
      if (decoded.startsWith('/') && !decoded.startsWith('//')) {
        return { returnTo: decoded, sessionId: undefined };
      }
    } catch { /* fall through to treating it as a session id */ }
    return { returnTo: null, sessionId: undefined };
  }

  return { returnTo: null, sessionId: state };
}

/** Rebuild the page the user left, preserving its params, plus auth outcome. */
function buildReturnRedirect(returnTo, extraParams = {}) {
  const url = new URL(returnTo, frontendBase());
  Object.entries(extraParams).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  // These are ours to control, never inherited from the page we came from.
  url.searchParams.delete('resume_drive');
  return url.toString();
}

// GET /api/auth/status
router.get('/status', async (_req, res) => {
  if (!isConfigured()) {
    return res.json({ authenticated: false, configured: false });
  }
  if (!isAuthenticated()) {
    let authUrl;
    try { authUrl = getAuthUrl(); } catch { authUrl = null; }
    return res.json({ authenticated: false, configured: true, authUrl });
  }

  try {
    const auth = await getAuthenticatedClient();
    const oauth2 = google.oauth2({ version: 'v2', auth });
    const { data } = await oauth2.userinfo.get();
    res.json({ authenticated: true, configured: true, email: data.email, name: data.name });
  } catch {
    res.json({ authenticated: true, configured: true });
  }
});

// GET /api/auth/google  — redirect to consent screen
router.get('/google', (_req, res) => {
  try {
    const state = typeof _req.query.state === 'string' ? _req.query.state : undefined;
    res.redirect(getAuthUrl(state));
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// GET /api/auth/google/callback
router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const { returnTo, sessionId } = decodeState(state);

  const failure = (message) => returnTo
    ? buildReturnRedirect(returnTo, { auth_error: message })
    : buildFrontendRedirect({ auth_error: message, ...(sessionId ? { sessionId } : {}) });

  if (error) return res.redirect(failure(error));
  if (!code) return res.status(400).send('Missing code');

  try {
    await handleAuthCallback(code);

    // Came from a specific page (e.g. a Language Expert's review step) — go
    // straight back to it with every param intact so they keep their session.
    if (returnTo) {
      return res.redirect(buildReturnRedirect(returnTo, { auth_success: 1 }));
    }

    // Editor's Drive step: resume_drive (not autostart) so the full pipeline
    // does not re-run copy + compress after OAuth.
    res.redirect(buildFrontendRedirect({
      auth_success: 1,
      ...(sessionId ? { sessionId, resume_drive: 1 } : {}),
    }));
  } catch (err) {
    res.redirect(failure(err.message));
  }
});

export default router;
