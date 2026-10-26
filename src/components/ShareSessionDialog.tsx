import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Copy, Check, Loader2 } from 'lucide-react';
import { createSharedSession, CreateSessionInput } from '@/lib/session-sync';

interface ShareSessionDialogProps {
  sessionData: CreateSessionInput;
  existingCode?: string | null;
  onClose: () => void;
  onCodeGenerated?: (code: string) => void;
}

export function ShareSessionDialog({ sessionData, existingCode, onClose, onCodeGenerated }: ShareSessionDialogProps) {
  const [code, setCode] = useState<string | null>(existingCode ?? null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Read these through refs so `generate` keeps a stable identity. `sessionData`
  // is rebuilt on every parent render, and the parent re-renders every 100ms
  // while the pipeline timer runs — depending on it directly made the effect
  // below refire continuously and create a new session each time.
  const sessionDataRef = useRef(sessionData);
  sessionDataRef.current = sessionData;
  const onCodeGeneratedRef = useRef(onCodeGenerated);
  onCodeGeneratedRef.current = onCodeGenerated;

  const generate = useCallback(async () => {
    setError(null);
    try {
      const { code: newCode } = await createSharedSession(sessionDataRef.current);
      setCode(newCode);
      onCodeGeneratedRef.current?.(newCode);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create session');
    }
  }, []);

  // Exactly one code per dialog. The ref guard holds even if the effect is
  // re-run, so a render loop can never mint a second session.
  const requestedRef = useRef(false);
  useEffect(() => {
    if (existingCode || requestedRef.current) return;
    requestedRef.current = true;
    generate();
  }, [existingCode, generate]);

  function copyCode() {
    if (!code) return;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-sm mx-4 bg-card border border-border rounded-xl shadow-2xl p-6">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>

        <h2 className="text-base font-semibold text-foreground mb-1">Share Session</h2>
        <p className="text-[12px] text-muted-foreground mb-6">
          Share this code with your Language Expert so they can join and track their steps.
        </p>

        {error ? (
          <div className="text-sm text-red-500 mb-4">{error}</div>
        ) : !code ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 bg-muted rounded-lg px-4 py-3 mb-4">
              <span className="font-mono text-2xl font-bold tracking-widest text-foreground">
                {code}
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

            <ol className="space-y-1 text-[12px] text-muted-foreground list-none">
              <li className="flex gap-2"><span className="text-primary font-medium">1.</span> Language Expert opens Akashvani on their machine</li>
              <li className="flex gap-2"><span className="text-primary font-medium">2.</span> Clicks <strong className="text-foreground">Join Session</strong> and enters this code</li>
              <li className="flex gap-2"><span className="text-primary font-medium">3.</span> Selects their role (LE 1 / LE 2 / LE 3)</li>
            </ol>
          </>
        )}

        {error && (
          <button
            type="button"
            onClick={generate}
            className="mt-4 w-full px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
