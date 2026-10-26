// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { openCommand, openInDefaultBrowser } from '../../server/openBrowser.js';

const URL = 'http://localhost:3001';

function fakeSpawn() {
  const child = { handlers: {} as Record<string, (e: Error) => void>, unref: vi.fn(), on(event: string, fn: (e: Error) => void) { this.handlers[event] = fn; return this; } };
  const spawnFn = vi.fn(() => child);
  return { child, spawnFn };
}

describe('openCommand', () => {
  it('uses cmd start with an empty title on Windows', () => {
    expect(openCommand('win32', URL)).toEqual(['cmd', ['/c', 'start', '""', URL]]);
  });

  it('uses open on macOS', () => {
    expect(openCommand('darwin', URL)).toEqual(['open', [URL]]);
  });

  it('has no way to open a browser elsewhere', () => {
    expect(openCommand('linux', URL)).toBeNull();
  });
});

describe('openInDefaultBrowser', () => {
  it('starts the command detached and lets it outlive the app', () => {
    const { child, spawnFn } = fakeSpawn();
    expect(openInDefaultBrowser(URL, { platform: 'darwin', spawnFn, report: vi.fn() })).toBe(true);
    expect(spawnFn).toHaveBeenCalledWith('open', [URL], { detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalled();
  });

  it('does nothing on a platform it does not know', () => {
    const { spawnFn } = fakeSpawn();
    expect(openInDefaultBrowser(URL, { platform: 'linux', spawnFn, report: vi.fn() })).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('tells the user the address when the command is missing (reported as an event, as Node does)', () => {
    const { child, spawnFn } = fakeSpawn();
    const report = vi.fn();
    openInDefaultBrowser(URL, { platform: 'darwin', spawnFn, report });
    child.handlers.error(new Error('spawn open ENOENT'));
    expect(report).toHaveBeenCalledWith('Could not open default browser:', 'spawn open ENOENT');
    expect(report).toHaveBeenCalledWith(`Open this URL manually: ${URL}`);
  });

  it('tells the user the address when starting the command throws', () => {
    const report = vi.fn();
    const spawnFn = vi.fn(() => { throw new Error('EPERM'); });
    expect(openInDefaultBrowser(URL, { platform: 'win32', spawnFn, report })).toBe(false);
    expect(report).toHaveBeenCalledWith(`Open this URL manually: ${URL}`);
  });
});
