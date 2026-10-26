import { Clapperboard, Play, RotateCcw, Share2, Square, Zap } from 'lucide-react';
import { formatTime } from '@/lib/pipeline';
import { SyncIndicator } from '@/components/SyncIndicator';
import { SyncStatus, ROLE_LABELS } from '@/lib/session-sync';

interface TopBarProps {
  pipelineRunning: boolean;
  completed: boolean;
  demoPlayback: boolean;
  elapsedMs: number;
  onRun: () => void;
  onRunDemo: () => void;
  onReset: () => void;
  /** Halt the run — also cancels any FFmpeg encode on the backend. */
  onStop?: () => void;
  /** True after a stop: completed steps are kept and Resume continues. */
  stopped?: boolean;
  // Session sharing
  role?: string | null;
  syncCode?: string | null;
  syncStatus?: SyncStatus;
  lastSyncAt?: number | null;
  onShare?: () => void;
}

export function TopBar({
  pipelineRunning,
  completed,
  demoPlayback,
  elapsedMs,
  onRun,
  onRunDemo,
  onReset,
  onStop,
  stopped = false,
  role,
  syncCode,
  syncStatus = 'idle',
  lastSyncAt = null,
  onShare,
}: TopBarProps) {
  const isLE = role && role !== 'editor';

  return (
    <div className="shrink-0 border-b border-border bg-card">
      <header className="h-14 flex items-center justify-between px-6">
        <div className="flex items-center gap-3 min-w-0">
          <Zap className="h-5 w-5 text-primary shrink-0" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-foreground tracking-tight truncate">
              Akashvani Pipeline
            </h1>
            {role ? (
              <p className="text-[11px] text-muted-foreground leading-tight truncate hidden sm:block">
                Viewing as{' '}
                <span className="text-primary font-medium">
                  {ROLE_LABELS[role] ?? role}
                </span>
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground leading-tight truncate hidden sm:block">
                UI prototype — simulated activity and logs; connect a backend later for real work
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 sm:gap-4 shrink-0">
          {/* Sync indicator */}
          {syncCode && syncStatus !== 'idle' && (
            <SyncIndicator status={syncStatus} lastSyncAt={lastSyncAt} code={syncCode} />
          )}

          {pipelineRunning && demoPlayback && (
            <span className="hidden md:inline text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
              Full demo
            </span>
          )}

          {stopped && !completed && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-destructive">
              Stopped
            </span>
          )}

          <div className="font-mono text-sm text-muted-foreground">
            {pipelineRunning || completed ? (
              <span className={pipelineRunning ? 'text-primary' : 'text-success'}>
                {formatTime(elapsedMs)}
              </span>
            ) : (
              <span>00:00:00</span>
            )}
          </div>

          {completed ? (
            <button
              type="button"
              onClick={onReset}
              className="flex items-center gap-2 px-4 py-2 rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors text-sm font-medium"
            >
              <RotateCcw className="h-4 w-4" />
              Run Again
            </button>
          ) : (
            <div className="flex items-center gap-2">
              {/* Share button — only for editor role */}
              {!isLE && onShare && (
                <button
                  type="button"
                  onClick={onShare}
                  title="Share session code with Language Expert"
                  className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-border bg-background hover:bg-muted/60 transition-colors text-sm font-medium text-muted-foreground"
                >
                  <Share2 className="h-4 w-4" />
                  <span className="hidden sm:inline">Share</span>
                </button>
              )}

              {/* Run controls — hide for LE roles (they only use Mark as Done) */}
              {!isLE && (
                pipelineRunning ? (
                  // Mid-run the only sensible control is Stop. It cancels the
                  // backend encode too, not just the on-screen animation.
                  <button
                    type="button"
                    onClick={onStop}
                    title="Stop the pipeline. Finished steps are kept and you can resume."
                    className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors text-sm font-medium"
                  >
                    <Square className="h-4 w-4" />
                    Stop
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={onRun}
                      className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm font-medium"
                    >
                      <Play className="h-4 w-4" />
                      {stopped ? 'Resume' : 'Run Pipeline'}
                    </button>
                    {!stopped && (
                      <button
                        type="button"
                        onClick={onRunDemo}
                        title="Slower automated steps (~2 min total for auto work); manual steps still need Mark as Done"
                        className="flex items-center gap-2 px-3 sm:px-4 py-2 rounded-md border border-border bg-background hover:bg-muted/60 transition-colors text-sm font-medium"
                      >
                        <Clapperboard className="h-4 w-4" />
                        <span className="hidden sm:inline">Full demo</span>
                      </button>
                    )}
                  </>
                )
              )}
            </div>
          )}
        </div>
      </header>
      <div className="px-6 py-1.5 text-center text-[11px] text-muted-foreground bg-muted/40 border-t border-border/60 sm:hidden">
        UI prototype — no backend; simulation only
      </div>
    </div>
  );
}
