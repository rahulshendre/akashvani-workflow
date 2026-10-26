"""Low-level Word (OOXML) run builders.

A "run" is the smallest styled span in a .docx. The review file shows each
correction as the red original followed by a colour-highlighted replacement, and
that is done by replacing a paragraph's runs with hand-built ones.
"""
from __future__ import annotations

import copy

from docx.oxml import OxmlElement
from docx.oxml.ns import qn


class RunBuilder:
    """Builds the styled runs the review document is made of."""

    @staticmethod
    def base_rPr(source_run_xml=None):
        """Copy the source run's formatting so corrections inherit the file's font."""
        if source_run_xml is not None:
            src = source_run_xml.find(qn('w:rPr'))
            if src is not None:
                return copy.deepcopy(src)
        return OxmlElement('w:rPr')

    @staticmethod
    def make_text(text: str):
        t = OxmlElement('w:t')
        t.text = text
        if text.startswith(' ') or text.endswith(' '):
            t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
        return t

    @staticmethod
    def clean_rPr(rPr):
        """Drop any inherited colour/strike/highlight so ours is the only styling."""
        for tag in ('w:color', 'w:strike', 'w:highlight'):
            for el in rPr.findall(qn(tag)):
                rPr.remove(el)
        return rPr

    @classmethod
    def red(cls, text, source_run_xml=None):
        """The original (wrong) word, in red."""
        r = OxmlElement('w:r')
        rPr = cls.clean_rPr(cls.base_rPr(source_run_xml))
        color = OxmlElement('w:color')
        color.set(qn('w:val'), 'FF0000')
        rPr.append(color)
        r.append(rPr)
        r.append(cls.make_text(text))
        return r

    @classmethod
    def highlight(cls, text, color, source_run_xml=None):
        """The replacement, highlighted in its tier colour."""
        r = OxmlElement('w:r')
        rPr = cls.clean_rPr(cls.base_rPr(source_run_xml))
        hl = OxmlElement('w:highlight')
        hl.set(qn('w:val'), color)
        rPr.append(hl)
        r.append(rPr)
        r.append(cls.make_text(text))
        return r

    @classmethod
    def normal(cls, text, source_run_xml=None):
        """Untouched text."""
        r = OxmlElement('w:r')
        r.append(cls.base_rPr(source_run_xml))
        r.append(cls.make_text(text))
        return r
