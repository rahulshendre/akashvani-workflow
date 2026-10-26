import express from 'express';
import cors from 'cors';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config as loadEnv } from 'dotenv';

import uploadRouter from './routes/upload.js';
import pipelineRouter from './routes/pipeline.js';
import authRouter from './routes/auth.js';
import setupRouter from './routes/setup.js';
import driveRouter from './routes/drive.js';
import {
  IS_PACKAGED,
  APP_ROOT,
  USER_DATA_DIR,
  UPLOADS_DIR,
  WORKFLOWS_DIR,
  SYSTEM_INTAKE_DIR,
  CONFIG_ENV_PATH,
  CONFIG_IN_SUPPORT_DIR,
  FRONTEND_DIR,
  describePaths,
} from './paths.js';
import { seedConfig } from './configSeed.js';
import { openInDefaultBrowser } from './openBrowser.js';
import {
  logStartup, logInfo, logWarn, logError, installCrashHandlers, LOG_DIR,
} from './services/logger.js';

// Nothing below may fail silently: a packaged exe has no console, so an
// uncaught error would just close the window with no explanation anywhere.
installCrashHandlers();

// ── 1. Load .env (from config.env next to .exe in prod, server/.env in dev) ──
// On macOS the file is in the user's Application Support folder and is created
// here from the copies shipped inside the app.
if (CONFIG_IN_SUPPORT_DIR) {
  try {
    seedConfig({
      configPath: CONFIG_ENV_PATH,
      templatePath: join(APP_ROOT, 'config.env.template'),
      defaultsPath: join(APP_ROOT, 'config.defaults.env'),
    });
  } catch (err) {
    logWarn(`Could not prepare ${CONFIG_ENV_PATH}: ${err.message}`);
  }
}
loadEnv({ path: CONFIG_ENV_PATH });
// In dev we also let a project-root .env override (e.g. ENCODE_MODE=2pass)
if (!IS_PACKAGED) loadEnv();

// ── 2. Ensure all user data directories exist ────────────────────────────────
mkdirSync(USER_DATA_DIR, { recursive: true });
mkdirSync(UPLOADS_DIR, { recursive: true });
mkdirSync(WORKFLOWS_DIR, { recursive: true });
mkdirSync(SYSTEM_INTAKE_DIR, { recursive: true });

const app = express();
const PORT = parseInt(process.env.PORT || '3001');

// ── 3. Middleware ────────────────────────────────────────────────────────────
// In dev the Vite dev server (port 8080) calls the API via its /api proxy →
// same origin from the browser's POV, so CORS is mostly belt-and-braces. In
// packaged mode the frontend is served by Express itself (same origin), so
// CORS is irrelevant — but we still allow it explicitly to avoid surprises.
app.use(cors({
  origin: IS_PACKAGED ? true : (process.env.FRONTEND_URL || 'http://localhost:8080'),
  credentials: true,
}));
app.use(express.json());

// One line per API call. Enough to reconstruct what a user did without dumping
// bodies (which would put file contents and tokens on disk).
app.use('/api', (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    const line = `${req.method} ${req.originalUrl.split('?')[0]} -> ${res.statusCode} (${ms}ms)`;
    if (res.statusCode >= 500) logError(line);
    else if (res.statusCode >= 400) logWarn(line);
    else if (ms > 5000) logWarn(`${line}  [slow]`);
    else logInfo(line);
  });
  next();
});

// ── 4. API routes ────────────────────────────────────────────────────────────
app.use('/api/upload', uploadRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/auth', authRouter);
app.use('/api/setup', setupRouter);
app.use('/api/drive', driveRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── 5. Serve the built frontend (packaged mode only) ─────────────────────────
//    In dev, Vite serves the React app on :8080 and proxies /api here, so this
//    block is skipped entirely.
if (IS_PACKAGED && FRONTEND_DIR && existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));

  // SPA fallback: any non-/api GET that didn't match a static file returns
  // index.html so React Router can handle client-side routes.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(FRONTEND_DIR, 'index.html'));
  });
}

// ── 6. Boot + open browser (packaged mode only) ──────────────────────────────
const server = app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('\nAkashvani backend ready');
  console.log(describePaths());
  console.log(`→ ${url}\n`);

  logStartup({ port: PORT, url, ...describePaths() });

  if (IS_PACKAGED) openInDefaultBrowser(url);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const msg = `Port ${PORT} is already in use - another copy of Akashvani is probably still running.`;
    console.error('\n' + msg);
    logError(msg, { port: PORT });
  } else {
    console.error('\nServer failed to start:', err);
    logError('Server failed to start', err);
  }
  process.exit(1);
});
