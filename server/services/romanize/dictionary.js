/**
 * The Universal Dictionary: the experts' agreed spellings, parsed from a .docx.
 *
 * The source table is 4 columns:
 *   S.No | AI Version | Planet Read Version | native-script word
 *
 * and it is parsed into the three shapes the pipeline needs:
 *   replacements : {wrongVariantLower: planetReadWord}  exact corrections
 *   pairs        : [[wrong, right], ...]                 correction pairs
 *   nativeMap    : {nativeScriptWord: planetReadWord}     drives pre-substitution
 */

import AdmZip from 'adm-zip';
import { HINDI_FORCE, INDIC_RE } from './config.js';

const NOTE_RE_SQUARE = /\[[^\]]*\]/g;
const NOTE_RE_ROUND = /\([^)]*\)/g;
const W_T_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');   // last, so "&amp;lt;" doesn't become "<"
}

/**
 * Every `<tag>…</tag>` element at the OUTERMOST level, depth-aware.
 *
 * A non-greedy regex would stop at the first closing tag, so a nested table
 * would silently split one cell into several and shift every column. Counting
 * depth costs a few lines and removes that whole class of corruption.
 */
function extractElements(xml, tag) {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?(/?)>`, 'g');
  const close = `</${tag}>`;
  const out = [];
  let depth = 0;
  let start = -1;
  let i = 0;

  while (i < xml.length) {
    open.lastIndex = i;
    const m = open.exec(xml);
    const closeAt = xml.indexOf(close, i);

    if (!m && closeAt === -1) break;

    if (m && (closeAt === -1 || m.index < closeAt)) {
      if (m[1] === '/') { i = m.index + m[0].length; continue; } // self-closing
      if (depth === 0) start = m.index;
      depth++;
      i = m.index + m[0].length;
    } else {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        out.push(xml.slice(start, closeAt + close.length));
        start = -1;
      }
      i = closeAt + close.length;
    }
  }
  return out;
}

/**
 * All text in a table cell, including text Word has wrapped in a content
 * control (<w:sdt>) or a tracked insertion (<w:ins>).
 *
 * A real dictionary hit this: the Hindi column was wrapped in content controls
 * and all 1,492 native words parsed as blank, silently disabling
 * pre-substitution while everything still looked fine. Reading every <w:t>
 * descendant in document order is immune to how the cell is wrapped.
 */
function cellText(cellXml) {
  const parts = [];
  W_T_RE.lastIndex = 0;
  let m;
  while ((m = W_T_RE.exec(cellXml)) !== null) parts.push(m[1]);
  return decodeXmlEntities(parts.join('')).trim();
}

export class Dictionary {
  constructor(replacements, pairs, nativeMap) {
    this.replacements = replacements;
    this.pairs = pairs;
    this.nativeMap = nativeMap;
    this._exactRe = undefined;
  }

  /** Strip human annotation notes like [accent] / (as per dialogue). */
  static cleanNote(s) {
    return s.replace(NOTE_RE_SQUARE, '').replace(NOTE_RE_ROUND, '').trim();
  }

  /**
   * True for the table's header row.
   *
   * Matched on BOTH columns rather than one exact string, because the header
   * wording has already changed once ("AI Version" → "AI Roman") and the old
   * exact check silently let the header through as a real correction pair.
   */
  static isHeaderRow(aiWord, prWord) {
    const a = aiWord.toLowerCase().trim();
    const p = prWord.toLowerCase().trim();
    return a.startsWith('ai ') || a === 'ai' || a === 'ai_version'
      || p.replace(/ /g, '').startsWith('planetread');
  }

  /**
   * @param {Buffer} fileBytes  the .docx
   * @param {string|null} language  dropdown label; gates HINDI_FORCE only, which
   *        must not be injected into another language's map.
   */
  static fromDocx(fileBytes, language = null) {
    const zip = new AdmZip(fileBytes);
    const entry = zip.getEntry('word/document.xml');
    if (!entry) throw new Error('That file is not a readable Word document (no document.xml).');
    const xml = entry.getData().toString('utf8');

    const replacements = {};
    const pairs = [];
    const nativeMap = {};

    // Rows directly, rather than tables-then-rows: the result is the same and it
    // sidesteps having to resolve table boundaries at all.
    for (const rowXml of extractElements(xml, 'w:tr')) {
      const cells = extractElements(rowXml, 'w:tc').map(cellText);
      if (cells.length < 3) continue;

      const aiWord = (cells[1] || '').trim();
      const prWord = (cells[2] || '').trim();
      const native = cells.length > 3 ? (cells[3] || '').trim() : '';

      // The native column only needs a PlanetRead word beside it — rows with an
      // empty AI Version still count for the pre-replacement map.
      if (prWord && native) {
        const prClean = Dictionary.cleanNote(prWord);
        if (prClean) {
          for (const raw of native.split('/')) {
            const nv = Dictionary.cleanNote(raw.trim());
            if (nv && INDIC_RE.test(nv)) nativeMap[nv] = prClean;
          }
        }
      }

      if (!aiWord || !prWord) continue;
      if (Dictionary.isHeaderRow(aiWord, prWord)) continue;

      for (const raw of aiWord.split('/')) {
        const variant = raw.trim();
        if (variant) replacements[variant.toLowerCase()] = prWord;
      }

      const a = Dictionary.cleanNote(aiWord);
      const b = Dictionary.cleanNote(prWord);
      if (a && b) pairs.push([a, b]);
    }

    // Pin the contradictory words to one spelling, overriding whatever the row
    // order produced. HINDI ONLY — these are Hindi headwords.
    if (language === 'Hindi') Object.assign(nativeMap, HINDI_FORCE);

    return new Dictionary(replacements, pairs, nativeMap);
  }

  /**
   * ONE regex matching any dictionary key (longest first), built once per run
   * instead of hundreds of separate regexes per line — the big speed win.
   */
  static buildExactRegex(replacements) {
    const keys = Object.keys(replacements).sort((a, b) => b.length - a.length);
    if (!keys.length) return null;
    const alt = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    return new RegExp(`(?<![A-Za-z])(${alt})(?![A-Za-z])`, 'gi');
  }

  get exactRegex() {
    if (this._exactRe === undefined) {
      this._exactRe = Dictionary.buildExactRegex(this.replacements);
    }
    return this._exactRe;
  }

  get size() {
    return Object.keys(this.replacements).length;
  }
}

/**
 * Make a correction follow the case of the word it replaces, so it is
 * capitalised only where the original was (sentence start, proper noun) and
 * stays lowercase mid-sentence — instead of the dictionary's stored
 * capitalisation leaking capitals into the middle of a sentence.
 */
export function matchCase(matched, replacement) {
  if (!replacement) return replacement;
  const rep = replacement.toLowerCase();
  if (/^[A-Z]/.test(matched)) return rep.charAt(0).toUpperCase() + rep.slice(1);
  return rep;
}
