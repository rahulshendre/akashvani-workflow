// @vitest-environment node
// This exercises server-side code (fs + adm-zip). Under the default jsdom
// environment the docx read silently fails and every result comes back null,
// which would make these assertions pass vacuously.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import AdmZip from 'adm-zip';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { convertDocxToSrt } from '../../server/services/docxToSrt.js';

let dir: string;

/** Minimal but structurally real .docx containing the given paragraphs. */
function makeDocx(name: string, paragraphs: string[]): string {
  const body = paragraphs
    .map(t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`)
    .join('');
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`;

  const path = join(dir, name);
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile('word/document.xml', Buffer.from(xml));
  zip.writeZip(path);
  return path;
}

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ak-docx-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('convertDocxToSrt', () => {
  // REGRESSION: this used to throw "No subtitle entries found. The Word file
  // should be in SRT format…". It ran BEFORE the Drive upload in the LE routes,
  // so a Language Expert submitting an ordinary corrected Word document got a
  // 500 and their file never reached Google Drive. It must never throw again.
  it('accepts an ordinary corrected Word file instead of throwing', async () => {
    const path = makeDocx('plain.docx', [
      'Namaste, welcome to the programme.',
      'This is a corrected sentence.',
      'Another line of dialogue.',
    ]);
    await expect(convertDocxToSrt(path)).resolves.toBeNull();
  });

  it('still converts a properly SRT-shaped Word file', async () => {
    const path = makeDocx('srt.docx', [
      '1', '00:00:01,000 --> 00:00:04,000', 'Namaste, welcome.', '',
      '2', '00:00:05,000 --> 00:00:08,000', 'Second subtitle.',
    ]);
    const srt = await convertDocxToSrt(path);
    expect(srt).toBeTruthy();
    expect(srt).toContain('00:00:01,000 --> 00:00:04,000');
    expect(srt!.trim().split(/\n\n/)).toHaveLength(2);
  });

  it('returns null rather than throwing for a missing or invalid file', async () => {
    await expect(convertDocxToSrt(join(dir, 'nope.docx'))).resolves.toBeNull();
  });

  it('returns null for an empty document', async () => {
    const path = makeDocx('empty.docx', []);
    await expect(convertDocxToSrt(path)).resolves.toBeNull();
  });
});
