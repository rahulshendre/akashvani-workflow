// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { listDrives } from '../../server/volumes.js';

const GB = 1024 ** 3;
const stat = (totalGB: number, freeGB: number) => ({ blocks: totalGB, bsize: GB, bfree: freeGB });

function fakeFs(disks: Record<string, { total: number; free: number }>, extra: Record<string, unknown> = {}) {
  return {
    existsSync: (p: string) => p in disks,
    statfsSync: (p: string) => {
      if (!(p in disks)) throw new Error('ENOENT');
      return stat(disks[p].total, disks[p].free);
    },
    readdirSync: () => [] as string[],
    realpathSync: (p: string) => p,
    statSync: () => ({ isDirectory: () => true }),
    accessSync: () => {},
    ...extra,
  };
}

describe('Windows drives', () => {
  it('lists the drive letters that exist, with space and the folder to create', () => {
    const fs = fakeFs({ 'C:\\': { total: 500, free: 100 }, 'D:\\': { total: 1000, free: 900 } });
    const drives = listDrives({ platform: 'win32', home: 'C:\\Users\\a', fs });
    expect(drives.map(d => d.letter)).toEqual(['C', 'D']);
    expect(drives[1]).toMatchObject({
      name: 'D:\\', root: 'D:\\', total: 1000 * GB, free: 900 * GB, used: 100 * GB,
      suggestedPath: 'D:\\Akashvani Workflow',
    });
  });

  it('skips a drive with no disc in it', () => {
    const fs = fakeFs({ 'C:\\': { total: 500, free: 100 }, 'E:\\': { total: 0, free: 0 } });
    expect(listDrives({ platform: 'win32', home: '', fs }).map(d => d.letter)).toEqual(['C']);
  });
});

describe('macOS volumes', () => {
  const home = '/Users/editor';
  const disks = {
    [home]: { total: 500, free: 200 },
    '/Volumes/Footage': { total: 2000, free: 1500 },
    '/Volumes/Installer': { total: 1, free: 0 },
  };

  it('offers the home folder first, suggesting the Documents folder', () => {
    const drives = listDrives({ platform: 'darwin', home, fs: fakeFs(disks) });
    expect(drives[0]).toMatchObject({
      name: 'Home folder', root: home, suggestedPath: '/Users/editor/Documents/Akashvani Workflow',
    });
    expect(drives[0].letter).toBeUndefined();
  });

  it('adds mounted disks, skips the startup disk link and hidden entries', () => {
    const fs = fakeFs(disks, {
      readdirSync: () => ['Macintosh HD', 'Footage', '.timemachine'],
      realpathSync: (p: string) => (p === '/Volumes/Macintosh HD' ? '/' : p),
    });
    const drives = listDrives({ platform: 'darwin', home, fs });
    expect(drives.map(d => d.name)).toEqual(['Home folder', 'Footage']);
    expect(drives[1]).toMatchObject({
      root: '/Volumes/Footage', free: 1500 * GB, suggestedPath: '/Volumes/Footage/Akashvani Workflow',
    });
  });

  it('skips read-only disks', () => {
    const fs = fakeFs(disks, {
      readdirSync: () => ['Footage', 'Installer'],
      accessSync: (p: string) => { if (p.endsWith('Installer')) throw new Error('EROFS'); },
    });
    expect(listDrives({ platform: 'darwin', home, fs }).map(d => d.name)).toEqual(['Home folder', 'Footage']);
  });

  it('still returns the home folder when /Volumes cannot be read', () => {
    const fs = fakeFs(disks, { readdirSync: () => { throw new Error('EACCES'); } });
    expect(listDrives({ platform: 'darwin', home, fs }).map(d => d.name)).toEqual(['Home folder']);
  });
});

describe('other platforms', () => {
  it('returns nothing', () => {
    expect(listDrives({ platform: 'linux', home: '/home/a', fs: fakeFs({}) })).toEqual([]);
  });
});
