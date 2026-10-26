import { Router } from 'express';
import {
  getDriveFolderMeta,
  isAuthenticated,
  isConfigured,
  getAuthUrl,
} from '../services/gdrive.js';
import { loadDriveTarget, saveDriveTarget } from '../paths.js';

const router = Router();

/**
 * Extract a folder ID from whatever the user pasted:
 *   https://drive.google.com/drive/folders/<ID>?usp=sharing
 *   https://drive.google.com/drive/u/0/folders/<ID>
 *   <ID>
 */
function parseFolderId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const urlMatch = raw.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];

  const idMatch = raw.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (idMatch) return idMatch[1];

  // Bare ID — Drive IDs are opaque but always URL-safe base64-ish
  if (/^[A-Za-z0-9_-]{10,}$/.test(raw)) return raw;

  return null;
}

/** Guard shared by every route that touches the Drive API. */
function requireAuth(res) {
  if (!isConfigured()) {
    res.status(503).json({ error: 'Google credentials are not configured in config.env.' });
    return false;
  }
  if (!isAuthenticated()) {
    let authUrl = null;
    try { authUrl = getAuthUrl(); } catch { /* no client id */ }
    res.status(401).json({ error: 'Not connected to Google Drive.', needsAuth: true, authUrl });
    return false;
  }
  return true;
}

/**
 * GET /api/drive/target
 * The destination this machine last picked (pre-fills the picker).
 */
router.get('/target', (_req, res) => {
  res.json({ target: loadDriveTarget() });
});

/**
 * POST /api/drive/target   { folderId, folderName }
 * Remember the editor's chosen destination for the next episode.
 */
router.post('/target', (req, res) => {
  const { folderId, folderName } = req.body || {};
  if (!folderId) return res.status(400).json({ error: 'folderId is required' });
  try {
    saveDriveTarget({ folderId, folderName: folderName || 'Selected folder' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/drive/resolve   { input }
 * Validate a pasted folder link or ID and return its real name.
 */
router.post('/resolve', async (req, res) => {
  if (!requireAuth(res)) return;
  const folderId = parseFolderId(req.body?.input);
  if (!folderId) {
    return res.status(400).json({ error: "That doesn't look like a Drive folder link or ID." });
  }
  try {
    const meta = await getDriveFolderMeta(folderId);
    res.json({ folder: meta });
  } catch (err) {
    const notFound = /not found|404|insufficient/i.test(err.message);
    res.status(notFound ? 404 : 500).json({
      error: notFound
        ? "Couldn't open that folder. Make sure the signed-in Google account has access to it."
        : err.message,
    });
  }
});

export default router;
