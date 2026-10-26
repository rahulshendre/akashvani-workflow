/**
 * The storage locations the first-run picker offers.
 *
 *   Windows — every fixed drive letter that exists (C:\ to Z:\)
 *   macOS   — the home folder, plus every writable disk mounted under /Volumes
 *
 * Space is read with fs.statfsSync, so no external commands are needed. The
 * filesystem calls are passed in so the lists can be tested without the real
 * disks (see src/test/volumes.test.ts).
 */

import * as nodeFs from 'fs';
import path from 'path';

function describe(fs, root, extra) {
  const stats = fs.statfsSync(root);
  const total = stats.blocks * stats.bsize;
  const free = stats.bfree * stats.bsize;
  if (total === 0) return null; // optical drive with no disc
  return { root, total, free, used: total - free, ...extra };
}

function windowsDrives(fs) {
  const drives = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    if (!fs.existsSync(root)) continue;
    try {
      const drive = describe(fs, root, { name: root, letter, suggestedPath: `${letter}:\\Akashvani Workflow` });
      if (drive) drives.push(drive);
    } catch {
      // not accessible (locked, optical, network): skip silently
    }
  }
  return drives;
}

function macVolumes(fs, home) {
  const drives = [];
  const add = (root, name, suggestedPath) => {
    try {
      const drive = describe(fs, root, { name, suggestedPath });
      if (drive) drives.push(drive);
    } catch {
      // not accessible: skip silently
    }
  };

  add(home, 'Home folder', path.posix.join(home, 'Documents', 'Akashvani Workflow'));

  let names = [];
  try {
    names = fs.readdirSync('/Volumes');
  } catch {
    return drives;
  }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const root = path.posix.join('/Volumes', name);
    try {
      if (fs.realpathSync(root) === '/') continue; // "Macintosh HD" is a link to the startup disk
      if (!fs.statSync(root).isDirectory()) continue;
      fs.accessSync(root, nodeFs.constants.W_OK); // read-only disk images cannot hold the workflow
    } catch {
      continue;
    }
    add(root, name, path.posix.join(root, 'Akashvani Workflow'));
  }
  return drives;
}

export function listDrives({ platform = process.platform, home, fs = nodeFs } = {}) {
  if (platform === 'win32') return windowsDrives(fs);
  if (platform === 'darwin') return macVolumes(fs, home);
  return [];
}
