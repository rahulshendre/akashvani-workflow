"""
Generate a millisecond-accurate SRT from a video using Sarvam Saaras v3.

Why silence-based segmentation?
  Saaras v3's real-time REST endpoint returns only utterance/chunk-level
  timestamps (one entry spanning the whole clip) and diarization is
  batch-API-only. So instead of trusting model timestamps, we cut the audio
  at DETECTED SILENCES (ffmpeg silencedetect reports boundaries with ms
  precision). Each speech segment between silences is transcribed
  separately, and the segment's real start/end times become the cue timing.

Pipeline:
  1. Extract mono 16 kHz WAV audio from the video (ffmpeg).
  2. Detect silences -> build speech segments (merged/split to 1-29 s).
  3. Transcribe every segment with model=saaras:v3, mode=transcribe
     (SAME-LANGUAGE output: Hindi audio -> Hindi subtitles).
  4. Emit SRT cues at HH:MM:SS,mmm precision. Long segments are split into
     sentence cues with time distributed proportionally by text length.

Usage:
    python generate_srt.py [input_video] [-o output.srt]

Requires: ffmpeg on PATH, `requests`, SARVAM_API_KEY in .env
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

# Windows consoles default to cp1252, which can't print Devanagari
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

API_URL = "https://api.sarvam.ai/speech-to-text"
MODEL = "saaras:v3"
MODE = "transcribe"          # same-language output (no translation)
MAX_WORKERS = 3              # parallel API calls
MAX_RETRIES = 4              # per-segment retries (handles 429/5xx)

# --- segmentation tuning -----------------------------------------------------
# Tuned for phrase-level (CC-style) cues: split at short inter-phrase pauses
SILENCE_NOISE = "-30dB"      # silencedetect noise floor
SILENCE_MIN = 0.20           # min silence length (s) to count as a boundary
SEG_PAD = 0.10               # widen each segment by this much on both sides
MERGE_GAP = 0.30             # merge neighbours separated by less than this
MERGE_MAX = 5.0              # ...but never grow a merged segment past this
HARD_MAX = 29.0              # REST cap safety: force-split anything longer
MIN_SEG = 0.25               # drop blips shorter than this

# --- SRT cue shaping ---------------------------------------------------------
MAX_CUE_CHARS = 42           # single-line phrase cues, CC-style
MIN_CUE_DURATION = 0.5       # pad ultra-short cues to stay readable

DEFAULT_VIDEO = "Zewar Ka Dibba (Edited)Watermark_first10min.mp4"


def load_env_key(env_path: Path = Path(".env")) -> str:
    key = os.environ.get("SARVAM_API_KEY")
    if key:
        return key.strip()
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("SARVAM_API_KEY"):
                return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("ERROR: SARVAM_API_KEY not found in environment or .env")


def run_ffmpeg(cmd: list[str]) -> str:
    res = subprocess.run(cmd, capture_output=True, text=True,
                         encoding="utf-8", errors="replace")
    if res.returncode != 0:
        sys.exit(f"ffmpeg failed:\n{res.stderr[-2000:]}")
    return res.stderr  # ffmpeg logs to stderr


# --- audio prep --------------------------------------------------------------

def extract_audio(video: Path, out_wav: Path) -> float:
    """Extract 16 kHz mono WAV; return its duration in seconds."""
    run_ffmpeg(["ffmpeg", "-y", "-i", str(video), "-vn", "-ac", "1",
                "-ar", "16000", "-c:a", "pcm_s16le", str(out_wav)])
    probe = subprocess.run(
        ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(out_wav)],
        capture_output=True, text=True)
    return float(probe.stdout.strip())


def detect_silences(wav: Path) -> list[tuple[float, float]]:
    """Return [(silence_start, silence_end)] via ffmpeg silencedetect."""
    log = run_ffmpeg([
        "ffmpeg", "-i", str(wav),
        "-af", f"silencedetect=noise={SILENCE_NOISE}:d={SILENCE_MIN}",
        "-f", "null", "-",
    ])
    starts = [float(m) for m in re.findall(r"silence_start:\s*([\d.]+)", log)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*([\d.]+)", log)]
    return list(zip(starts, ends))


def build_segments(silences: list[tuple[float, float]],
                   total: float) -> list[tuple[float, float]]:
    """Speech segments = complement of silences, padded/merged/split."""
    # complement of silence intervals
    segs, cursor = [], 0.0
    for s_start, s_end in silences:
        if s_start > cursor:
            segs.append([cursor, s_start])
        cursor = max(cursor, s_end)
    if cursor < total:
        segs.append([cursor, total])

    # pad into the surrounding silence so we don't clip word edges
    for seg in segs:
        seg[0] = max(0.0, seg[0] - SEG_PAD)
        seg[1] = min(total, seg[1] + SEG_PAD)

    # drop blips, then merge close neighbours (bounded length)
    segs = [s for s in segs if s[1] - s[0] >= MIN_SEG]
    merged: list[list[float]] = []
    for seg in segs:
        if (merged and seg[0] - merged[-1][1] < MERGE_GAP
                and seg[1] - merged[-1][0] <= MERGE_MAX):
            merged[-1][1] = seg[1]
        else:
            merged.append(seg)

    # hard-split anything over the REST cap
    final: list[tuple[float, float]] = []
    for start, end in merged:
        dur = end - start
        if dur <= HARD_MAX:
            final.append((start, end))
        else:
            n = int(dur // HARD_MAX) + 1
            step = dur / n
            final.extend((start + i * step, start + (i + 1) * step)
                         for i in range(n))
    return final


def cut_segment(wav: Path, start: float, end: float, out: Path) -> None:
    run_ffmpeg(["ffmpeg", "-y", "-i", str(wav),
                "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
                "-c:a", "pcm_s16le", str(out)])


# --- API ---------------------------------------------------------------------

def transcribe(audio: Path, api_key: str, language: str | None = None,
               model: str = MODEL) -> dict:
    """Transcribe one segment with retries. Returns the response JSON."""
    data = {"model": model, "mode": MODE}
    if language:
        # lock the language: auto-detect misfires on sub-second utterances
        # (e.g. Hindi "अच्छा" coming back in Bengali/Kannada script)
        data["language_code"] = language
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with open(audio, "rb") as f:
                resp = requests.post(
                    API_URL,
                    headers={"api-subscription-key": api_key},
                    files={"file": (audio.name, f, "audio/wav")},
                    data=data,
                    timeout=120,
                )
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 429:
                last_err = f"HTTP 429: {resp.text[:200]}"
                time.sleep(5 * attempt)  # rate limit: back off harder
                continue
            if resp.status_code in (500, 502, 503, 504):
                last_err = f"HTTP {resp.status_code}: {resp.text[:200]}"
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:500]}")
        except requests.RequestException as e:
            last_err = str(e)
            time.sleep(2 ** attempt)
    raise RuntimeError(f"{audio.name} failed after {MAX_RETRIES} retries: {last_err}")


# --- SRT building ------------------------------------------------------------

SENTENCE_SPLIT = re.compile(r"(?<=[।.?!])\s+")
CLAUSE_SPLIT = re.compile(r"(?<=[,;])\s+")

# Hallucinated labels the model emits for non-speech audio (music beds etc.)
JUNK_TRANSCRIPTS = {"music", "[music]", "म्यूजिक", "संगीत", "noise", "[noise]"}


def split_units(text: str) -> list[str]:
    """Break text into the smallest natural units: sentences, then clauses,
    then word-group halves for anything still over MAX_CUE_CHARS."""
    units: list[str] = []
    for sent in SENTENCE_SPLIT.split(text):
        sent = sent.strip()
        if not sent:
            continue
        parts = [sent] if len(sent) <= MAX_CUE_CHARS else CLAUSE_SPLIT.split(sent)
        for part in parts:
            part = part.strip()
            if not part:
                continue
            # word-level fallback: halve until each piece fits
            stack = [part]
            while stack:
                p = stack.pop(0)
                if len(p) <= MAX_CUE_CHARS or " " not in p:
                    units.append(p)
                    continue
                mid = len(p) // 2
                left = p.rfind(" ", 0, mid)
                right = p.find(" ", mid)
                cut = left if left != -1 and (right == -1 or mid - left <= right - mid) else right
                stack = [p[:cut].strip(), p[cut + 1:].strip()] + stack
    return units


def segment_to_cues(start: float, end: float, transcript: str) -> list[dict]:
    """One speech segment -> one or more cues.

    Short segments map 1:1 (timing is exact — straight from the silence
    boundaries). Long transcripts are split into natural units and the
    segment's duration is distributed proportionally by character count.
    """
    text = transcript.strip()
    if not text or text.lower().strip("[].।!?") in JUNK_TRANSCRIPTS:
        return []
    if len(text) <= MAX_CUE_CHARS:
        return [{"start": start, "end": end, "text": text}]

    units = split_units(text)
    # pack units into cue-sized pieces
    pieces, current = [], ""
    for s in units:
        candidate = f"{current} {s}".strip()
        if current and len(candidate) > MAX_CUE_CHARS:
            pieces.append(current)
            current = s
        else:
            current = candidate
    if current:
        pieces.append(current)

    total_chars = sum(len(p) for p in pieces)
    duration = end - start
    cues, cursor = [], start
    for i, piece in enumerate(pieces):
        share = duration * len(piece) / total_chars
        cue_end = end if i == len(pieces) - 1 else cursor + share
        cues.append({"start": cursor, "end": cue_end, "text": piece})
        cursor = cue_end
    return cues


def fmt_srt_time(seconds: float) -> str:
    """SRT timestamp with millisecond precision: HH:MM:SS,mmm"""
    if seconds < 0:
        seconds = 0.0
    ms_total = round(seconds * 1000)
    h, rem = divmod(ms_total, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def wrap_two_lines(text: str, width: int = 42) -> str:
    """Break long cue text into at most 2 balanced lines."""
    if len(text) <= width:
        return text
    mid = len(text) // 2
    left = text.rfind(" ", 0, mid)
    right = text.find(" ", mid)
    cut = left if (left != -1 and (right == -1 or mid - left <= right - mid)) else right
    if cut == -1:
        return text
    return text[:cut] + "\n" + text[cut + 1:]


def write_srt(cues: list[dict], out: Path) -> None:
    # enforce minimum readable duration, then clamp overlaps
    for cue in cues:
        if cue["end"] - cue["start"] < MIN_CUE_DURATION:
            cue["end"] = cue["start"] + MIN_CUE_DURATION
    for a, b in zip(cues, cues[1:]):
        if a["end"] > b["start"]:
            a["end"] = b["start"]

    lines = []
    for i, cue in enumerate(cues, 1):
        lines.append(str(i))
        lines.append(f"{fmt_srt_time(cue['start'])} --> {fmt_srt_time(cue['end'])}")
        lines.append(wrap_two_lines(cue["text"]))
        lines.append("")
    out.write_text("\n".join(lines), encoding="utf-8")


# --- main --------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate ms-accurate same-language SRT via Saaras v3")
    parser.add_argument("video", nargs="?", default=DEFAULT_VIDEO)
    parser.add_argument("-o", "--output", default=None,
                        help="output .srt path (default: <video>.srt)")
    parser.add_argument("--model", default=MODEL,
                        help=f"Sarvam STT model id (default {MODEL}); e.g. "
                             "saaras:v4, saaras:v4-multispk, saarika:v2.5")
    parser.add_argument("--language", default="hi-IN",
                        help="BCP-47 language lock (default hi-IN); "
                             "pass 'unknown' for auto-detect")
    parser.add_argument("--keep-workdir", action="store_true",
                        help="keep the temporary audio segments")
    parser.add_argument("--from-raw", default=None, metavar="RAW_JSON",
                        help="rebuild the SRT from a saved .raw.json "
                             "(no API calls)")
    args = parser.parse_args()

    if args.from_raw:
        raw = json.loads(Path(args.from_raw).read_text(encoding="utf-8"))
        out_srt = Path(args.output) if args.output else \
            Path(args.from_raw).with_suffix("").with_suffix(".srt")
        cues = []
        for entry in raw:
            if entry["response"] is None:
                continue
            cues.extend(segment_to_cues(
                entry["start"], entry["end"],
                entry["response"].get("transcript") or ""))
        write_srt(cues, out_srt)
        print(f"Rebuilt {len(cues)} cues -> {out_srt}")
        return

    video = Path(args.video)
    if not video.exists():
        sys.exit(f"ERROR: video not found: {video}")
    out_srt = Path(args.output) if args.output else video.with_suffix(".srt")

    api_key = load_env_key()
    workdir = Path("_srt_segments")
    workdir.mkdir(exist_ok=True)
    full_wav = workdir / "full_audio.wav"

    print(f"[1/5] Extracting audio from {video.name} ...")
    total = extract_audio(video, full_wav)
    print(f"      duration: {total:.3f}s")

    print("[2/5] Detecting silences / building speech segments ...")
    silences = detect_silences(full_wav)
    segments = build_segments(silences, total)
    speech_time = sum(e - s for s, e in segments)
    print(f"      {len(silences)} silences -> {len(segments)} speech segments "
          f"({speech_time:.0f}s of speech)")

    print("[3/5] Cutting segment WAVs ...")
    seg_files = []
    for i, (s, e) in enumerate(segments):
        p = workdir / f"seg_{i:04d}.wav"
        cut_segment(full_wav, s, e, p)
        seg_files.append(p)

    print(f"[4/5] Transcribing {len(segments)} segments with {args.model} "
          f"mode={MODE} ({MAX_WORKERS} workers) ...")
    results: list[dict | None] = [None] * len(segments)
    done = 0

    language = None if args.language == "unknown" else args.language

    def worker(idx: int):
        nonlocal done
        payload = transcribe(seg_files[idx], api_key, language, args.model)
        results[idx] = payload
        done += 1
        s, e = segments[idx]
        text = (payload.get("transcript") or "").strip()
        if done % 10 == 0 or done == len(segments):
            print(f"      [{done:>3}/{len(segments)}] "
                  f"{s:7.1f}s-{e:7.1f}s  {text[:50]}")

    errors = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = [pool.submit(worker, i) for i in range(len(segments))]
        for fut in futures:
            try:
                fut.result()
            except Exception as e:
                errors.append(str(e))
    for e in errors:
        print(f"      WARNING: {e}")

    # Sequential retry pass for anything that failed (rate-limit stragglers)
    missing = [i for i, r in enumerate(results) if r is None]
    if missing:
        print(f"      retrying {len(missing)} failed segments sequentially ...")
        time.sleep(10)
        for i in missing:
            try:
                results[i] = transcribe(seg_files[i], api_key, language, args.model)
                s, e = segments[i]
                text = (results[i].get("transcript") or "").strip()
                print(f"      [retry ok] {s:7.1f}s-{e:7.1f}s  {text[:50]}")
            except Exception as exc:
                print(f"      [retry FAILED] segment {i}: {exc}")
            time.sleep(2)
    if all(r is None for r in results):
        sys.exit("ERROR: every segment failed — aborting")

    # Save raw responses + segment times for debugging / re-runs
    raw_out = out_srt.with_suffix(".raw.json")
    raw_out.write_text(json.dumps(
        [{"start": s, "end": e, "response": r}
         for (s, e), r in zip(segments, results)],
        ensure_ascii=False, indent=2), encoding="utf-8")

    print("[5/5] Building SRT cues ...")
    cues: list[dict] = []
    for (s, e), payload in zip(segments, results):
        if payload is None:
            continue
        cues.extend(segment_to_cues(s, e, payload.get("transcript") or ""))
    write_srt(cues, out_srt)
    print(f"      {len(cues)} cues written")

    if not args.keep_workdir:
        for p in workdir.glob("*.wav"):
            p.unlink()
        try:
            workdir.rmdir()
        except OSError:
            pass

    print(f"\nDone. SRT: {out_srt}  |  raw responses: {raw_out}")
    if cues:
        print(f"First cue : {fmt_srt_time(cues[0]['start'])} --> "
              f"{fmt_srt_time(cues[0]['end'])}  {cues[0]['text'][:60]}")
        print(f"Last cue  : {fmt_srt_time(cues[-1]['start'])} --> "
              f"{fmt_srt_time(cues[-1]['end'])}  {cues[-1]['text'][:60]}")


if __name__ == "__main__":
    main()
