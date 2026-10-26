"""Guidelines 2 and 3: one spelling per word, consistent vowel length.

This cannot be a prompt instruction. Each batch is an independent API call with
no memory of the others, so "be consistent" has nothing to be consistent WITH.
Measured on a finished episode, the model contradicted itself 12 times in a
single file: pareshaan/pareshan, haan/han, kaam/kam, jaaye/jaye, waale/wale.

So consistency is enforced afterwards, mechanically: cluster the words that are
the same word spelled differently, pick the approved form where the dictionary
knows one, and flag the rest for the Language Expert rather than guessing.
"""
from __future__ import annotations

import collections
import logging
import re

log = logging.getLogger("romanize.consistency")


class ConsistencyChecker:
    """Finds words that appear in more than one spelling in the same output."""

    _WORD_RE = re.compile(r"[A-Za-z]+")

    # Differences that mean "same word, different spelling" rather than
    # "different word". Each is a convention the guidelines name explicitly.
    _FOLD = [
        (re.compile(r"([aeiou])\1+"), r"\1"),   # vowel length: aa/a, ee/i, oo/u
        (re.compile(r"ee"), "i"),               # guideline 3: ई -> i
        (re.compile(r"oo"), "u"),               # guideline 3: ऊ -> oo/u
        (re.compile(r"w"), "v"),                # व: v/w are the same consonant
        (re.compile(r"z"), "j"),                # ज़/ज
        (re.compile(r"chh"), "ch"),             # छ/च
        (re.compile(r"n$"), ""),                # guideline 4: nasal kept or not
    ]

    # Short words collide under folding for boring reasons ("a"/"aa", "to"/"too"),
    # so they are excluded rather than reported as false positives.
    MIN_LENGTH = 4

    def __init__(self, approved: dict = None):
        """`approved` is the dictionary's {wrong_lower: right} map; when a cluster
        contains an approved spelling, that one is the answer and no human needs
        to look at it."""
        self.approved = approved or {}

    @classmethod
    def fold(cls, word: str) -> str:
        """Reduce a word to the form it shares with its own variants."""
        w = word.lower()
        for pattern, repl in cls._FOLD:
            w = pattern.sub(repl, w)
        return w

    def clusters(self, text: str):
        """Every group of 2+ spellings that fold to the same word.

        Returns a list of dicts sorted by how often the word occurs, so the most
        damaging inconsistencies are reviewed first.
        """
        counts = collections.Counter(
            w for w in self._WORD_RE.findall(text) if len(w) >= self.MIN_LENGTH)

        grouped = collections.defaultdict(collections.Counter)
        for word, n in counts.items():
            grouped[self.fold(word)][word] += n

        out = []
        for _key, variants in grouped.items():
            # case-only differences are handled elsewhere (match_case), not here
            if len({v.lower() for v in variants}) < 2:
                continue
            spellings = sorted(variants.items(), key=lambda kv: -kv[1])
            approved = next(
                (s for s, _n in spellings
                 if s.lower() in self.approved.values()
                 or s.lower() in {v.lower() for v in self.approved.values()}),
                None)
            out.append({
                "variants": spellings,
                "total": sum(variants.values()),
                "approved": approved,
                "suggested": approved or spellings[0][0],   # else the commonest
            })
        out.sort(key=lambda c: -c["total"])
        log.info("Consistency: %d word(s) appear in more than one spelling", len(out))
        return out

    def summary(self, text: str):
        """One line per inconsistency, ready to show a reviewer."""
        rows = []
        for c in self.clusters(text):
            shown = " / ".join(f"{s}×{n}" for s, n in c["variants"])
            why = "dictionary" if c["approved"] else "most common in this file"
            rows.append(f"{shown}  →  use **{c['suggested']}** ({why})")
        return rows
