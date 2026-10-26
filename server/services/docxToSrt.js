import AdmZip from 'adm-zip';
import { readFile } from 'fs/promises';

function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Extract every paragraph's text from document.xml, preserving order. */
function extractParagraphs(documentXml) {
  const paragraphs = [];
  const pRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
  const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
  let pMatch;
  while ((pMatch = pRegex.exec(documentXml)) !== null) {
    const parts = [];
    tRegex.lastIndex = 0;
    let tMatch;
    while ((tMatch = tRegex.exec(pMatch[0])) !== null) parts.push(tMatch[1]);
    paragraphs.push(decodeXmlEntities(parts.join('')));
  }
  return paragraphs;
}

const TIMESTAMP_RE = /^\d{1,2}:\d{2}:\d{2}[,\.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,\.]\d{3}/;

/**
 * Convert a .docx to SRT — BEST EFFORT. Never throws.
 *
 * Recognises the plain-text SRT structure that srtToDocx.js writes:
 *   <index>
 *   <timeIn> --> <timeOut>
 *   <subtitle text>
 *   (blank line)
 *
 * The Language Expert's corrected Word file is the deliverable in its own right.
 * If it is not in SRT layout that is NOT an error — callers must still save and
 * upload the .docx and simply skip the generated .srt. Returning null instead of
 * throwing is deliberate: a throw here used to abort the whole request before
 * the Drive upload ran, so the file never reached the next reviewer.
 *
 * @param {string} docxPath  Absolute path to the .docx file
 * @returns {Promise<string|null>} SRT content, or null if none could be derived
 */
export async function convertDocxToSrt(docxPath) {
  let paragraphs;
  try {
    const buffer = await readFile(docxPath);
    const zip = new AdmZip(buffer);

    const docEntry = zip.getEntry('word/document.xml');
    if (!docEntry) return null;

    const xml = docEntry.getData().toString('utf8');
    paragraphs = extractParagraphs(xml);
  } catch {
    return null; // unreadable or not a real .docx — accept the file anyway
  }

  const entries = [];
  let i = 0;

  while (i < paragraphs.length) {
    // Skip blank lines
    if (!paragraphs[i].trim()) { i++; continue; }

    // Expect an index number
    const idx = parseInt(paragraphs[i].trim(), 10);
    if (isNaN(idx)) { i++; continue; }

    // Next non-empty line must be the timestamp
    let ti = i + 1;
    while (ti < paragraphs.length && !paragraphs[ti].trim()) ti++;
    if (ti >= paragraphs.length || !TIMESTAMP_RE.test(paragraphs[ti].trim())) { i++; continue; }

    const timeLine = paragraphs[ti].trim();

    // Collect subtitle text lines until blank line or next index
    const textLines = [];
    let j = ti + 1;
    while (j < paragraphs.length) {
      const line = paragraphs[j];
      if (!line.trim()) break;                          // blank = end of block
      if (/^\d+$/.test(line.trim()) && textLines.length > 0) break; // next index
      textLines.push(line);
      j++;
    }

    entries.push({ idx, timeLine, text: textLines.join('\n') });
    i = j;
  }

  // Not SRT-shaped, and that is fine — the .docx itself is what matters.
  if (entries.length === 0) return null;

  const blocks = entries.map(e => `${e.idx}\n${e.timeLine}\n${e.text}`);
  return blocks.join('\n\n') + '\n';
}
