import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import DriveSetup from '@/pages/DriveSetup';

const GB = 1024 ** 3;

vi.mock('@/lib/api', () => ({
  fetchDrives: vi.fn(),
  configureDataDir: vi.fn().mockResolvedValue(undefined),
  checkBackendHealth: vi.fn().mockResolvedValue(true),
}));

import { fetchDrives } from '@/lib/api';

describe('first-run storage picker', () => {
  it('lists macOS locations by name, with no drive letter', async () => {
    vi.mocked(fetchDrives).mockResolvedValue([
      { name: 'Home folder', root: '/Users/editor', total: 500 * GB, free: 200 * GB, used: 300 * GB,
        suggestedPath: '/Users/editor/Documents/Akashvani Workflow' },
      { name: 'Footage', root: '/Volumes/Footage', total: 2000 * GB, free: 1500 * GB, used: 500 * GB,
        suggestedPath: '/Volumes/Footage/Akashvani Workflow' },
    ]);
    await act(async () => { render(<DriveSetup />); });

    expect(screen.getByText('Home folder')).toBeTruthy();
    fireEvent.click(screen.getByText('Footage'));
    expect(screen.getAllByText('/Volumes/Footage/Akashvani Workflow').length).toBeGreaterThan(0);
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it('still shows the drive letter badge on Windows', async () => {
    vi.mocked(fetchDrives).mockResolvedValue([
      { letter: 'D', name: 'D:\\', root: 'D:\\', total: 1000 * GB, free: 900 * GB, used: 100 * GB,
        suggestedPath: 'D:\\Akashvani Workflow' },
    ]);
    await act(async () => { render(<DriveSetup />); });

    expect(screen.getByText('D:')).toBeTruthy();
    expect(screen.getByText('D:\\')).toBeTruthy();
  });
});
