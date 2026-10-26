"""Turning the reviewer's ticks into the three deliverable files.

Nothing is re-scanned here: the candidate list from DocumentCorrector is reused
and merely filtered by what the reviewer accepted, so ticking a box never costs
another pass over the document.
"""
from __future__ import annotations

from ..core.dictionary import Dictionary
from ..core.srt import SrtDocument
from .exporter import DictionaryExporter
from .review_docx import ReviewDocxBuilder
from .srt_writer import SrtWriter


class OutputBuilder:
    """Builds the final SRT, the review .docx, and the grow-the-dictionary export."""

    def __init__(self):
        self.review_builder = ReviewDocxBuilder()
        self.srt_writer = SrtWriter()
        self.exporter = DictionaryExporter()

    def build(self, romanized_text, replacements, all_changes, selected,
              protected=frozenset()):
        """Apply the exact dictionary + only the ticked engine pairs.

        Returns a dict with the review docx, final SRT, engine-pairs export, and
        counts. `protected` words (pre-substituted) are left as-is.
        """
        selected_engine = [
            c for c in all_changes
            if c["tier"] in ("fix", "suggest") and (c["orig"], c["repl"]) in selected
        ]
        # apply_map drives both the markup and the SRT replacement; exact wins conflicts.
        apply_map, tier_map = {}, {}
        for c in selected_engine:
            k = c["orig"].lower()
            apply_map[k] = c["repl"]
            tier_map[k] = c["tier"]
        for k, v in replacements.items():
            apply_map[k] = v
            tier_map[k] = "exact"

        apply_re = Dictionary.build_exact_regex(apply_map)
        review_docx = self.review_builder.build(romanized_text, apply_re, apply_map,
                                                tier_map, protected)

        rom_docx = SrtDocument.to_docx_bytes(romanized_text)
        srt_final, n_codes, n_fixes = self.srt_writer.build(rom_docx, apply_map, protected)

        exp_bytes, n_new = self.exporter.build(selected_engine)
        return {
            "review_docx": review_docx,
            "srt_final": srt_final,
            "n_codes": n_codes,
            "n_fixes": n_fixes,
            "engine_pairs": exp_bytes.getvalue(),
            "n_new": n_new,
            "n_engine_applied": len({(c["orig"], c["repl"]) for c in selected_engine}),
        }
