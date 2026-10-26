/**
 * Tidy-up passes applied to a romanized SRT before it is returned or cached.
 *
 * All pure functions: given the same text they always produce the same text.
 * Newlines are never touched by any of them, so the block/timecode structure
 * always survives.
 */

// closed-caption / sound cues like "[music playing]" — first letter inside [ ]
const CC_RE = /(\[[^A-Za-z\]]*)([a-z])/g;

// song-lyric markers; lyric lines should start with a capital like a sentence
const NOTE_RE = /[♪♫♩♬\u{1F3B5}\u{1F3B6}]/gu;
const LINE_FIRST_LOWER_RE = /^([^A-Za-z]*)([a-z])/;

const MULTISPACE_RE = /[ \t]{2,}/g;
const EDGE_SPACE_RE = /^[ \t]+|[ \t]+$/gm;

// first letter of a line, after any leading symbols/spaces
const LINE_START_RE = /^([^A-Za-z]*)([A-Za-z])/;

// a line that closes a unit -> the next line begins a new sentence
const UNIT_END_CHARS = '.!?…♪♫♩♬]';

/** Is this a subtitle text line, rather than a timecode, index or blank? */
function isTextLine(line) {
  const s = line.trim();
  return !!s && !line.includes('-->') && !/^\d+$/.test(s);
}

export class TextFinalizer {
  /**
   * Capitalize the first word inside any [ ... ] closed-caption cue:
   * '[music playing]' → '[Music playing]'. Idempotent.
   */
  static capitalizeClosedCaptions(text) {
    return text.replace(CC_RE, (_m, pre, ch) => pre + ch.toUpperCase());
  }

  /**
   * Capitalize the first word of every lyric line — a line containing a musical
   * note, or one sitting inside an open ♪...♪ region spanning several lines.
   */
  static capitalizeMusicLines(text) {
    let notesSeen = 0;
    return text.split('\n').map((line) => {
      if (!isTextLine(line)) return line;
      const inside = notesSeen % 2 === 1; // odd note count => inside a ♪...♪
      NOTE_RE.lastIndex = 0;
      const hasNote = NOTE_RE.test(line);
      let out = line;
      if (inside || hasNote) {
        out = out.replace(LINE_FIRST_LOWER_RE, (_m, pre, ch) => pre + ch.toUpperCase());
      }
      notesSeen += (out.match(NOTE_RE) || []).length;
      return out;
    }).join('\n');
  }

  /**
   * Capitalize a line's first letter ONLY when it starts a NEW sentence (the
   * previous text line ended with . ! ? or a music/CC boundary). A line that
   * merely continues a sentence is lowercased — so line breaks no longer all
   * start with a capital.
   */
  static sentenceCaseLineStarts(text) {
    let newSentence = true;
    return text.split('\n').map((line) => {
      if (!isTextLine(line)) return line;
      const cap = newSentence;
      const out = line.replace(LINE_START_RE,
        (_m, pre, ch) => pre + (cap ? ch.toUpperCase() : ch.toLowerCase()));
      const s = out.trim();
      newSentence = UNIT_END_CHARS.includes(s[s.length - 1]);
      return out;
    }).join('\n');
  }

  /**
   * Order matters: sentence-casing runs FIRST and would lowercase a lyric or a
   * cue that merely continues a sentence, so the two capitalization passes run
   * after it to put those back.
   */
  static finalize(text) {
    let out = text.replace(MULTISPACE_RE, ' ');
    out = out.replace(EDGE_SPACE_RE, '');
    out = TextFinalizer.sentenceCaseLineStarts(out);
    out = TextFinalizer.capitalizeClosedCaptions(out);
    out = TextFinalizer.capitalizeMusicLines(out);
    return out;
  }
}
