import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import DriveSetup from '@/pages/DriveSetup';

const GB = 1024 ** 3;

vi.mock('@/lib/api', () => ({
  fetchDrives: vi.fn(),
  configureDataDir: vi.fn(),
  checkBackendHealth: vi.fn(),
}));

import { fetchDrives, configureDataDir, checkBackendHealth } from '@/lib/api';

const mac = [
  { name: 'Home folder', root: '/Users/editor', total: 500 * GB, free: 200 * GB, used: 300 * GB,
    suggestedPath: '/Users/editor/Documents/Akashvani Workflow' },
  { name: 'Footage', root: '/Volumes/Footage', total: 2000 * GB, free: 1500 * GB, used: 500 * GB,
    suggestedPath: '/Volumes/Footage/Akashvani Workflow' },
];

const mounted = async () => { await act(async () => { render(<DriveSetup />); }); };

beforeEach(() => {
  vi.mocked(fetchDrives).mockResolvedValue(mac);
  vi.mocked(configureDataDir).mockResolvedValue(undefined);
  vi.mocked(checkBackendHealth).mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('first-run storage picker', () => {
  it('lists macOS locations by name, with no drive letter', async () => {
    await mounted();
    expect(screen.getByText('Home folder')).toBeTruthy();
    fireEvent.click(screen.getByText('Footage'));
    expect(screen.getAllByText('/Volumes/Footage/Akashvani Workflow').length).toBeGreaterThan(0);
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it('still shows the drive letter badge on Windows', async () => {
    vi.mocked(fetchDrives).mockResolvedValue([
      { letter: 'D', name: 'D:\\', root: 'D:\\', total: 1000 * GB, free: 900 * GB, used: 100 * GB, suggestedPath: 'D:\\Akashvani Workflow' },
    ]);
    await mounted();
    expect(screen.getByText('D:')).toBeTruthy();
    expect(screen.getByText('D:\\')).toBeTruthy();
  });

  it('shows free and total space for each location', async () => {
    await mounted();
    expect(screen.getByText('200.0 GB free')).toBeTruthy();
    expect(screen.getByText('of 500.0 GB')).toBeTruthy();
    expect(screen.getByText('1500.0 GB free')).toBeTruthy();
  });

  it('cannot be confirmed until a location is chosen', async () => {
    await mounted();
    const confirm = screen.getByRole('button', { name: /confirm location/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByText('Home folder'));
    expect(confirm.disabled).toBe(false);
    expect(screen.getByText(/will be created at/i).parentElement?.textContent).toContain('/Users/editor/Documents/Akashvani Workflow');
  });

  it('says so when there is nothing to choose from', async () => {
    vi.mocked(fetchDrives).mockResolvedValue([]);
    await mounted();
    expect(screen.getByText('No drives detected.')).toBeTruthy();
  });

  it('saves the chosen path, waits for the restarted app, then goes to the home page', async () => {
    vi.useFakeTimers();
    const location = { href: '/drive-setup' };
    vi.stubGlobal('location', location);
    // the new copy is not up for the first two checks
    vi.mocked(checkBackendHealth).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);

    await mounted();
    fireEvent.click(screen.getByText('Footage'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /confirm location/i })); });

    expect(configureDataDir).toHaveBeenCalledWith('/Volumes/Footage/Akashvani Workflow');
    expect(screen.getByText('Location saved!')).toBeTruthy();
    expect(screen.getByText(/restarting/i)).toBeTruthy();
    expect(location.href).toBe('/drive-setup');

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(location.href).toBe('/drive-setup');
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(checkBackendHealth).toHaveBeenCalledTimes(3);
    expect(location.href).toBe('/');
    vi.unstubAllGlobals();
  });

  it('stops waiting after about a minute if the app never comes back', async () => {
    vi.useFakeTimers();
    const location = { href: '/drive-setup' };
    vi.stubGlobal('location', location);
    vi.mocked(checkBackendHealth).mockResolvedValue(false);

    await mounted();
    fireEvent.click(screen.getByText('Home folder'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /confirm location/i })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500 * 60); });

    expect(vi.mocked(checkBackendHealth).mock.calls.length).toBeLessThanOrEqual(40);
    expect(location.href).toBe('/drive-setup');
    vi.unstubAllGlobals();
  });

  it('shows the reason and offers a retry when the folder cannot be created', async () => {
    vi.mocked(configureDataDir).mockRejectedValue(new Error('Failed to create directory: EACCES'));
    await mounted();
    fireEvent.click(screen.getByText('Home folder'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /confirm location/i })); });
    expect(screen.getByText('Failed to create directory: EACCES')).toBeTruthy();

    vi.mocked(fetchDrives).mockClear();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /retry/i })); });
    expect(fetchDrives).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Home folder')).toBeTruthy();
  });

  it('shows the reason and offers a retry when the list cannot be loaded', async () => {
    vi.mocked(fetchDrives).mockRejectedValueOnce(new Error('Failed to list drives'));
    await mounted();
    expect(screen.getByText('Failed to list drives')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /retry/i })); });
    expect(screen.getByText('Home folder')).toBeTruthy();
  });

  it('warns about a nearly full disk', async () => {
    vi.mocked(fetchDrives).mockResolvedValue([
      { name: 'Tight', root: '/Volumes/Tight', total: 1000 * GB, free: 50 * GB, used: 950 * GB, suggestedPath: '/Volumes/Tight/Akashvani Workflow' },
    ]);
    await mounted();
    const label = screen.getByText('5% free');
    expect(label.className).toMatch(/destructive/);
  });
});
