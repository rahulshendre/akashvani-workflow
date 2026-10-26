/**
 * Writing the experts' agreed spellings in BEFORE the model sees the text.
 *
 * This exists to settle words the model cannot settle on its own. The
 * dictionary contains conflicting pairs like nikal→nikaal AND nikaal→nikal;
 * only the ORIGINAL native-script word says which is right. So the native word
 * is replaced up front with its confirmed PlanetRead spelling, and the word is
 * returned in a `protected` set that every later correction pass must skip —
 * otherwise a confirmed spelling would be "corrected" a second time, straight
 * back to the wrong one.
 */

import { INDIC_CHARS } from './config.js';

const INDEX_RE = /^\d+$/;

export class PreSubstitutor {
  constructor(nativeMap) {
    this.nativeMap = nativeMap || {};
    this.pattern = PreSubstitutor.compile(this.nativeMap);
  }

  static compile(nativeMap) {
    const keys = Object.keys(nativeMap).sort((a, b) => b.length - a.length);
    if (!keys.length) return null;
    const alt = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    // The lookarounds span every supported Indic block, so a word is replaced
    // only when it is not glued to another native letter.
    return new RegExp(
      `(?<![${INDIC_CHARS}])(${alt})(?![${INDIC_CHARS}])`, 'g'
    );
  }

  /**
   * Replace dictionary native-script words with their PlanetRead Roman spellings.
   *
   * Timecode, index and blank lines are never touched.
   *
   * @returns {{text: string, protectedWords: Set<string>, replaced: number}}
   *   `protectedWords` are lowercase Roman words that were written in and must
   *   not be altered by any later correction pass.
   */
  apply(srtText) {
    if (this.pattern === null) {
      return { text: srtText, protectedWords: new Set(), replaced: 0 };
    }

    const protectedWords = new Set();
    let replaced = 0;

    const out = srtText.split('\n').map((line) => {
      const s = line.trim();
      if (line.includes('-->') || INDEX_RE.test(s) || !s) return line;
      return line.replace(this.pattern, (_m, word) => {
        const rep = this.nativeMap[word];
        protectedWords.add(rep.toLowerCase());
        replaced++;
        return rep;
      });
    });

    return { text: out.join('\n'), protectedWords, replaced };
  }
}
