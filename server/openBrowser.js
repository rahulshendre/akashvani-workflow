/**
 * Open a URL in the user's default browser.
 *
 *   Windows - cmd's `start`, with an empty title argument
 *   macOS   - `open`
 *   others  - nothing
 *
 * The platform and the process spawner are passed in so the command for each OS can
 * be checked from any OS (see src/test/open-browser.test.ts).
 */

import { spawn } from 'child_process';

/** [command, args] that opens the URL, or null where there is no known way. */
export function openCommand(platform, url) {
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', url]];
  if (platform === 'darwin') return ['open', [url]];
  return null;
}

export function openInDefaultBrowser(url, { platform = process.platform, spawnFn = spawn, report = console.error } = {}) {
  const command = openCommand(platform, url);
  if (!command) return false;
  const [cmd, args] = command;
  const failed = (err) => {
    report('Could not open default browser:', err.message);
    report(`Open this URL manually: ${url}`);
  };
  try {
    const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore' });
    // A missing command is reported asynchronously, as an 'error' event.
    child.on?.('error', failed);
    child.unref?.();
    return true;
  } catch (err) {
    failed(err);
    return false;
  }
}
