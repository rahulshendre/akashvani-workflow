"""Writing the experts' agreed spellings in BEFORE the model sees the text.

This exists to settle words the model cannot settle on its own. The dictionary
contains conflicting pairs like nikal→nikaal AND nikaal→nikal; only the ORIGINAL
native-script word says which is right. So the native word is replaced up front
with its confirmed PlanetRead spelling, and the word is returned in a `protected`
set that every later correction pass must skip — otherwise a confirmed spelling
would be "corrected" a second time, straight back to the wrong one.
"""
from __future__ import annotations

import logging
import re

from ..config import INDIC_CHARS

log = logging.getLogger("romanize.presub")


class PreSubstitutor:
    """Replaces native-script words with their confirmed Roman spellings."""

    INDEX_RE = re.compile(r'^\d+$')

    def __init__(self, native_map: dict):
        self.native_map = native_map or {}
        self._pattern = self._compile(self.native_map)

    @classmethod
    def _compile(cls, native_map):
        if not native_map:
            return None
        keys = sorted(native_map.keys(), key=len, reverse=True)   # longest first
        # The lookarounds span every supported Indic block, so a word is only
        # replaced when it is not glued to another native letter.
        return re.compile(
            rf'(?<![{INDIC_CHARS}])(' +
            '|'.join(re.escape(k) for k in keys) +
            rf')(?![{INDIC_CHARS}])'
        )

    def apply(self, srt_text: str):
        """Replace dictionary native-script words with their PlanetRead Roman versions.

        Returns (new_text, protected_words, n_replaced) where protected_words is a
        set of lowercase Roman words that were written in and must not be altered
        by any later correction pass. Timecode and index lines are never touched.
        """
        if self._pattern is None:
            return srt_text, set(), 0

        protected: set = set()
        count = 0

        def repl(m):
            nonlocal count
            rep = self.native_map[m.group(1)]
            protected.add(rep.lower())
            count += 1
            return rep

        out = []
        for line in srt_text.split('\n'):
            s = line.strip()
            if '-->' in line or self.INDEX_RE.match(s) or not s:
                out.append(line)
            else:
                out.append(self._pattern.sub(repl, line))

        log.info("Pre-substitution: %d native word occurrence(s) replaced, "
                 "%d unique protected word(s)", count, len(protected))
        return '\n'.join(out), protected, count
