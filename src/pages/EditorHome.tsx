import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Plus, ArrowRight, Loader2, RefreshCw, Trash2, CloudOff, LogOut } from 'lucide-react';
import { listSessionsByEmail, deleteSharedSession, ROLE_STEPS } from '@/lib/session-sync';
import { loadIdentity, clearIdentity } from '@/pages/Welcome';
import { fetchSetupStatus, fetchLocalSessions, deleteLocalSession, fetchLogInfo } from '@/lib/api';
import { STEPS_CONFIG } from '@/lib/pipeline';

const ALL_STEP_IDS = STEPS_CONFIG.map(s => s.id);

/**
 * A session id (`s-1787567638181-ljxk92`) is never a real episode name. An older
 * build wrote the id into the name field, so those rows are still out there in
 * the sync server — refuse to display one rather than showing a random hash.
 */
const looksLikeSessionId = (name: string | null | undefined): boolean =>
  /^s-[0-9]{10,}-[a-z0-9]+$/i.test(String(name ?? ''));
const cleanName = (name: string | null | undefined): string | null =>
  (name && !looksLikeSessionId(name) ? name : null);

/**
 * One episode, however we learned about it. Local disk and the shared record
 * are both normalised into this so the list renders identically either way.
 */
interface EpisodeRow {
  sessionId: string | null;
  code: string | null;
  folderName: string | null;
  selectedSteps: string[];
  stepStates: Record<string, string>;
  driveFolderId: string | null;
  updatedAt: string | null;
  /** Present in the shared record, so "Delete" has something to remove. */
  shared: boolean;
}

function stepProgress(row: EpisodeRow) {
  const selected = row.selectedSteps.length > 0 ? row.selectedSteps : ALL_STEP_IDS;
  const done = selected.filter(id => row.stepStates?.[id] === 'complete').length;
  return { done, total: selected.length };
}

function waitingForLabel(row: EpisodeRow): string | null {
  const selected = row.selectedSteps.length > 0 ? row.selectedSteps : ALL_STEP_IDS;
  const firstPending = selected.find(id => row.stepStates?.[id] !== 'complete');
  if (!firstPending) return null;

  const leEntry = Object.entries(ROLE_STEPS).find(([, ids]) => ids.includes(firstPending));
  const step = STEPS_CONFIG.find(s => s.id === firstPending);
  if (leEntry) {
    const labels: Record<string, string> = { le1: 'LE 1', le2: 'LE 2', le3: 'LE 3' };
    return `Waiting for ${labels[leEntry[0]] ?? leEntry[0]}${step ? ` — ${step.name}` : ''}`;
  }
  return step ? `Next: ${step.name}` : firstPending;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Combine the two sources. A step counts as complete if EITHER says so: local
 * disk knows what this machine did, the shared record knows what a Language
 * Expert did elsewhere. Neither alone is the full picture.
 */
function mergeSessions(
  local: Awaited<ReturnType<typeof fetchLocalSessions>>,
  remote: Awaited<ReturnType<typeof listSessionsByEmail>>,
): EpisodeRow[] {
  const byKey = new Map<string, EpisodeRow>();

  for (const l of local) {
    byKey.set(l.sessionId, {
      sessionId: l.sessionId,
      code: l.code,
      folderName: cleanName(l.folderName),
      selectedSteps: l.selectedSteps ?? [],
      stepStates: l.stepStates ?? {},
      driveFolderId: l.driveFolderId,
      updatedAt: l.updatedAt,
      shared: false,
    });
  }

  for (const r of remote) {
    const key = r.session_id || r.code;
    const existing = byKey.get(key);
    byKey.set(key, {
      sessionId: r.session_id || existing?.sessionId || null,
      code: r.code,
      // Prefer any usable name; the remote one loses if it is a session id.
      folderName: cleanName(r.folder_name) || existing?.folderName || null,
      selectedSteps: r.selected_steps?.length ? r.selected_steps : (existing?.selectedSteps ?? []),
      stepStates: { ...(existing?.stepStates ?? {}), ...(r.step_states ?? {}) },
      driveFolderId: r.drive_folder_id || existing?.driveFolderId || null,
      updatedAt: [r.updated_at, existing?.updatedAt].filter(Boolean).sort().reverse()[0] ?? null,
      shared: true,
    });
  }

  return [...byKey.values()].sort(
    (a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))
  );
}

export default function EditorHome() {
  const navigate = useNavigate();
  const identity = loadIdentity();

  const [rows, setRows] = useState<EpisodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncOffline, setSyncOffline] = useState(false);
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  // Kept separate from `error`: a failed delete must not replace the whole list
  // with the load-failure screen.
  const [actionError, setActionError] = useState<string | null>(null);
  const [logDir, setLogDir] = useState<string | null>(null);

  async function loadSessions() {
    setLoading(true);
    setError(null);
    setActionError(null);

    // Both are allowed to fail independently — only a total failure is fatal.
    const [localResult, remoteResult] = await Promise.allSettled([
      fetchLocalSessions(),
      identity?.email ? listSessionsByEmail(identity.email) : Promise.resolve([]),
    ]);

    const local = localResult.status === 'fulfilled' ? localResult.value : [];
    const remote = remoteResult.status === 'fulfilled' ? remoteResult.value : [];

    setSyncOffline(remoteResult.status === 'rejected');

    if (localResult.status === 'rejected' && remoteResult.status === 'rejected') {
      setError('Could not load your episodes. The app backend may still be starting up.');
      setRows([]);
    } else {
      setRows(mergeSessions(local, remote));
    }

    setLoading(false);
  }

  async function handleDelete(row: EpisodeRow) {
    const key = row.sessionId ?? row.code ?? '';
    setDeletingKey(key);
    setActionError(null);
    try {
      // Both stores, or the row comes straight back: the list merges the sync
      // server with local disk, and only the cloud row was being removed.
      if (row.code) await deleteSharedSession(row.code);
      if (row.sessionId) await deleteLocalSession(row.sessionId);
      setRows(prev => prev.filter(r => (r.sessionId ?? r.code) !== key));
      setConfirmingKey(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not delete the session');
    } finally {
      setDeletingKey(null);
    }
  }

  // Surface where the logs are, so a support request can start with the path.
  useEffect(() => {
    fetchLogInfo().then(i => setLogDir(i.logDir)).catch(() => {});
  }, []);

  // First-run drive setup check
  useEffect(() => {
    fetchSetupStatus()
      .then(({ isFirstRun }) => { if (isFirstRun) navigate('/drive-setup', { replace: true }); })
      .catch(() => {});
  }, [navigate]);

  useEffect(() => {
    if (!identity) { navigate('/', { replace: true }); return; }
    loadSessions();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleResume(row: EpisodeRow) {
    const params = new URLSearchParams({ role: 'editor' });
    // The original sessionId is essential — every local backend call is keyed by
    // it. Minting a new one sends uploads into an empty orphan folder.
    if (row.sessionId) params.set('sessionId', row.sessionId);
    if (row.code) params.set('code', row.code);
    if (row.selectedSteps.length > 0) params.set('steps', row.selectedSteps.join(','));
    if (row.driveFolderId) params.set('driveFolderId', row.driveFolderId);
    navigate(`/pipeline?${params.toString()}`);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          <span className="font-semibold">Akashvani Workflow</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground hidden sm:inline">
            {identity?.officeName} · {identity?.email}
          </span>
          <button
            type="button"
            onClick={() => {
              clearIdentity();
              navigate('/?switch=1', { replace: true });
            }}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            Log out
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold">Your Episodes</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Resume an in-progress episode or start a new one.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={loadSessions}
              title="Refresh"
              className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => navigate('/setup')}
              className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Episode
            </button>
          </div>
        </div>

        {/* Sync server unreachable, but local episodes still load */}
        {syncOffline && !loading && !error && (
          <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12px] text-amber-950 dark:text-amber-100/95">
            <CloudOff className="h-4 w-4 mt-px shrink-0" />
            <span>
              Can't reach the sync server, so these episodes are read from this
              computer. Your work is safe and you can keep going. Language Expert
              progress from other machines won't show until the connection is back.
            </span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading your episodes…
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <p className="text-sm text-destructive mb-3">{error}</p>
            <button type="button" onClick={loadSessions} className="text-sm text-primary hover:underline">
              Try again
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-16 border-2 border-dashed border-border rounded-xl">
            <p className="text-muted-foreground text-sm mb-4">No episodes yet.</p>
            <button
              type="button"
              onClick={() => navigate('/setup')}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Start your first episode
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {actionError && <p className="text-sm text-destructive px-1">{actionError}</p>}
            {rows.map(row => {
              const key = row.sessionId ?? row.code ?? '';
              const { done, total } = stepProgress(row);
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              const waiting = waitingForLabel(row);
              const allDone = total > 0 && done === total;

              return (
                <div
                  key={key}
                  className="bg-card border border-border rounded-xl p-4 flex items-center gap-4"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-foreground truncate">
                        {row.folderName || 'Unnamed episode'}
                      </span>
                      {row.code && (
                        <span className="font-mono text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
                          {row.code}
                        </span>
                      )}
                      {allDone && (
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-green-600 dark:text-green-400 shrink-0">
                          Done
                        </span>
                      )}
                    </div>

                    <div className="h-1.5 bg-muted rounded-full mb-1.5 overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>{done}/{total} steps complete</span>
                      <span>{formatDate(row.updatedAt)}</span>
                    </div>

                    {waiting && !allDone && (
                      <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">{waiting}</p>
                    )}
                  </div>

                  {confirmingKey === key ? (
                    <div className="shrink-0 flex flex-col items-end gap-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        Remove from this list?
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={deletingKey === key}
                          onClick={() => handleDelete(row)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-destructive text-destructive-foreground text-xs font-medium hover:bg-destructive/90 disabled:opacity-50 transition-colors"
                        >
                          {deletingKey === key
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <Trash2 className="h-3.5 w-3.5" />}
                          Delete
                        </button>
                        <button
                          type="button"
                          disabled={deletingKey === key}
                          onClick={() => setConfirmingKey(null)}
                          className="px-3 py-1.5 rounded-md border border-border text-xs font-medium hover:bg-muted/60 disabled:opacity-50 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="shrink-0 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleResume(row)}
                        className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-border bg-background hover:bg-muted/60 text-sm font-medium transition-colors"
                      >
                        {allDone ? 'View' : 'Resume'}
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => { setConfirmingKey(key); setActionError(null); }}
                        title="Remove this episode from your list (files are kept)"
                        className="p-2 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {/* Diagnostics — every machine keeps its own log in the same place. */}
        <footer className="mt-10 pt-4 border-t border-border/60 text-[11px] text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <a
              href="/api/pipeline/log?lines=500"
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              View application log
            </a>
            <a
              href="/api/pipeline/log?file=install&lines=500"
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              View install log
            </a>
            {logDir && <span className="font-mono truncate">{logDir}</span>}
          </div>
        </footer>
      </main>
    </div>
  );
}
