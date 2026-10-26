import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { ShareSessionDialog } from '@/components/ShareSessionDialog';

// Count how many times a session is actually created.
const createSharedSession = vi.fn(async () => ({ code: 'AK-TEST' }));
vi.mock('@/lib/session-sync', () => ({
  createSharedSession: (...args: unknown[]) => createSharedSession(...(args as [])),
}));

/**
 * Stands in for Index.tsx: rebuilds the sessionData object on every render, the
 * way a component driven by a 100ms timer does.
 */
function Host() {
  const [tick, setTick] = useState(0);
  return (
    <>
      <button data-testid="tick" onClick={() => setTick(t => t + 1)}>{tick}</button>
      <ShareSessionDialog
        sessionData={{ sessionId: 's-1', folderName: 'ep', episodeCount: 1 }}
        onClose={() => {}}
        onCodeGenerated={() => {}}
      />
    </>
  );
}

describe('ShareSessionDialog', () => {
  beforeEach(() => createSharedSession.mockClear());

  it('creates exactly one session no matter how often the parent re-renders', async () => {
    const { getByTestId } = render(<Host />);
    await waitFor(() => expect(createSharedSession).toHaveBeenCalledTimes(1));

    // Simulate 40 parent re-renders — the pipeline timer fires ~10x/second, so
    // this is about four seconds with the dialog open. Regression guard: this
    // used to mint a new session on every single one.
    for (let i = 0; i < 40; i++) {
      await act(async () => { getByTestId('tick').click(); });
    }

    expect(createSharedSession).toHaveBeenCalledTimes(1);
  });

  it('does not create a session when a code already exists', async () => {
    render(
      <ShareSessionDialog
        sessionData={{ sessionId: 's-2' }}
        existingCode="AK-KEEP"
        onClose={() => {}}
      />
    );
    await act(async () => {});
    expect(createSharedSession).not.toHaveBeenCalled();
  });
});
