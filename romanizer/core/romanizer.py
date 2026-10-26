"""Transliterating an .srt with Claude, and putting it back on its timecodes.

Only the subtitle TEXT is sent to the model. Timecodes and block numbers stay
local, which is both the token saving and the reason output timing always
matches input timing exactly.
"""
from __future__ import annotations

import logging
import random
import re
import time

from ..config import (BASE_RETRY_DELAY, BATCH_SIZE, INDIC_CHARS, LANGUAGES,
                      MAX_ATTEMPTS, MODEL, MODEL_EXTRA, RETRYABLE_STATUS)
from .cache import RomanizationCache
from .srt import SrtDocument
from .text import TextFinalizer
from .tracing import trace_inputs, trace_outputs, traceable, wrap_client

log = logging.getLogger("romanize.srt")

# Any Indic letter in the OUTPUT means that line was not romanized.
NATIVE_SCRIPT_RE = re.compile("[" + INDIC_CHARS + "]")


def anthropic_available() -> bool:
    """True if the anthropic SDK is importable (used to show a friendly error)."""
    try:
        import anthropic  # noqa: F401
        return True
    except Exception:
        return False


class BatchUnusable(RuntimeError):
    """Base for "the reply came back but we cannot use it". Callers respond by
    splitting the batch rather than accepting the result."""


class BatchRefused(BatchUnusable):
    """The API answered with stop_reason="refusal" — a safety decision, not an
    error: HTTP 200, zero content blocks, 0 output tokens. Retrying the identical
    batch is pointless (verified deterministic), so callers split it instead."""


class BatchNotRomanized(BatchUnusable):
    """The model echoed lines back in the ORIGINAL script instead of romanizing.

    This is the dangerous failure, because it looks like success: the reply parses,
    every line is accounted for, `missing` stays 0, and native-script text ships in
    a file that appears finished. Nothing downstream can catch it either — the
    dictionary pass only ever rewrites Roman words. So the output is verified here
    against the one thing we know for certain: romanized text contains no
    Devanagari, Telugu, Tamil or any other Indic letter.
    """


class Romanizer:
    """Romanizes one subtitle file for one language."""

    SYSTEM_TEMPLATE = (
        "You are an expert transliterator for Indian-language subtitles (Same Language "
        "Subtitling, used for reading practice).\n\n"
        "Every user message contains numbered subtitle lines in {language}. For each "
        "line, TRANSLITERATE it into the Latin/Roman alphabet — write how the words "
        "SOUND using ordinary English letters. Do NOT translate the meaning into "
        "English; only convert the script to Roman letters.\n\n"
        "Output rules (follow EXACTLY):\n"
        "- Return one output line for every input line, in the same order.\n"
        "- Each output line MUST be: the same number, then a single TAB character "
        "(\\t), then the romanized text. Example:  12\\tmera dil kho gaya\n"
        "- Use natural, widely-used phonetic romanization (the common way these "
        "words are written in Roman script).\n"
        "- Use normal sentence capitalization: capitalize the first letter of each "
        "sentence and proper nouns (names, places). Keep all other words lowercase. "
        "Do NOT lowercase everything, and do NOT capitalize every word.\n"
        "- Convert native-script digits to Western digits (e.g. १९४७ -> 1947).\n"
        "- Keep punctuation, musical symbols (like ♪), and any text that is already "
        "in Roman letters unchanged.\n"
        "- If a line cannot be transliterated, repeat it unchanged (still with its "
        "number and tab).\n"
        "- Never merge, split, drop, reorder, or add lines. Output ONLY the numbered "
        "lines — no commentary, headings, code fences, or blank lines."
    )

    NUMBERED_RE = re.compile(r'^\s*(\d+)\t(.*)$')            # strict: "12\t<text>"
    LOOSE_RE = re.compile(r'^\s*(\d+)\s*[\t.):\-]\s?(.*)$')  # fallback: "12. <text>"

    # class-level so the "SDK is too old for output_config" discovery is made once
    # per process rather than once per batch
    _extra = dict(MODEL_EXTRA)

    def __init__(self, language: str, api_key=None, cache: RomanizationCache = None):
        self.language = language
        self.language_desc = LANGUAGES.get(language, language)
        self.api_key = api_key
        self.cache = cache or RomanizationCache()
        self._client = None
        # Measured token spend for this file. Every API call adds to it,
        # including the extra calls a refusal split costs — those are real money
        # and must not be invisible in the usage report.
        self.usage = {"api_calls": 0, "input_tokens": 0, "output_tokens": 0,
                      "cache_write_tokens": 0, "cache_read_tokens": 0}

    # ── client ───────────────────────────────────────────────────────────────
    @property
    def client(self):
        """Created lazily so a cache hit never needs the anthropic SDK at all."""
        if self._client is None:
            import anthropic
            raw = (anthropic.Anthropic(api_key=self.api_key) if self.api_key
                   else anthropic.Anthropic())
            self._client = wrap_client(raw)
        return self._client

    # ── retry policy ─────────────────────────────────────────────────────────
    @staticmethod
    def _is_retryable(exc) -> bool:
        """True for transient Anthropic errors worth retrying (overloaded, rate limit,
        5xx, connection/timeout); False for client errors (bad request, auth, etc.)."""
        import anthropic
        if isinstance(exc, (anthropic.APIConnectionError, anthropic.APITimeoutError)):
            return True
        if getattr(exc, "status_code", None) in RETRYABLE_STATUS:
            return True
        return "overloaded" in str(exc).lower()

    # ── parsing the reply ────────────────────────────────────────────────────
    @classmethod
    def _parse_numbered(cls, output: str, n: int):
        """Map the model's reply back to n lines. Prefers the explicit 'N\\t...' form;
        falls back to positional mapping if the count lines up but numbering drifted."""
        result = [None] * n
        for line in output.split("\n"):
            m = cls.NUMBERED_RE.match(line)
            if not m:
                continue
            idx = int(m.group(1))
            if 1 <= idx <= n:
                result[idx - 1] = m.group(2)

        if any(x is None for x in result):
            cand = []
            for line in output.split("\n"):
                if not line.strip():
                    continue
                m = cls.LOOSE_RE.match(line)
                cand.append(m.group(2) if m else line.strip())
            if len(cand) == n:
                for i in range(n):
                    if result[i] is None:
                        result[i] = cand[i]
        return result

    # ── one batch ────────────────────────────────────────────────────────────
    def _romanize_batch(self, batch):
        """Romanize one batch of lines. Returns (lines, n_fell_back_to_original)."""
        numbered = "\n".join(f"{i}\t{t}" for i, t in enumerate(batch, 1))
        system = [{
            "type": "text",
            "text": self.SYSTEM_TEMPLATE.format(language=self.language_desc),
            "cache_control": {"type": "ephemeral"},   # reused across batches in a run
        }]
        kwargs = dict(
            model=MODEL,
            max_tokens=min(16000, max(1500, len(batch) * 200)),
            system=system,
            messages=[{"role": "user", "content": numbered}],
        )
        # stream (avoids HTTP timeouts on large batches); .get_final_message() gives
        # the assembled reply without hand-handling events. Anthropic can return an
        # "Overloaded" (529) or rate-limit (429) error — sometimes mid-stream, where
        # the SDK won't auto-retry — so we retry the whole batch with backoff.
        attempt = 0
        while True:
            try:
                with self.client.messages.stream(**kwargs, **type(self)._extra) as stream:
                    msg = stream.get_final_message()
                break
            except TypeError:
                if type(self)._extra:   # SDK predates output_config/effort — drop it
                    type(self)._extra = {}
                    continue
                raise                   # a genuine TypeError, not the effort kwarg
            except Exception as exc:
                attempt += 1
                if attempt >= MAX_ATTEMPTS or not self._is_retryable(exc):
                    raise
                delay = BASE_RETRY_DELAY * (2 ** (attempt - 1)) + random.uniform(0, 0.75)
                log.warning("Anthropic transient error (%s); retry %d/%d in %.1fs: %s",
                            type(exc).__name__, attempt, MAX_ATTEMPTS - 1, delay, exc)
                time.sleep(delay)

        self._add_usage(getattr(msg, "usage", None))

        # A safety refusal arrives as a normal 200 with stop_reason="refusal" and NO
        # content blocks. Without this check the empty reply looks exactly like "the
        # model returned nothing", every line silently falls back to its native-script
        # source, and a 40-line block of un-romanized text ships unnoticed.
        if getattr(msg, "stop_reason", None) == "refusal":
            raise BatchRefused(f"refused a batch of {len(batch)} line(s)")

        text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
        parsed = self._parse_numbered(text, len(batch))

        # Did the model hand anything back still in the source script? Checked
        # before the fallback below, so an echoed line is never mistaken for a
        # successful romanization.
        echoed = [i for i, p in enumerate(parsed) if p and NATIVE_SCRIPT_RE.search(p)]
        if echoed:
            raise BatchNotRomanized(
                f"{len(echoed)} of {len(batch)} line(s) came back in the original "
                f"script, e.g. {parsed[echoed[0]][:60]!r}")

        out, n_missing = [], 0
        for orig, rom in zip(batch, parsed):
            if rom is None or not rom.strip():
                out.append(orig)      # safest fallback: keep the source line
                n_missing += 1
            else:
                out.append(rom)
        return out, n_missing

    def _add_usage(self, usage) -> None:
        """Accumulate one reply's measured tokens.

        Recorded before the refusal and parse checks, because a refused batch
        still bills for its input even though it returns nothing usable.
        """
        if usage is None:
            return
        self.usage["api_calls"] += 1
        self.usage["input_tokens"] += getattr(usage, "input_tokens", 0) or 0
        self.usage["output_tokens"] += getattr(usage, "output_tokens", 0) or 0
        self.usage["cache_write_tokens"] += getattr(usage, "cache_creation_input_tokens", 0) or 0
        self.usage["cache_read_tokens"] += getattr(usage, "cache_read_input_tokens", 0) or 0

    # ── one batch, surviving refusals ────────────────────────────────────────
    def _romanize_resilient(self, batch, depth=0):
        """Romanize a batch, recursively halving it around a safety refusal.

Handles both failure kinds: a safety refusal, and a reply that
        came back still in the source script.

        A refusal is a judgement on the batch's ACCUMULATED content, not usually on
        one line — the same lines sail through in a smaller group (measured: a
        40-line batch refused 3/3 times, its second half passed immediately, and
        single lines always pass). Halving therefore recovers nearly everything and
        confines any genuinely unrecoverable refusal to one line instead of forty.

        Returns (lines, n_missing, refused_offsets) where refused_offsets are
        indices into `batch` that kept their source text.
        """
        try:
            out, n_missing = self._romanize_batch(batch)
            if depth:
                log.info("Recovered %d line(s) after splitting (depth %d)", len(batch), depth)
            return out, n_missing, []
        except BatchUnusable as exc:
            if len(batch) == 1:
                # Nothing left to split. Keep the source line and report it upward —
                # the caller turns this into a visible warning naming the subtitle.
                log.error("Unromanized even as a single line (%s); keeping source: %r",
                          type(exc).__name__, batch[0][:90])
                return list(batch), 0, [0]
            half = len(batch) // 2
            log.warning("%s on %d line(s) at depth %d; splitting into %d + %d",
                        type(exc).__name__, len(batch), depth, half, len(batch) - half)
            left, lm, lref = self._romanize_resilient(batch[:half], depth + 1)
            right, rm, rref = self._romanize_resilient(batch[half:], depth + 1)
            return left + right, lm + rm, lref + [half + i for i in rref]

    # ── the whole file ───────────────────────────────────────────────────────
    @traceable(run_type="chain", name="romanize_srt",
               process_inputs=trace_inputs, process_outputs=trace_outputs)
    def romanize(self, data: bytes, progress_cb=None, use_cache: bool = True):
        """Romanize a native-script .srt.

        Returns (romanized_srt_text, stats) where stats =
        {lines, blocks, missing, cached, refused, refused_subtitles}.
        `progress_cb(done, total)` is called after each batch (optional).

        If `use_cache` and an identical (file bytes + language) was romanized
        before, the stored result is returned WITHOUT contacting Anthropic.
        """
        key = self.cache.key(data, self.language)
        if use_cache:
            hit = self.cache.load(key)
            if hit is not None:
                stats = dict(hit.get("stats") or {})
                stats["cached"] = True
                log.info("Romanization cache HIT (%s…) — no API call", key[:8])
                # apply on the cached text too, so older caches still get the fix
                return TextFinalizer.finalize(hit["romanized_text"]), stats

        doc = SrtDocument.from_bytes(data)
        refs, texts = doc.collect()
        total = len(texts)
        if total == 0:
            stats = {"lines": 0, "blocks": len(doc.blocks), "missing": 0,
                     "cached": False, "refused": 0, "refused_subtitles": []}
            text = TextFinalizer.finalize(doc.serialize())
            if use_cache:
                self.cache.store(key, text, stats)
            return text, stats

        romanized, missing, refused = [], 0, []
        for start in range(0, total, BATCH_SIZE):
            batch = texts[start:start + BATCH_SIZE]
            out, n_missing, refused_off = self._romanize_resilient(batch)
            romanized.extend(out)
            missing += n_missing
            refused.extend(start + off for off in refused_off)
            if progress_cb:
                progress_cb(min(start + len(batch), total), total)

        doc.apply(refs, romanized)

        # Report refusals as the SUBTITLE NUMBERS the user sees, so the few affected
        # lines can be fixed by hand instead of hunting for them.
        refused_subtitles = sorted(
            {doc.subtitle_number(refs[i][0]) for i in refused
             if doc.subtitle_number(refs[i][0])},
            key=lambda s: int(s) if s.isdigit() else 0)

        text = TextFinalizer.finalize(doc.serialize())
        stats = {"lines": total, "blocks": len(doc.blocks), "missing": missing,
                 "cached": False, "refused": len(refused),
                 "refused_subtitles": refused_subtitles,
                 "usage": dict(self.usage)}
        log.info("Romanized %d lines across %d blocks (%d kept original, %d refused)",
                 total, len(doc.blocks), missing, len(refused))
        if use_cache:
            self.cache.store(key, text, stats)
        return text, stats
