import { Router } from 'express';
import { join } from 'path';
import { mkdirSync } from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { IS_PACKAGED, USER_DATA_DIR, isFirstRun, saveUserDataDir } from '../paths.js';
import { listDrives } from '../volumes.js';

const router = Router();

/** GET /api/setup/status — tells the frontend whether first-run picker is needed. */
router.get('/status', (_req, res) => {
  res.json({
    isFirstRun: isFirstRun(),
    currentDataDir: USER_DATA_DIR,
  });
});

/**
 * GET /api/setup/drives
 * Lists the places the data folder can go, with total and free space: fixed
 * drives on Windows, the home folder and mounted disks on macOS. See volumes.js.
 */
router.get('/drives', (_req, res) => {
  res.json({ drives: listDrives({ home: os.homedir() }) });
});

/**
 * POST /api/setup/configure
 * Body: { basePath: "D:\\Akashvani Workflow" }
 *
 * Saves the chosen directory to user-data-path.txt, creates the required
 * sub-directories, then restarts the app so paths reload cleanly.
 */
router.post('/configure', (req, res) => {
  if (!IS_PACKAGED) {
    return res.status(400).json({ error: 'Drive configuration is only available in the packaged app.' });
  }

  const { basePath } = req.body;
  if (!basePath || typeof basePath !== 'string' || !basePath.trim()) {
    return res.status(400).json({ error: 'basePath is required' });
  }

  const dataDir = basePath.trim();

  try {
    mkdirSync(join(dataDir, 'uploads'), { recursive: true });
    mkdirSync(join(dataDir, 'workflows'), { recursive: true });
    mkdirSync(join(dataDir, 'system-intake'), { recursive: true });
    saveUserDataDir(dataDir);
  } catch (err) {
    return res.status(500).json({ error: `Failed to create directory: ${err.message}` });
  }

  res.json({ ok: true, dataDir });

  // Spawn a new instance and exit current one. The 1.5s delay gives the
  // browser time to render the success screen before the connection drops.
  setTimeout(() => {
    try {
      spawn(process.execPath, [], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
    setTimeout(() => process.exit(0), 600);
  }, 1500);
});

export default router;
