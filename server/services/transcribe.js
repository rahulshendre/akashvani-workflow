/**
 * Automatic subtitle generation via Sarvam Saaras.
 *
 * This replaces the manual trip out to a third-party transcription tool: the
 * editor no longer exports audio, uploads it somewhere else, waits, downloads
 * an .srt and brings it back. The app does the whole thing from the episode's
 * own compressed video.
 *
 * WHY SILENCE-BASED SEGMENTATION (and not the model's own timestamps):
 *   Saaras' real-time REST endpoint returns utterance-level timing — one entry
 *   spanning the whole clip — and diarization is batch-API only. Trusting that
 *   would give us subtitles with no usable cue boundaries. So we cut the audio
 *   at silences DETECTED BY FFMPEG (millisecond precision), transcribe each
 *   speech segment on its own, and use the segment's real start/end as the cue
 *   timing. The timings are therefore measured, not inferred.
 *
 * Steps:
 *   1. Extract mono 16 kHz WAV from the video (what Saaras expects).
 *   2. Detect silences, build speech segments, merge/split them to 1–29 s.
 *   3. Transcribe every segment with mode=transcribe, so Hindi audio comes
 *      back as Hindi text rather than being translated to English.
 *   4. Emit SRT cues at HH:MM:SS,mmm precision, splitting long transcripts
 *      into sentence/clause cues with time shared out by text length.
 *
 * This is a direct port of the Python prototype in test-sarvam-models/, kept
 * deliberately parameter-for-parameter identical so output that was reviewed
 * and approved there is what the app produces here. Resist "improving" the
 * constants below without re-checking a real episode.
 */

import { spawn } from 'child_process';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { FFMPEG_BIN, FFPROBE_BIN } from '../paths.js';
import { logInfo, logWarn } from './logger.js';

const API_URL = 'https://api.sarvam.ai/speech-to-text';

export const DEFAULT_MODEL = 'saaras:v3';
/** Same-language output. "translate" would hand back English — not what we want. */
const MODE = 'transcribe';
export const DEFAULT_LANGUAGE = 'hi-IN';

const MAX_WORKERS = 3;   // parallel API calls; higher reliably trips rate limits
const MAX_RETRIES = 4;   // per segment, covers 429 and 5xx

// ── segmentation tuning ─────────────────────────────────────────────────────
// Tuned for phrase-level, closed-caption-style cues: split at the short pauses
// between phrases rather than only at sentence ends.
const SILENCE_NOISE = '-30dB'; // noise floor for silencedetect
const SILENCE_MIN = 0.20;      // min silence (s) that counts as a boundary
const SEG_PAD = 0.10;          // widen each segment both ways so words aren't clipped
const MERGE_GAP = 0.30;        // merge neighbours closer than this
const MERGE_MAX = 5.0;         // ...but never grow a merged segment past this
const HARD_MAX = 29.0;         // REST endpoint caps at 30 s — force-split above this
const MIN_SEG = 0.25;          // drop blips shorter than this

// ── cue shaping ─────────────────────────────────────────────────────────────
const MAX_CUE_CHARS = 42;      // single-line phrase cues
const MIN_CUE_DURATION = 0.5;  // pad ultra-short cues so they stay readable

/** Labels the model hallucinates over music beds and room noise. */
const JUNK_TRANSCRIPTS = new Set([
  'music', '[music]', 'म्यूजिक', 'संगीत', 'noise', '[noise]',
]);

/**
 * Every ffmpeg child this module has running. Pressing Stop must actually end
 * the work, not just hide it — without this, ffmpeg and a queue of API calls
 * would carry on in the background after the UI said the run had stopped.
 */
const liveProcs = new Set();

/** Kill in-flight audio work. Returns how many processes were killed. */
export function killActiveTranscriptions() {
  let killed = 0;
  for (const proc of liveProcs) {
    try { proc.kill('SIGKILL'); killed++; } catch { /* already gone */ }
  }
  liveProcs.clear();
  return killed;
}

/** Thrown when a run was deliberately stopped, so callers can tell it apart. */
export class TranscriptionStoppedError extends Error {
  constructor() {
    super('Transcription stopped by user');
    this.name = 'TranscriptionStoppedError';
    this.stopped = true;
  }
}

export function isTranscriptionConfigured() {
  return !!(process.env.SARVAM_API_KEY || '').trim();
}

function apiKey() {
  const key = (process.env.SARVAM_API_KEY || '').trim();
  if (!key) {
    const err = new Error(
      'No Sarvam API key on this machine, so subtitles cannot be generated automatically. ' +
      'Add SARVAM_API_KEY to config.env next to Akashvani.exe, or upload an .srt yourself.'
    );
    err.notConfigured = true;
    throw err;
  }
  return key;
}

// ── ffmpeg helpers ──────────────────────────────────────────────────────────

/** Run ffmpeg/ffprobe and resolve with its stderr (where ffmpeg logs). */
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    liveProcs.add(proc);

    let killedByUs = false;
    const origKill = proc.kill.bind(proc);
    proc.kill = (...a) => { killedByUs = true; return origKill(...a); };

    let stderr = '';
    let stdout = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.stdout.on('data', (d) => { stdout += d.toString(); });

    proc.on('error', (err) => {
      liveProcs.delete(proc);
      reject(new Error(`Could not run ${bin}: ${err.message}`));
    });
    proc.on('close', (code) => {
      liveProcs.delete(proc);
      if (killedByUs) return reject(new TranscriptionStoppedError());
      if (code !== 0) return reject(new Error(`${bin} exited ${code}: ${stderr.slice(-1500)}`));
      resolve({ stderr, stdout });
    });
  });
}

/** Extract 16 kHz mono WAV and return its duration in seconds. */
async function extractAudio(video, outWav) {
  await run(FFMPEG_BIN, [
    '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', outWav,
  ]);
  const { stdout } = await run(FFPROBE_BIN, [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', outWav,
  ]);
  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not read the audio duration of ${video}`);
  }
  return duration;
}

/** Silence intervals as [[start, end], ...], via ffmpeg's silencedetect. */
async function detectSilences(wav) {
  const { stderr } = await run(FFMPEG_BIN, [
    '-i', wav,
    '-af', `silencedetect=noise=${SILENCE_NOISE}:d=${SILENCE_MIN}`,
    '-f', 'null', '-',
  ]);
  const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  return starts.slice(0, Math.min(starts.length, ends.length))
    .map((s, i) => [s, ends[i]]);
}

/**
 * Speech segments are the complement of the silences: padded outwards, blips
 * dropped, close neighbours merged, and anything over the REST cap split.
 */
export function buildSegments(silences, total) {
  const segs = [];
  let cursor = 0;
  for (const [sStart, sEnd] of silences) {
    if (sStart > cursor) segs.push([cursor, sStart]);
    cursor = Math.max(cursor, sEnd);
  }
  if (cursor < total) segs.push([cursor, total]);

  // pad into the surrounding silence so word edges survive the cut
  for (const seg of segs) {
    seg[0] = Math.max(0, seg[0] - SEG_PAD);
    seg[1] = Math.min(total, seg[1] + SEG_PAD);
  }

  const kept = segs.filter(([s, e]) => e - s >= MIN_SEG);

  const merged = [];
  for (const seg of kept) {
    const last = merged[merged.length - 1];
    if (last && seg[0] - last[1] < MERGE_GAP && seg[1] - last[0] <= MERGE_MAX) {
      last[1] = seg[1];
    } else {
      merged.push([seg[0], seg[1]]);
    }
  }

  const final = [];
  for (const [start, end] of merged) {
    const dur = end - start;
    if (dur <= HARD_MAX) {
      final.push([start, end]);
      continue;
    }
    const n = Math.floor(dur / HARD_MAX) + 1;
    const step = dur / n;
    for (let i = 0; i < n; i++) final.push([start + i * step, start + (i + 1) * step]);
  }
  return final;
}

function cutSegment(wav, start, end, out) {
  return run(FFMPEG_BIN, [
    '-y', '-i', wav,
    '-ss', start.toFixed(3), '-to', end.toFixed(3),
    '-c:a', 'pcm_s16le', out,
  ]);
}

// ── Sarvam API ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Transcribe one segment, retrying on rate limits and server errors.
 *
 * `language` is locked rather than auto-detected: on sub-second utterances
 * auto-detect misfires badly — Hindi "अच्छा" has come back in Bengali or
 * Kannada script, which silently corrupts the subtitle file.
 */
async function transcribeSegment(path, key, language, model) {
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([await readFile(path)], { type: 'audio/wav' }), 'segment.wav');
      form.append('model', model);
      form.append('mode', MODE);
      if (language) form.append('language_code', language);

      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'api-subscription-key': key },
        body: form,
        signal: AbortSignal.timeout(120000),
      });

      if (resp.ok) return await resp.json();

      const body = (await resp.text()).slice(0, 200);
      if (resp.status === 429) {
        lastErr = `HTTP 429: ${body}`;
        await sleep(5000 * attempt);       // rate limited — back off harder
        continue;
      }
      if ([500, 502, 503, 504].includes(resp.status)) {
        lastErr = `HTTP ${resp.status}: ${body}`;
        await sleep(2 ** attempt * 1000);
        continue;
      }
      // 4xx other than 429 won't fix itself by retrying
      throw new Error(`HTTP ${resp.status}: ${body}`);
    } catch (err) {
      if (err.stopped) throw err;
      if (/^HTTP 4/.test(err.message)) throw err;
      lastErr = err.message;
      await sleep(2 ** attempt * 1000);
    }
  }
  throw new Error(`segment failed after ${MAX_RETRIES} retries: ${lastErr}`);
}

// ── cue building ────────────────────────────────────────────────────────────

// Devanagari danda plus western sentence enders.
const SENTENCE_SPLIT = /(?<=[।.?!])\s+/;
const CLAUSE_SPLIT = /(?<=[,;])\s+/;

/**
 * Break text into the smallest natural units: sentences, then clauses, then
 * balanced halves for anything still over MAX_CUE_CHARS.
 */
export function splitUnits(text) {
  const units = [];
  for (const rawSent of text.split(SENTENCE_SPLIT)) {
    const sent = rawSent.trim();
    if (!sent) continue;
    const parts = sent.length <= MAX_CUE_CHARS ? [sent] : sent.split(CLAUSE_SPLIT);
    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (!part) continue;
      // word-level fallback: halve at the space nearest the middle until it fits
      const stack = [part];
      while (stack.length) {
        const p = stack.shift();
        if (p.length <= MAX_CUE_CHARS || !p.includes(' ')) {
          units.push(p);
          continue;
        }
        const mid = Math.floor(p.length / 2);
        const left = p.lastIndexOf(' ', mid);
        const right = p.indexOf(' ', mid);
        const cut = left !== -1 && (right === -1 || mid - left <= right - mid) ? left : right;
        stack.unshift(p.slice(0, cut).trim(), p.slice(cut + 1).trim());
      }
    }
  }
  return units;
}

function isJunk(text) {
  const stripped = text.toLowerCase().replace(/^[[\].।!?]+|[[\].।!?]+$/g, '');
  return JUNK_TRANSCRIPTS.has(stripped);
}

/**
 * One speech segment becomes one or more cues.
 *
 * Short segments map 1:1, and their timing is exact — straight off the silence
 * boundaries. A long transcript is split into natural units and the segment's
 * duration shared out by character count, which is an estimate within that
 * segment but never drifts beyond it.
 */
export function segmentToCues(start, end, transcript) {
  const text = (transcript || '').trim();
  if (!text || isJunk(text)) return [];
  if (text.length <= MAX_CUE_CHARS) return [{ start, end, text }];

  const units = splitUnits(text);

  // pack units back up into cue-sized pieces
  const pieces = [];
  let current = '';
  for (const unit of units) {
    const candidate = `${current} ${unit}`.trim();
    if (current && candidate.length > MAX_CUE_CHARS) {
      pieces.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);

  const totalChars = pieces.reduce((n, p) => n + p.length, 0);
  const duration = end - start;
  const cues = [];
  let cursor = start;
  pieces.forEach((piece, i) => {
    const share = (duration * piece.length) / totalChars;
    const cueEnd = i === pieces.length - 1 ? end : cursor + share;
    cues.push({ start: cursor, end: cueEnd, text: piece });
    cursor = cueEnd;
  });
  return cues;
}

/** SRT timestamp with millisecond precision: HH:MM:SS,mmm */
export function fmtSrtTime(seconds) {
  const msTotal = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(msTotal / 3600000);
  const m = Math.floor((msTotal % 3600000) / 60000);
  const s = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/** Break a long cue into at most two balanced lines. */
function wrapTwoLines(text, width = MAX_CUE_CHARS) {
  if (text.length <= width) return text;
  const mid = Math.floor(text.length / 2);
  const left = text.lastIndexOf(' ', mid);
  const right = text.indexOf(' ', mid);
  const cut = left !== -1 && (right === -1 || mid - left <= right - mid) ? left : right;
  if (cut === -1) return text;
  return `${text.slice(0, cut)}\n${text.slice(cut + 1)}`;
}

/** Serialise cues to SRT text, enforcing readable durations and no overlaps. */
export function buildSrt(cues) {
  for (const cue of cues) {
    if (cue.end - cue.start < MIN_CUE_DURATION) cue.end = cue.start + MIN_CUE_DURATION;
  }
  // padding above can push a cue into the next one — clamp rather than overlap
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
  }

  const lines = [];
  cues.forEach((cue, i) => {
    lines.push(String(i + 1));
    lines.push(`${fmtSrtTime(cue.start)} --> ${fmtSrtTime(cue.end)}`);
    lines.push(wrapTwoLines(cue.text));
    lines.push('');
  });
  // CRLF throughout, including inside a two-line cue. Premiere Pro and the
  // Windows subtitle tools downstream expect it, and it makes the output
  // byte-identical to the prototype these cue rules were validated against.
  return lines.join('\n').replace(/\n/g, '\r\n');
}

// ── orchestration ───────────────────────────────────────────────────────────

/** Run `jobs` with at most `limit` in flight, preserving result order. */
async function pooled(jobs, limit, onSettled) {
  const results = new Array(jobs.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      try {
        results[i] = await jobs[i]();
      } catch (err) {
        if (err.stopped) throw err;
        results[i] = null;
        onSettled?.(i, err);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Generate an SRT for one video.
 *
 * @param {string} videoPath
 * @param {string} outSrtPath
 * @param {object} opts
 * @param {(pct:number)=>void}   [opts.onProgress] 0-100
 * @param {(msg:string)=>void}   [opts.onLog]
 * @param {()=>void}             [opts.throwIfStopped] called at each boundary
 * @param {string}               [opts.model]
 * @param {string}               [opts.language] BCP-47, or 'unknown' to auto-detect
 * @param {string}               [opts.workDir]  scratch dir for segment WAVs
 * @returns {Promise<{srt: string, cues: number, segments: number, failed: number}>}
 */
export async function generateSrtForVideo(videoPath, outSrtPath, opts = {}) {
  const {
    onProgress = () => {},
    onLog = () => {},
    throwIfStopped = () => {},
    model = (process.env.SARVAM_MODEL || DEFAULT_MODEL).trim(),
    language = (process.env.SARVAM_LANGUAGE || DEFAULT_LANGUAGE).trim(),
    workDir = `${outSrtPath}.segments`,
  } = opts;

  const key = apiKey();
  const langLock = language === 'unknown' ? null : language;

  await mkdir(workDir, { recursive: true });
  const fullWav = join(workDir, 'full_audio.wav');

  try {
    throwIfStopped();
    onLog('Extracting audio (16 kHz mono)...');
    const total = await extractAudio(videoPath, fullWav);
    onLog(`Audio duration: ${total.toFixed(1)}s`);
    onProgress(10);

    throwIfStopped();
    onLog('Detecting silences to find phrase boundaries...');
    const silences = await detectSilences(fullWav);
    const segments = buildSegments(silences, total);
    if (!segments.length) {
      throw new Error('No speech found in this video — nothing to transcribe.');
    }
    const speech = segments.reduce((n, [s, e]) => n + (e - s), 0);
    onLog(`${silences.length} silences → ${segments.length} speech segments (${Math.round(speech)}s of speech)`);
    onProgress(15);

    onLog(`Cutting ${segments.length} segment files...`);
    const segFiles = [];
    for (let i = 0; i < segments.length; i++) {
      throwIfStopped();
      const p = join(workDir, `seg_${String(i).padStart(4, '0')}.wav`);
      await cutSegment(fullWav, segments[i][0], segments[i][1], p);
      segFiles.push(p);
      if (i % 25 === 0) onProgress(15 + Math.round((i / segments.length) * 15));
    }
    onProgress(30);

    onLog(`Transcribing ${segments.length} segments with ${model} (${MAX_WORKERS} at a time)...`);
    let done = 0;
    const failures = [];
    const jobs = segFiles.map((file, i) => async () => {
      throwIfStopped();
      const payload = await transcribeSegment(file, key, langLock, model);
      done++;
      onProgress(30 + Math.round((done / segments.length) * 65));
      if (done % 10 === 0 || done === segments.length) {
        onLog(`  ${done}/${segments.length} segments transcribed`);
      }
      return payload;
    });

    const results = await pooled(jobs, MAX_WORKERS, (i, err) => {
      failures.push(i);
      logWarn('Sarvam segment failed', { index: i, error: err.message });
    });

    // Sequential retry for stragglers — these are nearly always rate-limit
    // casualties, and a second pass at one-at-a-time usually recovers them.
    if (failures.length) {
      onLog(`Retrying ${failures.length} failed segment(s) one at a time...`);
      await sleep(10000);
      for (const i of failures) {
        throwIfStopped();
        try {
          results[i] = await transcribeSegment(segFiles[i], key, langLock, model);
        } catch (err) {
          logWarn('Sarvam segment failed on retry', { index: i, error: err.message });
          onLog(`  segment ${i + 1} could not be transcribed — leaving a gap`);
        }
        await sleep(2000);
      }
    }

    if (results.every((r) => r === null)) {
      throw new Error(
        'Every segment failed to transcribe. Check the Sarvam API key and this machine\'s internet connection.'
      );
    }

    onLog('Building subtitle cues...');
    const cues = [];
    results.forEach((payload, i) => {
      if (!payload) return;
      cues.push(...segmentToCues(segments[i][0], segments[i][1], payload.transcript || ''));
    });
    if (!cues.length) {
      throw new Error('Transcription returned no usable text for this video.');
    }

    const srt = buildSrt(cues);
    await writeFile(outSrtPath, srt, 'utf8');

    // Keep the raw responses next to the SRT. When a reviewer says a line is
    // wrong, this is the only way to tell a bad transcription apart from bad
    // cue shaping without paying to run the whole episode again.
    await writeFile(
      `${outSrtPath.replace(/\.srt$/i, '')}.raw.json`,
      JSON.stringify(segments.map(([s, e], i) => ({ start: s, end: e, response: results[i] })), null, 2),
      'utf8'
    );

    const stillFailed = results.filter((r) => r === null).length;
    onLog(`${cues.length} cues written${stillFailed ? ` (${stillFailed} segment(s) missing)` : ''}`);
    onProgress(100);

    logInfo('Sarvam transcription complete', {
      video: videoPath, cues: cues.length, segments: segments.length, failed: stillFailed, model,
    });

    return { srt, cues: cues.length, segments: segments.length, failed: stillFailed };
  } finally {
    // Segment WAVs are pure scratch and can run to hundreds of files.
    await rm(workDir, { recursive: true, force: true }).catch((err) => {
      logWarn('Could not clean up transcription scratch dir', { workDir, error: err.message });
    });
  }
}
