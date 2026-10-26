/**
 * Copy non-code runtime assets (watermark image, etc.) into dist-server/
 * so they get picked up by the installer build.
 *
 * Run with:  node scripts/bundle-resources.mjs
 *      or:   npm run bundle:resources
 */

import { copyFile, mkdir } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const SRC_DIR   = join(ROOT, 'server', 'assets');
const DEST_DIR  = join(ROOT, 'dist-server', 'resources');

const FILES = [
  'watermark.png',
];

function fmtKB(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

async function main() {
  await mkdir(DEST_DIR, { recursive: true });

  let copied = 0;
  for (const name of FILES) {
    const src = join(SRC_DIR, name);
    const dst = join(DEST_DIR, name);
    if (!existsSync(src)) {
      console.error(`✗ ${name} missing from ${SRC_DIR}`);
      process.exit(1);
    }
    await copyFile(src, dst);
    console.log(`  ✓ ${name} (${fmtKB(statSync(dst).size)})`);
    copied++;
  }

  console.log(`Done. ${copied} file(s) copied to ${DEST_DIR}`);
}

main().catch((err) => {
  console.error('\nbundle:resources failed:', err.message);
  process.exit(1);
});
