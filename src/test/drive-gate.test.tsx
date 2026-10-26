import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import Welcome, { saveIdentity } from '@/pages/Welcome';

const fetchAuthStatus = vi.fn();
vi.mock('@/lib/api', () => ({
  fetchAuthStatus: (...a: unknown[]) => fetchAuthStatus(...(a as [])),
}));
vi.mock('@/lib/session-sync', () => ({
  registerUser: vi.fn().mockResolvedValue(null),
}));

function Probe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

const renderAt = (path = '/') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
      <Routes>
        <Route path="/" element={<Welcome />} />
        <Route path="/editor" element={<div>editor home</div>} />
        <Route path="/join" element={<div>join screen</div>} />
      </Routes>
    </MemoryRouter>
  );

const CONNECTED = { authenticated: true, configured: true, email: 'abinash@planetread.org' };
const NEEDS_AUTH = { authenticated: false, configured: true, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' };
const NOT_CONFIGURED = { authenticated: false, configured: false };

beforeEach(() => {
  localStorage.clear();
  fetchAuthStatus.mockReset();
});

describe('Google Drive gate on the first screen', () => {
  it('offers Connect when Drive is not authenticated', async () => {
    fetchAuthStatus.mockResolvedValue(NEEDS_AUTH);
    await act(async () => { renderAt(); });

    expect(screen.getByText('Google Drive')).toBeTruthy();
    expect(screen.getByText('Connect')).toBeTruthy();
    expect(screen.getByText(/never stop the workflow later/)).toBeTruthy();
  });

  it('shows the connected account instead of a prompt', async () => {
    fetchAuthStatus.mockResolvedValue(CONNECTED);
    await act(async () => { renderAt(); });

    expect(screen.getByText(/Connected as abinash@planetread\.org/)).toBeTruthy();
    expect(screen.queryByText('Connect')).toBeNull();
  });

  it('refuses to continue while Drive is unconnected', async () => {
    fetchAuthStatus.mockResolvedValue(NEEDS_AUTH);
    await act(async () => { renderAt(); });

    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.org' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Mumbai Office'), { target: { value: 'Delhi' } });
    await act(async () => { fireEvent.click(screen.getByText('Continue')); });

    expect(screen.getByText(/Connect Google Drive first/)).toBeTruthy();
    expect(screen.getByTestId('loc').textContent).toBe('/');
  });

  it('lets a signed-in user through once Drive is connected', async () => {
    saveIdentity({ email: 'a@b.org', officeName: 'Delhi', role: 'editor' });
    fetchAuthStatus.mockResolvedValue(CONNECTED);
    await act(async () => { renderAt(); });

    expect(screen.getByTestId('loc').textContent).toBe('/editor');
  });

  // THE important case: tokens are in-memory, so every app restart lands here.
  // If the redirect fired anyway, the Google prompt would reappear mid-pipeline —
  // exactly the behaviour this change exists to remove.
  it('holds a returning user on this screen when the token is gone', async () => {
    saveIdentity({ email: 'a@b.org', officeName: 'Delhi', role: 'editor' });
    fetchAuthStatus.mockResolvedValue(NEEDS_AUTH);
    await act(async () => { renderAt(); });

    expect(screen.getByTestId('loc').textContent).toBe('/');
    expect(screen.getByText('One more thing')).toBeTruthy();
    expect(screen.getByText('Connect')).toBeTruthy();
  });

  it('does not trap anyone when Drive is not configured at all', async () => {
    saveIdentity({ email: 'a@b.org', officeName: 'Delhi', role: 'le' });
    fetchAuthStatus.mockResolvedValue(NOT_CONFIGURED);
    await act(async () => { renderAt(); });

    // Nothing to connect to — sending them onward beats a dead end.
    expect(screen.getByTestId('loc').textContent).toBe('/join');
  });

  it('survives the status check failing outright', async () => {
    fetchAuthStatus.mockRejectedValue(new Error('backend down'));
    await act(async () => { renderAt(); });

    expect(screen.getByText('Welcome')).toBeTruthy();
  });
});
