// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { encodeReturnTo } from '../../server/routes/auth.js';

/**
 * Mirrors the decode + redirect rebuild in the OAuth callback. Kept here so the
 * contract is pinned even though those helpers are module-private.
 */
function decodeReturnTo(state: string): string | null {
  if (!state.startsWith('r:')) return null;
  try {
    const decoded = Buffer.from(state.slice(2), 'base64url').toString('utf8');
    return decoded.startsWith('/') && !decoded.startsWith('//') ? decoded : null;
  } catch {
    return null;
  }
}

const LE_URL =
  '/pipeline?code=AK-4EKB&role=le1&steps=review-pass1,align-srt' +
  '&sessionId=s-le-123&driveFolderId=1ebyfpQgHCMz8WlP3UVY5OYy9vf0Ieb0c';

describe('OAuth return-to', () => {
  // REGRESSION: the callback used to always redirect to a bare /pipeline. A
  // Language Expert who authorized mid-upload came back with no code, no role
  // and no step filter — a blank, unfiltered pipeline that looked like someone
  // else's session, with their review unsubmitted.
  it('brings a Language Expert back with every param intact', () => {
    const returnTo = decodeReturnTo(encodeReturnTo(LE_URL));
    expect(returnTo).toBe(LE_URL);

    const url = new URL(returnTo!, 'http://localhost:3001');
    url.searchParams.set('auth_success', '1');
    url.searchParams.delete('resume_drive');

    const p = url.searchParams;
    expect(p.get('code')).toBe('AK-4EKB');
    expect(p.get('role')).toBe('le1');
    expect(p.get('steps')).toBe('review-pass1,align-srt');
    expect(p.get('sessionId')).toBe('s-le-123');
    expect(p.get('driveFolderId')).toBe('1ebyfpQgHCMz8WlP3UVY5OYy9vf0Ieb0c');
    expect(p.get('auth_success')).toBe('1');
    // resume_drive is an editor-only flow and must not leak into an LE return.
    expect(p.get('resume_drive')).toBeNull();
  });

  it('survives paths containing spaces and punctuation', () => {
    const tricky = '/pipeline?code=AK-1&driveParentName=ARNOLD INTERVIEW WITH PT. NEHRU P.M. OF INDIA';
    expect(decodeReturnTo(encodeReturnTo(tricky))).toBe(tricky);
  });

  it('refuses to redirect off-origin', () => {
    for (const bad of ['https://evil.example/x', '//evil.example/x', 'pipeline', '']) {
      const state = `r:${Buffer.from(bad, 'utf8').toString('base64url')}`;
      expect(decodeReturnTo(state)).toBeNull();
    }
  });

  it('treats a plain state as the editor session id, not a return path', () => {
    expect(decodeReturnTo('s-1785313851662-2t0zzy')).toBeNull();
  });
});
