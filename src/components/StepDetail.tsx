import { useState, useRef, useEffect } from 'react';
import { Check, Hand, Loader2, Clock, ListOrdered, Upload, FileText, Share2, Copy, Sparkles, Languages } from 'lucide-react';
import { PipelineStep, formatTime, STEPS_CONFIG } from '@/lib/pipeline';
import {
  uploadSourceSrt, uploadPrproj, uploadLE1Word, uploadLE3Srt,
  transcribeEpisode, fetchTranscribeStatus,
  romanizeEpisode, fetchRomanizeStatus, setDictionaryLink, checkDictionary,
  DriveContext, DriveUploadError, TranscribeStatus, TranscribeResult,
  RomanizeStatus, RomanizeResult, DictionaryInfo, DictionaryCheck,
} from '@/lib/api';

// Which LE role owns each step (used to show correct view to editor vs LE)
const LE_STEP_OWNERS: Record<string, { label: string }> = {
  'review-pass1': { label: 'LE 1' },
  'align-srt':    { label: 'LE 1' },
  // Final quality check is the editor's own sign-off now that the LE 2 pass is
  // gone, so it is deliberately absent here — no LE owns it.
  'review-pass3': { label: 'LE 3' },
};

// ---------------------------------------------------------------------------
// Reusable upload block used by manual file-upload steps
// ---------------------------------------------------------------------------
interface ManualFileUploadProps {
  accept: string;
  chooseLabel: string;
  uploadLabel: string;
  hint: React.ReactNode;
  onUpload: (file: File) => Promise<void>;
}

function ManualFileUpload({ accept, chooseLabel, uploadLabel, hint, onUpload }: ManualFileUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        className="flex items-center gap-2 px-4 py-2 rounded-md border border-border bg-muted/40 hover:bg-muted text-sm transition-colors"
      >
        <FileText className="h-4 w-4 text-muted-foreground" />
        {file ? file.name : chooseLabel}
      </button>
      {file && (
        <button
          disabled={uploading}
          onClick={async () => {
            setUploading(true);
            setError(null);
            setAuthUrl(null);
            try {
              await onUpload(file);
            } catch (err) {
              // A Drive failure must never look like success — the next
              // reviewer picks this file up from Drive, not from this machine.
              if (err instanceof DriveUploadError) {
                setError(err.message);
                setAuthUrl(err.authUrl);
              } else {
                setError(err instanceof Error ? err.message : 'Upload failed');
              }
            } finally {
              setUploading(false);
            }
          }}
          className="flex items-center gap-2 px-5 py-2.5 rounded-md bg-success text-success-foreground hover:bg-success/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-semibold"
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {uploading ? 'Uploading…' : uploadLabel}
        </button>
      )}
      {error && (
        <div className="space-y-2">
          <p className="text-xs text-destructive">{error}</p>
          {authUrl && (
            <a
              href={authUrl}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              Connect Google Drive
            </a>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground leading-relaxed">{hint}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI subtitles: generated in-app from the episode's own audio
// ---------------------------------------------------------------------------
interface SubtitleGenerationPanelProps {
  sessionId: string | null;
  drive?: DriveContext;
  /** Live progress from the backend, so an unattended run is visible here too. */
  progress: number;
  onDone: () => void;
}

/**
 * Replaces the old round trip to an outside transcription tool. The usual path
 * is that the unattended run already did this and the step ticked itself off;
 * this panel is what the editor sees when it did not — no key at the time, Drive
 * authorised late, the API down, or they are resuming a stopped episode.
 *
 * The manual .srt upload stays available underneath. It is the only way through
 * if the service is unreachable, and losing a day's work to a third-party outage
 * is not an acceptable failure mode.
 */
function SubtitleGenerationPanel({ sessionId, drive, progress, onDone }: SubtitleGenerationPanelProps) {
  const [status, setStatus] = useState<TranscribeStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [result, setResult] = useState<TranscribeResult | null>(null);

  useEffect(() => { fetchTranscribeStatus().then(setStatus); }, []);

  // The backend run reports progress on this step, so a bar already moving
  // means subtitles are being generated right now and a second Generate would
  // duplicate the work — and the API spend.
  const backendBusy = !running && progress > 0 && progress < 100;

  async function generate() {
    setRunning(true);
    setError(null);
    setAuthUrl(null);
    try {
      setResult(await transcribeEpisode(sessionId ?? '', drive));
      onDone();
    } catch (err) {
      if (err instanceof DriveUploadError) {
        setError(err.message);
        setAuthUrl(err.authUrl);
      } else {
        setError(err instanceof Error ? err.message : 'Subtitle generation failed');
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mt-4 space-y-4">
      {backendBusy ? (
        <div className="flex items-center gap-2 text-sm text-primary">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Generating subtitles from the episode audio… {Math.round(progress)}%</span>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm text-warning">
            <Hand className="h-4 w-4" />
            <span>Subtitles not generated yet</span>
          </div>

          {status?.configured === false ? (
            <p className="text-xs text-muted-foreground leading-relaxed">
              Automatic subtitles are switched off on this computer — no{' '}
              <code className="font-mono">SARVAM_API_KEY</code> in{' '}
              <code className="font-mono">config.env</code>. Upload an{' '}
              <code className="font-mono">.srt</code> below instead, or ask whoever set the app
              up to add the key and restart it.
            </p>
          ) : (
            <>
              <button
                type="button"
                disabled={running}
                onClick={generate}
                className="flex items-center gap-2 px-5 py-2.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-semibold"
              >
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {running
                  ? `Generating… ${progress > 0 ? `${Math.round(progress)}%` : 'this takes a few minutes'}`
                  : 'Generate subtitles'}
              </button>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Transcribes this episode's own audio{status?.model ? ` with ${status.model}` : ''} and
                writes the subtitles in the spoken language — no separate transcription tool, no
                downloading and re-uploading. The <strong>.srt</strong> and a{' '}
                <strong>Word document</strong> copy are both saved to the{' '}
                <strong>AI Subtitles</strong> folder on Drive; the Word file is the one LE 1 corrects.
                Expect a few minutes for a full episode — you can leave this page open.
              </p>
            </>
          )}
        </>
      )}

      {result && (
        <p className="text-xs text-success">
          Done — {result.files.map(f => `${f.srt} (${f.cues} cues)`).join(', ')}
        </p>
      )}

      {error && (
        <div className="space-y-2">
          <p className="text-xs text-destructive">{error}</p>
          {authUrl && (
            <a
              href={authUrl}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              Connect Google Drive
            </a>
          )}
        </div>
      )}

      {!backendBusy && (
        <details className="border-t border-border pt-3">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            Or upload an .srt yourself
          </summary>
          <div className="mt-3">
            <ManualFileUpload
              accept=".srt"
              chooseLabel="Choose .srt file…"
              uploadLabel="Upload SRT"
              hint={
                <>
                  Use this if you already have subtitles for this episode, or if automatic
                  generation is unavailable. The <strong>.srt</strong> and a{' '}
                  <strong>Word document</strong> copy are saved to the{' '}
                  <strong>AI Subtitles</strong> folder.
                </>
              }
              onUpload={async (file) => {
                await uploadSourceSrt(sessionId ?? '', file, drive);
                onDone();
              }}
            />
          </div>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roman script: transliterate the final subtitles, correcting against the
// experts' dictionary
// ---------------------------------------------------------------------------
interface RomanScriptPanelProps {
  sessionId: string | null;
  drive?: DriveContext;
  progress: number;
  onDone: () => void;
}

/**
 * The dictionary for each language lives in Google Docs and the experts edit it
 * constantly, so it is pulled fresh rather than uploaded.
 *
 * Its link is NOT a secret here. The prototype this came from had no Google
 * login, so each doc had to be world-readable-by-link and the link itself was
 * the only thing protecting it. Akashvani is already signed in to Drive, so the
 * doc is read as the editor and can stay private — which is why this is a plain
 * settings field.
 */
function DictionarySettings({ dictionaries, language, onChanged }: {
  dictionaries: DictionaryInfo[];
  language: string;
  onChanged: (next: DictionaryInfo[]) => void;
}) {
  const current = dictionaries.find(d => d.language === language);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<DictionaryCheck | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
      <div className="text-xs font-semibold">{language} dictionary</div>

      {current?.configured ? (
        <p className="text-xs text-muted-foreground">
          Using <strong>{current.name || current.docId}</strong>
          {current.source ? ` (set in ${current.source})` : ''}. Corrections come from
          this doc, so an expert's edit is picked up on the next run.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No dictionary set for {language}. Subtitles will still be converted to Roman
          script, but PlanetRead's agreed spellings won't be applied. Paste the Google
          Docs link below to fix that.
        </p>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={link}
          onChange={(e) => { setLink(e.target.value); setError(null); }}
          placeholder="https://docs.google.com/document/d/…"
          className="flex-1 min-w-0 px-2 py-1.5 rounded-md border border-border bg-background text-xs"
        />
        <button
          type="button"
          disabled={busy || !link.trim()}
          onClick={() => run(async () => {
            onChanged(await setDictionaryLink(language, link));
            setLink('');
            setChecked(null);
          })}
          className="shrink-0 px-3 py-1.5 rounded-md border border-border bg-card text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          Save
        </button>
      </div>

      {current?.configured && (
        <button
          type="button"
          disabled={busy}
          onClick={() => run(async () => setChecked(await checkDictionary(language)))}
          className="text-xs text-primary underline hover:no-underline disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Check it reads correctly'}
        </button>
      )}

      {checked && (
        <p className="text-xs text-success">
          "{checked.name}" — {checked.spellings} spellings, {checked.nativeWords} native words.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function RomanScriptPanel({ sessionId, drive, progress, onDone }: RomanScriptPanelProps) {
  const [status, setStatus] = useState<RomanizeStatus | null>(null);
  const [language, setLanguage] = useState<string>('Hindi');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [result, setResult] = useState<RomanizeResult | null>(null);

  useEffect(() => {
    fetchRomanizeStatus().then(s => {
      setStatus(s);
      if (s.defaultLanguage) setLanguage(s.defaultLanguage);
    });
  }, []);

  const backendBusy = !running && progress > 0 && progress < 100;

  async function convert() {
    setRunning(true);
    setError(null);
    setAuthUrl(null);
    try {
      setResult(await romanizeEpisode(sessionId ?? '', language, drive));
      onDone();
    } catch (err) {
      if (err instanceof DriveUploadError) {
        setError(err.message);
        setAuthUrl(err.authUrl);
      } else {
        setError(err instanceof Error ? err.message : 'Roman-script conversion failed');
      }
    } finally {
      setRunning(false);
    }
  }

  const stats = result?.stats;

  return (
    <div className="mt-4 space-y-4">
      {backendBusy ? (
        <div className="flex items-center gap-2 text-sm text-primary">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Converting to Roman script… {Math.round(progress)}%</span>
        </div>
      ) : status?.configured === false ? (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Roman-script conversion is switched off on this computer — no{' '}
          <code className="font-mono">ANTHROPIC_API_KEY</code> in{' '}
          <code className="font-mono">config.env</code>. Ask whoever set the app up to
          add it and restart.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm text-warning">
            <Hand className="h-4 w-4" />
            <span>Not converted yet</span>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">Language of this episode</label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={running}
              className="px-2 py-1.5 rounded-md border border-border bg-background text-xs"
            >
              {(status?.languages ?? ['Hindi']).map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>

          {status && (
            <DictionarySettings
              dictionaries={status.dictionaries}
              language={language}
              onChanged={(dictionaries) => setStatus({ ...status, dictionaries })}
            />
          )}

          <button
            type="button"
            disabled={running}
            onClick={convert}
            className="flex items-center gap-2 px-5 py-2.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-semibold"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
            {running
              ? `Converting… ${progress > 0 ? `${Math.round(progress)}%` : 'this takes a few minutes'}`
              : 'Convert to Roman script'}
          </button>

          <p className="text-xs text-muted-foreground leading-relaxed">
            Takes the final subtitle file from the last Language Expert pass and writes
            it in Roman letters — the same words, not a translation. Timings are copied
            across untouched. PlanetRead's agreed spellings are applied from the{' '}
            {language} dictionary. Both the <strong>.srt</strong> and a{' '}
            <strong>review Word file</strong> showing every correction are saved to the{' '}
            <strong>AI Subtitles</strong> folder on Drive.
          </p>
        </>
      )}

      {stats && (
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1.5 text-xs">
          <p className="text-success font-medium">
            {result!.savedAs} — {stats.lines} lines, {stats.timecodes} timings kept
            {stats.cached ? ' (reused an earlier run)' : ''}
          </p>
          {stats.corrections > 0 && (
            <p className="text-muted-foreground">
              {stats.corrections} dictionary correction(s) applied
              {stats.preReplaced > 0 && `, ${stats.preReplaced} word(s) locked before conversion`}.
            </p>
          )}
          {/* A refusal leaves those lines in the ORIGINAL script. That must never be
              a quiet footnote — the file looks finished but ships unconverted text. */}
          {stats.refused > 0 && (
            <p className="text-destructive">
              <strong>{stats.refused} line(s) could not be converted</strong> and are still
              in the original script. Fix these subtitle(s) by hand:{' '}
              {stats.refusedSubtitles.slice(0, 40).join(', ')}
              {stats.refusedSubtitles.length > 40 ? ' …' : ''}
            </p>
          )}
          {stats.inconsistencies.length > 0 && (
            <details>
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                {stats.inconsistencies.length} word(s) spelled inconsistently — review before delivery
              </summary>
              <ul className="mt-1.5 space-y-0.5 text-muted-foreground">
                {stats.inconsistencies.slice(0, 25).map((row, i) => <li key={i}>{row}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {error && (
        <div className="space-y-2">
          <p className="text-xs text-destructive">{error}</p>
          {authUrl && (
            <a
              href={authUrl}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              Connect Google Drive
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel shown to the Editor when the pipeline reaches an LE step
// ---------------------------------------------------------------------------
interface EditorLEWaitPanelProps {
  leLabel: string;
  syncCode?: string | null;
  onShare?: () => void;
  onMarkDone: () => void;
  isUploadStep: boolean; // false for auto-completing steps like align-srt
}

function EditorLEWaitPanel({ leLabel, syncCode, onShare, onMarkDone, isUploadStep }: EditorLEWaitPanelProps) {
  const [copied, setCopied] = useState(false);

  function copyCode() {
    if (!syncCode) return;
    navigator.clipboard.writeText(syncCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (!isUploadStep) {
    return (
      <div className="mt-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Check className="h-4 w-4" />
          <span>This step auto-completes after {leLabel} uploads their file.</span>
        </div>
        <button
          onClick={onMarkDone}
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          Mark as done manually (override)
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center gap-2 text-sm text-warning">
        <Hand className="h-4 w-4" />
        <span>Waiting for {leLabel} to complete this step</span>
      </div>

      <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">
          Share your session code with {leLabel}:
        </p>

        {syncCode ? (
          <div className="flex items-center gap-3">
            <span className="font-mono text-2xl font-bold tracking-widest text-foreground">
              {syncCode}
            </span>
            <button
              type="button"
              onClick={copyCode}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onShare}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Share2 className="h-4 w-4" />
            Generate Session Code
          </button>
        )}

        <ol className="space-y-1 text-[12px] text-muted-foreground list-none">
          <li className="flex gap-2"><span className="text-primary font-medium">1.</span> {leLabel} opens Akashvani on their machine</li>
          <li className="flex gap-2"><span className="text-primary font-medium">2.</span> Clicks <strong className="text-foreground">Join Session</strong> and enters this code</li>
          <li className="flex gap-2"><span className="text-primary font-medium">3.</span> Selects <strong className="text-foreground">{leLabel}</strong> as their role</li>
        </ol>
      </div>

      <button
        onClick={onMarkDone}
        className="text-xs text-muted-foreground hover:text-foreground underline"
      >
        Mark as done manually (override)
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main StepDetail component
// ---------------------------------------------------------------------------
interface StepDetailProps {
  step: PipelineStep | null;
  stepIndex: number;
  totalSteps: number;
  isPreviewOnly?: boolean;
  /** Return to the step the pipeline is actually on. Absent when there is none. */
  onBackToCurrent?: () => void;
  onMarkDone: () => void;
  sessionId?: string;
  role?: string | null;
  syncCode?: string | null;
  onShare?: () => void;
  /** Drive destination for review uploads — required for cross-machine LE work. */
  drive?: DriveContext;
  /** What was already submitted for each review pass, keyed by le1/le2/le3. */
  leUploads?: Record<string, { fileName: string; at: string }>;
}

export function StepDetail({
  step,
  stepIndex,
  totalSteps,
  isPreviewOnly,
  onBackToCurrent,
  onMarkDone,
  sessionId,
  role,
  syncCode,
  onShare,
  drive,
  leUploads,
}: StepDetailProps) {
  if (!step) {
    return (
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-2xl mx-auto">
          <div className="rounded-lg border border-border bg-card p-6 mb-6">
            <p className="text-lg font-semibold text-foreground">How this prototype works</p>
            <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
              Everything runs in the browser for now. <strong className="text-foreground">Run Pipeline</strong> uses shorter
              automated steps. <strong className="text-foreground">Full demo</strong> stretches automated work to about two
              minutes total for the auto parts — manual steps always wait until you click <strong className="text-foreground">Mark as Done</strong>; nothing skips past them.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            <ListOrdered className="h-4 w-4" />
            All pipeline steps ({STEPS_CONFIG.length})
          </div>
          <ol className="space-y-2">
            {STEPS_CONFIG.map((s, i) => (
              <li
                key={s.id}
                className="flex gap-3 text-sm rounded-md border border-border/80 bg-muted/20 px-3 py-2.5"
              >
                <span className="font-mono text-muted-foreground w-6 shrink-0">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">{s.name}</span>
                  <span
                    className={`ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      s.type === 'manual' ? 'bg-warning/15 text-warning' : 'bg-primary/15 text-primary'
                    }`}
                  >
                    {s.type}
                  </span>
                </div>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground mt-6">
            Tip: click any step in the sidebar to preview its full description.
          </p>
        </div>
      </div>
    );
  }

  // What was previously submitted for the pass being viewed.
  const LE_SLOT_FOR_STEP: Record<string, string> = {
    'review-pass1': 'le1', 'review-pass3': 'le3',
  };
  const priorUpload = step ? leUploads?.[LE_SLOT_FOR_STEP[step.id]] : undefined;

  // Is the viewing user an editor looking at an LE-owned step?
  const leOwner = LE_STEP_OWNERS[step.id];
  const isEditorViewingLEStep = (role === 'editor' || !role) && !!leOwner;

  // Upload steps that have a specific LE upload action (vs auto-completing steps)
  const LE_UPLOAD_STEP_IDS = new Set(['review-pass1', 'review-pass3']);

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="max-w-2xl">
        {isPreviewOnly && (
          <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100/95 flex items-center justify-between gap-3">
            <span>You're viewing a different step — actions appear on the current step.</span>
            {onBackToCurrent && (
              <button
                type="button"
                onClick={onBackToCurrent}
                className="shrink-0 font-semibold underline hover:no-underline"
              >
                Back to current step
              </button>
            )}
          </div>
        )}
        {/* Header */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <span>Step {stepIndex + 1} of {totalSteps}</span>
          <span>•</span>
          <span className="uppercase tracking-wider">{step.type}</span>
        </div>

        <h2 className="text-2xl font-semibold text-foreground mb-4">{step.name}</h2>

        {/* Timer */}
        <div className="flex items-center gap-2 mb-6">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className={`font-mono text-lg ${step.status === 'running' ? 'text-primary' : 'text-foreground'}`}>
            {formatTime(step.elapsedMs)}
          </span>
          {step.status === 'running' && (
            <span className="text-xs text-muted-foreground animate-pulse">elapsed</span>
          )}
        </div>

        {/* Status card */}
        <div className={`rounded-lg border p-5 mb-6 ${
          step.status === 'running' && step.type === 'automated'
            ? 'border-running/30 bg-running/5'
            : step.status === 'running' && step.type === 'manual'
              ? 'border-warning/30 bg-warning/5'
              : step.status === 'completed'
                ? 'border-success/30 bg-success/5'
                : step.status === 'error'
                  ? 'border-destructive/30 bg-destructive/5'
                  : 'border-border bg-card'
        }`}>
          <p className="text-sm text-foreground/80 leading-relaxed">{step.description}</p>

          {/* Already submitted once — show it so a reviewer returning to this
              step can see what they sent rather than guessing. */}
          {priorUpload && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2">
              <FileText className="h-4 w-4 text-success mt-px shrink-0" />
              <div className="min-w-0 text-xs">
                <p className="text-foreground font-medium truncate">{priorUpload.fileName}</p>
                <p className="text-muted-foreground mt-0.5">
                  Submitted {new Date(priorUpload.at).toLocaleString(undefined, {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                  . Uploading again replaces it.
                </p>
              </div>
            </div>
          )}

          {/* Progress bar for automated steps */}
          {step.type === 'automated' && step.status === 'running' && (
            <div className="mt-4">
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>Processing...</span>
                <span>{Math.round(step.progress)}%</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300 ease-linear"
                  style={{ width: `${step.progress}%` }}
                />
              </div>
            </div>
          )}

          {step.type === 'automated' && step.status === 'running' && (
            <div className="mt-4 flex items-center gap-2 text-sm text-running">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Automated step in progress...</span>
            </div>
          )}

          {/* Manual step action */}
          {step.type === 'manual' && step.status === 'running' && (
            // ── Editor viewing an LE step ──────────────────────────────────
            isEditorViewingLEStep ? (
              <EditorLEWaitPanel
                leLabel={leOwner.label}
                syncCode={syncCode}
                onShare={onShare}
                onMarkDone={onMarkDone}
                isUploadStep={LE_UPLOAD_STEP_IDS.has(step.id)}
              />
            ) :
            // ── Upload steps (LE view or editor non-LE steps) ──────────────
            step.id === 'roman-script' ? (
              <RomanScriptPanel
                sessionId={sessionId}
                drive={drive}
                progress={step.progress}
                onDone={onMarkDone}
              />
            ) : step.id === 'upload-feltiv-srt' ? (
              <SubtitleGenerationPanel
                sessionId={sessionId}
                drive={drive}
                progress={step.progress}
                onDone={onMarkDone}
              />
            ) : step.id === 'upload-prproj' ? (
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-2 text-sm text-warning">
                  <Hand className="h-4 w-4" />
                  <span>Waiting for Premiere Pro project upload</span>
                </div>
                <ManualFileUpload
                  accept=".prproj"
                  chooseLabel="Choose .prproj file…"
                  uploadLabel="Upload Project"
                  hint={
                    <>
                      Upload the Premiere Pro project file (<code className="font-mono">.prproj</code>)
                      for this episode. It will be saved to the <strong>Editor</strong> folder in your workflow.
                    </>
                  }
                  onUpload={async (file) => {
                    await uploadPrproj(sessionId ?? '', file);
                    onMarkDone();
                  }}
                />
              </div>
            ) : step.id === 'review-pass1' ? (
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-2 text-sm text-warning">
                  <Hand className="h-4 w-4" />
                  <span>Language Expert 1 — upload corrected Word file</span>
                </div>
                <ManualFileUpload
                  accept=".doc,.docx"
                  chooseLabel="Choose Word file…"
                  uploadLabel="Upload Word File"
                  hint={
                    <>
                      Upload the <strong>.docx</strong> that was generated by this system when the AI subtitle file
                      was uploaded (saved in your <strong>AI Subtitles</strong> folder). Open it in Word, correct
                      the <em>Subtitle</em> column, save, then upload here. It will be saved to the{' '}
                      <strong>LE 1</strong> Drive folder, converted to SRT, and placed in the{' '}
                      <strong>Editors</strong> directory.
                    </>
                  }
                  onUpload={async (file) => {
                    await uploadLE1Word(sessionId ?? '', file, drive);
                    onMarkDone();
                  }}
                />
              </div>
            ) : step.id === 'review-pass3' ? (
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-2 text-sm text-warning">
                  <Hand className="h-4 w-4" />
                  <span>Language Expert 3 — upload final corrected SRT file</span>
                </div>
                <ManualFileUpload
                  accept=".srt"
                  chooseLabel="Choose .srt file…"
                  uploadLabel="Upload Final SRT"
                  hint={
                    <>
                      Upload the final corrected <code className="font-mono">.srt</code> file for this episode.
                    </>
                  }
                  onUpload={async (file) => {
                    await uploadLE3Srt(sessionId ?? '', file, drive);
                    onMarkDone();
                  }}
                />
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="flex items-center gap-2 text-sm text-warning">
                  <Hand className="h-4 w-4" />
                  <span>Waiting for human action</span>
                </div>
                <button
                  onClick={onMarkDone}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-md bg-success text-success-foreground hover:bg-success/90 transition-colors text-sm font-semibold"
                >
                  <Check className="h-4 w-4" />
                  Mark as Done
                </button>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  The pipeline stays on this step until you mark it done — it will not move on by itself.
                </p>
              </div>
            )
          )}

          {/* Completed */}
          {step.status === 'completed' && (
            <div className="mt-4 flex items-center gap-2 text-sm text-success">
              <Check className="h-4 w-4" />
              <span>Completed in {formatTime(step.elapsedMs)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
