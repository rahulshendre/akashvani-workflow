import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import Welcome, { saveIdentity, loadIdentity, clearIdentity } from '@/pages/Welcome';
import Join from '@/pages/Join';

vi.mock('@/lib/session-sync', () => ({
  fetchSharedSession: vi.fn(),
  updateSharedSession: vi.fn().mockResolvedValue(undefined),
  registerUser: vi.fn().mockResolvedValue(null),
  ROLE_STEPS: { le1: ['review-pass1', 'align-srt'], le3: ['review-pass3'] },
  ROLE_LABELS: { editor: 'Editor', le1: 'LE 1', le3: 'LE 3' },
}));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/" element={<Welcome />} />
        <Route path="/join" element={<Join />} />
        <Route path="/editor" element={<div>editor home</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => localStorage.clear());

describe('identity switching', () => {
  it('sends a returning Language Expert straight to /join', async () => {
    saveIdentity({ email: 'bhagyashree@planetread.org', officeName: 'Delhi', role: 'le' });
    renderAt('/');
    await act(async () => {});
    expect(screen.getByTestId('loc').textContent).toBe('/join');
  });

  // REGRESSION: a saved Language Expert role used to be permanent. Welcome
  // redirected to /join on every launch, and /join's only link went back to '/',
  // which redirected straight to /join again — an inescapable loop.
  it('lets a Language Expert escape to the Welcome form', async () => {
    saveIdentity({ email: 'bhagyashree@planetread.org', officeName: 'Delhi', role: 'le' });
    renderAt('/join');
    await act(async () => {});

    await act(async () => { screen.getByText('Sign in as Editor').click(); });

    expect(loadIdentity()).toBeNull();
    expect(screen.getByTestId('loc').textContent).toBe('/?switch=1');
  });

  it('shows the form instead of redirecting when ?switch is present', async () => {
    saveIdentity({ email: 'bhagyashree@planetread.org', officeName: 'Delhi', role: 'le' });
    renderAt('/?switch=1');
    await act(async () => {});
    // Still on Welcome, with the form rendered rather than bounced to /join.
    expect(screen.getByTestId('loc').textContent).toBe('/?switch=1');
    expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();
  });

  it('surfaces the signed-in account on /join so a wrong role is visible', async () => {
    saveIdentity({ email: 'bhagyashree@planetread.org', officeName: 'Delhi', role: 'le' });
    renderAt('/join');
    await act(async () => {});
    expect(screen.getByText(/bhagyashree@planetread\.org/)).toBeTruthy();
    expect(screen.getByText('Log out')).toBeTruthy();
  });

  it('clearIdentity removes the stored record', () => {
    saveIdentity({ email: 'x@y.org', officeName: 'O', role: 'editor' });
    expect(loadIdentity()).not.toBeNull();
    clearIdentity();
    expect(loadIdentity()).toBeNull();
  });
});
