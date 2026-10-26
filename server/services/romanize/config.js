/**
 * Every tunable value for romanization, in one place.
 *
 * Ported from the PlanetRead Romanizer prototype (romanizer/config.py). The
 * numbers here were tuned against real episodes — treat them as measurements,
 * not preferences, and re-check a real file before changing any of them.
 */

// ── Model ───────────────────────────────────────────────────────────────────
// Transliteration is mechanical and format-sensitive, so it runs at LOW effort:
// fast, cheap, and less likely to "overthink" the strict line format. The
// prototype pinned Opus 4.8; Opus 5.5 is the current Opus and costs less
// ($4/$20 vs $5/$25 per Mtok). Thinking cannot be turned off on 5.5, so low
// effort is the lever that keeps this cheap.
export const MODEL = (process.env.ROMANIZE_MODEL || 'claude-opus-5-5').trim();
export const EFFORT = (process.env.ROMANIZE_EFFORT || 'low').trim();

/** Lines per API call — small enough to keep the 1:1 numbering alignment. */
export const BATCH_SIZE = 40;

/**
 * Anthropic can answer "Overloaded" (529) or rate-limit (429), sometimes
 * mid-stream where the SDK does NOT auto-retry. Retry those; never retry a 4xx
 * like bad-request or auth, where retrying is pointless.
 */
export const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
export const MAX_ATTEMPTS = 6;      // initial try + 5 retries
export const BASE_RETRY_DELAY = 1500; // ms, doubled each retry

// ── Languages — label → the script hint injected into the system prompt ─────
export const LANGUAGES = {
  Hindi: 'Hindi, written in the Devanagari script',
  Bengali: 'Bengali, written in the Bengali (Bangla) script',
  Punjabi: 'Punjabi, written in the Gurmukhi script',
  Marathi: 'Marathi, written in the Devanagari script',
  Tamil: 'Tamil, written in the Tamil script',
  Telugu: 'Telugu, written in the Telugu script',
  Kannada: 'Kannada, written in the Kannada script',
  Gujarati: 'Gujarati, written in the Gujarati script',
  Malayalam: 'Malayalam, written in the Malayalam script',
  Odia: 'Odia, written in the Odia (Oriya) script',
};

export const DEFAULT_LANGUAGE = 'Hindi';

/** How long a downloaded dictionary is reused before being re-fetched. */
export const DICT_CACHE_TTL_MS = 600 * 1000;

/** Bump when the prompt or parsing changes, so old results aren't reused. */
export const CACHE_VERSION = 'v2';

// ── Scripts ─────────────────────────────────────────────────────────────────
/**
 * Spans EVERY Indic block the app supports — Devanagari (U+0900) through
 * Malayalam (U+0D7F), covering Bengali, Gurmukhi, Gujarati, Odia, Tamil,
 * Telugu and Kannada in between.
 *
 * This was once Devanagari-only, which silently dropped every native word in a
 * non-Devanagari dictionary — a Tamil dictionary lost its whole column.
 */
export const INDIC_CHARS = 'ऀ-ൿ';
export const INDIC_RE = new RegExp(`[${INDIC_CHARS}]`);

/**
 * Hindi words with CONTRADICTORY rows in the dictionary — two different
 * PlanetRead spellings for the same word — so the output would otherwise depend
 * on which row happened to come last. One spelling is pinned here; whenever the
 * word appears in the source it is pre-substituted to this exact form and
 * locked, so no later rule can change it.
 *
 * Picks follow PlanetRead's long-vowel convention (आ→aa, ऊ→oo, ई→ee).
 */
export const HINDI_FORCE = {
  'निकाल': 'nikaal',          // vs निकल → nikal (kept distinct)
  'राज्य': 'raajya',
  'माँ': 'maa',
  'ऊपर': 'oopar',
  'हमारे': 'hamaare',
  'आवाज़': 'Aawaaz',
  'भलाई': 'bhalaai',
  'महत्वपूर्ण': 'mahatvapoorn',
  'कर्तव्य': 'kartavya',
  'महज़': 'mehaz',
  'बजाऊँ': 'bajaoon',
  'शासन': 'shaasan',
};

/** An SRT timecode line: 00:00:01,200 --> 00:00:04,000 */
export const TIMECODE_RE =
  /\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}/g;

export function isTranslationConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY || '').trim();
}
