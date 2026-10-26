/**
 * Romanizing one episode's subtitles, end to end.
 *
 * The order of the passes is the design, and it is not arbitrary:
 *
 *   1. PUNCTUATION is normalised in the source, so the model never has to
 *      decide — and the rule holds even with no dictionary configured.
 *   2. PRE-SUBSTITUTION writes the experts' confirmed spellings in before the
 *      model sees the text, and locks those words. This settles words the model
 *      cannot: the dictionary holds contradictory pairs (nikal→nikaal AND
 *      nikaal→nikal) and only the original native script says which is right.
 *   3. CLAUDE transliterates the text only. Timecodes never leave srt.js.
 *   4. FINALIZE fixes spacing and sentence/lyric capitalisation.
 *   5. The DICTIONARY applies its confirmed corrections — skipping the locked
 *      words, or a confirmed spelling would be "corrected" straight back.
 *   6. The QUALITY REPORT flags what still needs a human: leftover punctuation,
 *      diacritics, and words spelled inconsistently across the file.
 */

import { readFile } from 'fs/promises';
import { ConsistencyChecker } from './consistency.js';
import { Dictionary, matchCase } from './dictionary.js';
import { PreSubstitutor } from './presubstitute.js';
import { PunctuationNormalizer } from './punctuation.js';
import { Romanizer } from './claude.js';
import { RomanizationCache } from './cache.js';
import { SrtDocument } from './srt.js';
import { TextFinalizer } from './textFinalizer.js';
import { buildReviewDocx } from './reviewDocx.js';
import { fetchDictionary } from './dictionarySource.js';
import { DEFAULT_LANGUAGE, LANGUAGES, TIMECODE_RE } from './config.js';
import { logInfo } from '../logger.js';

export { LANGUAGES, DEFAULT_LANGUAGE };

/**
 * Apply the confirmed dictionary corrections to finished romanized text.
 *
 * Only the exact dictionary is applied — these are the spellings the experts
 * have agreed, so they are certain. Pre-substituted words are skipped.
 */
function applyDictionary(text, replacements, protectedWords) {
  const exactRe = Dictionary.buildExactRegex(replacements);
  if (!exactRe) return { text, applied: 0, exactRe: null };

  let applied = 0;
  const INDEX_RE = /^\d+$/;

  const out = text.split('\n').map((line) => {
    const s = line.trim();
    if (!s || line.includes('-->') || INDEX_RE.test(s)) return line;
    exactRe.lastIndex = 0;
    return line.replace(exactRe, (whole, word) => {
      const lower = word.toLowerCase();
      if (protectedWords.has(lower)) return whole;
      const rep = replacements[lower];
      if (rep === undefined) return whole;
      applied += 1;
      return matchCase(word, rep);
    });
  }).join('\n');

  return { text: out, applied, exactRe };
}

/**
 * Romanize one .srt file.
 *
 * @param {string} srtPath            the native-script subtitle to romanize
 * @param {object} opts
 * @param {string} [opts.language]    dropdown label, e.g. "Hindi"
 * @param {boolean} [opts.useCache]   reuse an identical earlier run
 * @param {(p:number)=>void} [opts.onProgress]  0-100
 * @param {(m:string)=>void} [opts.onLog]
 * @param {()=>void} [opts.throwIfStopped]
 * @returns {Promise<{romanizedText, reviewDocx, stats}>}
 */
export async function romanizeSrtFile(srtPath, opts = {}) {
  const {
    language = DEFAULT_LANGUAGE,
    useCache = true,
    onProgress = () => {},
    onLog = () => {},
    throwIfStopped = () => {},
  } = opts;

  if (!LANGUAGES[language]) {
    throw new Error(`"${language}" is not one of the supported languages.`);
  }

  const raw = await readFile(srtPath);
  let sourceText = SrtDocument.decode(raw);

  // ── 1. punctuation ────────────────────────────────────────────────────────
  const { text: punctText, counts: punct } = new PunctuationNormalizer().normalizeSource(sourceText);
  sourceText = punctText;
  const punctTotal = Object.values(punct).reduce((a, b) => a + b, 0);
  if (punctTotal) {
    onLog(`Punctuation normalised: ${Object.entries(punct)
      .filter(([, v]) => v).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')}.`);
  }
  onProgress(3);

  // ── 2. dictionary + pre-substitution ──────────────────────────────────────
  throwIfStopped();
  let dictionary = null;
  let dictionaryName = null;
  let protectedWords = new Set();
  let preReplaced = 0;

  const fetched = await fetchDictionary(language);
  if (!fetched) {
    onLog(`No ${language} dictionary is set, so no spelling corrections will be applied.`);
  } else {
    dictionary = Dictionary.fromDocx(fetched.bytes, language);
    dictionaryName = fetched.name;
    onLog(`Dictionary "${fetched.name}": ${dictionary.size} spellings, ` +
      `${Object.keys(dictionary.nativeMap).length} native words${fetched.cached ? ' (cached)' : ''}.`);

    if (Object.keys(dictionary.nativeMap).length) {
      const pre = new PreSubstitutor(dictionary.nativeMap).apply(sourceText);
      sourceText = pre.text;
      protectedWords = pre.protectedWords;
      preReplaced = pre.replaced;
      if (preReplaced) {
        onLog(`${preReplaced} native word(s) replaced with their confirmed spelling and locked.`);
      }
    }
  }
  onProgress(8);

  // ── 3. romanize (cached by exact source + language) ───────────────────────
  throwIfStopped();
  const cache = new RomanizationCache();
  const cacheKey = cache.key(sourceText, language);
  let romanizedText = null;
  let romanizeStats = null;

  if (useCache) {
    const hit = await cache.load(cacheKey);
    if (hit) {
      romanizedText = TextFinalizer.finalize(hit.romanizedText);
      romanizeStats = { ...(hit.stats || {}), cached: true };
      onLog('This exact subtitle was romanized before — reusing it, no API call.');
      onProgress(70);
    }
  }

  if (romanizedText === null) {
    const doc = SrtDocument.parse(sourceText);
    const { refs, texts } = doc.collect();

    if (!texts.length) throw new Error('That subtitle file has no text lines to romanize.');

    onLog(`Romanizing ${texts.length} line(s) across ${doc.blocks.length} subtitle(s)...`);
    const romanizer = new Romanizer(language, { throwIfStopped });
    const { lines, missing, refused } = await romanizer.romanizeAll(texts, (done, total) => {
      onProgress(8 + Math.round((done / total) * 62));
      if (done % 200 === 0 || done === total) onLog(`  ${done}/${total} lines romanized`);
    });

    doc.apply(refs, lines);

    // Report refusals as the SUBTITLE NUMBERS a reader sees, so the few
    // affected lines can be fixed by hand instead of hunted for.
    const refusedSubtitles = [...new Set(
      refused.map((i) => doc.subtitleNumber(refs[i][0])).filter(Boolean)
    )].sort((a, b) => Number(a) - Number(b));

    romanizedText = TextFinalizer.finalize(doc.serialize());
    romanizeStats = {
      lines: texts.length,
      blocks: doc.blocks.length,
      missing,
      cached: false,
      refused: refused.length,
      refusedSubtitles,
      usage: romanizer.usage,
    };
    if (useCache) await cache.store(cacheKey, romanizedText, romanizeStats);
  }
  onProgress(72);

  // ── 4. confirmed dictionary corrections ───────────────────────────────────
  throwIfStopped();
  let corrections = 0;
  let exactRe = null;
  if (dictionary && dictionary.size) {
    const applied = applyDictionary(romanizedText, dictionary.replacements, protectedWords);
    romanizedText = applied.text;
    corrections = applied.applied;
    exactRe = applied.exactRe;
    onLog(`${corrections} confirmed dictionary correction(s) applied.`);
  }
  onProgress(85);

  // ── 5. quality report ─────────────────────────────────────────────────────
  const bodyOnly = romanizedText.split('\n')
    .filter((l) => !l.includes('-->') && !/^\d+$/.test(l.trim()))
    .join('\n');

  const issues = new PunctuationNormalizer().checkOutput(bodyOnly);
  for (const issue of issues) {
    onLog(`Check: ${issue.code.replace(/_/g, ' ')} on ${issue.count} line(s) — ${issue.note}`);
  }

  const inconsistencies = new ConsistencyChecker(dictionary?.replacements).summary(bodyOnly);
  if (inconsistencies.length) {
    onLog(`${inconsistencies.length} word(s) are spelled inconsistently in this file — see the review file.`);
  }

  // ── 6. review document ────────────────────────────────────────────────────
  const { buffer: reviewDocx } = await buildReviewDocx(
    romanizedText, dictionary?.replacements || {}, protectedWords, exactRe
  );
  onProgress(95);

  const stats = {
    language,
    dictionary: dictionaryName,
    preReplaced,
    corrections,
    inconsistencies,
    issues,
    punct,
    timecodes: (romanizedText.match(TIMECODE_RE) || []).length,
    ...romanizeStats,
  };

  logInfo('romanization complete', {
    srtPath, language, lines: stats.lines, corrections,
    refused: stats.refused, cached: stats.cached,
  });

  return { romanizedText, reviewDocx, stats };
}
