import { spawn } from 'child_process';
import { copyFile, stat, unlink } from 'fs/promises';
import { basename, join, extname } from 'path';
import { existsSync } from 'fs';
import { FFMPEG_BIN, FFPROBE_BIN, WATERMARK_PATH } from '../paths.js';

// Single-pass VBR is the default (much faster). Set ENCODE_MODE=2pass to
// re-enable the 2-pass adaptive path (slower, higher quality-per-byte).
const TWO_PASS_MODE = (process.env.ENCODE_MODE || '').toLowerCase() === '2pass';
// libx264 preset — "veryfast" gives ~3-5x speedup over "medium" with marginal
// size/quality cost, which is fine for a demo/showcase pipeline.
const X264_PRESET = process.env.X264_PRESET || 'veryfast';

// ─────────────────────────────── helpers ───────────────────────────────────

function normalizeWatermarkPath(raw) {
  if (!raw) return '';
  let p = String(raw).trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  return p;
}

function checkBin(name) {
  return new Promise(resolve => {
    const proc = spawn(name, ['-version'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('close', code => resolve(code === 0));
  });
}

function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

// ─────────────────────────── ffprobe metadata ──────────────────────────────

function getVideoMeta(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE_BIN, [
      '-v', 'quiet', '-print_format', 'json',
      '-show_streams', '-show_format', input,
    ]);
    let out = '';
    let err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err.slice(-200)}`));
      try {
        const j = JSON.parse(out);
        const vs = j.streams?.find(s => s.codec_type === 'video');
        const [rn, rd] = (vs?.r_frame_rate || '24/1').split('/').map(Number);
        resolve({
          duration: parseFloat(j.format?.duration ?? 0),
          width:    vs ? parseInt(vs.width,  10) : 0,
          height:   vs ? parseInt(vs.height, 10) : 0,
          fps:      rd ? rn / rd : (rn || 24),
        });
      } catch (e) { reject(e); }
    });
  });
}

// ────────────────── Adaptive Low Bitrate settings engine ───────────────────
//
// Mirrors Adobe Premiere Pro / Media Encoder "Match Source - Adaptive Low
// Bitrate" H.264 preset. Verified against community references and Adobe docs:
//
//   Resolution      Target (Mbps)   Max (Mbps)
//   ------------    -------------   ----------
//   2160p (4K)         16              32
//   1440p              12              24
//   1080p               6              12     ← canonical "Low" 1080p value
//    720p               3               6
//    540p               2               4
//    480p             1.5               3
//    360p             0.7              1.4
//
// Other Premiere defaults baked in:
//   - VBR 1-pass (we expose 2-pass via ENCODE_MODE=2pass)
//   - GOP = 2 s of frames, profile=high, level=4.0
//   - Audio: 192 kbps AAC stereo (Premiere uses 192–320 kbps)
//
// Source resolution is preserved (no down-scaling). Premiere's "Adaptive"
// label refers to bitrate adapting to source frame size, not down-scaling.
//
// scale factor (vs uncompressed source): a 369 s 1080p30 file at 6 Mbps video
// + 192 kbps audio ≈ (6.192 Mbps × 369 s ÷ 8) ≈ 285 MB output, which on a
// typical ~3 GB ProRes/uncompressed source is roughly **10–12× compression**.

function calcAdaptiveSettings(_durationSec, _width, height, fps) {
  // Pick rung = source height clamped to the published Premiere ladder.
  const ladder = [
    { h: 2160, videoKbps: 16000, maxKbps: 32000 },
    { h: 1440, videoKbps: 12000, maxKbps: 24000 },
    { h: 1080, videoKbps:  6000, maxKbps: 12000 },
    { h:  720, videoKbps:  3000, maxKbps:  6000 },
    { h:  540, videoKbps:  2000, maxKbps:  4000 },
    { h:  480, videoKbps:  1500, maxKbps:  3000 },
    { h:  360, videoKbps:   700, maxKbps:  1400 },
  ];

  // Pick the rung whose height is <= source (i.e. don't upgrade) but
  // closest to source. Source resolution is preserved on output.
  let rung = ladder[ladder.length - 1];
  for (const r of ladder) {
    if (height >= r.h) { rung = r; break; }
  }

  const gopSize     = Math.max(Math.round(fps * 2), 24); // 2 s keyint
  const bufsizeKbps = rung.maxKbps * 2;

  return {
    videoKbps:    rung.videoKbps,
    maxKbps:      rung.maxKbps,
    bufsizeKbps,
    targetHeight: 0,            // 0 = keep source resolution (Premiere does too)
    gopSize,
  };
}

// ──────────────────────── watermark filter builder ─────────────────────────
//
// Recreates the diagonal "WAVES OTT FOR SLC" watermark seen in the Premiere
// reference screenshot — large semi-transparent white text rotated ~22.5° CCW,
// centred over the frame.
//
// Performance notes:
//   - Avoids `geq` (per-pixel JS evaluator) and `scale2ref` (slow, fragile).
//   - Builds the watermark as a separate `lavfi color` stream so the base
//     video stream is never copied or re-encoded as RGBA.
//   - The `rotate` filter is fast for a static angle.

function buildFilterArgs(watermarkAssetPath, meta) {
  const canvasW = meta.width;
  const canvasH = meta.height;
  const fps     = Math.round(meta.fps || 30);

  // ─── Image-watermark path (preferred) ──────────────────────────────────
  // The user's PNG is a fully-designed full-frame watermark exported from
  // their Premiere "Watermark Template" project — it already contains the
  // diagonal text, the correct alpha (semi-transparency baked into the PNG),
  // and the correct positioning. So we just **scale it to the video's exact
  // resolution and composite at 0,0**. No extra rotation, no opacity tweak,
  // no text rendering — anything else would corrupt the designer's intent.
  //
  // For non-matching aspect ratios (e.g. 4:3 PNG over 16:9 video) we stretch
  // to fill the frame so the watermark always covers full coverage.
  const ext = watermarkAssetPath ? extname(watermarkAssetPath).toLowerCase() : '';
  const isImage = watermarkAssetPath && ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);

  if (isImage) {
    // Optional knobs for the PNG path:
    //   WATERMARK_ROTATE=1   → apply rotation in code (default: 0, PNG as-is)
    //   WATERMARK_ANGLE_RAD  → ffmpeg rotate angle (default -PI/8)
    //   WATERMARK_OPACITY    → alpha multiplier (default 4.0)
    //
    // Why default 4.0? Premiere bakes layer opacity into the alpha channel
    // when exporting PNG. The "Watermark Template" layers commonly land in
    // the ~7-10% raw-alpha range, which is invisible over real footage even
    // though it looks crisp in the Premiere monitor (which adds its own
    // layer opacity on top). 4.0× brings raw 7-10% up to ~30-40% — the
    // same visual weight you see in the Premiere preview.
    const wmRotate  = (process.env.WATERMARK_ROTATE || '0') === '1';
    const rotateRad = process.env.WATERMARK_ANGLE_RAD || '-PI/8';
    const opRaw     = parseFloat(process.env.WATERMARK_OPACITY ?? '4.0');
    const opacity   = isFinite(opRaw) ? Math.max(0, Math.min(10, opRaw)) : 4.0;
    const opStr     = opacity.toFixed(2);

    // Use `lut` to multiply alpha with arbitrary factor. `colorchannelmixer`
    // caps `aa` at 2.0, so it can't reach the typical 4-5× boost a Premiere
    // PNG export needs. `lut` builds a 256-entry alpha lookup table —
    // equally fast and unbounded (auto-clipped to 0-255 by the filter).
    const opStep     = opacity === 1.0 ? '' : `,lut=a='val*${opStr}'`;
    const rotateStep = wmRotate
      ? `,rotate=${rotateRad}:fillcolor=#00000000:ow=rotw(iw):oh=roth(ih)`
      : '';

    const imgGraph = [
      `[1:v]format=rgba,scale=${canvasW}:${canvasH}:flags=lanczos${opStep}${rotateStep}[wm]`,
      '[0:v][wm]overlay=0:0:format=auto[outv]',
    ].join(';');

    return {
      args: ['-i', watermarkAssetPath, '-filter_complex', imgGraph, '-map', '[outv]'],
      mode: wmRotate ? `image-rotated@${opStr}` : `image-as-is@${opStr}`,
    };
  }

  // ─── Text-only fallback (no PNG provided) ──────────────────────────────
  // Recreates a Premiere-style diagonal "WAVES OTT FOR SLC" overlay.
  const watermarkText = escapeDrawtext(process.env.WATERMARK_TEXT || 'WAVES OTT FOR SLC');
  const textOpacity   = process.env.WATERMARK_OPACITY || '0.45';
  const rotateRad     = process.env.WATERMARK_ANGLE_RAD || '-PI/8';
  const fontPx        = Math.round(canvasH / 9);

  const drawText =
    `drawtext=text='${watermarkText}':fontcolor=white@${textOpacity}` +
    `:fontsize=${fontPx}:bordercolor=black@0.55:borderw=2` +
    `:x=(w-text_w)/2:y=(h-text_h)/2`;

  // `color` lavfi outputs YUV with no alpha — force RGBA + zero alpha
  // BEFORE drawtext, otherwise we'd composite an opaque rectangle.
  const canvasInput = `color=c=black:size=${canvasW}x${canvasH}:rate=${fps}:duration=${(meta.duration || 9999).toFixed(2)}`;
  const diagonalGraph = [
    `[1:v]format=rgba,colorchannelmixer=aa=0,${drawText}[txt]`,
    `[txt]rotate=${rotateRad}:fillcolor=#00000000:ow=rotw(iw):oh=roth(ih)[wm]`,
    '[0:v][wm]overlay=(W-w)/2:(H-h)/2:shortest=1[outv]',
  ].join(';');

  return {
    args: ['-f', 'lavfi', '-i', canvasInput, '-filter_complex', diagonalGraph, '-map', '[outv]'],
    mode: 'text-diagonal',
  };
}

// ─────────────────────────── ffmpeg runner ─────────────────────────────────

/**
 * Every ffmpeg encode currently running. A desktop instance runs one pipeline at
 * a time, so "stop" means killing whatever is in here — without this, pressing
 * Stop would only hide the UI while ffmpeg kept burning CPU to completion.
 */
const liveEncodes = new Set();

/** Kill any in-flight encode. Returns how many were killed. */
export function killActiveEncodes() {
  let killed = 0;
  for (const proc of liveEncodes) {
    try { proc.kill('SIGKILL'); killed++; } catch { /* already gone */ }
  }
  liveEncodes.clear();
  return killed;
}

/** Thrown when an encode was deliberately stopped, so callers can tell it apart. */
export class EncodeStoppedError extends Error {
  constructor() {
    super('Encode stopped by user');
    this.name = 'EncodeStoppedError';
    this.stopped = true;
  }
}

function runProcess(args, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args);
    liveEncodes.add(proc);
    let killedByUs = false;
    const origKill = proc.kill.bind(proc);
    proc.kill = (...a) => { killedByUs = true; return origKill(...a); };

    let durationSec = null;
    let stderrTail  = '';

    proc.stderr.on('data', chunk => {
      const line = chunk.toString();
      stderrTail = (stderrTail + line).slice(-4000);
      if (!durationSec) {
        const dm = line.match(/Duration:\s*(\d+):(\d+):(\d+)/);
        if (dm) durationSec = +dm[1] * 3600 + +dm[2] * 60 + +dm[3];
      }
      if (durationSec && onProgress) {
        const pm = line.match(/time=(\d+):(\d+):(\d+)/);
        if (pm) {
          const elapsed = +pm[1] * 3600 + +pm[2] * 60 + +pm[3];
          onProgress(Math.min(Math.round((elapsed / durationSec) * 100), 99));
        }
      }
    });

    proc.on('error', (err) => {
      liveEncodes.delete(proc);
      reject(err);
    });
    proc.on('close', code => {
      liveEncodes.delete(proc);
      if (killedByUs) return reject(new EncodeStoppedError());
      return code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}: ${stderrTail.slice(-800)}`));
    });
  });
}

// ──────────── Two-pass adaptive encode (the Premiere Pro equivalent) ────────
//
// Pass 1: dry run — analyses every frame for scene complexity, motion, and
//         bit-allocation weight. Output is discarded (null muxer).
// Pass 2: real encode — uses the log from pass 1 to allocate bits optimally.
//
// x264 parameters that mirror Premiere's adaptive behaviour:
//   rc-lookahead=60  – look-ahead buffer for rate control decisions
//   bframes=6        – aggressive B-frame use (VoD has no latency constraint)
//   b-adapt=2        – adaptive B-frame placement (optimal, not just fixed)
//   aq-mode=3        – variance-based AQ: more bits where the eye notices detail
//   qcomp=0.70       – shift bits toward complex scenes
//   scenecut=40      – force I-frame at 40 % luminance change (scene cuts)

async function runAdaptiveEncode(input, output, onProgress, wmPath, meta, onLog) {
  const s       = calcAdaptiveSettings(meta.duration, meta.width, meta.height, meta.fps);
  const filter  = buildFilterArgs(wmPath, meta);
  const passlog = output + '.passlog';

  const x264params = [
    'rc-lookahead=40',
    'bframes=3',
    'b-adapt=1',
    'aq-mode=2',
    `keyint=${s.gopSize}`,
    `min-keyint=${Math.round(s.gopSize / 2)}`,
  ].join(':');

  const sharedVideoArgs = [
    '-c:v', 'libx264',
    '-preset', X264_PRESET,
    '-profile:v', 'high',
    '-level:v', '4.0',
    '-b:v', `${s.videoKbps}k`,
    '-maxrate', `${s.maxKbps}k`,
    '-bufsize', `${s.bufsizeKbps}k`,
    '-x264-params', x264params,
    '-passlogfile', passlog,
  ];

  // Pass 1 — analysis only, but report progress as 0–50% so the UI moves.
  onLog(`  Pass 1/2: analysing scene complexity...`);
  await runProcess([
    '-i', input,
    ...filter.args,
    '-an',
    ...sharedVideoArgs,
    '-pass', '1',
    '-f', 'null',
    process.platform === 'win32' ? 'NUL' : '/dev/null',
  ], (pct) => onProgress(Math.round(pct / 2)));

  // Pass 2 — real encode using pass-1 bit-allocation log; progress 50–100%.
  onLog(`  Pass 2/2: encoding at ${s.videoKbps} kbps...`);
  await runProcess([
    '-i', input,
    ...filter.args,
    '-map', '0:a?',
    ...sharedVideoArgs,
    '-pass', '2',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-y', output,
  ], (pct) => onProgress(50 + Math.round(pct / 2)));

  // Remove passlog artefacts
  for (const suffix of ['', '-0.log', '-0.log.mbtree']) {
    try { await unlink(passlog + suffix); } catch { /* ok */ }
  }

  return filter.mode;
}

// ────────── Single-pass VBR encode (default — much faster than 2-pass) ──────

async function runSinglePassVBR(input, output, onProgress, wmPath, meta, onLog) {
  const s      = calcAdaptiveSettings(meta.duration, meta.width, meta.height, meta.fps);
  const filter = buildFilterArgs(wmPath, meta);

  const x264params = [
    'rc-lookahead=20',
    'bframes=3',
    'aq-mode=2',
    `keyint=${s.gopSize}`,
    `min-keyint=${Math.round(s.gopSize / 2)}`,
  ].join(':');

  onLog(`  Encoding at ${s.videoKbps} kbps (max ${s.maxKbps} kbps), preset=${X264_PRESET}, profile=high@4.0`);
  await runProcess([
    '-i', input,
    ...filter.args,
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', X264_PRESET,
    '-profile:v', 'high',
    '-level:v', '4.0',
    '-b:v', `${s.videoKbps}k`,
    '-maxrate', `${s.maxKbps}k`,
    '-bufsize', `${s.bufsizeKbps}k`,
    '-x264-params', x264params,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-y', output,
  ], onProgress);

  return filter.mode;
}

// ────────── CRF single-pass fallback (when ffprobe unavailable) ─────────────

function runCRFFallback(input, output, onProgress, wmPath, meta) {
  // Build with whatever meta we have; missing height defaults to text-only watermark.
  const filter = buildFilterArgs(wmPath, meta || { width: 1920, height: 1080, fps: 30, duration: 9999 });
  return runProcess([
    '-i', input,
    ...filter.args,
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', X264_PRESET,
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-y', output,
  ], onProgress);
}

// ────────────────────── no-ffmpeg simulation ────────────────────────────────

function simulateCompress(input, output, onProgress) {
  return new Promise(resolve => {
    let p = 0;
    const iv = setInterval(async () => {
      p = Math.min(p + 8, 99);
      onProgress(p);
      if (p >= 99) {
        clearInterval(iv);
        await copyFile(input, output);
        onProgress(100);
        resolve();
      }
    }, 180);
  });
}

// ──────────────────────────── public API ────────────────────────────────────

export async function compressVideos(inputPaths, outputDir, onProgress, onLog) {
  const results      = [];
  const hasFfmpeg    = await checkBin(FFMPEG_BIN);
  const hasFfprobe   = await checkBin(FFPROBE_BIN);
  // Watermark resolution order:
  //   1. WATERMARK_FILE_PATH override from config.env (if it exists on disk)
  //   2. Bundled watermark shipped alongside the .exe / source repo
  //   3. None → text-only watermark
  const wmRaw      = normalizeWatermarkPath(process.env.WATERMARK_FILE_PATH);
  const wmOverride = (wmRaw && existsSync(wmRaw)) ? wmRaw : undefined;
  const wmBundled  = (WATERMARK_PATH && existsSync(WATERMARK_PATH)) ? WATERMARK_PATH : undefined;
  const wmPath     = wmOverride || wmBundled;

  if (wmRaw && !wmOverride) onLog(`Watermark override "${wmRaw}" not found — using bundled watermark`);
  if (wmOverride)            onLog(`Using watermark override: ${wmOverride}`);
  else if (wmBundled)        onLog(`Using bundled watermark: ${wmBundled}`);
  else                       onLog('No image watermark available — text-only watermark');

  if (!hasFfprobe)           onLog('ffprobe not found — adaptive mode unavailable; using CRF fallback');

  for (let i = 0; i < inputPaths.length; i++) {
    const input   = inputPaths[i];
    const ext     = extname(input);
    const outName = basename(input, ext) + '_compressed' + ext;
    const output  = join(outputDir, outName);

    const perFile = p => {
      const overall = ((i / inputPaths.length) + (p / 100 / inputPaths.length)) * 100;
      onProgress(Math.round(overall));
    };

    onLog(`\n[${i + 1}/${inputPaths.length}] ${basename(input)}`);

    if (!hasFfmpeg) {
      onLog('  ffmpeg not found — simulating (install ffmpeg and add to PATH)');
      await simulateCompress(input, output, perFile);
    } else if (hasFfprobe) {
      let meta;
      try {
        meta = await getVideoMeta(input);
        if (meta.duration <= 0) throw new Error('Could not read video duration');

        const s     = calcAdaptiveSettings(meta.duration, meta.width, meta.height, meta.fps);
        const estMB = Math.round((s.videoKbps + 192) * meta.duration / 8 / 1024 / 1024);

        onLog(`  Source : ${meta.width}×${meta.height} @ ${meta.fps.toFixed(2)} fps, ${meta.duration.toFixed(0)} s`);
        onLog(`  Premiere "Adaptive Low": ${s.videoKbps} kbps video / ${s.maxKbps} kbps max → ~${estMB} MB`);

        const mode = TWO_PASS_MODE
          ? await runAdaptiveEncode(input, output, perFile, wmPath, meta, onLog)
          : await runSinglePassVBR(input, output, perFile, wmPath, meta, onLog);
        onLog(`  Watermark: ${mode}`);
      } catch (err) {
        // A deliberate stop must not be treated as an encode failure, or the
        // CRF fallback would immediately restart the work we just killed.
        if (err.stopped) throw err;
        onLog(`  Encode failed: ${err.message}`);
        onLog('  Retrying with CRF fallback...');
        try {
          await runCRFFallback(input, output, perFile, wmPath, meta);
          onLog('  CRF fallback applied');
        } catch (err2) {
          if (err2.stopped) throw err2;
          onLog(`  CRF fallback also failed: ${err2.message}`);
        }
      }
    } else {
      try {
        await runCRFFallback(input, output, perFile, wmPath);
      } catch (err) {
        if (err.stopped) throw err;
        onLog(`  Encode failed: ${err.message}`);
      }
    }

    try {
      const s = await stat(output);
      onLog(`  ✓ Output: ${(s.size / 1024 / 1024).toFixed(1)} MB`);
      results.push(output);
    } catch { /* output missing — error already logged */ }
  }

  return results;
}
