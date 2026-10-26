#!/usr/bin/env node
/**
 * compress-video.js — standalone compression script
 *
 * Usage:
 *   node compress-video.js <input-video> [output-path] [options]
 *
 * Options:
 *   --watermark-text "MY TEXT"   override watermark text (default: WAVES OTT FOR SLC)
 *   --watermark-file <path>      PNG/JPG image to use as watermark asset
 *   --target-mb <number>         target output size in MB (default: 280)
 *   --no-watermark               skip watermark entirely
 *   --crf                        use single-pass CRF instead of 2-pass adaptive
 *
 * Examples:
 *   node compress-video.js video.mp4
 *   node compress-video.js video.mp4 output.mp4
 *   node compress-video.js video.mp4 --target-mb 150
 *   node compress-video.js video.mp4 --watermark-text "DD NATIONAL"
 */

import { spawn } from 'child_process';
import { stat, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, extname, dirname, resolve as resolvePath } from 'path';

// ─────────────────────────── CLI argument parsing ──────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    input:         null,
    output:        null,
    watermarkText: process.env.WATERMARK_TEXT || 'WAVES OTT FOR SLC',
    watermarkFile: process.env.WATERMARK_FILE_PATH || null,
    targetMB:      280,
    noWatermark:   false,
    useCRF:        false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--watermark-text')  { opts.watermarkText = args[++i]; }
    else if (a === '--watermark-file')  { opts.watermarkFile = args[++i]; }
    else if (a === '--target-mb')       { opts.targetMB = Number(args[++i]); }
    else if (a === '--no-watermark')    { opts.noWatermark = true; }
    else if (a === '--crf')             { opts.useCRF = true; }
    else if (!a.startsWith('--') && !opts.input)  { opts.input = resolvePath(a); }
    else if (!a.startsWith('--') && !opts.output) { opts.output = resolvePath(a); }
  }

  return opts;
}

// ────────────────────────── bin availability check ─────────────────────────

function checkBin(name) {
  return new Promise(resolve => {
    const p = spawn(name, ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', code => resolve(code === 0));
  });
}

// ──────────────────────────── ffprobe metadata ─────────────────────────────

function getVideoMeta(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
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
        const j     = JSON.parse(out);
        const vs    = j.streams?.find(s => s.codec_type === 'video');
        const [n,d] = (vs?.r_frame_rate || '24/1').split('/').map(Number);
        resolve({
          duration: parseFloat(j.format?.duration ?? 0),
          width:    vs ? parseInt(vs.width,  10) : 0,
          height:   vs ? parseInt(vs.height, 10) : 0,
          fps:      d ? n / d : (n || 24),
          sizeMB:   parseFloat(j.format?.size ?? 0) / 1024 / 1024,
        });
      } catch (e) { reject(e); }
    });
  });
}

// ──────────────────────── adaptive settings engine ─────────────────────────

function calcAdaptiveSettings(durationSec, width, height, fps, targetMB, sourceMB) {
  const AUDIO_KBPS   = 128;
  const totalKbps    = Math.floor((targetMB * 1024 * 1024 * 8) / durationSec / 1000);
  const sourceKbps   = sourceMB > 0 ? Math.floor((sourceMB * 1024 * 1024 * 8) / durationSec / 1000) : Infinity;
  // Never target a higher bitrate than the source — that would inflate the file
  const videoKbps    = Math.max(Math.min(totalKbps - AUDIO_KBPS, sourceKbps - AUDIO_KBPS), 150);

  // Resolution ladder — mirrors Adobe Premiere Pro "Adaptive Low Bitrate"
  const ladder = [
    { h: 1080, minKbps: 2500 },
    { h:  720, minKbps: 1200 },
    { h:  480, minKbps:  600 },
    { h:  360, minKbps:  250 },
    { h:  240, minKbps:  100 },
  ];

  let targetHeight = 240;
  for (const rung of ladder) {
    if (height >= rung.h && videoKbps >= rung.minKbps) {
      targetHeight = rung.h;
      break;
    }
  }

  return {
    videoKbps,
    maxKbps:     Math.min(videoKbps * 2, 15000),
    bufsizeKbps: Math.min(videoKbps * 4, 30000),
    targetHeight,
    gopSize:     Math.max(Math.round(fps * 2), 24),
  };
}

// ─────────────────────── drawtext escape helper ────────────────────────────

function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g,  '\\:')
    .replace(/'/g,  "\\'");
}

// ──────────────────────── watermark filter builder ─────────────────────────

function buildFilter(watermarkText, watermarkFile, scaleHeight) {
  const text      = escapeDrawtext(watermarkText);
  const drawtext  =
    `drawtext=text='${text}':fontcolor=white@0.6:fontsize=h/12` +
    `:x=(w-text_w)/2:y=(h-text_h)/2:shadowcolor=black@0.55:shadowx=2:shadowy=2`;
  const scaleStep = scaleHeight > 0 ? `scale=-2:${scaleHeight},` : '';

  // Diagonal centred text — transparent canvas → draw text → rotate 30° → overlay
  // Converting rotated layer to yuva420p before overlay keeps the base video
  // in native YUV colour space with zero conversion overhead.
  const diagonalOverlay = [
    `[0:v]${scaleStep}split=2[base][ref]`,
    '[ref]format=rgba,geq=r=0:g=0:b=0:a=0[canvas]',
    `[canvas]${drawtext}[drawn]`,
    '[drawn]rotate=PI/6:fillcolor=0x00000000:ow=rotw(iw):oh=roth(ih)[rot]',
    '[rot]format=yuva420p[wm]',
    '[base][wm]overlay=(W-w)/2:(H-h)/2[outv]',
  ].join(';');

  if (!watermarkFile || !existsSync(watermarkFile)) {
    return { filterArgs: ['-filter_complex', diagonalOverlay, '-map', '[outv]'], label: 'text' };
  }

  const ext = extname(watermarkFile).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    return { filterArgs: ['-filter_complex', diagonalOverlay, '-map', '[outv]'], label: 'text' };
  }

  const scaledSrc = scaleHeight > 0
    ? `[0:v]scale=-2:${scaleHeight}[vs];[vs]`
    : '[0:v]';

  const imgFilter = [
    `${scaledSrc}[1:v]scale2ref=w='floor(main_w*0.42)':h=-1:flags=lanczos[wmraw][base]`,
    '[wmraw]format=rgba,eq=brightness=0.55:contrast=1.35[wmi]',
    '[base][wmi]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2[vwm]',
    '[vwm]split=2[imgbase][ref]',
    '[ref]format=rgba,geq=r=0:g=0:b=0:a=0[canvas]',
    `[canvas]${drawtext}[drawn]`,
    '[drawn]rotate=PI/6:fillcolor=0x00000000:ow=rotw(iw):oh=roth(ih)[rot]',
    '[rot]format=yuva420p[wm]',
    '[imgbase][wm]overlay=(W-w)/2:(H-h)/2[outv]',
  ].join(';');

  return {
    filterArgs: ['-i', watermarkFile, '-filter_complex', imgFilter, '-map', '[outv]'],
    label: 'image+text',
  };
}

// ─────────────────────────── ffmpeg process runner ─────────────────────────

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let durationSec  = null;
    let lastProgress = -1;
    let stderrTail   = '';

    proc.stderr.on('data', chunk => {
      const line = chunk.toString();
      stderrTail = (stderrTail + line).slice(-6000);

      if (!durationSec) {
        const m = line.match(/Duration:\s*(\d+):(\d+):(\d+)/);
        if (m) durationSec = +m[1] * 3600 + +m[2] * 60 + +m[3];
      }

      if (durationSec) {
        const m = line.match(/time=(\d+):(\d+):(\d+)/);
        if (m) {
          const elapsed = +m[1] * 3600 + +m[2] * 60 + +m[3];
          const pct     = Math.min(Math.round((elapsed / durationSec) * 100), 99);
          if (pct !== lastProgress) {
            lastProgress = pct;
            process.stdout.write(`\r  Progress: ${pct}%   `);
          }
        }
      }
    });

    proc.on('error', reject);
    proc.on('close', code => {
      process.stdout.write('\r');
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code}\n${stderrTail.slice(-1000)}`));
    });
  });
}

// ──────────────────── 2-pass adaptive encode (main path) ───────────────────

async function adaptiveEncode(input, output, opts, meta) {
  const s      = calcAdaptiveSettings(meta.duration, meta.width, meta.height, meta.fps, opts.targetMB, meta.sizeMB);
  const scale  = s.targetHeight < meta.height ? s.targetHeight : 0;
  const wmText = opts.noWatermark ? '' : opts.watermarkText;
  const wmFile = opts.noWatermark ? null : opts.watermarkFile;
  const { filterArgs } = opts.noWatermark
    ? { filterArgs: scale > 0
        ? ['-vf', `scale=-2:${scale}`]
        : [] }
    : buildFilter(wmText, wmFile, scale);

  const passlog = output + '.passlog';

  // x264 params that replicate Premiere Pro's adaptive algorithm:
  //   rc-lookahead  — look ahead 60 frames for rate-control decisions
  //   bframes=6     — 6 B-frames; aggressive but fine for VoD
  //   b-adapt=2     — optimal B-frame placement
  //   aq-mode=3     — variance-weighted AQ (perceptual quality)
  //   qcomp=0.70    — shift bits toward complex/high-motion scenes
  //   scenecut=40   — force I-frame on 40% luminance jump (scene cut)
  const x264p = [
    'rc-lookahead=60', 'bframes=6', 'b-adapt=2',
    'aq-mode=3', 'qcomp=0.70', 'scenecut=40',
    `keyint=${s.gopSize}`, `min-keyint=${Math.round(s.gopSize / 2)}`,
  ].join(':');

  const sharedVideo = [
    '-c:v', 'libx264', '-preset', 'medium',
    '-profile:v', 'high', '-level:v', '4.1',
    '-b:v', `${s.videoKbps}k`,
    '-maxrate', `${s.maxKbps}k`,
    '-bufsize', `${s.bufsizeKbps}k`,
    '-x264-params', x264p,
    '-passlogfile', passlog,
  ];

  console.log(`\n  Pass 1/2  —  analysing scene complexity...`);
  await runFFmpeg([
    '-i', input, ...filterArgs,
    '-an', ...sharedVideo,
    '-pass', '1', '-f', 'null',
    process.platform === 'win32' ? 'NUL' : '/dev/null',
  ]);

  console.log(`  Pass 2/2  —  encoding at ${s.videoKbps} kbps${scale ? ` (scaled to ${s.targetHeight}p)` : ''}...`);
  await runFFmpeg([
    '-i', input, ...filterArgs,
    '-map', '0:a?',
    ...sharedVideo,
    '-pass', '2',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-y', output,
  ]);

  for (const suf of ['', '-0.log', '-0.log.mbtree']) {
    try { await unlink(passlog + suf); } catch { /* ok */ }
  }

  return s;
}

// ────────────────── single-pass CRF fallback / --crf mode ──────────────────

function crfEncode(input, output, opts) {
  const wmText = opts.noWatermark ? '' : opts.watermarkText;
  const wmFile = opts.noWatermark ? null : opts.watermarkFile;
  const { filterArgs } = opts.noWatermark
    ? { filterArgs: [] }
    : buildFilter(wmText, wmFile, 0);

  return runFFmpeg([
    '-i', input, ...filterArgs,
    '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '17',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-y', output,
  ]);
}

// ─────────────────────────────── main ──────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  // ── validate input ──────────────────────────────────────────────────────
  if (!opts.input) {
    console.error([
      'Usage: node compress-video.js <input-video> [output-path] [options]',
      '',
      'Options:',
      '  --watermark-text "TEXT"   override watermark text',
      '  --watermark-file <path>   PNG/JPG watermark image',
      '  --target-mb <n>           target output size in MB  (default: 280)',
      '  --no-watermark            skip watermark',
      '  --crf                     single-pass CRF instead of 2-pass adaptive',
    ].join('\n'));
    process.exit(1);
  }

  if (!existsSync(opts.input)) {
    console.error(`Error: input file not found — ${opts.input}`);
    process.exit(1);
  }

  // ── derive output path if not given ─────────────────────────────────────
  if (!opts.output) {
    const dir  = dirname(opts.input);
    const base = basename(opts.input, extname(opts.input));
    opts.output = resolvePath(dir, `${base}_compressed${extname(opts.input)}`);
  }

  // ── check tools ─────────────────────────────────────────────────────────
  const [hasFfmpeg, hasFfprobe] = await Promise.all([checkBin('ffmpeg'), checkBin('ffprobe')]);

  if (!hasFfmpeg) {
    console.error('Error: ffmpeg not found in PATH. Install ffmpeg first.');
    process.exit(1);
  }

  // ── print header ────────────────────────────────────────────────────────
  const inputStat = await stat(opts.input);
  console.log('');
  console.log('  ┌──────────────────────────────────────────────────┐');
  console.log('  │         Akashvani Video Compressor                │');
  console.log('  └──────────────────────────────────────────────────┘');
  console.log(`  Input   : ${opts.input}`);
  console.log(`  Output  : ${opts.output}`);
  console.log(`  Size    : ${(inputStat.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Target  : ≤ ${opts.targetMB} MB`);
  console.log(`  Mode    : ${opts.useCRF ? 'Single-pass CRF' : '2-pass Adaptive (Premiere-style)'}`);
  console.log(`  Watermark: ${opts.noWatermark ? 'none' : `"${opts.watermarkText}"`}`);
  console.log('');

  const startTime = Date.now();

  if (opts.useCRF || !hasFfprobe) {
    if (!hasFfprobe) console.log('  ffprobe not found — using CRF fallback');
    console.log('  Encoding...');
    await crfEncode(opts.input, opts.output, opts);
  } else {
    // ── get source metadata ──────────────────────────────────────────────
    process.stdout.write('  Reading source metadata...');
    const meta = await getVideoMeta(opts.input);
    process.stdout.write(` done\n`);

    if (meta.duration <= 0) {
      console.error('  Error: could not read video duration from ffprobe');
      process.exit(1);
    }

    const s      = calcAdaptiveSettings(meta.duration, meta.width, meta.height, meta.fps, opts.targetMB, meta.sizeMB);
    const estMB  = Math.round((s.videoKbps + 128) * 1000 * meta.duration / 8 / 1024 / 1024);

    console.log(`  Source  : ${meta.width}×${meta.height} @ ${meta.fps.toFixed(2)} fps  |  ${meta.duration.toFixed(1)} s`);
    console.log(`  Adaptive: ${s.videoKbps} kbps video → estimated ~${estMB} MB${s.targetHeight < meta.height ? `  |  scaled ${meta.height}p → ${s.targetHeight}p` : ''}`);

    await adaptiveEncode(opts.input, opts.output, opts, meta);
  }

  // ── print result ────────────────────────────────────────────────────────
  const elapsed     = ((Date.now() - startTime) / 1000).toFixed(1);
  const outputStat  = await stat(opts.output);
  const outputMB    = outputStat.size / 1024 / 1024;
  const inputMB     = inputStat.size  / 1024 / 1024;
  const ratio       = (inputMB / outputMB).toFixed(1);

  console.log('');
  console.log('  ─────────────────────────────────────────────────────');
  console.log(`  ✓ Done in ${elapsed}s`);
  console.log(`  Input : ${inputMB.toFixed(1)} MB`);
  console.log(`  Output: ${outputMB.toFixed(1)} MB`);
  console.log(`  Ratio : ${ratio}× compression`);
  console.log(`  File  : ${opts.output}`);
  console.log('');
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
