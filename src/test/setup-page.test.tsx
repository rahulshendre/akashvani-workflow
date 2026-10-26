import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Setup from '@/pages/Setup';

vi.mock('@/lib/api', () => ({
  uploadFiles: vi.fn(),
  fetchDriveTarget: vi.fn().mockResolvedValue(null),
  saveDriveTarget: vi.fn().mockResolvedValue(undefined),
  parseDriveFolderId: (v: string) =>
    (v.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1] ?? null),
  DuplicateFolderError: class extends Error {},
}));
vi.mock('@/lib/session-sync', () => ({ createSharedSession: vi.fn() }));

const renderSetup = () =>
  render(<MemoryRouter><Setup /></MemoryRouter>);

beforeEach(() => localStorage.clear());

describe('Setup page', () => {
  // REGRESSION: the page rendered blank because JSX referenced state variables
  // (progress, autoDetected, openStep, duplicate) that were never declared.
  // The root tsconfig has "files": [], so `tsc --noEmit` checked nothing and
  // exited 0 — the crash reached a shipped build. Mounting it here is the check
  // that actually would have caught it.
  it('mounts without throwing', async () => {
    await act(async () => { renderSetup(); });
    expect(screen.getByText('Choose the episode folder')).toBeTruthy();
  });

  it('shows the three setup steps in the order the work happens', async () => {
    await act(async () => { renderSetup(); });
    const headings = ['Choose the episode folder', 'Where should it go on Google Drive?', 'What should the app do?']
      .map(t => screen.getByText(t));
    // Folder first, Drive second — the Drive box used to sit above the drop zone.
    expect(headings[0].compareDocumentPosition(headings[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(headings[1].compareDocumentPosition(headings[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('explains each step in plain language, not folder names', async () => {
    await act(async () => { renderSetup(); });
    expect(screen.getByText('Copy videos into the workspace')).toBeTruthy();
    expect(screen.getByText('Copies your videos from the external drive onto this computer.')).toBeTruthy();
    expect(screen.queryByText('Copy to Raw Footage')).toBeNull();
  });

  it('expands a step card to reveal the full explanation', async () => {
    await act(async () => { renderSetup(); });
    expect(screen.queryByText(/never moved or changed/)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByText('Copy videos into the workspace'));
    });
    expect(screen.getByText(/never moved or changed/)).toBeTruthy();
  });

  it('labels steps by who acts, not by internal jargon', async () => {
    await act(async () => { renderSetup(); });
    expect(screen.getAllByText('automatic').length).toBeGreaterThan(0);
    expect(screen.getAllByText('you do this').length).toBeGreaterThan(0);
    expect(screen.queryByText('AUTOMATED')).toBeNull();
  });

  it('hides the episode count until a folder is chosen', async () => {
    await act(async () => { renderSetup(); });
    // It is derived from the folder, so there is nothing to show beforehand.
    expect(screen.queryByText('Episodes detected:')).toBeNull();
  });
});
