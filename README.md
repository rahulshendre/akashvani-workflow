# Akashvani Workflow

A desktop app for Windows and for Macs with Apple silicon that runs PlanetRead's video subtitling pipeline: it copies and
compresses episode footage, uploads it to Google Drive, generates subtitles from the
audio, hands them to Language Experts on other machines for review, and converts the
finished subtitles to Roman script.

It ships as a single `.exe` (a `.dmg` on the Mac) — a Node backend with a React frontend bundled inside,
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
| **Node 20** | `pkg` targets `node20-win-x64` and `node20-macos-arm64`; other majors produce a broken binary |
| **Windows x64** | Required to *build* the installer. Dev also runs on other platforms, but the bundled FFmpeg and Inno Setup are Windows-only |
| **Apple silicon Mac** | Required to *build* the Mac app. It uses `osacompile`, `codesign` and `hdiutil`, which ship with macOS. Built for macOS 13 or newer, tested on 15 |
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

### Smoke tests for the built Mac app

`npm test` checks the code. These check the **built app**, the way an editor would run it, on a
throwaway home folder so nothing touches your own data:

```bash
npm run build:mac:app -- --no-keys   # or the full npm run build:mac first
npm run test:smoke                   # about 3 minutes
```

They cover first launch and the storage choice, copy and compress with the FFmpeg inside the app,
Stop and resume, the whole Google Drive flow, automatic subtitles, the `.app` and the disk image
(signature, architecture, linked libraries), and the screens in a real browser. The browser tests
walk the full workflow: an editor on one Mac and Language Experts on another.

Nothing here needs a Google account. `scripts/smoke/fake-google.mjs` stands in for Google (the app
is pointed at it through `HTTPS_PROXY`), and the browser tests run this repo's own `fly-service/`
against a temporary PostgreSQL. The one real service is Sarvam, for the subtitle tests.

What is needed on the Mac running them:

| | for |
|---|---|
| the built app in `dist-mac/` | everything |
| `ffmpeg` and `ffprobe` on PATH | making test videos and inspecting results (the app uses its own) |
| Google Chrome | the browser tests |
| PostgreSQL server programs (`brew install postgresql@14`) and `npm ci` in `fly-service/` | the browser tests |
| `SARVAM_API_KEY` in `server/.env`, and the macOS `say` command | the subtitle tests, which spend a little Sarvam credit |

A suite whose requirement is missing is skipped with the reason. `SMOKE_LAUNCHER=1` also runs the
test that starts the app the way a double-click does (it opens your browser once),
`SMOKE_SCREENSHOTS=<folder>` saves screenshots from the browser tests, and `AKASHVANI_BIN` points the
tests at a different server binary.

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

## Building the Mac app

On an Apple silicon Mac with Node 20:

```bash
npm install
npm run build:mac
```

That runs the frontend build, downloads a static arm64 FFmpeg, bundles the watermark,
builds the server with `pkg` for `node20-macos-arm64`, and assembles the app. The
result is `dist-mac/Akashvani Workflow.app` and `dist-mac/AkashvaniWorkflow.dmg`.

The app is a small AppleScript launcher (`installer/mac/launcher.applescript`) around the
same server the Windows exe runs. It gives the editor a Dock icon, Quit (Cmd+Q), and
reopens the page when the app is clicked again. Inside the bundle, the server sits in
`Contents/Resources/server/` with the same layout as the Windows install folder, so
`server/paths.js` finds the frontend, FFmpeg and watermark next to the binary on both
platforms.

**FFmpeg.** `scripts/fetch-ffmpeg-mac.mjs` downloads the static build from osxexperts.net.
The URLs are not versioned, so the zips are pinned by SHA-256. If the build changes, the
script stops and tells you; check the new build and update the hashes in the script.
Homebrew's FFmpeg is not an alternative: it loads dylibs other Macs do not have.

**Keys.** They are read from `server/.env` only, and written to `config.defaults.env`
inside the app. The environment is ignored unless you pass `--from-env`
(`node scripts/build-mac-app.mjs --from-env`), because variables such as
`ANTHROPIC_API_KEY` are often exported for other tools and a key picked up that way
would end up in an app you hand to someone else. The build prints which keys it found,
masked. On every launch the app copies any baked-in key into a blank slot of the user's
`config.env`, and never overwrites a value somebody typed.

**Signing.** The app is signed ad hoc, not with an Apple Developer ID, so it is not
notarised. macOS blocks it the first time; the editor opens System Settings, Privacy &
Security, and chooses Open Anyway (the steps are in `installer/mac/First-run-setup-mac.txt`,
which is also in the disk image). With a Developer ID, replace the `codesign --sign -`
call in `scripts/build-mac-app.mjs` and add notarisation.

The server binary is arm64 only. On an Intel Mac the app says so and does not start.

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

| | Packaged (Windows) | Packaged (macOS) | Dev |
|---|---|---|---|
| Episode data | the drive the editor picks on first run, else `Documents\Akashvani Workflow` | the home folder or a disk the editor picks on first run, else `~/Documents/Akashvani Workflow` | `server/` |
| Logs | `%LOCALAPPDATA%\Akashvani Workflow\logs\` | `~/Library/Logs/Akashvani Workflow/` | `logs/` |
| Config | `config.env` next to the exe | `~/Library/Application Support/Akashvani Workflow/config.env` | `server/.env` |

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
