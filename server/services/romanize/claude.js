/**
 * Transliterating subtitle text with Claude.
 *
 * Only the subtitle TEXT is sent. Timecodes and block numbers stay in srt.js,
 * which is both the token saving and the reason output timing always matches
 * input timing exactly.
 *
 * Two failure modes are handled here, and both were found the hard way:
 *
 *   1. A SAFETY REFUSAL arrives as a normal HTTP 200 with stop_reason
 *      "refusal", no content blocks and zero output tokens. Retrying the same
 *      batch is pointless (verified deterministic) — but the same lines sail
 *      through in a smaller group, so the batch is halved instead. Measured: a
 *      40-line batch refused 3/3 times, its second half passed immediately, and
 *      single lines always pass.
 *
 *   2. The model ECHOES lines back in the original script. This is the
 *      dangerous one, because it looks like success: the reply parses, every
 *      line is accounted for, and native-script text ships in a file that
 *      appears finished. Nothing downstream catches it either — the dictionary
 *      pass only ever rewrites Roman words. So the output is checked against
 *      the one thing we know for certain: romanized text contains no Indic
 *      letters.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  BASE_RETRY_DELAY, BATCH_SIZE, EFFORT, INDIC_CHARS, LANGUAGES,
  MAX_ATTEMPTS, MODEL, RETRYABLE_STATUS,
} from './config.js';
import { logInfo, logWarn, logError } from '../logger.js';
import { CONFIG_FILE_HINT } from '../../paths.js';

const NATIVE_SCRIPT_RE = new RegExp(`[${INDIC_CHARS}]`);
const NUMBERED_RE = /^\s*(\d+)\t(.*)$/;            // strict: "12\t<text>"
const LOOSE_RE = /^\s*(\d+)\s*[\t.):\-]\s?(.*)$/;  // fallback: "12. <text>"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_TEMPLATE = (language) =>
  'You are an expert transliterator for Indian-language subtitles (Same Language ' +
  'Subtitling, used for reading practice).\n\n' +
  `Every user message contains numbered subtitle lines in ${language}. For each ` +
  'line, TRANSLITERATE it into the Latin/Roman alphabet — write how the words ' +
  'SOUND using ordinary English letters. Do NOT translate the meaning into ' +
  'English; only convert the script to Roman letters.\n\n' +
  'Output rules (follow EXACTLY):\n' +
  '- Return one output line for every input line, in the same order.\n' +
  '- Each output line MUST be: the same number, then a single TAB character ' +
  '(\\t), then the romanized text. Example:  12\\tmera dil kho gaya\n' +
  '- Use natural, widely-used phonetic romanization (the common way these ' +
  'words are written in Roman script).\n' +
  '- Use normal sentence capitalization: capitalize the first letter of each ' +
  'sentence and proper nouns (names, places). Keep all other words lowercase. ' +
  'Do NOT lowercase everything, and do NOT capitalize every word.\n' +
  '- Convert native-script digits to Western digits (e.g. १९४७ -> 1947).\n' +
  '- Keep punctuation, musical symbols (like ♪), and any text that is already ' +
  'in Roman letters unchanged.\n' +
  '- If a line cannot be transliterated, repeat it unchanged (still with its ' +
  'number and tab).\n' +
  '- Never merge, split, drop, reorder, or add lines. Output ONLY the numbered ' +
  'lines — no commentary, headings, code fences, or blank lines.';

/** "The reply came back but we cannot use it" — callers split rather than accept. */
export class BatchUnusable extends Error {}
export class BatchRefused extends BatchUnusable {}
export class BatchNotRomanized extends BatchUnusable {}

export function isRomanizeConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY || '').trim();
}

export class Romanizer {
  constructor(language, { apiKey, throwIfStopped } = {}) {
    this.language = language;
    this.languageDesc = LANGUAGES[language] || language;
    this.throwIfStopped = throwIfStopped || (() => {});
    const key = (apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
    if (!key) {
      const err = new Error(
        'No Anthropic API key on this machine, so subtitles cannot be romanized. ' +
        `Add ANTHROPIC_API_KEY to ${CONFIG_FILE_HINT}.`
      );
      err.notConfigured = true;
      throw err;
    }
    this.client = new Anthropic({ apiKey: key });

    // Measured spend for this file. Every call adds to it, including the extra
    // calls a refusal split costs — those are real money and must not be
    // invisible in the usage report.
    this.usage = {
      apiCalls: 0, inputTokens: 0, outputTokens: 0,
      cacheWriteTokens: 0, cacheReadTokens: 0,
    };
  }

  /** Transient Anthropic errors worth retrying; never a 4xx. */
  static isRetryable(err) {
    const status = err?.status ?? err?.statusCode;
    if (status && RETRYABLE_STATUS.has(status)) return true;
    if (err instanceof Anthropic.APIConnectionError) return true;
    if (err?.name === 'APIConnectionTimeoutError') return true;
    return /overloaded/i.test(String(err?.message || ''));
  }

  /**
   * Map the model's reply back to n lines. Prefers the explicit "N\t…" form;
   * falls back to positional mapping if the count lines up but numbering drifted.
   */
  static parseNumbered(output, n) {
    const result = new Array(n).fill(null);
    for (const line of output.split('\n')) {
      const m = NUMBERED_RE.exec(line);
      if (!m) continue;
      const idx = parseInt(m[1], 10);
      if (idx >= 1 && idx <= n) result[idx - 1] = m[2];
    }

    if (result.some((x) => x === null)) {
      const cand = [];
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        const m = LOOSE_RE.exec(line);
        cand.push(m ? m[2] : line.trim());
      }
      if (cand.length === n) {
        for (let i = 0; i < n; i++) if (result[i] === null) result[i] = cand[i];
      }
    }
    return result;
  }

  addUsage(usage) {
    if (!usage) return;
    this.usage.apiCalls += 1;
    this.usage.inputTokens += usage.input_tokens || 0;
    this.usage.outputTokens += usage.output_tokens || 0;
    this.usage.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
    this.usage.cacheReadTokens += usage.cache_read_input_tokens || 0;
  }

  /** One batch. @returns {{lines: string[], missing: number}} */
  async romanizeBatch(batch) {
    const numbered = batch.map((t, i) => `${i + 1}\t${t}`).join('\n');
    const request = {
      model: MODEL,
      max_tokens: Math.min(16000, Math.max(1500, batch.length * 200)),
      output_config: { effort: EFFORT },
      system: [{
        type: 'text',
        text: SYSTEM_TEMPLATE(this.languageDesc),
        cache_control: { type: 'ephemeral' },  // reused across batches in a run
      }],
      messages: [{ role: 'user', content: numbered }],
    };

    let msg;
    let attempt = 0;
    for (;;) {
      this.throwIfStopped();
      try {
        // Streaming avoids HTTP timeouts on large batches; the helper assembles
        // the reply without hand-handling events.
        const stream = this.client.messages.stream(request);
        msg = await stream.finalMessage();
        break;
      } catch (err) {
        if (err?.stopped) throw err;
        attempt += 1;
        if (attempt >= MAX_ATTEMPTS || !Romanizer.isRetryable(err)) throw err;
        const delay = BASE_RETRY_DELAY * 2 ** (attempt - 1) + Math.random() * 750;
        logWarn('Anthropic transient error; retrying romanize batch', {
          attempt, of: MAX_ATTEMPTS - 1, delayMs: Math.round(delay), error: err?.message,
        });
        await sleep(delay);
      }
    }

    // Recorded BEFORE the checks below, because a refused batch still bills for
    // its input even though it returns nothing usable.
    this.addUsage(msg.usage);

    if (msg.stop_reason === 'refusal') {
      throw new BatchRefused(
        `refused a batch of ${batch.length} line(s)` +
        (msg.stop_details?.category ? ` (${msg.stop_details.category})` : '')
      );
    }

    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const parsed = Romanizer.parseNumbered(text, batch.length);

    // Checked BEFORE the fallback below, so an echoed line is never mistaken
    // for a successful romanization.
    const echoed = parsed
      .map((p, i) => (p && NATIVE_SCRIPT_RE.test(p) ? i : -1))
      .filter((i) => i >= 0);
    if (echoed.length) {
      throw new BatchNotRomanized(
        `${echoed.length} of ${batch.length} line(s) came back in the original script, ` +
        `e.g. "${String(parsed[echoed[0]]).slice(0, 60)}"`
      );
    }

    const lines = [];
    let missing = 0;
    batch.forEach((orig, i) => {
      const rom = parsed[i];
      if (!rom || !rom.trim()) {
        lines.push(orig);   // safest fallback: keep the source line
        missing += 1;
      } else {
        lines.push(rom);
      }
    });
    return { lines, missing };
  }

  /**
   * One batch, surviving refusals by recursively halving around them.
   *
   * Halving recovers nearly everything and confines any genuinely
   * unrecoverable refusal to ONE line instead of forty.
   *
   * @returns {{lines, missing, refusedOffsets}} offsets into `batch` that kept
   *   their source text.
   */
  async romanizeResilient(batch, depth = 0) {
    try {
      const { lines, missing } = await this.romanizeBatch(batch);
      if (depth) logInfo(`Recovered ${batch.length} line(s) after splitting`, { depth });
      return { lines, missing, refusedOffsets: [] };
    } catch (err) {
      if (!(err instanceof BatchUnusable)) throw err;

      if (batch.length === 1) {
        // Nothing left to split. Keep the source line and report it upward — the
        // caller turns this into a visible warning naming the subtitle.
        logError('Unromanized even as a single line; keeping source', {
          kind: err.constructor.name, line: batch[0].slice(0, 90),
        });
        return { lines: [...batch], missing: 0, refusedOffsets: [0] };
      }

      const half = Math.floor(batch.length / 2);
      logWarn(`${err.constructor.name} on ${batch.length} line(s); splitting`, {
        depth, into: [half, batch.length - half],
      });
      const left = await this.romanizeResilient(batch.slice(0, half), depth + 1);
      const right = await this.romanizeResilient(batch.slice(half), depth + 1);
      return {
        lines: [...left.lines, ...right.lines],
        missing: left.missing + right.missing,
        refusedOffsets: [
          ...left.refusedOffsets,
          ...right.refusedOffsets.map((i) => half + i),
        ],
      };
    }
  }

  /**
   * Romanize every line of a file.
   *
   * @param {string[]} texts
   * @param {(done:number,total:number)=>void} [onProgress]
   * @returns {{lines, missing, refused:number[]}}
   */
  async romanizeAll(texts, onProgress) {
    const lines = [];
    const refused = [];
    let missing = 0;

    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      this.throwIfStopped();
      const batch = texts.slice(start, start + BATCH_SIZE);
      const res = await this.romanizeResilient(batch);
      lines.push(...res.lines);
      missing += res.missing;
      refused.push(...res.refusedOffsets.map((off) => start + off));
      onProgress?.(Math.min(start + batch.length, texts.length), texts.length);
    }

    return { lines, missing, refused };
  }
}
