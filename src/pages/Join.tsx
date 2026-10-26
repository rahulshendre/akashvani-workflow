import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Loader2, LogOut } from 'lucide-react';
import { fetchSharedSession, updateSharedSession, ROLE_STEPS, ROLE_LABELS } from '@/lib/session-sync';
import { loadIdentity, clearIdentity } from '@/pages/Welcome';

const ROLES = ['le1', 'le3'] as const;
type Role = (typeof ROLES)[number];

function makeSessionId() {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function Join() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleJoin() {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed || !role) return;

    setLoading(true);
    setError(null);
    try {
      const session = await fetchSharedSession(trimmed);

      // Record who is taking this pass, so the editor can see which Language
      // Expert has the episode rather than just that a step is outstanding.
      const me = loadIdentity();
      if (me?.email) {
        updateSharedSession(trimmed, {}, undefined, { leEmail: me.email, leRole: role }).catch(() => {});
      }
      const roleSteps = ROLE_STEPS[role];
      // Only include steps that exist in the session's selected steps
      const sessionSelected = session.selected_steps ?? [];
      const visibleSteps = roleSteps.filter(
        s => sessionSelected.length === 0 || sessionSelected.includes(s)
      );
      const stepsParam = visibleSteps.length > 0 ? visibleSteps.join(',') : roleSteps.join(',');

      const params = new URLSearchParams({
        code: trimmed,
        role,
        steps: stepsParam,
        sessionId: makeSessionId(),
      });
      // Carry the Drive destination through the URL as well as leaving the
      // pipeline page to re-fetch it. Without a folder id the upload has nowhere
      // safe to go, so this must not depend on a second network round-trip.
      if (session.drive_folder_id) params.set('driveFolderId', session.drive_folder_id);
      if (session.drive_parent_name) params.set('driveParentName', session.drive_parent_name);

      navigate(`/pipeline?${params.toString()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to join session');
    } finally {
      setLoading(false);
    }
  }

  function handleCodeInput(val: string) {
    // Auto-format: strip non-alphanumeric, uppercase, prefix AK- if needed
    let cleaned = val.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (cleaned.length > 7) cleaned = cleaned.slice(0, 7);
    setCode(cleaned);
    setError(null);
  }

  const isValid = code.trim().length >= 3 && role !== null;

  const identity = loadIdentity();

  function logOut() {
    clearIdentity();
    navigate('/?switch=1', { replace: true });
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
      {/* Who this machine is signed in as, and a way out. Without this the saved
          Language Expert role is permanent — every launch lands back here. */}
      {identity && (
        <div className="fixed top-0 inset-x-0 h-12 px-6 flex items-center justify-end gap-3 text-xs">
          <span className="text-muted-foreground truncate">
            {identity.officeName} · {identity.email}
          </span>
          <button
            type="button"
            onClick={logOut}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            Log out
          </button>
        </div>
      )}

      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <Zap className="h-5 w-5 text-primary" />
          <span className="text-lg font-semibold text-foreground">Akashvani</span>
        </div>

        <h1 className="text-xl font-semibold text-foreground mb-1">Join Session</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Enter the code your Editor shared, then select your role.
        </p>

        {/* Code input */}
        <label className="block mb-4">
          <span className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">
            Session Code
          </span>
          <input
            type="text"
            value={code}
            onChange={e => handleCodeInput(e.target.value)}
            placeholder="AK-XXXX"
            maxLength={7}
            className="w-full px-4 py-3 rounded-lg border border-border bg-muted font-mono text-lg tracking-widest text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/50"
            onKeyDown={e => { if (e.key === 'Enter' && isValid) handleJoin(); }}
          />
        </label>

        {/* Role selection */}
        <div className="mb-6">
          <span className="block text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">
            Your Role
          </span>
          <div className="grid grid-cols-2 gap-2">
            {ROLES.map(r => (
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
                <div className="font-semibold">{ROLE_LABELS[r]}</div>
                <div className="text-[10px] mt-0.5 opacity-70">
                  {r === 'le1' ? 'First pass' : 'Final pass'}
                </div>
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-500 mb-4">{error}</p>
        )}

        <button
          type="button"
          onClick={handleJoin}
          disabled={!isValid || loading}
          className="w-full py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? 'Joining…' : 'Join Session'}
        </button>

        {/* This used to navigate to '/', which bounced straight back here via the
            Welcome redirect. It must clear the saved role to actually escape. */}
        <p className="text-center text-xs text-muted-foreground mt-4">
          Not a Language Expert?{' '}
          <button
            type="button"
            onClick={logOut}
            className="text-primary hover:underline"
          >
            Sign in as Editor
          </button>
        </p>
      </div>
    </div>
  );
}
