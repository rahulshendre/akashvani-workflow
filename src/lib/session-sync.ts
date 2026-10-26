const SYNC_BASE = 'https://akashvani-session.fly.dev';

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error';

export interface SharedSession {
  code: string;
  session_id: string;
  folder_name: string | null;
  episode_count: number;
  selected_steps: string[];
  step_states: Record<string, string>;
  current_step: string | null;
  /** Drive destination folder the editor picked — the LE uploads into this. */
  drive_folder_id: string | null;
  /** Drive episode folder name (derived from the first video's filename). */
  drive_parent_name: string | null;
  /** Which Language Expert took each pass, once they join. */
  le1_email: string | null;
  le2_email: string | null;
  le3_email: string | null;
  status?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSessionInput {
  sessionId: string;
  folderName?: string | null;
  episodeCount?: number;
  selectedSteps?: string[];
  stepStates?: Record<string, string>;
  currentStep?: string | null;
  editorEmail?: string | null;
  officeName?: string | null;
  driveFolderId?: string | null;
  driveParentName?: string | null;
}

export async function createSharedSession(data: CreateSessionInput): Promise<{ code: string }> {
  const res = await fetch(`${SYNC_BASE}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: data.sessionId,
      folderName: data.folderName,
      episodeCount: data.episodeCount,
      selectedSteps: data.selectedSteps,
      stepStates: data.stepStates,
      currentStep: data.currentStep,
      editorEmail: data.editorEmail,
      officeName: data.officeName,
      driveFolderId: data.driveFolderId,
      driveParentName: data.driveParentName,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to create shared session');
  }
  return res.json();
}

export async function fetchSharedSession(code: string): Promise<SharedSession> {
  const res = await fetch(`${SYNC_BASE}/sessions/${encodeURIComponent(code.toUpperCase())}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Session not found. Check the code and try again.');
  }
  return res.json();
}

export async function pollSharedSession(code: string): Promise<{
  step_states: Record<string, string>;
  current_step: string | null;
  updated_at: string;
}> {
  const res = await fetch(`${SYNC_BASE}/sessions/${encodeURIComponent(code.toUpperCase())}/poll`);
  if (!res.ok) throw new Error('Poll failed');
  return res.json();
}

export async function updateSharedSession(
  code: string,
  stepStates: Record<string, string>,
  currentStep?: string | null,
  actor?: { leEmail?: string | null; leRole?: string | null },
): Promise<void> {
  const res = await fetch(`${SYNC_BASE}/sessions/${encodeURIComponent(code.toUpperCase())}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stepStates, currentStep, ...actor }),
  });
  if (!res.ok) throw new Error('Sync update failed');
}

export interface AppUser {
  email: string;
  office_name: string | null;
  role: 'editor' | 'le';
  created_at: string;
  last_seen_at: string;
}

/**
 * Record someone signing in. Called for BOTH roles — this is the only place a
 * Language Expert is registered anywhere outside their own machine.
 * Best-effort: never block sign-in just because the sync server is unreachable.
 */
export async function registerUser(input: {
  email: string;
  officeName: string;
  role: 'editor' | 'le';
}): Promise<AppUser | null> {
  try {
    const res = await fetch(`${SYNC_BASE}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    return (await res.json()).user;
  } catch {
    return null;
  }
}

/** Everyone who has signed in, for an admin/overview view. */
export async function listUsers(): Promise<AppUser[]> {
  const res = await fetch(`${SYNC_BASE}/users`);
  if (!res.ok) throw new Error('Failed to list users');
  return (await res.json()).users;
}

export const ROLE_STEPS: Record<string, string[]> = {
  le1: ['review-pass1', 'align-srt'],
  le3: ['review-pass3'],
};

/**
 * Remove a session from the shared record. Local footage and files already on
 * Drive are NOT touched — this only removes it from the editor's list.
 */
export async function deleteSharedSession(code: string): Promise<void> {
  const res = await fetch(`${SYNC_BASE}/sessions/${encodeURIComponent(code.toUpperCase())}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Could not delete the session');
  }
}

export async function listSessionsByEmail(email: string): Promise<SharedSession[]> {
  const res = await fetch(`${SYNC_BASE}/sessions/by-email/${encodeURIComponent(email.toLowerCase())}`);
  if (!res.ok) throw new Error('Failed to fetch sessions');
  const data = await res.json();
  return data.sessions;
}

export const ROLE_LABELS: Record<string, string> = {
  editor: 'Editor',
  le1: 'LE 1',
  le2: 'LE 2',
  le3: 'LE 3',
};
