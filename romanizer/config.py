"""Every tunable value in the romanizer, in one place.

Nothing here imports the rest of the package, so any module can read config
without a circular import.
"""
from __future__ import annotations

import os
import re

# ─────────────────────────────────────────────────────────────────────────────
# Model
# ─────────────────────────────────────────────────────────────────────────────
# claude-opus-4-8: Anthropic's most capable Opus-tier model. Transliteration is
# mechanical and format-sensitive, so we run with adaptive thinking off (omit it)
# and low effort — fast, cheap, and less likely to "overthink" the line format.
MODEL = "claude-opus-4-8"
BATCH_SIZE = 40          # lines per API call — small enough to keep 1:1 alignment

# effort is an optimisation; dropped automatically on an SDK that doesn't know it
MODEL_EXTRA = {"output_config": {"effort": "low"}}

# Anthropic occasionally returns "Overloaded" (HTTP 529) or rate-limits (429).
# These can arrive mid-stream, where the SDK does NOT auto-retry, so a batch is
# retried with exponential backoff — but only on transient errors, never on a 4xx
# like bad-request or auth (retrying those is pointless).
RETRYABLE_STATUS = {408, 409, 429, 500, 502, 503, 504, 529}
MAX_ATTEMPTS = 6         # initial try + 5 retries (~1.5+3+6+12+24s max backoff)
BASE_RETRY_DELAY = 1.5   # seconds, doubled each retry

# ─────────────────────────────────────────────────────────────────────────────
# Pricing — Opus 4.8, US dollars per MILLION tokens
# ─────────────────────────────────────────────────────────────────────────────
# Update these whenever Anthropic's rates change; everything downstream reads
# them, so the usage log recosts automatically.
#
# Cached system-prompt tokens are NOT billed at the input rate: a cache write
# costs 1.25x and a cache read 0.1x. Ignoring that would overstate the bill,
# because the prompt is re-sent on every batch and read from cache almost every
# time.
PRICE_INPUT_PER_MTOK = 5.00
PRICE_OUTPUT_PER_MTOK = 25.00
CACHE_WRITE_MULTIPLIER = 1.25
CACHE_READ_MULTIPLIER = 0.10

# Where per-run usage is appended. Override with ROMANIZE_USAGE_LOG to point at
# persistent storage — on Streamlit Community Cloud the default path is wiped on
# every restart, which would silently lose the history.
USAGE_LOG_PATH = os.environ.get("ROMANIZE_USAGE_LOG") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "usage_log.csv")

# ─────────────────────────────────────────────────────────────────────────────
# Languages — dropdown label -> script hint injected into the system prompt
# ─────────────────────────────────────────────────────────────────────────────
LANGUAGES = {
    "Hindi":    "Hindi, written in the Devanagari script",
    "Bengali":  "Bengali, written in the Bengali (Bangla) script",
    "Punjabi":  "Punjabi, written in the Gurmukhi script",
    "Marathi":  "Marathi, written in the Devanagari script",
    "Tamil":    "Tamil, written in the Tamil script",
    "Telugu":   "Telugu, written in the Telugu script",
    "Kannada":  "Kannada, written in the Kannada script",
    "Gujarati": "Gujarati, written in the Gujarati script",
    "Malayalam": "Malayalam, written in the Malayalam script",
    "Odia":     "Odia, written in the Odia (Oriya) script",
}

# ─────────────────────────────────────────────────────────────────────────────
# Dictionary sources — one Google Doc per language
# ─────────────────────────────────────────────────────────────────────────────
# There are deliberately NO URLs in this file.
#
# A Google Doc shared as "Anyone with the link" makes the LINK ITSELF the
# credential: anyone holding it can read the dictionary. Committing one to the
# repo would publish PlanetRead's dictionary to everyone who can see the code.
# So each language's doc is supplied at runtime as configuration:
#
#   locally         .env            DICTIONARY_DOC_URL_HINDI=https://...
#   Streamlit Cloud Settings → Secrets   DICTIONARY_DOC_URL_HINDI = "https://..."
#
# The variable name is DICTIONARY_DOC_URL_<LANGUAGE IN CAPS>; see
# DictionarySource.env_var_for(). A language with nothing set simply has no
# dictionary yet — the app says so and offers the manual upload override rather
# than silently loading another language's doc.
#
# DICTIONARY_DOC_URL (no language suffix) points every language at one doc, which
# is only useful for testing.

# How long a downloaded copy is reused before being re-fetched. Short enough that
# an expert's edit shows up on its own within minutes; the Reload button skips
# the wait entirely.
DICT_CACHE_TTL = 600          # seconds

# ─────────────────────────────────────────────────────────────────────────────
# Romanization cache (same file + language -> no second API call)
# ─────────────────────────────────────────────────────────────────────────────
# Bump when the prompt/parsing logic changes so old results aren't reused.
CACHE_VERSION = "v2"

# Override with ROMANIZE_CACHE_DIR to point at persistent storage (e.g. a mounted
# volume). On Streamlit Community Cloud the default dir is ephemeral — it works
# while the app is awake but is wiped on every reboot/redeploy.
CACHE_DIR = os.environ.get("ROMANIZE_CACHE_DIR") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".romanize_cache")

# ─────────────────────────────────────────────────────────────────────────────
# Correction tiers
# ─────────────────────────────────────────────────────────────────────────────
# exact   : confirmed dictionary correction        -> yellow highlight
# fix     : engine fix, higher confidence (review) -> green  highlight
# suggest : engine guess, lower confidence (review)-> cyan   highlight
TIER_HL = {"exact": "yellow", "fix": "green", "suggest": "cyan"}

FIX_CUTOFF = 0.75       # >= this -> "fix" tier (green). below -> "suggest"
SUGGEST_FLOOR = 0.60    # below this -> ignore entirely (the 0.50-0.60 band was
                        # ~50% accurate — a coin flip — so we don't show it)

# ─────────────────────────────────────────────────────────────────────────────
# Scripts
# ─────────────────────────────────────────────────────────────────────────────
# Native-script detection for the dictionary's 4th column, and the word-boundary
# class for pre-substitution. Both deliberately span EVERY Indic block the app
# supports — Devanagari (U+0900) through Malayalam (U+0D7F), covering Bengali,
# Gurmukhi, Gujarati, Odia, Tamil, Telugu and Kannada in between. This was once
# Devanagari-only, which silently dropped every native word in a non-Devanagari
# dictionary (a Tamil dictionary's whole column was lost).
INDIC_CHARS = "ऀ-ൿ"
INDIC_RE = re.compile("[" + INDIC_CHARS + "]")

# ── Temporary stitch (bucket A) ──────────────────────────────────────────────
# These Hindi words have CONTRADICTORY rows in the dictionary — two different
# PlanetRead spellings for the same word — so the output otherwise depends on
# which row happens to come last. We pin ONE spelling here; whenever the word
# appears in the source it is pre-substituted to this exact form and locked, so
# no later (and possibly conflicting) rule can change it.
#
# Picks follow PlanetRead's long-vowel convention (आ→aa, ऊ→oo, ई→ee) and should
# be confirmed by the language expert — just edit the value to re-pin a word.
HINDI_FORCE = {
    "निकाल": "nikaal",          # vs निकल -> nikal (kept distinct)
    "राज्य": "raajya",
    "माँ": "maa",
    "ऊपर": "oopar",
    "हमारे": "hamaare",
    "आवाज़": "Aawaaz",
    "भलाई": "bhalaai",
    "महत्वपूर्ण": "mahatvapoorn",
    "कर्तव्य": "kartavya",
    "महज़": "mehaz",
    "बजाऊँ": "bajaoon",
    "शासन": "shaasan",
}

# regex for an SRT timecode line: 00:00:01,200 --> 00:00:04,000
TIMECODE_RE = re.compile(
    r'\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}'
)
