# Akashvani Workflow

A Windows desktop app that runs PlanetRead's video subtitling pipeline: it copies and
compresses episode footage, uploads it to Google Drive, generates subtitles from the
audio, hands them to Language Experts on other machines for review, and converts the
finished subtitles to Roman script.

It ships as a single `.exe` — a Node backend with a React frontend bundled inside,
plus FFmpeg. Editors install it and never see a terminal.

---

## How it fits together

```
React + Vite frontend ──┐
                        ├── Express on localhost:3001 ── FFmpeg (bundled)
   served by Express ───┘          │                  ── Google Drive API
   in the packaged .exe            │                  ── Sarvam (speech → text)
                                   │                  ── Claude  (Roman script)
                                   │
                        akashvani-session on Fly.io
                        (session metadata only — no media ever leaves the machine)
```

The Fly service exists so an Editor and a Language Expert on **different machines**
can work on the same episode: it stores which steps are done and where the Drive
folder is, keyed by a short `AK-XXXX` code. Video and subtitles go through Google
Drive, never through it.

---

## Prerequisites

| | |
|---|---|
| **Node 20** | `pkg` targets `node20-win-x64`; other majors produce a broken exe |
| **Windows x64** | Required to *build* the installer. Dev also runs on other platforms, but the bundled FFmpeg and Inno Setup are Windows-only |
| **Inno Setup 6** | Only to build the installer — <https://jrsoftware.org/isinfo.php> (free) |
| **A Google Cloud project** | For Drive access (below) |

FFmpeg is downloaded automatically by the build; you don't install it yourself.

---

## 1. Clone and install

```bash
git clone https://github.com/abinash-sketch/akashvani-workflow.git
cd akashvani-workflow
npm install
```

## 2. Create `server/.env`

This file is gitignored and holds every credential. Create it with:

```ini
# ── Google Drive ────────────────────────────────────────────────────────────
GOOGLE_CLIENT_ID=<your client id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your client secret>
GOOGLE_REDIRECT_URI=http://localhost:3001/api/auth/google/callback

# ── Automatic subtitles ─────────────────────────────────────────────────────
SARVAM_API_KEY=<key from dashboard.sarvam.ai>

# ── Roman script ────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=<key from console.anthropic.com>

PORT=3001
```

### Setting up the Google project

1. <https://console.cloud.google.com/> → create a project
2. Enable the **Google Drive API**
3. APIs & Services → Credentials → **OAuth 2.0 Client ID** → *Web application*
4. Authorised redirect URI, **exactly**: `http://localhost:3001/api/auth/google/callback`
5. Add your editors as test users (or publish the consent screen)

The app requests the **full `drive` scope**, not `drive.file`. This is deliberate and
cannot be narrowed: editors pick an *existing* Drive folder as the destination, and
`drive.file` only grants access to files the app itself created — so it could neither
list their folders nor upload into one.

### Optional: romanization dictionaries

PlanetRead's agreed spellings live in one Google Doc per language. Add them here to
pre-set every machine, or let each editor paste the link in the app:

```ini
DICTIONARY_DOC_URL_HINDI=https://docs.google.com/document/d/…
DICTIONARY_DOC_URL_TAMIL=…
```

The docs are read through the signed-in Google account, so they do **not** need to be
shared publicly — share them with that account and nothing more.

## 3. Run it

```bash
npm run dev:full
```

Frontend on <http://localhost:8080>, backend on `:3001`, with Vite proxying `/api`.
Run them separately with `npm run dev` and `npm run dev:server` if you prefer.

## 4. Checks

```bash
npm test           # vitest — 103 tests, no network calls
npm run typecheck  # tsc against tsconfig.app.json
npm run lint
```

> Use `npm run typecheck`, not a bare `npx tsc --noEmit`. The root `tsconfig.json` is a
> solution file (`"files": []` plus project references), so the bare command type-checks
> **zero files** and exits 0 — a green tick that means nothing.

---

## Building the installer

```bash
npm run build:installer        # frontend + FFmpeg + resources + Akashvani.exe
npm run build:installer:setup  # Inno Setup → dist-installer/AkashvaniSetup.exe
```

The API keys are read from the environment, falling back to `server/.env`, and baked
into the installer as compile-time defines — they are never written into any tracked
file. The build prints which keys it found, masked:

```
SARVAM_API_KEY: ********uuSt (from server\.env) — baked into the installer
ANTHROPIC_API_KEY: ********ZgAA (from server\.env) — baked into the installer
```

A missing key is a loud warning, not an error: the installer still builds, that feature
is just off until someone edits `config.env` on the machine.

On install, the keys are written into `config.env` next to the exe. That file is
installed with `onlyifdoesntexist` to protect each office's own Drive and watermark
settings, so the installer fills in **blank** values only — anything typed by hand is
left alone. This is also what reaches machines that already have the app.

The installer is **unsigned**, so SmartScreen warns and machines with Application
Control will block it.

---

## The session sync service (optional)

Only needed for cross-machine collaboration. Without it the app still works for a
single editor; sessions just can't be shared.

```bash
cd fly-service
flyctl launch --no-deploy        # or `flyctl deploy` against the existing app
flyctl postgres create
flyctl postgres attach <db-name> # sets DATABASE_URL
flyctl deploy
```

`DATABASE_URL` is the only variable it needs. Tables are created on boot
(`CREATE TABLE IF NOT EXISTS`), so there is no migration step.

> **If you deploy your own**, change `SYNC_BASE` at the top of
> [`src/lib/session-sync.ts`](src/lib/session-sync.ts) — it is hardcoded to
> `https://akashvani-session.fly.dev` and the frontend will otherwise talk to the
> original deployment.

The VM is 256 MB. That is enough for this workload, but it has run out of memory once,
when a render loop created ~10 sessions per second.

---

## Where things live at runtime

| | Packaged | Dev |
|---|---|---|
| Episode data | the drive the editor picks on first run, else `Documents\Akashvani Workflow` | `server/` |
| Logs | `%LOCALAPPDATA%\Akashvani Workflow\logs\` | `logs/` |
| Config | `config.env` next to the exe | `server/.env` |

Logs are deliberately **not** on the user-chosen data drive: that varies per machine and
may be missing, and supporting several offices remotely needs one path that is the same
everywhere.

`akashvani.log` holds a startup banner (build, machine, paths), every upload failure
with the Drive folder it was aimed at, and any uncaught exception. `install.log` is the
Inno Setup log, copied into the same folder so support only ever asks for one place.

---

## The pipeline

13 steps, defined in [`src/lib/pipeline.ts`](src/lib/pipeline.ts):

| Step | What runs it |
|---|---|
| Copy videos into the workspace | backend |
| Compress and add the watermark | backend (FFmpeg, 2-pass optional) |
| Upload the videos to Google Drive | backend |
| Generate the AI subtitles | backend — Sarvam |
| Language Expert review — first pass | LE 1 uploads a corrected Word file |
| Align the subtitles in Premiere Pro | auto-completes with LE 1's upload |
| Add the Premiere Pro project file | editor uploads |
| Turn the Word file back into subtitles | *simulated* |
| Final quality check | editor marks done |
| Language Expert review — final pass | LE 3 uploads the final `.srt` |
| SLS / SLC | *simulated* |
| Convert to Roman script | backend — Claude + the dictionary |

**Three steps are still simulations** — SLS, SLC and Word-to-SRT tick themselves off
without doing work. They are placeholders, not bugs, and are the main thing left to
build.

### How subtitle generation works

Sarvam's real-time endpoint returns only utterance-level timing, so cue boundaries are
taken from **silences detected by FFmpeg** instead: the audio is cut at the pauses, each
speech segment is transcribed on its own, and the segment's measured start/end becomes
the cue timing. Timings are therefore measured, not inferred.

### How Roman script works

Punctuation is normalised deterministically, the dictionary's confirmed spellings are
written in and *locked* (the dictionary holds contradictory pairs — only the original
script says which is right), then Claude transliterates the text. Timecodes never leave
[`srt.js`](server/services/romanize/srt.js).

Two failure modes are handled explicitly, both found the hard way: a safety refusal
causes the batch to be **halved recursively** (a 40-line batch refused 3/3 times, its
halves passed immediately), and a reply still containing Indic letters is **rejected**
rather than shipped — that one looks exactly like success.

---

## Repository layout

```
server/              Express backend
  routes/            pipeline, auth, drive, setup, upload
  services/          compress, gdrive, transcribe (Sarvam), sessionState, logger
    romanize/        the Roman-script port — srt, dictionary, claude, …
src/                 React frontend (Vite, shadcn/ui, Tailwind)
  test/              vitest suites
fly-service/         session sync API (Express + Postgres)
installer/           Inno Setup script and config.env template
scripts/             FFmpeg fetch, resource bundling, installer build
romanizer/           the original Python/Streamlit prototype, kept for reference
test-sarvam-models/  the Sarvam prototype scripts
```

`romanizer/` and `test-sarvam-models/` are **not** used at runtime. They are the
prototypes the Node ports were derived from, kept because the constants in them were
tuned against real episodes — see `scripts/verify-transcribe-port.mjs`, which checks the
ported cue logic against the prototype's own output.
