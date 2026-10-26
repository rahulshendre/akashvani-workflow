/**
 * Runs the repo's real session service (fly-service/) against a throwaway PostgreSQL, so the
 * browser tests exercise the actual sign-in, share-code and polling code with no cloud.
 *
 * Needs PostgreSQL's server programs (initdb, pg_ctl, createdb) on PATH, for example
 * `brew install postgresql@14`, and the service's own dependencies: `cd fly-service && npm ci`.
 * The database lives in a temp folder and is removed on stop.
 */

import { spawn, execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, openSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ROOT, freePort, waitFor, which } from './harness.mjs';

const SERVICE_DIR = join(ROOT, 'fly-service');

export function sessionServiceAvailable() {
  if (!['initdb', 'pg_ctl', 'createdb'].every(which)) return 'PostgreSQL server programs (initdb, pg_ctl, createdb) are not on PATH';
  if (!existsSync(join(SERVICE_DIR, 'node_modules', 'pg'))) return 'run `npm ci` in fly-service first';
  return false;
}

export async function startSessionService() {
  const why = sessionServiceAvailable();
  if (why) throw new Error(why);

  const dir = mkdtempSync(join(tmpdir(), 'akashvani-pg-'));
  const data = join(dir, 'data');
  const pgPort = await freePort();
  execFileSync('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' });
  execFileSync('pg_ctl', ['-D', data, '-o', `-p ${pgPort} -k ${dir} -c listen_addresses=127.0.0.1`, '-l', join(dir, 'pg.log'), '-w', 'start'], { stdio: 'ignore' });
  execFileSync('createdb', ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'postgres', 'akashvani'], { stdio: 'ignore' });

  const port = await freePort();
  const out = openSync(join(dir, 'service.log'), 'a');
  const service = spawn(process.execPath, ['index.js'], {
    cwd: SERVICE_DIR,
    env: { PATH: process.env.PATH, PORT: String(port), DATABASE_URL: `postgres://postgres@127.0.0.1:${pgPort}/akashvani` },
    stdio: ['ignore', out, out],
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, { timeout: 20000, what: 'the session service' });

  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    /** Run SQL directly, to check what the service stored. */
    sql: (text) => spawnSync('psql', ['-h', '127.0.0.1', '-p', String(pgPort), '-U', 'postgres', '-d', 'akashvani', '-At', '-c', text], { encoding: 'utf8' }).stdout.trim(),
    async stop() {
      service.kill('SIGTERM');
      spawnSync('pg_ctl', ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
