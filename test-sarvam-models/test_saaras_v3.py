"""
Test script for Sarvam Saaras v3 speech-to-text (same-language transcription).

Extracts a 30s audio sample from the input video and transcribes it with
mode="transcribe", which keeps the output in the ORIGINAL spoken language
(Hindi audio -> Hindi text). Prints the transcript, detected language,
latency, and whether word-level timestamps came back.

Usage:
    python test_saaras_v3.py [input_video] [--start 60]

Requires: ffmpeg on PATH, `requests`, SARVAM_API_KEY in .env
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

# Windows consoles default to cp1252, which can't print Devanagari
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

API_URL = "https://api.sarvam.ai/speech-to-text"
MODEL = "saaras:v3"
MODE = "transcribe"  # same-language output: Hindi audio -> Hindi text

DEFAULT_VIDEO = "Zewar Ka Dibba (Edited)Watermark_first10min.mp4"


def load_env_key(env_path: Path = Path(".env")) -> str:
    """Tiny .env parser — avoids a python-dotenv dependency."""
    key = os.environ.get("SARVAM_API_KEY")
    if key:
        return key.strip()
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("SARVAM_API_KEY"):
                return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("ERROR: SARVAM_API_KEY not found in environment or .env")


def extract_sample(video: Path, start: float, duration: float, out: Path) -> Path:
    """Extract a mono 16 kHz WAV sample (Saaras works best at 16 kHz)."""
    cmd = [
        "ffmpeg", "-y", "-ss", str(start), "-i", str(video),
        "-t", str(duration), "-vn", "-ac", "1", "-ar", "16000",
        "-c:a", "pcm_s16le", str(out),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"ffmpeg failed:\n{res.stderr[-2000:]}")
    return out


def call_saaras(audio_path: Path, api_key: str,
                with_timestamps: bool = True) -> tuple[dict, float]:
    """POST one audio file to the Saaras v3 REST endpoint."""
    data = {"model": MODEL, "mode": MODE}
    if with_timestamps:
        data["with_timestamps"] = "true"
    with open(audio_path, "rb") as f:
        files = {"file": (audio_path.name, f, "audio/wav")}
        t0 = time.perf_counter()
        resp = requests.post(
            API_URL,
            headers={"api-subscription-key": api_key},
            files=files,
            data=data,
            timeout=120,
        )
        elapsed = time.perf_counter() - t0

    if resp.status_code != 200:
        # Retry once without with_timestamps in case the param is rejected
        if with_timestamps and resp.status_code == 400:
            print(f"  400 with with_timestamps=true, retrying without it... "
                  f"({resp.text[:200]})")
            return call_saaras(audio_path, api_key, with_timestamps=False)
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:500]}")
    return resp.json(), elapsed


def summarize_timestamps(payload: dict) -> str:
    ts = payload.get("timestamps")
    if not ts or not ts.get("words"):
        return "no word timestamps in response"
    words = ts["words"]
    starts = ts.get("start_time_seconds", [])
    ends = ts.get("end_time_seconds", [])
    first = f"{words[0]!r} @ {starts[0]:.3f}s" if starts else words[0]
    last = f"{words[-1]!r} @ {ends[-1]:.3f}s" if ends else words[-1]
    return f"{len(words)} words with timestamps (first: {first}, last: {last})"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Test Saaras v3 same-language transcription")
    parser.add_argument("video", nargs="?", default=DEFAULT_VIDEO)
    parser.add_argument("--start", type=float, default=60.0,
                        help="offset (s) in the video to sample from")
    parser.add_argument("--duration", type=float, default=29.5,
                        help="sample length (s), must be <= 30")
    args = parser.parse_args()

    video = Path(args.video)
    if not video.exists():
        sys.exit(f"ERROR: video not found: {video}")

    api_key = load_env_key()
    sample = Path("sample_30s.wav")
    print(f"Extracting {args.duration}s sample from {video.name} @ {args.start}s ...")
    extract_sample(video, args.start, args.duration, sample)
    print(f"Sample ready: {sample} ({sample.stat().st_size / 1024:.0f} KiB)\n")

    print(f"=== model: {MODEL}  mode: {MODE} (same-language) ===")
    try:
        payload, elapsed = call_saaras(sample, api_key)
    except Exception as e:
        sys.exit(f"FAILED: {e}")

    print(f"  latency        : {elapsed:.2f}s")
    print(f"  language_code  : {payload.get('language_code')}"
          f" (p={payload.get('language_probability')})")
    print(f"  timestamps     : {summarize_timestamps(payload)}")
    print(f"  transcript     : {payload.get('transcript', '')}\n")

    out = Path("test_results_saaras_v3.json")
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    print(f"Full raw response saved to {out}")


if __name__ == "__main__":
    main()
