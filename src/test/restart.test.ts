// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { restartApp } from '../../server/restart.js';

afterEach(() => vi.useRealTimers());

function fakeServer() {
  const calls: string[] = [];
  let finish = () => {};
  return {
    calls,
    finish: () => finish(),
    server: {
      close: (cb: () => void) => { calls.push('close'); finish = cb; },
      closeAllConnections: () => { calls.push('closeAllConnections'); },
    },
  };
}

describe('restartApp', () => {
  it('stops listening before it starts the new copy', () => {
    vi.useFakeTimers();
    const { server, calls, finish } = fakeServer();
    const spawnFn = vi.fn(() => { calls.push('spawn'); return { unref: () => {} }; });
    const exit = vi.fn();

    restartApp({ server, spawnFn, exit, execPath: '/app/Akashvani' });
    expect(spawnFn).not.toHaveBeenCalled();

    finish();
    expect(calls).toEqual(['close', 'closeAllConnections', 'spawn']);
    expect(spawnFn).toHaveBeenCalledWith('/app/Akashvani', [], { detached: true, stdio: 'ignore' });

    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(600);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('starts the new copy anyway if the server will not finish closing', () => {
    vi.useFakeTimers();
    const { server } = fakeServer();
    const spawnFn = vi.fn(() => ({ unref: () => {} }));
    restartApp({ server, spawnFn, exit: vi.fn(), closeTimeoutMs: 3000 });

    vi.advanceTimersByTime(2999);
    expect(spawnFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('starts only one new copy when both the close and the timeout fire', () => {
    vi.useFakeTimers();
    const { server, finish } = fakeServer();
    const spawnFn = vi.fn(() => ({ unref: () => {} }));
    restartApp({ server, spawnFn, exit: vi.fn(), closeTimeoutMs: 3000 });

    finish();
    vi.advanceTimersByTime(5000);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('still restarts when there is no server to close', () => {
    vi.useFakeTimers();
    const spawnFn = vi.fn(() => ({ unref: () => {} }));
    const exit = vi.fn();
    restartApp({ server: null, spawnFn, exit });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
