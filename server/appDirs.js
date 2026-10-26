/**
 * Per-user folders for the packaged app: the data-folder preference, the config
 * file on macOS, and the logs.
 *
 * Pure on purpose. The platform, environment and home folder are passed in, so
 * the answer for every OS can be checked from any OS (see src/test/app-dirs.test.ts).
 * Nothing here touches the disk.
 */

import path from 'path';

const APP_NAME = 'Akashvani Workflow';

function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 *   Windows — %LOCALAPPDATA%\Akashvani Workflow
 *   macOS   — ~/Library/Application Support/Akashvani Workflow
 */
export function supportDir(platform, env, home) {
  const p = pathFor(platform);
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', APP_NAME);
  return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), APP_NAME);
}

/**
 *   Windows — %LOCALAPPDATA%\Akashvani Workflow\logs
 *   macOS   — ~/Library/Logs/Akashvani Workflow (the folder Console.app reads)
 */
export function logDir(platform, env, home) {
  const p = pathFor(platform);
  if (platform === 'darwin') return p.join(home, 'Library', 'Logs', APP_NAME);
  return p.join(supportDir(platform, env, home), 'logs');
}
