/**
 * Guideline 8: punctuation.
 *
 * Romanization must not change punctuation, and the Devanagari-only marks have
 * exact Roman equivalents. That makes this the one guideline that is fully
 * deterministic, so it is done in code and deliberately kept OUT of the prompt:
 * every rule spent on punctuation is prompt budget taken from the rules that
 * genuinely need the model's judgement.
 *
 * Source normalisation runs BEFORE the model sees the text, so the model never
 * has to decide. The output check runs after, as a guard rather than a fix.
 */

const DANDA = '।';         // ।
const DOUBLE_DANDA = '॥';  // ॥
const VISARGA = 'ः';       // ः

/**
 * ॥१॥ — a verse number, not dialogue. Matched before the bare double danda so
 * the digits go with it instead of being left stranded mid-subtitle.
 */
const VERSE_NUMBER_RE = /॥\s*[०-९0-9]+\s*॥/g;

/**
 * An ASCII colon between two Devanagari letters is a typed stand-in for visarga
 * (दु:ख for दुःख), not punctuation — the dictionary drops it. A colon with a
 * space or digit beside it is left alone, so timecodes and ordinary "note:"
 * colons are untouched.
 */
const INLINE_COLON_RE = /(?<=[ऀ-ॿ]):(?=[ऀ-ॿ])/g;

/** Diacritics guidelines 4 and 5 say not to introduce. */
const DIACRITIC_RE =
  /[Ā-ſḀ-ỿāīūēōṭḍṇṛṣśñṅṃḥãõ]/;
const DEVANAGARI_RE = /[ऀ-ॿ]/;
const DANDA_LEFT_RE = new RegExp(`[${DANDA}${DOUBLE_DANDA}]`);
const VISARGA_RE = new RegExp(VISARGA);

export class PunctuationNormalizer {
  /**
   * Rewrite Devanagari-only punctuation in the SOURCE subtitle.
   *
   * Visarga is deliberately left for the dictionary and the model, because its
   * correct output depends on position (word-final → "h", mid-word → dropped)
   * and faking that here would mean inserting Devanagari letters.
   *
   * @returns {{text: string, counts: object}}
   */
  normalizeSource(text) {
    const counts = { danda: 0, double_danda: 0, verse_number: 0, inline_colon: 0 };

    counts.verse_number = (text.match(VERSE_NUMBER_RE) || []).length;
    text = text.replace(VERSE_NUMBER_RE, '.');

    counts.double_danda = (text.match(new RegExp(DOUBLE_DANDA, 'g')) || []).length;
    text = text.split(DOUBLE_DANDA).join('.');

    counts.danda = (text.match(new RegExp(DANDA, 'g')) || []).length;
    text = text.split(DANDA).join('.');

    counts.inline_colon = (text.match(INLINE_COLON_RE) || []).length;
    text = text.replace(INLINE_COLON_RE, '');

    return { text, counts };
  }

  /**
   * Report guideline violations left in the romanized text. Nothing is
   * rewritten — these are flagged for review, which is what guideline 9.4 asks.
   *
   * @returns {{code: string, count: number, examples: string[], note: string}[]}
   */
  checkOutput(text) {
    const issues = [];
    const lines = text.split('\n');

    const add = (code, pattern, note) => {
      const hits = lines.filter((l) => pattern.test(l));
      if (hits.length) {
        issues.push({ code, count: hits.length, examples: hits.slice(0, 5), note });
      }
    };

    add('devanagari_left', DEVANAGARI_RE,
      'lines still in the original script — usually a refused batch');
    add('diacritics', DIACRITIC_RE,
      'guidelines 4 and 5 say plain A-Z only, no diacritical marks');
    add('danda_left', DANDA_LEFT_RE,
      'danda should have become a period');
    add('visarga_left', VISARGA_RE,
      "visarga should be 'h' word-finally, dropped mid-word");

    return issues;
  }
}
