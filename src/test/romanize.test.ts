// @vitest-environment node
import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { SrtDocument } from '../../server/services/romanize/srt.js';
import { PunctuationNormalizer } from '../../server/services/romanize/punctuation.js';
import { TextFinalizer } from '../../server/services/romanize/textFinalizer.js';
import { ConsistencyChecker } from '../../server/services/romanize/consistency.js';
import { Dictionary, matchCase } from '../../server/services/romanize/dictionary.js';
import { PreSubstitutor } from '../../server/services/romanize/presubstitute.js';
import { Romanizer } from '../../server/services/romanize/claude.js';
import { parseDocId, envVarFor } from '../../server/services/romanize/dictionarySource.js';

/**
 * These pin the behaviour ported from the PlanetRead Romanizer prototype. Each
 * rule here was tuned against real episodes, so a change that breaks one of
 * these is a change to output the language experts already signed off on.
 *
 * Nothing here touches the network.
 */

const SAMPLE_SRT = [
  '1',
  '00:00:01,200 --> 00:00:04,000',
  'मेरा दिल खो गया।',
  '',
  '2',
  '00:00:04,500 --> 00:00:07,000',
  'पहली पंक्ति',
  'दूसरी पंक्ति',
  '',
].join('\n');

describe('SRT parsing keeps timecodes out of the model', () => {
  it('round-trips a file unchanged', () => {
    const doc = SrtDocument.parse(SAMPLE_SRT);
    expect(doc.blocks).toHaveLength(2);
    expect(doc.serialize().trim()).toBe(SAMPLE_SRT.trim());
  });

  it('collects only text lines, never timecodes or indices', () => {
    const { texts } = SrtDocument.parse(SAMPLE_SRT).collect();
    expect(texts).toEqual(['मेरा दिल खो गया।', 'पहली पंक्ति', 'दूसरी पंक्ति']);
  });

  it('writes romanized lines back onto their own positions', () => {
    const doc = SrtDocument.parse(SAMPLE_SRT);
    const { refs, texts } = doc.collect();
    doc.apply(refs, texts.map((_t, i) => `line${i}`));
    const out = doc.serialize();
    expect(out).toContain('00:00:01,200 --> 00:00:04,000');  // timing untouched
    expect(out).toContain('line0');
    expect(out).not.toContain('मेरा');
  });

  it('survives a missing index line', () => {
    const doc = SrtDocument.parse('00:00:01,000 --> 00:00:02,000\nhello\n');
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].timecode).toBe('00:00:01,000 --> 00:00:02,000');
  });

  it('strips a UTF-8 BOM', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('1\n', 'utf8')]);
    expect(SrtDocument.decode(withBom)).toBe('1\n');
  });

  it('reports the subtitle number a reader sees', () => {
    const doc = SrtDocument.parse(SAMPLE_SRT);
    expect(doc.subtitleNumber(1)).toBe('2');
  });
});

describe('punctuation (guideline 8)', () => {
  const p = new PunctuationNormalizer();

  it('turns danda and double danda into periods', () => {
    const { text, counts } = p.normalizeSource('मेरा दिल। तेरा दिल॥');
    expect(text).toBe('मेरा दिल. तेरा दिल.');
    expect(counts.danda).toBe(1);
    expect(counts.double_danda).toBe(1);
  });

  it('takes the digits with a verse number instead of stranding them', () => {
    const { text, counts } = p.normalizeSource('॥१॥ shloka');
    expect(counts.verse_number).toBe(1);
    expect(text).toBe('. shloka');
  });

  it('drops a colon typed as visarga between two Devanagari letters', () => {
    const { text, counts } = p.normalizeSource('दु:ख');
    expect(text).toBe('दुख');
    expect(counts.inline_colon).toBe(1);
  });

  it('leaves ordinary colons and timecodes alone', () => {
    const { text } = p.normalizeSource('00:00:01,200 --> 00:00:04,000\nnote: hello');
    expect(text).toContain('00:00:01,200 --> 00:00:04,000');
    expect(text).toContain('note: hello');
  });

  it('flags native script left in the output — the dangerous failure', () => {
    const issues = p.checkOutput('mera dil\nमेरा दिल');
    expect(issues.find(i => i.code === 'devanagari_left')?.count).toBe(1);
  });

  it('flags diacritics, which guidelines 4 and 5 forbid', () => {
    expect(p.checkOutput('mērā dil').some(i => i.code === 'diacritics')).toBe(true);
    expect(p.checkOutput('mera dil').some(i => i.code === 'diacritics')).toBe(false);
  });
});

describe('text finalization', () => {
  it('capitalizes a line that starts a new sentence, not every line break', () => {
    const out = TextFinalizer.sentenceCaseLineStarts('mera dil kho gaya.\ntera dil\nmila nahi.');
    const lines = out.split('\n');
    expect(lines[0]).toBe('Mera dil kho gaya.');
    expect(lines[1]).toBe('Tera dil');   // follows a full stop
    expect(lines[2]).toBe('mila nahi.'); // continues the previous line
  });

  it('capitalizes inside a closed-caption cue', () => {
    expect(TextFinalizer.capitalizeClosedCaptions('[music playing]')).toBe('[Music playing]');
  });

  it('capitalizes lyric lines and lines inside an open ♪…♪ region', () => {
    const out = TextFinalizer.capitalizeMusicLines('♪ mera dil\nkho gaya ♪');
    expect(out.split('\n')[0]).toBe('♪ Mera dil');
    expect(out.split('\n')[1]).toBe('Kho gaya ♪');
  });

  it('collapses extra spaces and trims line edges without touching newlines', () => {
    const out = TextFinalizer.finalize('  mera   dil  \n  tera dil  ');
    expect(out).toBe('Mera dil\ntera dil');
  });

  it('never touches timecode or index lines', () => {
    const out = TextFinalizer.finalize(SAMPLE_SRT);
    expect(out).toContain('00:00:01,200 --> 00:00:04,000');
    expect(out.split('\n')[0]).toBe('1');
  });
});

describe('consistency (guidelines 2 and 3)', () => {
  it('groups the same word spelled two ways', () => {
    const rows = new ConsistencyChecker({}).clusters('pareshaan pareshaan pareshan');
    expect(rows).toHaveLength(1);
    expect(rows[0].suggested).toBe('pareshaan');   // the commoner spelling
  });

  it('prefers the dictionary spelling over the commoner one', () => {
    // "pareshan" appears more often, but the dictionary approves "pareshaan".
    const rows = new ConsistencyChecker({ pareshan: 'pareshaan' })
      .clusters('pareshan pareshan pareshan pareshaan');
    expect(rows[0].approved).toBe('pareshaan');
    expect(rows[0].suggested).toBe('pareshaan');
  });

  it('ignores short words, which collide for boring reasons', () => {
    expect(new ConsistencyChecker({}).clusters('to too to')).toHaveLength(0);
  });

  it('does not report a word that is spelled only one way', () => {
    expect(new ConsistencyChecker({}).clusters('pareshaan pareshaan')).toHaveLength(0);
  });
});

// ── dictionary .docx parsing ────────────────────────────────────────────────

/** Minimal .docx holding one table, built from raw WordprocessingML. */
function makeDocx(rowsXml: string): Buffer {
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:tbl>${rowsXml}</w:tbl></w:body></w:document>`;
  const zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}

const cell = (text: string) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;

describe('dictionary parsing', () => {
  it('reads the four columns into the three shapes the pipeline needs', () => {
    const docx = makeDocx(
      row('S.No', 'AI Version', 'Planet Read Version', 'Word') +
      row('1', 'nikal', 'nikaal', 'निकाल')
    );
    const dict = Dictionary.fromDocx(docx, null);
    expect(dict.replacements).toEqual({ nikal: 'nikaal' });
    expect(dict.pairs).toEqual([['nikal', 'nikaal']]);
    expect(dict.nativeMap).toEqual({ 'निकाल': 'nikaal' });
  });

  it('skips the header row even though its wording has changed before', () => {
    // The header once read "AI Version" and later "AI Roman"; an exact-string
    // check silently let the renamed header through as a correction pair.
    const dict = Dictionary.fromDocx(makeDocx(
      row('S.No', 'AI Roman', 'PlanetRead Version', 'Word') +
      row('1', 'nikal', 'nikaal', 'निकाल')
    ), null);
    expect(Object.keys(dict.replacements)).toEqual(['nikal']);
  });

  it('reads text wrapped in a content control — the bug that lost 1,492 words', () => {
    // python-docx's cell.text only walks direct children, so a column wrapped
    // in <w:sdt> parsed as blank and silently disabled pre-substitution while
    // everything still looked fine.
    const wrapped =
      '<w:tc><w:sdt><w:sdtContent><w:p><w:r><w:t>निकाल</w:t></w:r></w:p></w:sdtContent></w:sdt></w:tc>';
    const dict = Dictionary.fromDocx(makeDocx(
      `<w:tr>${cell('1')}${cell('nikal')}${cell('nikaal')}${wrapped}</w:tr>`
    ), null);
    expect(dict.nativeMap).toEqual({ 'निकाल': 'nikaal' });
  });

  it('splits slash-separated variants on both sides', () => {
    const dict = Dictionary.fromDocx(makeDocx(
      row('1', 'nikal/nikala', 'nikaal', 'निकाल/निकालो')
    ), null);
    expect(Object.keys(dict.replacements).sort()).toEqual(['nikal', 'nikala']);
    expect(Object.keys(dict.nativeMap).sort()).toEqual(['निकाल', 'निकालो']);
  });

  it('strips annotation notes like [accent] and (as per dialogue)', () => {
    const dict = Dictionary.fromDocx(makeDocx(
      row('1', 'nikal [accent]', 'nikaal (as per dialogue)', 'निकाल')
    ), null);
    expect(dict.pairs).toEqual([['nikal', 'nikaal']]);
    expect(dict.nativeMap).toEqual({ 'निकाल': 'nikaal' });
  });

  it('takes a native word even when the AI column is empty', () => {
    const dict = Dictionary.fromDocx(makeDocx(row('1', '', 'nikaal', 'निकाल')), null);
    expect(dict.nativeMap).toEqual({ 'निकाल': 'nikaal' });
    expect(dict.replacements).toEqual({});
  });

  it('keeps a non-Devanagari native column, which was once dropped entirely', () => {
    // The script class was Devanagari-only at one point, which silently lost a
    // Tamil dictionary's whole native column.
    const dict = Dictionary.fromDocx(makeDocx(row('1', 'vanakkam', 'vanakkam', 'வணக்கம்')), null);
    expect(dict.nativeMap).toEqual({ 'வணக்கம்': 'vanakkam' });
  });

  it('pins the contradictory Hindi words, and only for Hindi', () => {
    const rows = row('1', 'x', 'y', 'ज़');
    expect(Dictionary.fromDocx(makeDocx(rows), 'Hindi').nativeMap['माँ']).toBe('maa');
    expect(Dictionary.fromDocx(makeDocx(rows), 'Tamil').nativeMap['माँ']).toBeUndefined();
  });

  it('matches whole words only, longest first', () => {
    const re = Dictionary.buildExactRegex({ nikal: 'nikaal', nikala: 'nikaala' })!;
    expect('nikala'.replace(re, (m) => `<${m}>`)).toBe('<nikala>');  // longest wins
    expect('unikal'.replace(re, (m) => `<${m}>`)).toBe('unikal');    // not a whole word
  });
});

describe('case matching', () => {
  it('follows the case of the word being replaced, not the dictionary entry', () => {
    // Otherwise the dictionary's stored capitalisation leaks capitals into the
    // middle of a sentence.
    expect(matchCase('Nikal', 'nikaal')).toBe('Nikaal');
    expect(matchCase('nikal', 'Nikaal')).toBe('nikaal');
  });
});

describe('pre-substitution', () => {
  it('writes the confirmed spelling in and locks the word', () => {
    const { text, protectedWords, replaced } =
      new PreSubstitutor({ 'निकाल': 'nikaal' }).apply('1\n00:00:01,000 --> 00:00:02,000\nमुझे निकाल दो');
    expect(text).toContain('मुझे nikaal दो');
    expect(protectedWords.has('nikaal')).toBe(true);
    expect(replaced).toBe(1);
  });

  it('never touches timecode or index lines', () => {
    const { text } = new PreSubstitutor({ 'निकाल': 'nikaal' })
      .apply('1\n00:00:01,000 --> 00:00:02,000\nनिकाल');
    expect(text.split('\n')[1]).toBe('00:00:01,000 --> 00:00:02,000');
  });

  it('does not replace a word glued to another native letter', () => {
    const { replaced } = new PreSubstitutor({ 'दिल': 'dil' }).apply('दिलवाला');
    expect(replaced).toBe(0);
  });

  it('is a no-op when the dictionary has no native column', () => {
    const { text, replaced } = new PreSubstitutor({}).apply('मेरा दिल');
    expect(text).toBe('मेरा दिल');
    expect(replaced).toBe(0);
  });
});

describe('parsing the model reply', () => {
  it('maps numbered lines back by their own number', () => {
    expect(Romanizer.parseNumbered('1\tmera dil\n2\ttera dil', 2))
      .toEqual(['mera dil', 'tera dil']);
  });

  it('falls back to position when the numbering drifts but the count matches', () => {
    expect(Romanizer.parseNumbered('1. mera dil\n2. tera dil', 2))
      .toEqual(['mera dil', 'tera dil']);
  });

  it('leaves a line null when it cannot be recovered, rather than guessing', () => {
    // The caller turns a null into "keep the source line", which is safe; a
    // guess would ship the wrong text under the right timecode.
    expect(Romanizer.parseNumbered('1\tmera dil', 2)).toEqual(['mera dil', null]);
  });
});

describe('dictionary links', () => {
  it('accepts a Google Docs URL, a Drive URL, or a bare id', () => {
    const id = '1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvWxYz';
    expect(parseDocId(`https://docs.google.com/document/d/${id}/edit?usp=sharing`)).toBe(id);
    expect(parseDocId(`https://drive.google.com/file/d/${id}/view`)).toBe(id);
    expect(parseDocId(`https://drive.google.com/uc?export=download&id=${id}`)).toBe(id);
    expect(parseDocId(id)).toBe(id);
  });

  it('rejects something that is not a link', () => {
    expect(parseDocId('my dictionary')).toBeNull();
    expect(parseDocId('')).toBeNull();
  });

  it('names the config key per language', () => {
    expect(envVarFor('Hindi')).toBe('DICTIONARY_DOC_URL_HINDI');
    expect(envVarFor('Odia')).toBe('DICTIONARY_DOC_URL_ODIA');
  });
});
