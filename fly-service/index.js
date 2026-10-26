import express from 'express';
import { query, initDb } from './db.js';

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let code = 'AK-';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function uniqueCode() {
  for (let i = 0; i < 10; i++) {
    const code = generateCode();
    const { rows } = await query('SELECT code FROM sessions WHERE code = $1', [code]);
    if (rows.length === 0) return code;
  }
  throw new Error('Could not generate unique code');
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * POST /users   { email, officeName, role }
 *
 * Called when someone signs in on the Welcome screen, whichever role they pick.
 * Upsert, so signing in again refreshes their office/role and last-seen rather
 * than erroring. This is the only record that a Language Expert exists at all —
 * before it, their identity never left their own machine.
 */
app.post('/users', async (req, res) => {
  const { email, officeName, role } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });
  if (!['editor', 'le'].includes(role)) {
    return res.status(400).json({ error: "role must be 'editor' or 'le'" });
  }

  try {
    const { rows } = await query(
      `INSERT INTO users (email, office_name, role)
       VALUES (lower($1), $2, $3)
       ON CONFLICT (email) DO UPDATE
         SET office_name = EXCLUDED.office_name,
             role        = EXCLUDED.role,
             last_seen_at = NOW()
       RETURNING email, office_name, role, created_at, last_seen_at`,
      [email, officeName || null, role]
    );
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /users — everyone who has signed in, newest activity first. */
app.get('/users', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT email, office_name, role, created_at, last_seen_at
       FROM users ORDER BY last_seen_at DESC LIMIT 200`
    );
    res.json({ users: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /users/:email */
app.get('/users/:email', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT email, office_name, role, created_at, last_seen_at FROM users WHERE email = lower($1)',
      [req.params.email]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /sessions
 * Body: { sessionId, folderName, episodeCount, selectedSteps, stepStates, currentStep, editorEmail, officeName }
 */
app.post('/sessions', async (req, res) => {
  const {
    sessionId, folderName, episodeCount, selectedSteps, stepStates, currentStep,
    editorEmail, officeName, driveFolderId, driveParentName,
  } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  try {
    const code = await uniqueCode();
    await query(
      `INSERT INTO sessions (code, session_id, folder_name, episode_count, selected_steps, step_states, current_step, editor_email, office_name, drive_folder_id, drive_parent_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        code,
        sessionId,
        folderName || null,
        episodeCount || 1,
        JSON.stringify(selectedSteps || []),
        JSON.stringify(stepStates || {}),
        currentStep || null,
        editorEmail || null,
        officeName || null,
        driveFolderId || null,
        driveParentName || null,
      ]
    );
    res.status(201).json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /sessions/by-email/:email
 * List all sessions for an editor, newest first.
 */
app.get('/sessions/by-email/:email', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT code, session_id, folder_name, episode_count, selected_steps, step_states,
              current_step, status, office_name, drive_folder_id, drive_parent_name,
              le1_email, le2_email, le3_email,
              created_at, updated_at
       FROM sessions
       WHERE editor_email = $1
       ORDER BY updated_at DESC
       LIMIT 50`,
      [req.params.email.toLowerCase()]
    );
    res.json({ sessions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /sessions/:code
 */
app.get('/sessions/:code', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM sessions WHERE code = $1', [req.params.code.toUpperCase()]);
    if (rows.length === 0) return res.status(404).json({ error: 'Session not found. Check the code and try again.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /sessions/:code
 * Body: { stepStates?, currentStep?, status?, folderName? }
 */
app.patch('/sessions/:code', async (req, res) => {
  const {
    stepStates, currentStep, status, folderName, driveFolderId, driveParentName,
    leEmail, leRole,
  } = req.body;
  try {
    const { rows } = await query('SELECT * FROM sessions WHERE code = $1', [req.params.code.toUpperCase()]);
    if (rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    const existing = rows[0];
    const newStepStates = stepStates
      ? { ...existing.step_states, ...stepStates }
      : existing.step_states;
    const newCurrentStep = currentStep !== undefined ? currentStep : existing.current_step;
    const newStatus = status || existing.status;
    const newFolderName = folderName !== undefined ? folderName : existing.folder_name;
    const newDriveFolderId = driveFolderId !== undefined ? driveFolderId : existing.drive_folder_id;
    const newDriveParentName = driveParentName !== undefined ? driveParentName : existing.drive_parent_name;

    // Record which Language Expert is on this session, in their own column.
    const leColumn = { le1: 'le1_email', le2: 'le2_email', le3: 'le3_email' }[leRole];
    const newLe1 = leColumn === 'le1_email' && leEmail ? leEmail.toLowerCase() : existing.le1_email;
    const newLe2 = leColumn === 'le2_email' && leEmail ? leEmail.toLowerCase() : existing.le2_email;
    const newLe3 = leColumn === 'le3_email' && leEmail ? leEmail.toLowerCase() : existing.le3_email;

    await query(
      `UPDATE sessions
       SET step_states = $1, current_step = $2, status = $3, folder_name = $4,
           drive_folder_id = $5, drive_parent_name = $6,
           le1_email = $7, le2_email = $8, le3_email = $9,
           updated_at = NOW()
       WHERE code = $10`,
      [
        JSON.stringify(newStepStates), newCurrentStep, newStatus, newFolderName,
        newDriveFolderId, newDriveParentName,
        newLe1, newLe2, newLe3, req.params.code.toUpperCase(),
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /sessions/:code
 * Removes the shared record so it stops showing in the editor's list.
 * Local files on the editor's machine and anything already on Drive are
 * untouched — this only forgets the session, it does not destroy work.
 */
app.delete('/sessions/:code', async (req, res) => {
  try {
    const { rowCount } = await query(
      'DELETE FROM sessions WHERE code = $1',
      [req.params.code.toUpperCase()]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Session not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /sessions/:code/poll
 */
app.get('/sessions/:code/poll', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT step_states, current_step, updated_at FROM sessions WHERE code = $1',
      [req.params.code.toUpperCase()]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3002;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`akashvani-session ready on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
