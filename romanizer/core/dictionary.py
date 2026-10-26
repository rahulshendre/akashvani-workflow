"""The Universal Dictionary: the experts' agreed spellings, parsed from a .docx."""
from __future__ import annotations

import io
import logging
import re
import time

from docx import Document

from ..config import HINDI_FORCE, INDIC_RE

log = logging.getLogger("romanize.dictionary")


class Dictionary:
    """Parsed dictionary, in the three shapes the pipeline needs.

    replacements : {wrong_variant_lower: planetread_word}  exact corrections
    pairs        : [(wrong, right), ...]                   training data for the engine
    native_map   : {native_script_word: planetread_word}   drives pre-substitution

    The source table is 4 columns: S.No | AI Version | Planet Read Version | native word.
    """

    _NOTE_RE_SQUARE = re.compile(r"\[[^\]]*\]")
    _NOTE_RE_ROUND = re.compile(r"\([^)]*\)")

    # Word's namespace, for reading cell text ourselves (see cell_text below).
    _W_T = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t"

    def __init__(self, replacements: dict, pairs: list, native_map: dict):
        self.replacements = replacements
        self.pairs = pairs
        self.native_map = native_map
        self._exact_re = None
        self._exact_re_built = False

    # ── parsing ──────────────────────────────────────────────────────────────
    @staticmethod
    def clean_note(s: str) -> str:
        """Strip human annotation notes like [accent] / (as per dialogue)."""
        s = Dictionary._NOTE_RE_SQUARE.sub("", s)
        s = Dictionary._NOTE_RE_ROUND.sub("", s)
        return s.strip()

    @staticmethod
    def is_header_row(ai_word: str, pr_word: str) -> bool:
        """True for the table's header row.

        Matched on BOTH columns rather than one exact string, because the header
        wording has already changed once ("AI Version" -> "AI Roman") and the old
        exact check silently let the header through as a real correction pair.
        """
        a, p = ai_word.lower().strip(), pr_word.lower().strip()
        return (a.startswith("ai ") or a in ("ai", "ai_version")
                or p.replace(" ", "").startswith("planetread"))

    @classmethod
    def cell_text(cls, cell) -> str:
        """All text in a table cell, including text Word has wrapped in a
        content control (<w:sdt>) or a tracked insertion (<w:ins>).

        python-docx's `cell.text` only walks paragraphs that are DIRECT children
        of the cell, so anything nested inside those wrappers reads as empty. A
        real dictionary hit this: the Hindi column was wrapped in content controls
        and all 1,492 native words parsed as blank, silently disabling
        pre-substitution while everything still looked fine. Reading every <w:t>
        descendant in document order is immune to how the cell is wrapped.
        """
        return "".join(node.text or "" for node in cell._tc.iter(cls._W_T)).strip()

    @classmethod
    def from_docx(cls, file_bytes: bytes, language=None) -> "Dictionary":
        """Parse a dictionary .docx.

        `language` is the dropdown label. It only gates HINDI_FORCE, which pins a
        few contradictory HINDI words and must not be injected into another
        language's map — pass None (the default) for any language-agnostic use.
        """
        t0 = time.perf_counter()
        log.info("Loading dictionary (%d KB)…", len(file_bytes) // 1024)
        doc = Document(io.BytesIO(file_bytes))
        replacements, pairs, native_map = {}, [], {}

        for table in doc.tables:
            for row in table.rows:
                cells = [cls.cell_text(c) for c in row.cells]
                if len(cells) < 3:
                    continue
                ai_word, pr_word = cells[1].strip(), cells[2].strip()
                # The native column only needs a PlanetRead word next to it — rows
                # with an empty AI Version still count for the pre-replacement map.
                native = cells[3].strip() if len(cells) > 3 else ""
                if pr_word and native:
                    pr_clean = cls.clean_note(pr_word)
                    if pr_clean:
                        for nv in native.split('/'):
                            nv = cls.clean_note(nv.strip())
                            if nv and INDIC_RE.search(nv):
                                native_map[nv] = pr_clean
                if not ai_word or not pr_word:
                    continue
                if cls.is_header_row(ai_word, pr_word):
                    continue
                for variant in ai_word.split('/'):
                    variant = variant.strip()
                    if variant:
                        replacements[variant.lower()] = pr_word
                a, b = cls.clean_note(ai_word), cls.clean_note(pr_word)
                if a and b:
                    pairs.append((a, b))

        # Pin the contradictory (bucket A) words to one spelling, overriding whatever
        # the dictionary's row order produced. HINDI ONLY — these are Hindi headwords,
        # so injecting them into e.g. a Tamil map would be nonsense.
        n_forced = 0
        if language == "Hindi":
            native_map.update(HINDI_FORCE)
            n_forced = len(HINDI_FORCE)

        log.info("Dictionary loaded (%s): %d exact variants, %d clean pairs, %d native words "
                 "(%d force-pinned) in %.2fs",
                 language or "language-agnostic", len(replacements), len(pairs),
                 len(native_map), n_forced, time.perf_counter() - t0)
        return cls(replacements, pairs, native_map)

    # ── matching ─────────────────────────────────────────────────────────────
    @staticmethod
    def build_exact_regex(replacements):
        """Compile ONE regex matching any dictionary key (longest first). Built once
        per run instead of 600 separate regexes per paragraph — the big speed win."""
        keys = sorted(replacements.keys(), key=len, reverse=True)
        if not keys:
            return None
        alt = "|".join(re.escape(k) for k in keys)
        return re.compile(r'(?<![A-Za-z])(' + alt + r')(?![A-Za-z])', re.IGNORECASE)

    @property
    def exact_regex(self):
        """The compiled matcher for this dictionary, built once and reused."""
        if not self._exact_re_built:
            self._exact_re = self.build_exact_regex(self.replacements)
            self._exact_re_built = True
        return self._exact_re

    def __len__(self):
        return len(self.replacements)
