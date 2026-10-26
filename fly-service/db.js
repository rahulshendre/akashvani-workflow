import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // This app sits behind an auto-stopping Fly machine and a Postgres that drops
  // idle connections. Without these, a pooled client goes stale and the next
  // query fails with "Connection terminated unexpectedly".
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

// An error on an IDLE client is emitted on the pool, not on any query. Without
// a listener here Node treats it as an unhandled 'error' event and takes the
// process down — which is how a single dropped connection became an outage.
pool.on('error', (err) => {
  console.error('[pg] idle client error (pool will recycle it):', err.message);
});

const RETRYABLE = [
  'Connection terminated unexpectedly',
  'Client has encountered a connection error',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now — still booting
];

function isRetryable(err) {
  const text = `${err?.code ?? ''} ${err?.message ?? ''}`;
  return RETRYABLE.some((needle) => text.includes(needle));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a query, retrying once or twice when the failure is a dropped/stale
 * connection rather than a real SQL error. A stale pooled client must not
 * surface to the desktop app as "could not reach the sync server".
 */
export async function query(text, params) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      console.warn(`[pg] retrying after connection error (attempt ${attempt + 1}):`, err.message);
      await sleep(200 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS sessions (
      code           TEXT PRIMARY KEY,
      session_id     TEXT NOT NULL,
      folder_name    TEXT,
      episode_count  INTEGER DEFAULT 1,
      selected_steps JSONB DEFAULT '[]',
      step_states    JSONB DEFAULT '{}',
      current_step   TEXT,
      editor_email   TEXT,
      office_name    TEXT,
      status         TEXT DEFAULT 'active',
      drive_folder_id   TEXT,
      drive_parent_name TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Migrate existing tables that may lack newer columns
  await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS editor_email TEXT`);
  await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS office_name TEXT`);
  await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`);
  // Drive destination — the LE's machine reads these to upload into the same folder
  await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS drive_folder_id TEXT`);
  await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS drive_parent_name TEXT`);

  // Listing by editor is the app's home screen query
  await query(`CREATE INDEX IF NOT EXISTS sessions_editor_email_idx ON sessions (editor_email)`);

  // Who reviewed each pass. Previously a Language Expert's identity never left
  // their own machine, so there was no record of who completed a review.
  await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS le1_email TEXT`);
  await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS le2_email TEXT`);
  await query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS le3_email TEXT`);

  // Everyone who has signed in, whichever role they chose.
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      email        TEXT PRIMARY KEY,
      office_name  TEXT,
      role         TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS users_office_idx ON users (office_name)`);
}

export { pool };
