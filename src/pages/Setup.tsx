import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clapperboard, FolderUp, HardDrive, Loader2, Upload, CheckCircle2, ChevronDown } from 'lucide-react';
import { uploadFiles, fetchDriveTarget, saveDriveTarget, parseDriveFolderId, DuplicateFolderError } from '@/lib/api';
import { STEPS_CONFIG } from '@/lib/pipeline';
import { createSharedSession } from '@/lib/session-sync';
import { loadIdentity } from '@/pages/Welcome';

function makeSessionId() {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const STEP_GROUPS = [
  {
    label: 'File Processing',
    ids: ['copy', 'compress'],
  },
  {
    label: 'Google Drive',
    ids: ['upload-gdrive'],
  },
  {
    label: 'SRT Workflow',
    ids: ['upload-feltiv-srt', 'upload-prproj', 'word-to-srt'],
  },
  {
    label: 'Expert Reviews',
    ids: ['review-pass1', 'align-srt', 'final-qc', 'review-pass3'],
  },
  {
    label: 'Post-Processing',
    ids: ['sls', 'slc', 'roman-script'],
  },
];

const ALL_IDS = STEPS_CONFIG.map(s => s.id);

function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export default function Setup() {
  const navigate = useNavigate();
  const [sessionId] = useState(makeSessionId);
  const [episodeCount, setEpisodeCount] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [folderName, setFolderName] = useState<string>('');
  const [selectedSteps, setSelectedSteps] = useState<Set<string>>(
    () => new Set(ALL_IDS)
  );
  const folderInputRef = useRef<HTMLInputElement>(null);

  /** An episode already exists for this folder — offer to resume it instead. */
  const [duplicate, setDuplicate] = useState<{ sessionId: string; code: string | null; folderName: string | null } | null>(null);
  /** Real bytes-sent progress while the folder copies. */
  const [progress, setProgress] = useState<{ percent: number; sent: number; total: number } | null>(null);
  /** Episode count came from counting the folder, not from typing. */
  const [autoDetected, setAutoDetected] = useState(false);
  /** Which step card is expanded. */
  const [openStep, setOpenStep] = useState<string | null>(null);

  // Google Drive destination — the editor just pastes the folder link.
  // Parsing is local, so it works without contacting Google at all.
  const [driveLink, setDriveLink] = useState('');
  const driveFolderId = useMemo(() => parseDriveFolderId(driveLink), [driveLink]);

  // Pre-fill with the link used last time on this machine
  useEffect(() => {
    fetchDriveTarget()
      .then(t => { if (t?.folderId) setDriveLink(t.folderName || t.folderId); })
      .catch(() => { /* nothing saved yet */ });
  }, []);

  const totalBytes = useMemo(() => files.reduce((n, f) => n + f.size, 0), [files]);

  const fileSummary = useMemo(() => {
    if (files.length === 0) return 'No folder selected';
    return `${files.length} video file(s) selected`;
  }, [files.length]);

  function toggleStep(id: string) {
    setSelectedSteps(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() { setSelectedSteps(new Set(ALL_IDS)); }
  function deselectAll() { setSelectedSteps(new Set()); }

  function pickFolder() { folderInputRef.current?.click(); }

  function sanitizeVideos(selected: FileList | null) {
    const all = Array.from(selected || []);
    const onlyVideos = all.filter(f => f.type.startsWith('video/') || /\.(mp4|mov|avi|mkv|mxf)$/i.test(f.name));
    const detectedFolder = onlyVideos[0]?.webkitRelativePath?.split('/')[0] || 'input-folder';
    setFolderName(detectedFolder);
    setFiles(onlyVideos);
    setDuplicate(null);
    setProgress(null);
    // One video = one episode. Detected from the folder so nobody has to count.
    if (onlyVideos.length > 0) {
      setEpisodeCount(onlyVideos.length);
      setAutoDetected(true);
    }
    setError(onlyVideos.length ? null : 'Folder should contain video files (.mp4, .mov, .avi, .mkv, .mxf)');
  }

  const needsDrive = selectedSteps.has('upload-gdrive')
    || ['review-pass1', 'review-pass3', 'upload-feltiv-srt'].some(id => selectedSteps.has(id));

  async function handleAutomate() {
    if (files.length === 0) { setError('Please select or drop a folder first.'); return; }
    if (selectedSteps.size === 0) { setError('Select at least one pipeline step.'); return; }
    if (needsDrive && !driveFolderId) {
      setError('Paste the Google Drive folder link where this episode should be stored.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      // Remember the link so the next episode pre-fills it
      if (driveFolderId) {
        await saveDriveTarget(driveFolderId, driveLink.trim()).catch(() => {});
      }
      setProgress({ percent: 0, sent: 0, total: 0 });
      const { parentName } = await uploadFiles(
        files, sessionId, episodeCount, folderName || 'input-folder',
        (percent, sent, total) => setProgress({ percent, sent, total }),
      );
      const orderedIds = ALL_IDS.filter(id => selectedSteps.has(id));

      // Create Fly.io session immediately so the editor can resume after shutdown,
      // and so a Language Expert on another machine can read the Drive destination.
      let sharedCode: string | null = null;
      try {
        const identity = loadIdentity();
        const { code } = await createSharedSession({
          sessionId,
          folderName: folderName || 'input-folder',
          episodeCount,
          selectedSteps: orderedIds,
          stepStates: {},
          editorEmail: identity?.email ?? null,
          officeName: identity?.officeName ?? null,
          driveFolderId: driveFolderId ?? null,
          driveParentName: parentName,
        });
        sharedCode = code;
      } catch {
        // Fly.io unreachable — proceed without sync code
      }

      const codeParam = sharedCode ? `&code=${sharedCode}&role=editor` : '';
      const driveParam = driveFolderId ? `&driveFolderId=${encodeURIComponent(driveFolderId)}` : '';
      navigate(`/pipeline?sessionId=${encodeURIComponent(sessionId)}&autostart=1&steps=${orderedIds.join(',')}${codeParam}${driveParam}`);
    } catch (err) {
      if (err instanceof DuplicateFolderError) {
        // The workflow folder for this name already exists — offer the episode
        // they already have instead of silently forking it in two.
        setError(err.message);
        setDuplicate(err.existing);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to upload folder');
      }
    } finally {
      setUploading(false);
      setProgress(null);
    }
  }

  const selectedCount = selectedSteps.size;

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-3xl rounded-xl border border-border bg-card p-6 md:p-8 space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <Clapperboard className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl md:text-2xl font-semibold">Akashvani Automation Setup</h1>
            <p className="text-sm text-muted-foreground">Three things to set up, then the app takes over.</p>
          </div>
        </div>

        {/* ── 1. Choose the footage ────────────────────── */}
        <section>
          <div className="flex items-baseline gap-2 mb-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px] font-semibold">1</span>
            <h2 className="text-sm font-medium">Choose the episode folder</h2>
          </div>

          <div
            className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
              dragging ? 'border-primary bg-primary/5'
                : files.length > 0 ? 'border-success/50 bg-success/5'
                : 'border-border hover:border-primary/40'
            }`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); sanitizeVideos(e.dataTransfer.files); }}
          >
            <input
              ref={folderInputRef}
              type="file"
              // eslint-disable-next-line @typescript-eslint/ban-ts-comment
              // @ts-ignore
              webkitdirectory="true"
              multiple
              className="hidden"
              onChange={e => sanitizeVideos(e.target.files)}
            />

            {files.length === 0 ? (
              <>
                <Upload className="h-6 w-6 mx-auto mb-2 text-primary" />
                <p className="text-sm mb-1">Drag your episode folder here</p>
                <p className="text-xs text-muted-foreground mb-4">or pick it from your drive</p>
                <button
                  type="button"
                  onClick={pickFolder}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-border hover:bg-muted text-sm"
                >
                  <FolderUp className="h-4 w-4" />
                  Choose Folder
                </button>
              </>
            ) : (
              <>
                {/* Something was actually picked — say so plainly. */}
                <CheckCircle2 className="h-6 w-6 mx-auto mb-2 text-success" />
                <p className="text-sm font-medium">{folderName}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {files.length} video{files.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
                </p>
                <button
                  type="button"
                  onClick={pickFolder}
                  disabled={uploading}
                  className="mt-3 text-xs text-primary hover:underline disabled:opacity-50"
                >
                  Choose a different folder
                </button>
              </>
            )}
          </div>

          {/* Live copy progress. A multi-GB folder with no feedback looks frozen. */}
          {progress && (
            <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="flex items-center gap-2 font-medium">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  {progress.percent >= 100 ? 'Finishing up…' : 'Copying your videos…'}
                </span>
                <span className="font-mono text-muted-foreground">{progress.percent}%</span>
              </div>
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              {progress.total > 1 && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {formatBytes(progress.sent)} of {formatBytes(progress.total)} · keep the app open
                </p>
              )}
            </div>
          )}

          {/* Episode count, worked out from the folder rather than typed. */}
          {files.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Episodes detected:</span>
              <input
                id="episode-count"
                type="number"
                min={1}
                max={500}
                value={episodeCount}
                onChange={e => { setEpisodeCount(Math.max(1, Number(e.target.value || 1))); setAutoDetected(false); }}
                className="w-20 px-2 py-1 rounded border border-input bg-background text-sm"
              />
              {autoDetected && (
                <span className="text-[11px] text-muted-foreground">
                  counted from the folder — change it if that is wrong
                </span>
              )}
            </div>
          )}
        </section>

        {/* ── 2. Where it goes on Drive ─────────────────── */}
        <section>
          <div className="flex items-baseline gap-2 mb-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px] font-semibold">2</span>
            <h2 className="text-sm font-medium">Where should it go on Google Drive?</h2>
          </div>

          <div className={`rounded-lg border p-4 ${
            needsDrive && !driveFolderId ? 'border-warning/50 bg-warning/5' : 'border-border bg-muted/20'
          }`}>
            <div className="flex items-center gap-2 mb-2">
              <HardDrive className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm font-medium">Google Drive folder link</span>
              {driveFolderId && <CheckCircle2 className="h-4 w-4 text-success" />}
            </div>
            <input
              type="text"
              value={driveLink}
              onChange={e => { setDriveLink(e.target.value); setError(null); }}
              placeholder="https://drive.google.com/drive/folders/..."
              spellCheck={false}
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="text-[12px] text-muted-foreground mt-2">
              Open the folder in Google Drive, copy the address from the browser bar, and paste it here.
              Everything for this episode is created inside it, and the Language Experts upload into it too.
            </p>
            {driveLink.trim() && !driveFolderId && (
              <p className="text-[12px] text-destructive mt-1">
                That link does not look like a Drive folder.
              </p>
            )}
          </div>
        </section>

        {/* ── 3. What should run ─────────────────────── */}
        <section>
          <div className="flex items-baseline gap-2 mb-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px] font-semibold">3</span>
            <h2 className="text-sm font-medium">What should the app do?</h2>
          </div>

          <div className="rounded-lg border border-border">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <p className="text-xs text-muted-foreground">
                {selectedCount} of {ALL_IDS.length} steps selected · tap a step to see what it does
              </p>
              <div className="flex gap-2">
                <button type="button" onClick={selectAll}
                  className="text-xs px-2.5 py-1 rounded border border-border hover:bg-muted transition-colors">All</button>
                <button type="button" onClick={deselectAll}
                  className="text-xs px-2.5 py-1 rounded border border-border hover:bg-muted transition-colors">None</button>
              </div>
            </div>

            <div className="divide-y divide-border/60">
              {STEP_GROUPS.map(group => {
                const groupSteps = STEPS_CONFIG.filter(s => group.ids.includes(s.id));
                return (
                  <div key={group.label} className="px-4 py-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      {group.label}
                    </p>
                    <div className="space-y-1">
                      {groupSteps.map(step => {
                        const on = selectedSteps.has(step.id);
                        const open = openStep === step.id;
                        return (
                          <div key={step.id} className="rounded-md border border-transparent hover:border-border/70 transition-colors">
                            <div className="flex items-start gap-3 px-2 py-1.5">
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => toggleStep(step.id)}
                                className="mt-1 h-4 w-4 rounded border-border accent-primary cursor-pointer shrink-0"
                              />
                              {/* The whole row expands — the explanation lives here. */}
                              <button
                                type="button"
                                onClick={() => setOpenStep(open ? null : step.id)}
                                className="flex-1 min-w-0 text-left"
                                aria-expanded={open}
                              >
                                <span className={`block text-sm ${on ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                                  {step.name}
                                </span>
                                <span className="block text-[11px] text-muted-foreground mt-0.5">
                                  {step.summary}
                                </span>
                              </button>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider shrink-0 ${
                                step.type === 'manual' ? 'bg-warning/15 text-warning' : 'bg-primary/15 text-primary'
                              }`}>
                                {step.type === 'manual' ? 'you do this' : 'automatic'}
                              </span>
                              <ChevronDown
                                className={`h-4 w-4 text-muted-foreground shrink-0 mt-0.5 transition-transform ${open ? 'rotate-180' : ''}`}
                              />
                            </div>
                            {open && (
                              <p className="px-2 pb-2.5 pl-9 text-[12px] text-muted-foreground leading-relaxed">
                                {step.description}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {error && (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{error}</p>
            {duplicate && (
              <button
                type="button"
                onClick={() => navigate('/editor')}
                className="text-sm text-primary hover:underline"
              >
                Open Your Episodes to resume it
              </button>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Language Expert?{' '}
            <button
              type="button"
              onClick={() => navigate('/join')}
              className="text-primary hover:underline font-medium"
            >
              Join Session
            </button>
          </p>
          <button
            type="button"
            disabled={uploading || selectedSteps.size === 0}
            onClick={handleAutomate}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {uploading ? (
              <><Loader2 className="h-4 w-4 animate-spin" />Uploading...</>
            ) : (
              <>Automate</>
            )}
          </button>
        </div>

      </div>
    </div>
  );
}
