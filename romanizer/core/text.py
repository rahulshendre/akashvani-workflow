"""Text tidy-up passes applied to a romanized SRT before it is returned or cached.

All pure functions on a class, because they are a cohesive set of rules with no
state: given the same text they always produce the same text. Newlines are never
touched by any of them, so the block/timecode structure always survives.
"""
from __future__ import annotations

import re


class TextFinalizer:
    """Whitespace + capitalization rules for romanized subtitle text."""

    # closed-caption / sound cues like "[music playing]" — first letter inside [ ]
    _CC_RE = re.compile(r'(\[[^A-Za-z\]]*)([a-z])')

    # song-lyric markers; lyric lines should start with a capital like a sentence
    _NOTE_CHARS = "♪♫♩♬🎵🎶"
    _NOTE_RE = re.compile("[" + _NOTE_CHARS + "]")
    _LINE_FIRST_LOWER_RE = re.compile(r'^([^A-Za-z]*)([a-z])')  # leading symbols then 1st letter

    # collapse runs of spaces/tabs; trim leading/trailing spaces on each line
    _MULTISPACE_RE = re.compile(r'[ \t]{2,}')
    _EDGE_SPACE_RE = re.compile(r'(?m)^[ \t]+|[ \t]+$')

    # first letter of a line, after any leading symbols/spaces
    _LINE_START_RE = re.compile(r'^([^A-Za-z]*)([A-Za-z])')
    # a line that closes a unit -> the next line begins a new sentence
    _UNIT_END_CHARS = ".!?…♪♫♩♬]"

    @staticmethod
    def capitalize_closed_captions(text: str) -> str:
        """Capitalize the first word inside any [ ... ] closed-caption / sound cue,
        e.g. '[music playing]' -> '[Music playing]'. Idempotent (skips already-caps)."""
        return TextFinalizer._CC_RE.sub(lambda m: m.group(1) + m.group(2).upper(), text)

    @staticmethod
    def capitalize_music_lines(text: str) -> str:
        """Capitalize the first word of every lyric line — a text line that contains a
        musical note (e.g. '♪ mera dil ♪') or sits inside an open ♪...♪ region that
        spans several lines. Timecode/index/blank lines are skipped. Idempotent."""
        notes_seen = 0
        out = []
        for line in text.split("\n"):
            s = line.strip()
            is_text = bool(s) and "-->" not in line and not s.isdigit()
            if is_text:
                inside = notes_seen % 2 == 1          # odd note count => inside a ♪...♪
                if inside or TextFinalizer._NOTE_RE.search(line):
                    line = TextFinalizer._LINE_FIRST_LOWER_RE.sub(
                        lambda m: m.group(1) + m.group(2).upper(), line, count=1)
                notes_seen += len(TextFinalizer._NOTE_RE.findall(line))
            out.append(line)
        return "\n".join(out)

    @staticmethod
    def sentence_case_line_starts(text: str) -> str:
        """Capitalize a line's first letter ONLY when it starts a NEW sentence (the
        previous text line ended with . ! ? or a music/CC boundary). A line that just
        continues the previous sentence is lowercased — so line breaks no longer all
        start with a capital. CC/lyric lines are re-capitalized by their own passes
        afterwards, so this never undoes those."""
        new_sentence = True
        out = []
        for line in text.split("\n"):
            s = line.strip()
            is_text = bool(s) and "-->" not in line and not s.isdigit()
            if is_text:
                cap = new_sentence
                line = TextFinalizer._LINE_START_RE.sub(
                    lambda m: m.group(1) + (m.group(2).upper() if cap else m.group(2).lower()),
                    line, count=1)
                new_sentence = s[-1] in TextFinalizer._UNIT_END_CHARS
            out.append(line)
        return "\n".join(out)

    @staticmethod
    def finalize(text: str) -> str:
        """Tidy the romanized SRT before returning/caching: collapse extra spaces
        between words, trim per-line edge spaces, fix sentence-start capitalization
        (only after . ! ? — not every line break), then re-capitalize closed captions
        and musical-note lyric lines. Newlines are never touched, so the block/timecode
        structure is preserved.

        Order matters: sentence-casing runs FIRST and would lowercase a lyric or a
        cue that merely continues a sentence, so the two capitalization passes run
        after it to put those back.
        """
        text = TextFinalizer._MULTISPACE_RE.sub(' ', text)
        text = TextFinalizer._EDGE_SPACE_RE.sub('', text)
        text = TextFinalizer.sentence_case_line_starts(text)
        text = TextFinalizer.capitalize_closed_captions(text)
        text = TextFinalizer.capitalize_music_lines(text)
        return text
