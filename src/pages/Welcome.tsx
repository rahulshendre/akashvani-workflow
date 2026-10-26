import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Zap, Loader2, HardDrive, CheckCircle2 } from 'lucide-react';
import { registerUser } from '@/lib/session-sync';
import { fetchAuthStatus, AuthStatus } from '@/lib/api';

export interface Identity {
  email: string;
  officeName: string;
  role: 'editor' | 'le';
}

export function saveIdentity(id: Identity) {
  localStorage.setItem('akashvani-identity', JSON.stringify(id));
}

/** Forget who this machine is signed in as, so the Welcome form shows again. */
export function clearIdentity() {
  localStorage.removeItem('akashvani-identity');
}

export function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem('akashvani-identity');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function Welcome() {
  const navigate = useNavigate();
  const location = useLocation();
  const saved = loadIdentity();

  const [email, setEmail] = useState(saved?.email ?? '');
  const [officeName, setOfficeName] = useState(saved?.officeName ?? '');
  const [role, setRole] = useState<'editor' | 'le'>(saved?.role ?? 'editor');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /**
   * Google Drive connection, checked here rather than mid-pipeline. Every role
   * needs it — the editor to upload videos, the Language Experts to submit
   * their reviews — so asking once up front beats interrupting the run.
   */
  const [drive, setDrive] = useState<AuthStatus | null>(null);
  const [driveChecking, setDriveChecking] = useState(true);

  // Returning users skip the form — unless they explicitly came here to change
  // who they are. Without that escape hatch the saved role is permanent: someone
  // who once signed in as a Language Expert is redirected to /join on every
  // launch with no way back to this screen.
  useEffect(() => {
    // Wait for the Drive check before deciding — otherwise a returning user is
    // bounced onward before we know whether Drive still needs connecting.
    if (driveChecking) return;

    // Read the router's location, not window.location — inside a Router those
    // can disagree, and this guard is the only thing standing between a user and
    // a permanent role.
    const wantsSwitch = new URLSearchParams(location.search).has('switch');
    if (wantsSwitch) return;

    const identity = loadIdentity();
    if (!identity) return;

    // Hold them on this screen while Drive is unconnected. Tokens live in memory
    // only, so this is the normal case after any restart — skipping past here is
    // exactly what pushed the Google prompt into the middle of the workflow.
    if (drive?.configured && !drive.authenticated) return;

    navigate(identity.role === 'le' ? '/join' : '/editor', { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driveChecking, drive?.configured, drive?.authenticated]);

  function refreshDrive() {
    setDriveChecking(true);
    fetchAuthStatus()
      .then(setDrive)
      .catch(() => setDrive(null))
      .finally(() => setDriveChecking(false));
  }

  useEffect(() => { refreshDrive(); }, []);

  /**
   * Save the identity BEFORE leaving for Google, or the redirect loses what
   * they typed. `returnTo` brings them back to this screen afterwards.
   */
  function connectDrive() {
    if (!drive?.authUrl) return;
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedOffice = officeName.trim();
    if (trimmedEmail && trimmedOffice) {
      saveIdentity({ email: trimmedEmail, officeName: trimmedOffice, role });
    }
    const back = `/?switch=1`;
    const state = 'r:' + btoa(back).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = new URL(drive.authUrl, window.location.origin);
    url.searchParams.set('state', state);
    window.location.href = url.toString();
  }

  /** Signed in already, but parked here because Drive is not connected. */
  const heldForDrive = !!saved && !driveChecking && !!drive?.configured && !drive.authenticated;

  async function handleContinue() {
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedOffice = officeName.trim();
    if (!trimmedEmail || !trimmedOffice) {
      setError('Please fill in all fields.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    // Drive is needed by every role. Stopping here is the whole point: it used
    // to surface halfway through a run, or after a reviewer had already done
    // two days of work and tried to submit.
    if (drive?.configured && !drive.authenticated) {
      setError('Connect Google Drive first — the workflow cannot upload without it.');
      return;
    }

    const identity: Identity = { email: trimmedEmail, officeName: trimmedOffice, role };
    saveIdentity(identity);

    // Register in the shared directory — for Editors AND Language Experts.
    // Best-effort: a sync outage must not stop someone signing in locally.
    setSubmitting(true);
    await registerUser({ email: trimmedEmail, officeName: trimmedOffice, role });
    setSubmitting(false);

    navigate(role === 'le' ? '/join' : '/editor');
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <Zap className="h-5 w-5 text-primary" />
          <span className="text-lg font-semibold text-foreground">Akashvani Workflow</span>
        </div>

        <h1 className="text-xl font-semibold text-foreground mb-1">
          {heldForDrive ? 'One more thing' : 'Welcome'}
        </h1>
        <p className="text-sm text-muted-foreground mb-6">
          {heldForDrive
            ? 'Connect Google Drive to carry on. Doing it now means the workflow will not stop for it later.'
            : 'Tell us who you are to get started.'}
        </p>

        <div className="space-y-4 mb-6">
          <label className="block">
            <span className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">
              Work Email
            </span>
            <input
              type="email"
              value={email}
              onChange={e => { setEmail(e.target.value); setError(null); }}
              placeholder="you@example.com"
              className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
              onKeyDown={e => { if (e.key === 'Enter') handleContinue(); }}
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">
              Office Name
            </span>
            <input
              type="text"
              value={officeName}
              onChange={e => { setOfficeName(e.target.value); setError(null); }}
              placeholder="e.g. Mumbai Office"
              className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/50 text-sm"
              onKeyDown={e => { if (e.key === 'Enter') handleContinue(); }}
            />
          </label>

          <div>
            <span className="block text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">
              I am a…
            </span>
            <div className="grid grid-cols-2 gap-2">
              {(['editor', 'le'] as const).map(r => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  className={`py-3 rounded-lg border text-sm font-medium transition-colors ${
                    role === r
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-card text-muted-foreground hover:bg-muted/60'
                  }`}
                >
                  <div className="font-semibold">{r === 'editor' ? 'Editor' : 'Language Expert'}</div>
                  <div className="text-[10px] mt-0.5 opacity-70">
                    {r === 'editor' ? 'Starts episodes' : 'Reviews & uploads'}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Google Drive — connected here so the workflow never stops for it */}
        <div className="mb-6 rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-primary shrink-0" />
                <span className="text-sm font-medium">Google Drive</span>
                {drive?.authenticated && <CheckCircle2 className="h-4 w-4 text-success" />}
              </div>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {driveChecking
                  ? 'Checking…'
                  : !drive?.configured
                    ? 'Not configured on this computer — ask IT to set up config.env.'
                    : drive.authenticated
                      ? `Connected as ${drive.email ?? 'your Google account'}`
                      : 'Connect now so uploads never stop the workflow later.'}
              </p>
            </div>

            {!driveChecking && drive?.configured && !drive.authenticated && (
              <button
                type="button"
                onClick={connectDrive}
                className="shrink-0 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
              >
                Connect
              </button>
            )}
            {!driveChecking && drive?.authenticated && (
              <button
                type="button"
                onClick={refreshDrive}
                className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Recheck
              </button>
            )}
          </div>
        </div>
        {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

        <button
          type="button"
          onClick={handleContinue}
          disabled={submitting}
          className="w-full py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-60 transition-colors flex items-center justify-center gap-2"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? 'Signing in…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
