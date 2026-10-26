"""Building the final, clean .srt from the corrected subtitle document."""
from __future__ import annotations

import io
import logging
import re

from docx import Document

from ..config import TIMECODE_RE
from ..core.dictionary import Dictionary

log = logging.getLogger("romanize.srt_writer")


class SrtWriter:
    """Writes the deliverable .srt: corrections applied, no markup."""

    _MULTISPACE_RE = re.compile(r'[ \t]{2,}')
    _EDGE_SPACE_RE = re.compile(r'(?m)^[ \t]+|[ \t]+$')

    @staticmethod
    def match_case(matched, replacement):
        """Make a correction follow the case of the word it replaces, so it is
        capitalised only where the original word was (start of a sentence / proper
        noun) and stays lowercase mid-sentence — instead of the dictionary's stored
        capitalisation leaking capital letters into the middle of a sentence."""
        if not replacement:
            return replacement
        rep = replacement.lower()                 # canonical lowercase base form
        if matched[:1].isupper():
            rep = rep[:1].upper() + rep[1:]        # original was capitalised -> match it
        return rep

    def build(self, input_bytes: bytes, replacements: dict, protected=frozenset()):
        """Build a clean .srt from the subtitle Word file.

        - applies ONLY the confirmed dictionary (yellow) corrections — wrong word is
          replaced by the correct word, with NO red/green/cyan markup at all
        - engine guesses are NOT applied (original word kept) — they're unconfirmed
        - words in `protected` (pre-substituted) are kept as-is
        - timecodes / block numbers already present in the Word text are preserved

        Returns (srt_bytes, num_timecodes, num_corrections).
        """
        exact_re = Dictionary.build_exact_regex(replacements)
        n_fixes = 0

        def fix_line(text):
            nonlocal n_fixes
            if exact_re is None:
                return text

            def repl(m):
                nonlocal n_fixes
                if m.group(1).lower() in protected:
                    return m.group(0)
                rep = replacements.get(m.group(1).lower())
                if rep is None:
                    return m.group(0)
                n_fixes += 1
                return self.match_case(m.group(1), rep)
            return exact_re.sub(repl, text)

        doc = Document(io.BytesIO(input_bytes))
        lines = [fix_line(p.text) for p in doc.paragraphs]
        srt_text = "\n".join(lines).strip() + "\n"
        # tidy whitespace: collapse runs of spaces between words, trim per-line edges.
        # Belt-and-braces against a dictionary value that itself contains double
        # spaces, so the delivered file never has stray inter-word gaps.
        srt_text = self._MULTISPACE_RE.sub(' ', srt_text)
        srt_text = self._EDGE_SPACE_RE.sub('', srt_text)
        n_codes = len(TIMECODE_RE.findall(srt_text))
        log.info("SRT built: %d timecodes, %d dictionary corrections applied",
                 n_codes, n_fixes)
        return srt_text.encode("utf-8"), n_codes, n_fixes
