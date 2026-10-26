/**
 * The review Word file: the romanized subtitle with every applied correction
 * shown in place.
 *
 * Each correction renders as the original word in red, then the confirmed
 * PlanetRead spelling highlighted — so a Language Expert can see at a glance
 * what the dictionary changed and check it, instead of diffing two files.
 */

import { Document, Packer, Paragraph, TextRun } from 'docx';
import { matchCase } from './dictionary.js';

const INDEX_RE = /^\d+$/;

/**
 * Walk one line, yielding the untouched text and the corrections in order.
 * Returns null when nothing in the line changes, so unchanged lines stay plain.
 */
function markUpLine(line, exactRe, replacements, protectedWords) {
  if (!exactRe) return null;
  exactRe.lastIndex = 0;

  const pieces = [];
  let pos = 0;
  let changed = 0;
  let m;

  while ((m = exactRe.exec(line)) !== null) {
    const word = m[1];
    const lower = word.toLowerCase();
    if (protectedWords.has(lower)) continue;      // already the confirmed spelling
    const rep = replacements[lower];
    if (rep === undefined) continue;

    if (pos < m.index) pieces.push({ kind: 'plain', text: line.slice(pos, m.index) });
    pieces.push({ kind: 'old', text: word });
    pieces.push({ kind: 'plain', text: ' ' });
    pieces.push({ kind: 'new', text: matchCase(word, rep) });
    pos = m.index + word.length;
    changed += 1;
  }

  if (!changed) return null;
  if (pos < line.length) pieces.push({ kind: 'plain', text: line.slice(pos) });
  return pieces;
}

/**
 * @param {string} romanizedText the finished romanized SRT
 * @param {object} replacements  {wrongLower: right}
 * @param {Set<string>} protectedWords pre-substituted words, never re-corrected
 * @returns {Promise<{buffer: Buffer, corrections: number}>}
 */
export async function buildReviewDocx(romanizedText, replacements, protectedWords, exactRe) {
  const paragraphs = [];
  let corrections = 0;

  for (const line of romanizedText.split('\n')) {
    const s = line.trim();

    // Timecode, index and blank lines carry no words to correct — emit them
    // verbatim so the file still reads as a subtitle document.
    if (!s || line.includes('-->') || INDEX_RE.test(s)) {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: line, size: 20 })] }));
      continue;
    }

    const pieces = markUpLine(line, exactRe, replacements, protectedWords);
    if (!pieces) {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: line, size: 20 })] }));
      continue;
    }

    const children = pieces.map((p) => {
      if (p.kind === 'old') {
        corrections += 1;
        return new TextRun({ text: p.text, size: 20, color: 'C00000', strike: true });
      }
      if (p.kind === 'new') {
        return new TextRun({ text: p.text, size: 20, highlight: 'yellow' });
      }
      return new TextRun({ text: p.text, size: 20 });
    });
    paragraphs.push(new Paragraph({ children }));
  }

  const doc = new Document({ sections: [{ children: paragraphs }] });
  return { buffer: await Packer.toBuffer(doc), corrections };
}
