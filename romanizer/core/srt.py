"""Parsing and rebuilding .srt files.

The whole point of this module is that TIMECODES NEVER LEAVE IT. The romanizer
only ever sees the bare text lines; the block numbers and timings stay here and
are put back verbatim, which is why the output timing always matches the input.
"""
from __future__ import annotations

import io
import re


class Block:
    """One subtitle: its index line, its timecode line, and its text lines."""

    __slots__ = ("index", "timecode", "lines")

    def __init__(self, index, timecode, lines):
        self.index = index        # original index line (str) or None
        self.timecode = timecode  # original "00:00:01,200 --> ..." (str) or None
        self.lines = lines        # list[str] of text lines (mutated in place)


class SrtDocument:
    """A parsed .srt: a list of Blocks, plus the ways in and out of that form."""

    INDEX_RE = re.compile(r'^\d+$')

    def __init__(self, blocks):
        self.blocks = blocks

    # ── in ───────────────────────────────────────────────────────────────────
    @staticmethod
    def decode(data: bytes) -> str:
        for enc in ("utf-8-sig", "utf-8"):
            try:
                return data.decode(enc)
            except UnicodeDecodeError:
                continue
        return data.decode("latin-1", errors="replace")

    @classmethod
    def parse(cls, text: str) -> "SrtDocument":
        """Tolerant SRT parser. Splits on blank lines; finds the timecode line by the
        '-->' marker so missing/extra index lines don't throw it off."""
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        chunks = re.split(r'\n[ \t]*\n', text.strip("\n"))
        blocks = []
        for chunk in chunks:
            if not chunk.strip():
                continue
            lines = chunk.split("\n")
            tc_i = next((i for i, l in enumerate(lines) if '-->' in l), None)
            if tc_i is None:
                # no timecode in this chunk — keep its lines as plain text
                blocks.append(Block(None, None, lines))
                continue
            index = None
            for l in lines[:tc_i]:
                if cls.INDEX_RE.match(l.strip()):
                    index = l.strip()
            blocks.append(Block(index, lines[tc_i].strip(), lines[tc_i + 1:]))
        return cls(blocks)

    @classmethod
    def from_bytes(cls, data: bytes) -> "SrtDocument":
        return cls.parse(cls.decode(data))

    # ── out ──────────────────────────────────────────────────────────────────
    def serialize(self) -> str:
        out = []
        for b in self.blocks:
            parts = []
            if b.index is not None:
                parts.append(b.index)
            if b.timecode is not None:
                parts.append(b.timecode)
            parts.extend(b.lines)
            out.append("\n".join(parts))
        return "\n\n".join(out).strip() + "\n"

    # ── working with the text lines ──────────────────────────────────────────
    def collect(self):
        """Flatten every non-blank text line into a list, keeping (block, line) refs
        so the romanized output can be written straight back."""
        refs, texts = [], []
        for bi, b in enumerate(self.blocks):
            for lj, line in enumerate(b.lines):
                if line.strip():
                    refs.append((bi, lj))
                    texts.append(line)
        return refs, texts

    def apply(self, refs, lines):
        """Write romanized lines back onto their original positions."""
        for (bi, lj), text in zip(refs, lines):
            self.blocks[bi].lines[lj] = text

    def subtitle_number(self, block_index: int):
        """The subtitle number a reader sees, for a block position."""
        return self.blocks[block_index].index

    # ── handing off to the dictionary fixer ──────────────────────────────────
    @staticmethod
    def to_docx_bytes(srt_text: str) -> bytes:
        """Wrap an .srt (one line per paragraph) in a .docx so it can be fed to the
        dictionary fixer, which expects a 'Romanized subtitle docx'."""
        from docx import Document
        doc = Document()
        for line in srt_text.split("\n"):
            doc.add_paragraph(line)
        buf = io.BytesIO()
        doc.save(buf)
        buf.seek(0)
        return buf.getvalue()
