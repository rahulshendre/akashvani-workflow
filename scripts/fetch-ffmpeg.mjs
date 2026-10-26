/**
 * Downloads the gyan.dev FFmpeg "essentials" build for Windows and extracts
 * ffmpeg.exe + ffprobe.exe into dist-server/ffmpeg/. Skips work if the binaries
 * are already in place.
 *
 * Run with:  node scripts/fetch-ffmpeg.mjs
 *      or:   npm run fetch:ffmpeg
 *
 * Source: https://www.gyan.dev/ffmpeg/builds/  (GPL "essentials" build, ~80 MB)
 * That URL 302s to a GitHub release asset; Node 18+ global fetch follows redirects.
 */

import { existsSync, mkdirSync, statSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, '..');
const FFMPEG_DIR = join(ROOT, 'dist-server', 'ffmpeg');
const CACHE_DIR  = join(ROOT, '.cache');
const CACHE_ZIP  = join(CACHE_DIR, 'ffmpeg-essentials.zip');

const SOURCE_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

const FFMPEG_EXE  = join(FFMPEG_DIR, 'ffmpeg.exe');
const FFPROBE_EXE = join(FFMPEG_DIR, 'ffprobe.exe');

function fmtMB(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  // ── Short-circuit if binaries already on disk ──────────────────────────────
  if (existsSync(FFMPEG_EXE) && existsSync(FFPROBE_EXE)) {
    const sizes = `${fmtMB(statSync(FFMPEG_EXE).size)} + ${fmtMB(statSync(FFPROBE_EXE).size)}`;
    console.log(`FFmpeg already present in dist-server/ffmpeg/ (${sizes}). Skipping download.`);
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  await mkdir(FFMPEG_DIR, { recursive: true });

  // ── Download (or reuse cached zip) ─────────────────────────────────────────
  let zipBuffer;
  if (existsSync(CACHE_ZIP)) {
    console.log(`Using cached zip: ${CACHE_ZIP} (${fmtMB(statSync(CACHE_ZIP).size)})`);
    const { readFile } = await import('fs/promises');
    zipBuffer = await readFile(CACHE_ZIP);
  } else {
    console.log(`Downloading FFmpeg essentials from gyan.dev …`);
    console.log(`  ${SOURCE_URL}`);
    console.log(`  (this is ~80 MB, may take a minute)`);
    const res = await fetch(SOURCE_URL, { redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
    }
    zipBuffer = Buffer.from(await res.arrayBuffer());
    console.log(`Downloaded ${fmtMB(zipBuffer.length)}`);
    await writeFile(CACHE_ZIP, zipBuffer);
    console.log(`Cached to ${CACHE_ZIP}`);
  }

  // ── Extract just the two .exes we need ─────────────────────────────────────
  console.log('Extracting ffmpeg.exe and ffprobe.exe …');
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  let count = 0;
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/');
    // Zip path looks like: ffmpeg-7.x-essentials_build/bin/ffmpeg.exe
    if (/\/bin\/(ffmpeg|ffprobe)\.exe$/i.test(name)) {
      // maintainEntryPath=false → strips the inner zip dirs, writes straight to FFMPEG_DIR
      zip.extractEntryTo(entry, FFMPEG_DIR, /*maintainEntryPath*/ false, /*overwrite*/ true);
      console.log(`  ✓ ${name.split('/').pop()}`);
      count++;
    }
  }

  if (count !== 2) {
    throw new Error(`Expected to extract 2 binaries (ffmpeg.exe + ffprobe.exe), got ${count}. Zip layout may have changed.`);
  }

  console.log(`Done. Binaries in ${FFMPEG_DIR}`);
}

main().catch((err) => {
  console.error('\nFFmpeg fetch failed:', err.message);
  process.exit(1);
});
