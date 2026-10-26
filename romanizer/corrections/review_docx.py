"""The Word review file: every applied correction shown in context."""
from __future__ import annotations

import io

from docx import Document

from ..config import TIER_HL
from .runs import RunBuilder
from .srt_writer import SrtWriter


class ReviewDocxBuilder:
    """Renders the romanized text with each applied correction marked up."""

    def build(self, text, apply_re, apply_map, tier_map, protected=frozenset()):
        """Word review file: each applied correction shown as red original + a
        tier-coloured highlight of the replacement. Only keys in apply_map are
        marked; `protected` words (pre-substituted) are never marked."""
        doc = Document()
        for line in text.split("\n"):
            para = doc.add_paragraph()
            if not line:
                continue
            spans = []
            if apply_re is not None:
                for m in apply_re.finditer(line):
                    key = m.group(1).lower()
                    if key in protected:
                        continue
                    rep = apply_map.get(key)
                    if rep is not None:
                        rep = SrtWriter.match_case(m.group(1), rep)
                        spans.append((m.start(), m.end(), rep, tier_map.get(key, "exact")))
            if not spans:
                para._p.append(RunBuilder.normal(line))
                continue
            pos = 0
            for s, e, rep, tier in spans:
                if pos < s:
                    para._p.append(RunBuilder.normal(line[pos:s]))
                para._p.append(RunBuilder.red(line[s:e]))
                para._p.append(RunBuilder.normal(' '))
                para._p.append(RunBuilder.highlight(rep, TIER_HL.get(tier, "yellow")))
                pos = e
            if pos < len(line):
                para._p.append(RunBuilder.normal(line[pos:]))
        buf = io.BytesIO()
        doc.save(buf)
        return buf.getvalue()
