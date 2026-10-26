import { Document, Packer, Paragraph, TextRun } from 'docx';
import { writeFile } from 'fs/promises';

function parseSrt(raw) {
  const entries = [];
  const blocks = raw.replace(/\r\n/g, '\n').trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    const idx = parseInt(lines[0].trim(), 10);
    if (isNaN(idx)) continue;
    const timeParts = (lines[1] || '').split(' --> ');
    const timeIn = (timeParts[0] || '').trim();
    const timeOut = (timeParts[1] || '').trim();
    const text = lines.slice(2).join('\n').trim();
    entries.push({ idx, timeIn, timeOut, text });
  }
  return entries;
}

/**
 * Convert SRT content to a .docx file that looks exactly like the SRT —
 * same index / timestamp / text block structure, just saved as Word.
 *
 * @param {string} srtContent  Raw SRT text
 * @param {string} outputPath  Absolute path to write the .docx to
 */
export async function convertSrtToDocx(srtContent, outputPath) {
  const entries = parseSrt(srtContent);
  const children = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];

    // Index number
    children.push(new Paragraph({ children: [new TextRun({ text: String(e.idx), size: 20 })] }));

    // Timestamp line
    children.push(new Paragraph({ children: [new TextRun({ text: `${e.timeIn} --> ${e.timeOut}`, size: 20 })] }));

    // Subtitle text (preserve original line breaks within an entry)
    for (const line of e.text.split('\n')) {
      children.push(new Paragraph({ children: [new TextRun({ text: line, size: 20 })] }));
    }

    // Blank separator between entries (skip after last)
    if (i < entries.length - 1) {
      children.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  await writeFile(outputPath, buffer);
  return { entries: entries.length };
}
