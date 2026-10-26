"""Guideline 8: punctuation.

Romanization must not change punctuation, and the Devanagari-only marks have
exact Roman equivalents. That makes this the one guideline that is fully
deterministic, so it is done in code and deliberately kept OUT of the prompt:
every rule spent on punctuation is prompt budget taken from the rules that
genuinely need the model's judgement.

Source normalisation runs BEFORE the model sees the text, so the model never has
to decide. The output check runs after, as a guard rather than a fix.
"""
from __future__ import annotations

import logging
import re

log = logging.getLogger("romanize.punctuation")


class PunctuationNormalizer:
    """Devanagari punctuation in, ordinary Roman punctuation out."""

    DANDA = "।"          # ।
    DOUBLE_DANDA = "॥"   # ॥
    VISARGA = "ः"        # ः

    # ॥१॥ — a verse number, not dialogue. Matched before the bare double danda so
    # the digits go with it instead of being left stranded mid-subtitle.
    _VERSE_NUMBER_RE = re.compile(r"॥\s*[०-९0-9]+\s*॥")

    # An ASCII colon sitting BETWEEN two Devanagari letters is a typed stand-in
    # for visarga (दु:ख for दुःख), not punctuation. The dictionary drops it:
    # दु:स्वप्न -> duswapn. A colon with a space or a digit beside it is left
    # alone, so timecodes and ordinary "note:" colons are untouched.
    _INLINE_COLON_RE = re.compile(r"(?<=[ऀ-ॿ]):(?=[ऀ-ॿ])")

    # Marks guideline 8 says to retain — checked, never rewritten.
    RETAINED = ",;?!\"'()-…"

    def normalize_source(self, text: str):
        """Rewrite Devanagari-only punctuation in the SOURCE subtitle.

        Returns (text, counts). Only characters with an unambiguous Roman
        equivalent are touched; visarga is deliberately left for the dictionary
        and the model, because its correct output depends on position
        (word-final -> "h", mid-word -> dropped) and faking that here would mean
        inserting Devanagari letters.
        """
        counts = {"danda": 0, "double_danda": 0, "verse_number": 0, "inline_colon": 0}

        text, n = self._VERSE_NUMBER_RE.subn(".", text)
        counts["verse_number"] = n

        counts["double_danda"] = text.count(self.DOUBLE_DANDA)
        text = text.replace(self.DOUBLE_DANDA, ".")

        counts["danda"] = text.count(self.DANDA)
        text = text.replace(self.DANDA, ".")

        text, n = self._INLINE_COLON_RE.subn("", text)
        counts["inline_colon"] = n

        total = sum(counts.values())
        if total:
            log.info("Punctuation normalised: %s",
                     ", ".join(f"{k}={v}" for k, v in counts.items() if v))
        return text, counts

    # ── output guard ─────────────────────────────────────────────────────────
    # Diacritics the guidelines say not to introduce (rules 4 and 5).
    _DIACRITIC_RE = re.compile(
        r"[Ā-ſḀ-ỿāīūēō"
        r"ṭḍṇṛṣśñṅṃḥãõ]")
    _DEVANAGARI_RE = re.compile(r"[ऀ-ॿ]")

    def check_output(self, text: str):
        """Report guideline violations left in the romanized text.

        Returns a list of (code, count, examples). Nothing is rewritten — these
        are flagged for review, which is what guideline 9.4 asks for.
        """
        issues = []

        def add(code, pattern, note):
            lines = [l for l in text.split("\n") if pattern.search(l)]
            if lines:
                issues.append((code, len(lines), lines[:5], note))

        add("devanagari_left", self._DEVANAGARI_RE,
            "lines still in the original script — usually a refused batch")
        add("diacritics", self._DIACRITIC_RE,
            "guidelines 4 and 5 say plain A-Z only, no diacritical marks")
        add("danda_left", re.compile(f"[{self.DANDA}{self.DOUBLE_DANDA}]"),
            "danda should have become a period")
        add("visarga_left", re.compile(self.VISARGA),
            "visarga should be 'h' word-finally, dropped mid-word")
        return issues
