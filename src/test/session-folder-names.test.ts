// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const where = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../server/paths.js', () => ({
  get WORKFLOWS_DIR() { return where.dir; },
}));

import { updateSessionState, findSessionByFolderName, markSessionDeleted } from '../../server/services/sessionState.js';

beforeEach(() => { where.dir = mkdtempSync(join(tmpdir(), 'akashvani-sessions-')); });
afterEach(() => rmSync(where.dir, { recursive: true, force: true }));

describe('finding an episode by its folder name', () => {
  it('ignores case and surrounding spaces', async () => {
    await updateSessionState('s1', { folderName: 'Monsoon Diaries' });
    expect((await findSessionByFolderName('  monsoon DIARIES '))?.sessionId).toBe('s1');
  });

  it('treats composed and decomposed accents as the same name', async () => {
    const composed = 'Café Nights';
    const decomposed = 'Café Nights';
    expect(composed).not.toBe(decomposed);

    await updateSessionState('s1', { folderName: composed });
    expect((await findSessionByFolderName(decomposed))?.sessionId).toBe('s1');

    await updateSessionState('s2', { folderName: decomposed + ' Two' });
    expect((await findSessionByFolderName(composed + ' Two'))?.sessionId).toBe('s2');
  });

  it('does the same for Devanagari letters that can be written as one character or as letter plus nukta', async () => {
    const oneCharacter = '\u0929';       // NNNA
    const letterAndNukta = '\u0928\u093c'; // NA + nukta, which is the same letter
    expect(oneCharacter).not.toBe(letterAndNukta);
    await updateSessionState('s1', { folderName: oneCharacter });
    expect((await findSessionByFolderName(letterAndNukta))?.sessionId).toBe('s1');
    expect(await findSessionByFolderName('\u0928')).toBeNull();
  });

  it('does not match a different name, an empty name, or a deleted episode', async () => {
    await updateSessionState('s1', { folderName: 'One' });
    expect(await findSessionByFolderName('Two')).toBeNull();
    expect(await findSessionByFolderName('')).toBeNull();
    expect(await findSessionByFolderName(undefined as unknown as string)).toBeNull();

    await markSessionDeleted('s1');
    expect(await findSessionByFolderName('One')).toBeNull();
  });
});
