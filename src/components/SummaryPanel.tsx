import { PipelineStep, formatTime } from '@/lib/pipeline';
import { CheckCircle2, RotateCcw, Clock } from 'lucide-react';

interface SummaryPanelProps {
  steps: PipelineStep[];
  totalElapsedMs: number;
  onReset: () => void;
}

export function SummaryPanel({ steps, totalElapsedMs, onReset }: SummaryPanelProps) {
  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-success/20 mb-4 animate-pop-in">
            <CheckCircle2 className="h-8 w-8 text-success" />
          </div>
          <h2 className="text-2xl font-semibold text-foreground">Pipeline Complete</h2>
          <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
            Summary reflects the simulated run in this UI prototype — timings and statuses are for demonstration only.
          </p>
          <div className="flex items-center justify-center gap-2 mt-3 text-muted-foreground">
            <Clock className="h-4 w-4" />
            <span className="font-mono text-lg">{formatTime(totalElapsedMs)}</span>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card overflow-hidden mb-6">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground p-3">#</th>
                <th className="text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground p-3">Step</th>
                <th className="text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground p-3">Type</th>
                <th className="text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground p-3">Duration</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step, i) => (
                <tr key={step.id} className="border-b border-border last:border-0">
                  <td className="p-3 text-sm text-muted-foreground">{i + 1}</td>
                  <td className="p-3 text-sm text-foreground">{step.name}</td>
                  <td className="p-3">
                    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${
                      step.type === 'manual' ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary'
                    }`}>
                      {step.type}
                    </span>
                  </td>
                  <td className="p-3 text-sm font-mono text-right text-muted-foreground">{formatTime(step.elapsedMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="text-center">
          <button
            onClick={onReset}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors text-sm font-medium"
          >
            <RotateCcw className="h-4 w-4" />
            Run Again
          </button>
        </div>
      </div>
    </div>
  );
}
