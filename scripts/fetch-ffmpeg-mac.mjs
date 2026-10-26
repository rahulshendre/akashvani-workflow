/**
 * Downloads static Apple Silicon builds of ffmpeg and ffprobe from osxexperts.net
 * and puts them in dist-server/ffmpeg-mac/. Skips work if they are already there.
 *
 * Run with:  node scripts/fetch-ffmpeg-mac.mjs
 *      or:   npm run fetch:ffmpeg:mac
 *
 * These are the macOS counterpart of the gyan.dev build that fetch-ffmpeg.mjs
 * downloads for Windows: GPL builds with libx264, libass and freetype, linked
 * against macOS system libraries only, so they run on a Mac with nothing installed.
 * (Homebrew's ffmpeg is not an option: it loads dylibs that other Macs do not have.)
 *
 * The URLs are not versioned, so the zips are pinned by SHA-256. If osxexperts
 * publishes a new build the check fails on purpose; look at the new build, then
 * update the hashes below.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, '..');
const FFMPEG_DIR = join(ROOT, 'dist-server', 'ffmpeg-mac');
const CACHE_DIR  = join(ROOT, '.cache');

const TOOLS = [
  {
    name: 'ffmpeg',
    zip: 'ffmpeg9arm.zip',
    url: 'https://www.osxexperts.net/ffmpeg9arm.zip',
    sha256: 'd0c06c5c68ce48af3143b262f7a9118a7c9f67de1e237fcc24ffb14df9c67af9',
  },
  {
    name: 'ffprobe',
    zip: 'ffprobe9arm.zip',
    url: 'https://www.osxexperts.net/ffprobe9arm.zip',
    sha256: '0c94fbdd8917022f28115eca512196cf4648732bc9e5db9ec8896c7e519d02aa',
  },
];

const MACHO_64_LE = 0xfeedfacf;
const CPU_ARM64   = 0x0100000c;

function fmtMB(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** A 64-bit Mach-O file for arm64, read from the header. Nothing is executed. */
function isArm64MachO(buf) {
  return buf.length > 8 && buf.readUInt32LE(0) === MACHO_64_LE && buf.readUInt32LE(4) === CPU_ARM64;
}

async function zipFor(tool) {
  const cached = join(CACHE_DIR, tool.zip);
  if (existsSync(cached)) {
    console.log(`Using cached ${tool.zip} (${fmtMB(statSync(cached).size)})`);
    return readFileSync(cached);
  }
  console.log(`Downloading ${tool.url} ...`);
  const res = await fetch(tool.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`Downloaded ${fmtMB(buf.length)}`);
  await writeFile(cached, buf);
  return buf;
}

async function main() {
  if (TOOLS.every(t => existsSync(join(FFMPEG_DIR, t.name)))) {
    console.log('ffmpeg and ffprobe already present in dist-server/ffmpeg-mac/. Skipping download.');
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  await mkdir(FFMPEG_DIR, { recursive: true });

  for (const tool of TOOLS) {
    const zipBuffer = await zipFor(tool);

    const got = sha256(zipBuffer);
    if (got !== tool.sha256) {
      throw new Error(
        `${tool.zip} does not match the pinned checksum.\n` +
        `  expected ${tool.sha256}\n  got      ${got}\n` +
        `The file at ${tool.url} has changed. If the new build is wanted, update the hash in this script. ` +
        `A cached copy in .cache/ may also be stale: delete it to download again.`
      );
    }

    const entry = new AdmZip(zipBuffer).getEntry(tool.name);
    if (!entry) throw new Error(`${tool.zip} has no "${tool.name}" file inside.`);
    const binary = entry.getData();
    if (!isArm64MachO(binary)) {
      throw new Error(`${tool.name} from ${tool.zip} is not an arm64 Mach-O binary.`);
    }

    await writeFile(join(FFMPEG_DIR, tool.name), binary, { mode: 0o755 });
    console.log(`  ok ${tool.name} (${fmtMB(binary.length)}, arm64)`);
  }

  console.log(`Done. Binaries in ${FFMPEG_DIR}`);
}

main().catch((err) => {
  console.error('\nFFmpeg fetch failed:', err.message);
  process.exit(1);
});
