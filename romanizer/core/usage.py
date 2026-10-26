"""Per-run token usage and cost, aggregated by language and week.

Every number here is MEASURED from `response.usage`, never estimated from
character counts. That matters: an earlier estimate of this pipeline came out
3.6x under the real bill, because output tokens and retry traffic are impossible
to guess from the input.

One row is appended per romanization run. Aggregation happens at read time, so
the raw rows stay available for any other grouping later.
"""
from __future__ import annotations

import csv
import datetime as _dt
import logging
import os
import threading

from ..config import (CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER,
                      PRICE_INPUT_PER_MTOK, PRICE_OUTPUT_PER_MTOK,
                      USAGE_LOG_PATH)

log = logging.getLogger("romanize.usage")

FIELDS = [
    "timestamp", "iso_week", "language", "file", "lines",
    "api_calls", "input_tokens", "output_tokens",
    "cache_write_tokens", "cache_read_tokens", "cost_usd", "refused",
]


def cost_of(input_tokens=0, output_tokens=0, cache_write_tokens=0,
            cache_read_tokens=0) -> float:
    """Dollar cost of one run's measured tokens.

    The four token kinds are priced differently, so they are costed separately
    rather than summed into a single "input" figure.
    """
    return (
        input_tokens / 1e6 * PRICE_INPUT_PER_MTOK
        + output_tokens / 1e6 * PRICE_OUTPUT_PER_MTOK
        + cache_write_tokens / 1e6 * PRICE_INPUT_PER_MTOK * CACHE_WRITE_MULTIPLIER
        + cache_read_tokens / 1e6 * PRICE_INPUT_PER_MTOK * CACHE_READ_MULTIPLIER
    )


class UsageLog:
    """Append-only CSV of what each run actually cost."""

    _lock = threading.Lock()

    def __init__(self, path: str = USAGE_LOG_PATH):
        self.path = path

    # ── writing ──────────────────────────────────────────────────────────────
    def record(self, language: str, filename: str, stats: dict) -> dict | None:
        """Append one run. Returns the row written, or None if nothing was spent.

        A cache hit costs nothing and makes no API call, so it is deliberately
        NOT recorded — logging it would dilute the per-language averages with
        zero-cost rows and make the cost-per-episode figure meaningless.
        """
        usage = (stats or {}).get("usage") or {}
        if not any(usage.get(k) for k in
                   ("input_tokens", "output_tokens",
                    "cache_write_tokens", "cache_read_tokens")):
            return None

        now = _dt.datetime.now()
        row = {
            "timestamp": now.isoformat(timespec="seconds"),
            "iso_week": "%d-W%02d" % now.isocalendar()[:2],
            "language": language,
            "file": filename,
            "lines": stats.get("lines", 0),
            "api_calls": usage.get("api_calls", 0),
            "input_tokens": usage.get("input_tokens", 0),
            "output_tokens": usage.get("output_tokens", 0),
            "cache_write_tokens": usage.get("cache_write_tokens", 0),
            "cache_read_tokens": usage.get("cache_read_tokens", 0),
            "cost_usd": round(cost_of(
                usage.get("input_tokens", 0), usage.get("output_tokens", 0),
                usage.get("cache_write_tokens", 0),
                usage.get("cache_read_tokens", 0)), 6),
            "refused": stats.get("refused", 0),
        }
        try:
            with self._lock:
                new = not os.path.exists(self.path)
                os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
                with open(self.path, "a", newline="", encoding="utf-8") as f:
                    w = csv.DictWriter(f, fieldnames=FIELDS)
                    if new:
                        w.writeheader()
                    w.writerow(row)
            log.info("Usage logged: %s %s — %d in / %d out, $%.4f",
                     language, row["iso_week"], row["input_tokens"],
                     row["output_tokens"], row["cost_usd"])
        except OSError as e:
            # Never fail a finished romanization because bookkeeping failed.
            log.warning("Could not write the usage log: %s", e)
        return row

    # ── reading ──────────────────────────────────────────────────────────────
    def rows(self) -> list:
        try:
            with open(self.path, newline="", encoding="utf-8") as f:
                out = []
                for r in csv.DictReader(f):
                    for k in ("lines", "api_calls", "input_tokens", "output_tokens",
                              "cache_write_tokens", "cache_read_tokens", "refused"):
                        r[k] = int(r.get(k) or 0)
                    r["cost_usd"] = float(r.get("cost_usd") or 0.0)
                    out.append(r)
                return out
        except (OSError, ValueError):
            return []

    def weekly_by_language(self) -> list:
        """One row per (week, language): runs, lines, tokens, cost.

        Sorted newest week first so the current week is what you see without
        scrolling.
        """
        buckets = {}
        for r in self.rows():
            key = (r["iso_week"], r["language"])
            b = buckets.setdefault(key, {
                "Week": r["iso_week"], "Language": r["language"],
                "Runs": 0, "Lines": 0, "API calls": 0,
                "Input tokens": 0, "Output tokens": 0,
                "Cached tokens": 0, "Cost (USD)": 0.0,
            })
            b["Runs"] += 1
            b["Lines"] += r["lines"]
            b["API calls"] += r["api_calls"]
            b["Input tokens"] += r["input_tokens"]
            b["Output tokens"] += r["output_tokens"]
            b["Cached tokens"] += r["cache_read_tokens"] + r["cache_write_tokens"]
            b["Cost (USD)"] += r["cost_usd"]
        rows = sorted(buckets.values(),
                      key=lambda b: (b["Week"], b["Cost (USD)"]), reverse=True)
        for b in rows:
            b["Cost (USD)"] = round(b["Cost (USD)"], 4)
        return rows

    def totals(self) -> dict:
        rows = self.rows()
        return {
            "runs": len(rows),
            "lines": sum(r["lines"] for r in rows),
            "input_tokens": sum(r["input_tokens"] for r in rows),
            "output_tokens": sum(r["output_tokens"] for r in rows),
            "cost_usd": round(sum(r["cost_usd"] for r in rows), 4),
        }

    def as_csv(self) -> bytes:
        try:
            with open(self.path, "rb") as f:
                return f.read()
        except OSError:
            return b""
