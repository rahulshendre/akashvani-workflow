import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X, Loader2, Circle, Hand } from 'lucide-react';
import { PipelineStep, formatTime } from '@/lib/pipeline';

const SIDEBAR_WIDTH_KEY = 'akashvani-sidebar-width';

interface StepSidebarProps {
  steps: PipelineStep[];
  activeStepIndex: number;
  onSelectStep: (index: number) => void;
  /** When false, step rows are not clickable (pipeline running or finished). */
  selectionWhileIdle: boolean;
}

function StatusIcon({ status, type }: { status: PipelineStep['status']; type: PipelineStep['type'] }) {
  switch (status) {
    case 'completed':
      return (
        <div className="h-6 w-6 rounded-full bg-success/20 flex items-center justify-center animate-pop-in">
          <Check className="h-3.5 w-3.5 text-success" />
        </div>
      );
    case 'running':
      return (
        <div className="h-6 w-6 rounded-full bg-running/20 flex items-center justify-center animate-pulse-ring">
          {type === 'manual' ? (
            <Hand className="h-3.5 w-3.5 text-warning" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 text-running animate-spin-slow" />
          )}
        </div>
      );
    case 'error':
      return (
        <div className="h-6 w-6 rounded-full bg-destructive/20 flex items-center justify-center">
          <X className="h-3.5 w-3.5 text-destructive" />
        </div>
      );
    default:
      return (
        <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center">
          <Circle className="h-3 w-3 text-idle" />
        </div>
      );
  }
}

export function StepSidebar({ steps, activeStepIndex, onSelectStep, selectionWhileIdle }: StepSidebarProps) {
  // Step names are long ("Copy videos into the workspace"), so a fixed 288px
  // sidebar cut every one of them off with no way to read the rest. The edge
  // is draggable and the chosen width is remembered per machine.
  const MIN_W = 220;
  const MAX_W = 560;
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return saved >= MIN_W && saved <= MAX_W ? saved : 288;
  });
  const [dragging, setDragging] = useState(false);
  const asideRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const left = asideRef.current?.getBoundingClientRect().left ?? 0;
      setWidth(Math.min(MAX_W, Math.max(MIN_W, e.clientX - left)));
    };
    const onUp = () => setDragging(false);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Stop the pointer turning into a text-selection caret mid-drag.
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  }, [width]);

  /** Keyboard resizing, so this is not mouse-only. */
  const onHandleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") setWidth(w => Math.max(MIN_W, w - 16));
    if (e.key === "ArrowRight") setWidth(w => Math.min(MAX_W, w + 16));
  }, []);
  return (
    <aside
      ref={asideRef as React.RefObject<HTMLElement>}
      className="relative border-r border-border bg-sidebar shrink-0 flex flex-col overflow-hidden"
      style={{ width }}
    >
      <div className="p-4 border-b border-border">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pipeline Steps</h2>
        {selectionWhileIdle && (
          <p className="text-[10px] text-muted-foreground/80 mt-1.5 leading-snug">
            Click a step to preview its description before you run.
          </p>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        {steps.map((step, i) => {
          const isActive = i === activeStepIndex;
          return (
            <button
              key={step.id}
              type="button"
              disabled={!selectionWhileIdle}
              onClick={() => onSelectStep(i)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-all duration-200 group relative disabled:opacity-60 disabled:cursor-default ${
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent/50'
              } ${step.status === 'completed' ? 'animate-flash-green' : ''}`}
            >
              {isActive && (
                <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-primary" />
              )}
              <div className="relative">
                <StatusIcon status={step.status} type={step.type} />
              </div>
              <div className="flex-1 min-w-0">
                {/* Wrap instead of truncating: widening the sidebar now reveals the name,
                    and the title covers the case where someone keeps it narrow. */}
                <div className="text-sm font-medium leading-snug break-words" title={step.name}>{step.name}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  {step.status === 'running' ? (
                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${step.type === 'manual' ? 'text-warning' : 'text-primary'}`}>
                      {step.type === 'manual' ? 'Awaiting Action' : 'Processing...'}
                    </span>
                  ) : step.status === 'completed' ? (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-success">
                      Done
                    </span>
                  ) : step.status === 'error' ? (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-destructive">
                      Error
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {step.type === 'manual' ? 'Manual' : 'Auto'}
                    </span>
                  )}
                  {(step.status === 'completed' || step.status === 'running') && (
                    <span className="text-[10px] font-mono text-muted-foreground">
                      {formatTime(step.elapsedMs)}
                    </span>
                  )}
                </div>
              </div>
              <span className="text-[10px] font-mono text-muted-foreground">{i + 1}/{steps.length}</span>
            </button>
          );
        })}
      </nav>

      {/* Drag to widen — grab area is 8px but the visible line is 1px. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize step list"
        aria-valuenow={width}
        aria-valuemin={MIN_W}
        aria-valuemax={MAX_W}
        tabIndex={0}
        onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
        onDoubleClick={() => setWidth(288)}
        onKeyDown={onHandleKeyDown}
        title="Drag to resize · double-click to reset"
        className={`absolute right-0 top-0 h-full w-2 cursor-col-resize group
          focus:outline-none focus-visible:bg-primary/40
          ${dragging ? "bg-primary/40" : "hover:bg-primary/20"}`}
      >
        <div className="absolute right-0 top-1/2 -translate-y-1/2 h-8 w-1 rounded-full bg-border group-hover:bg-primary/60 transition-colors" />
      </div>
    </aside>
  );
}
