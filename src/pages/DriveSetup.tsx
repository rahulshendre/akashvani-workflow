import { useEffect, useState } from 'react';
import { HardDrive, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { fetchDrives, configureDataDir, checkBackendHealth, DriveInfo } from '@/lib/api';

function fmtGB(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

function UsageBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const color = pct > 85 ? 'bg-destructive' : pct > 65 ? 'bg-warning' : 'bg-primary';
  return (
    <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden mt-1">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

type Phase = 'loading' | 'pick' | 'saving' | 'restarting' | 'error';

export default function DriveSetup() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [selected, setSelected] = useState<DriveInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDrives()
      .then(d => { setDrives(d); setPhase('pick'); })
      .catch(e => { setError(e.message); setPhase('error'); });
  }, []);

  async function handleConfirm() {
    if (!selected) return;
    setPhase('saving');
    try {
      await configureDataDir(selected.suggestedPath);
      setPhase('restarting');
      // Poll health until the new instance is up, then reload
      waitForRestart();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Configuration failed');
      setPhase('error');
    }
  }

  function waitForRestart() {
    let attempts = 0;
    const id = setInterval(async () => {
      attempts++;
      if (attempts > 40) { clearInterval(id); return; }
      const ok = await checkBackendHealth();
      if (ok) { clearInterval(id); window.location.href = '/'; }
    }, 1500);
  }

  if (phase === 'loading') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (phase === 'restarting') {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <CheckCircle2 className="h-12 w-12 text-primary" />
        <h2 className="text-xl font-semibold">Location saved!</h2>
        <p className="text-sm text-muted-foreground">
          Akashvani is restarting — this takes a few seconds…
        </p>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mt-2" />
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-6">
        <p className="text-destructive text-sm">{error}</p>
        <button
          onClick={() => { setError(null); setPhase('loading'); fetchDrives().then(d => { setDrives(d); setPhase('pick'); }).catch(e => { setError(e.message); setPhase('error'); }); }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-border text-sm hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" /> Retry
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card p-6 md:p-8 space-y-6">

        <div className="flex items-start gap-3">
          <HardDrive className="h-6 w-6 text-primary mt-0.5 shrink-0" />
          <div>
            <h1 className="text-xl font-semibold">Choose a storage location</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Select which drive to store the <span className="font-medium text-foreground">Akashvani Workflow</span> folder.
              It will hold your raw footage, compressed videos, uploads, and workflow data.
            </p>
          </div>
        </div>

        {drives.length === 0 ? (
          <p className="text-sm text-muted-foreground">No drives detected.</p>
        ) : (
          <div className="space-y-3">
            {drives.map(drive => {
              const isSelected = selected?.letter === drive.letter;
              const freePct = drive.total > 0 ? (drive.free / drive.total) * 100 : 0;
              return (
                <button
                  key={drive.letter}
                  type="button"
                  onClick={() => setSelected(drive)}
                  className={`w-full text-left rounded-lg border p-4 transition-colors ${
                    isSelected
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'border-border hover:border-primary/40 hover:bg-muted/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className={`h-9 w-9 rounded-md flex items-center justify-center text-sm font-bold ${isSelected ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
                        {drive.letter}:
                      </div>
                      <div>
                        <p className="text-sm font-medium">{drive.root}</p>
                        <p className="text-xs text-muted-foreground font-mono">{drive.suggestedPath}</p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-medium text-foreground">{fmtGB(drive.free)} free</p>
                      <p className="text-xs text-muted-foreground">of {fmtGB(drive.total)}</p>
                    </div>
                  </div>
                  <UsageBar used={drive.used} total={drive.total} />
                  <div className="flex justify-between mt-1">
                    <span className="text-[10px] text-muted-foreground">Used: {fmtGB(drive.used)}</span>
                    <span className={`text-[10px] font-medium ${freePct < 15 ? 'text-destructive' : 'text-muted-foreground'}`}>
                      {freePct.toFixed(0)}% free
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {selected && (
          <div className="rounded-md bg-muted/60 border border-border px-4 py-3 text-sm">
            <span className="text-muted-foreground">Akashvani Workflow will be created at: </span>
            <span className="font-mono font-medium text-foreground">{selected.suggestedPath}</span>
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="button"
            disabled={!selected || phase === 'saving'}
            onClick={handleConfirm}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 text-sm font-medium"
          >
            {phase === 'saving' ? (
              <><Loader2 className="h-4 w-4 animate-spin" />Saving…</>
            ) : (
              'Confirm Location'
            )}
          </button>
        </div>

      </div>
    </div>
  );
}
