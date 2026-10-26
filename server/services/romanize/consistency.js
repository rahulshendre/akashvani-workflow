/**
 * Guidelines 2 and 3: one spelling per word, consistent vowel length.
 *
 * This cannot be a prompt instruction. Each batch is an independent API call
 * with no memory of the others, so "be consistent" has nothing to be consistent
 * WITH. Measured on a finished episode, the model contradicted itself 12 times
 * in a single file: pareshaan/pareshan, haan/han, kaam/kam, jaaye/jaye,
 * waale/wale.
 *
 * So consistency is enforced afterwards, mechanically: cluster the words that
 * are the same word spelled differently, pick the approved form where the
 * dictionary knows one, and flag the rest for the Language Expert rather than
 * guessing.
 */

const WORD_RE = /[A-Za-z]+/g;

/**
 * Differences that mean "same word, different spelling" rather than "different
 * word". Each is a convention the guidelines name explicitly.
 */
const FOLD = [
  [/([aeiou])\1+/g, '$1'],  // vowel length: aa/a, ee/i, oo/u
  [/ee/g, 'i'],             // guideline 3: ई → i
  [/oo/g, 'u'],             // guideline 3: ऊ → oo/u
  [/w/g, 'v'],              // व: v/w are the same consonant
  [/z/g, 'j'],              // ज़/ज
  [/chh/g, 'ch'],           // छ/च
  [/n$/g, ''],              // guideline 4: nasal kept or not
];

/**
 * Short words collide under folding for boring reasons ("a"/"aa", "to"/"too"),
 * so they are excluded rather than reported as false positives.
 */
const MIN_LENGTH = 4;

export class ConsistencyChecker {
  /**
   * @param {object} approved the dictionary's {wrongLower: right} map; when a
   *   cluster contains an approved spelling, that one is the answer and no
   *   human needs to look at it.
   */
  constructor(approved) {
    this.approved = approved || {};
    this._approvedLower = new Set(
      Object.values(this.approved).map((v) => String(v).toLowerCase())
    );
  }

  /** Reduce a word to the form it shares with its own variants. */
  static fold(word) {
    let w = word.toLowerCase();
    for (const [pattern, repl] of FOLD) w = w.replace(pattern, repl);
    return w;
  }

  /**
   * Every group of 2+ spellings that fold to the same word, most frequent
   * first — so the most damaging inconsistencies are reviewed first.
   */
  clusters(text) {
    const counts = new Map();
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text)) !== null) {
      if (m[0].length < MIN_LENGTH) continue;
      counts.set(m[0], (counts.get(m[0]) || 0) + 1);
    }

    const grouped = new Map();
    for (const [word, n] of counts) {
      const key = ConsistencyChecker.fold(word);
      if (!grouped.has(key)) grouped.set(key, new Map());
      const variants = grouped.get(key);
      variants.set(word, (variants.get(word) || 0) + n);
    }

    const out = [];
    for (const variants of grouped.values()) {
      // case-only differences are handled by matchCase, not here
      if (new Set([...variants.keys()].map((v) => v.toLowerCase())).size < 2) continue;

      const spellings = [...variants.entries()].sort((a, b) => b[1] - a[1]);
      const approved = spellings.find(([s]) => this._approvedLower.has(s.toLowerCase()))?.[0] ?? null;

      out.push({
        variants: spellings,
        total: spellings.reduce((n, [, c]) => n + c, 0),
        approved,
        suggested: approved || spellings[0][0],  // else the commonest
      });
    }

    out.sort((a, b) => b.total - a.total);
    return out;
  }

  /** One line per inconsistency, ready to show a reviewer. */
  summary(text) {
    return this.clusters(text).map((c) => {
      const shown = c.variants.map(([s, n]) => `${s}x${n}`).join(' / ');
      const why = c.approved ? 'dictionary' : 'most common in this file';
      return `${shown}  ->  use ${c.suggested} (${why})`;
    });
  }
}
