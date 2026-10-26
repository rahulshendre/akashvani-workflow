/**
 * Restarting the app after the first-run storage choice.
 *
 * The data folder is read once at startup, so picking a new one means starting a
 * fresh copy of the app. The new copy has to find port 3001 free: if it starts
 * while this one still listens, it logs "port in use" and exits, and both copies
 * are gone. So the port is released first, and only then is the new copy started.
 */

import { spawn } from 'child_process';

let httpServer = null;

/** Called once from index.js with the listening server. */
export function registerServer(server) {
  httpServer = server;
}

export function restartApp({
  server = httpServer,
  spawnFn = spawn,
  execPath = process.execPath,
  exit = (code) => process.exit(code),
  graceMs = 600,
  closeTimeoutMs = 3000,
} = {}) {
  let relaunched = false;
  const relaunch = () => {
    if (relaunched) return;
    relaunched = true;
    try {
      spawnFn(execPath, [], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
    setTimeout(() => exit(0), graceMs);
  };

  if (!server) return relaunch();

  // Do not wait forever for a connection that will not close.
  setTimeout(relaunch, closeTimeoutMs).unref?.();
  server.close(relaunch);
  server.closeAllConnections?.();
}
