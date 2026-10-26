"""
Build the RAW (pre-postprocessing) SRT from a saved .raw.json.

One cue per Sarvam API call, using Sarvam's own segment boundaries and its
verbatim transcript. Deliberately applies NONE of generate_srt.py's cue
shaping: no sentence/clause splitting, no proportional time redistribution,
no two-line wrapping, no MIN_CUE_DURATION padding, no overlap clamping and
no junk-label filtering. Use it to see exactly what the model returned.

Usage:
    python make_raw_srt.py <run>.raw.json [more.raw.json ...]
    python make_raw_srt.py <run>.raw.json -o out.srt
    python make_raw_srt.py <run>.raw.json --keep-empty
"""

import argparse
import json
from pathlib import Path

from generate_srt import fmt_srt_time  # reuse the exact same timestamp format


def raw_to_srt(raw_path: Path, out_path: Path,
               keep_empty: bool = False) -> tuple[int, int]:
    segs = json.loads(raw_path.read_text(encoding="utf-8"))
    lines: list[str] = []
    n = skipped = 0
    for seg in segs:
        resp = seg.get("response") or {}
        text = (resp.get("transcript") or "").strip()
        if not text and not keep_empty:
            skipped += 1          # nothing for a player to display
            continue
        n += 1
        lines += [str(n),
                  f"{fmt_srt_time(seg['start'])} --> {fmt_srt_time(seg['end'])}",
                  text, ""]
    out_path.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    return n, skipped


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Raw SRT straight from Sarvam responses")
    ap.add_argument("raw_json", nargs="+", type=Path)
    ap.add_argument("-o", "--output", type=Path, default=None,
                    help="output .srt (only valid with a single input)")
    ap.add_argument("--keep-empty", action="store_true",
                    help="emit cues for segments Sarvam returned empty")
    args = ap.parse_args()

    if args.output and len(args.raw_json) > 1:
        ap.error("-o/--output takes a single input file")

    for raw in args.raw_json:
        if not raw.exists():
            ap.error(f"not found: {raw}")
        out = args.output or raw.with_suffix("").with_suffix(".raw.srt")
        n, skipped = raw_to_srt(raw, out, args.keep_empty)
        print(f"{out.name:36} {n:4} cues  ({skipped} empty segments skipped)")


if __name__ == "__main__":
    main()
