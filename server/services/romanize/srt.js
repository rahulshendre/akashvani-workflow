/**
 * Parsing and rebuilding .srt files.
 *
 * The whole point of this module is that TIMECODES NEVER LEAVE IT. The
 * romanizer only ever sees the bare text lines; block numbers and timings stay
 * here and are put back verbatim, which is why output timing always matches
 * input timing exactly — and why the model is never given the chance to
 * "helpfully" adjust a timestamp.
 */

const INDEX_RE = /^\d+$/;

/** One subtitle: its index line, its timecode line, and its text lines. */
class Block {
  constructor(index, timecode, lines) {
    this.index = index;       // original index line, or null
    this.timecode = timecode; // original "00:00:01,200 --> ...", or null
    this.lines = lines;       // text lines, mutated in place
  }
}

export class SrtDocument {
  constructor(blocks) {
    this.blocks = blocks;
  }

  /** Strip a UTF-8 BOM; everything downstream assumes there isn't one. */
  static decode(buf) {
    let text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  }

  /**
   * Tolerant parser. Splits on blank lines and finds the timecode by its '-->'
   * marker, so a missing or duplicated index line doesn't throw it off.
   */
  static parse(text) {
    const normalised = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const chunks = normalised.replace(/^\n+|\n+$/g, '').split(/\n[ \t]*\n/);
    const blocks = [];

    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      const lines = chunk.split('\n');
      const tcIndex = lines.findIndex((l) => l.includes('-->'));

      if (tcIndex === -1) {
        // No timecode here — keep the lines as plain text rather than dropping them.
        blocks.push(new Block(null, null, lines));
        continue;
      }

      let index = null;
      for (const l of lines.slice(0, tcIndex)) {
        if (INDEX_RE.test(l.trim())) index = l.trim();
      }
      blocks.push(new Block(index, lines[tcIndex].trim(), lines.slice(tcIndex + 1)));
    }
    return new SrtDocument(blocks);
  }

  static fromBuffer(buf) {
    return SrtDocument.parse(SrtDocument.decode(buf));
  }

  serialize() {
    const out = this.blocks.map((b) => {
      const parts = [];
      if (b.index !== null) parts.push(b.index);
      if (b.timecode !== null) parts.push(b.timecode);
      parts.push(...b.lines);
      return parts.join('\n');
    });
    return `${out.join('\n\n').trim()}\n`;
  }

  /**
   * Flatten every non-blank text line, keeping (block, line) references so the
   * romanized output can be written straight back onto its own position.
   */
  collect() {
    const refs = [];
    const texts = [];
    this.blocks.forEach((b, bi) => {
      b.lines.forEach((line, lj) => {
        if (line.trim()) {
          refs.push([bi, lj]);
          texts.push(line);
        }
      });
    });
    return { refs, texts };
  }

  apply(refs, lines) {
    refs.forEach(([bi, lj], i) => {
      if (i < lines.length) this.blocks[bi].lines[lj] = lines[i];
    });
  }

  /** The subtitle number a reader sees, for a block position. */
  subtitleNumber(blockIndex) {
    return this.blocks[blockIndex]?.index ?? null;
  }
}
