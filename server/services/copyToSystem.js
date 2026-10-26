import { copyFile, mkdir } from 'fs/promises';
import { basename, join } from 'path';
import { SYSTEM_INTAKE_DIR } from '../paths.js';

export async function copyToSystem(inputPaths, onProgress, onLog) {
  const destDir = process.env.SYSTEM_INTAKE_PATH || SYSTEM_INTAKE_DIR;
  await mkdir(destDir, { recursive: true });

  onLog(`Destination: ${destDir}`);
  const results = [];

  for (let i = 0; i < inputPaths.length; i++) {
    const input = inputPaths[i];
    const dest = join(destDir, basename(input));

    onLog(`Copying ${basename(input)}...`);
    await copyFile(input, dest);

    const progress = Math.round(((i + 1) / inputPaths.length) * 100);
    onProgress(progress);
    onLog(`✓ ${basename(input)} → system intake`);
    results.push(dest);
  }

  return results;
}
