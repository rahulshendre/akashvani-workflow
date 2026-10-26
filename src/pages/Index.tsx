import { useReducer, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pipelineReducer, createInitialState, FAKE_LOG_MESSAGES } from '@/lib/pipeline';
import {
  isBackendStep, checkBackendHealth, startPipeline, resumeDrivePipeline,
  UploadedFile, fetchUploadSession, fetchPipelineState, recordStepComplete, fetchAuthStatus,
  stopPipeline,
} from '@/lib/api';
import { SyncStatus, updateSharedSession, pollSharedSession, fetchSharedSession } from '@/lib/session-sync';
import { TopBar } from '@/components/TopBar';
import { StepSidebar } from '@/components/StepSidebar';
import { StepDetail } from '@/components/StepDetail';
import { LogPanel } from '@/components/LogPanel';
import { SummaryPanel } from '@/components/SummaryPanel';
import { GoogleAuthBanner } from '@/components/GoogleAuthBanner';
import { ShareSessionDialog } from '@/components/ShareSessionDialog';
import { loadIdentity } from '@/pages/Welcome';

function makeSessionId() {
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function Index() {
  // Parse URL params first — selectedStepIds must exist before useReducer's init runs
  const queryParams = new URLSearchParams(window.location.search);
  const querySessionId = queryParams.get('sessionId');
  const shouldAutoStart = queryParams.get('autostart') === '1';
  const shouldResumeDrive = queryParams.get('resume_drive') === '1';
  const stepsParam = queryParams.get('steps');
  const selectedStepIds = stepsParam ? stepsParam.split(',').filter(Boolean) : null;
  const urlRole = queryParams.get('role') ?? null;
  const urlCode = queryParams.get('code') ?? null;
  const urlDriveFolderId = queryParams.get('driveFolderId') ?? null;
  const urlDriveParentName = queryParams.get('driveParentName') ?? null;

  const [state, dispatch] = useReducer(pipelineReducer, undefined, () => createInitialState(selectedStepIds));
  const [idlePreviewIndex, setIdlePreviewIndex] = useState<number | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [backendOnline, setBackendOnline] = useState(false);
  const [googleAuthUrl, setGoogleAuthUrl] = useState<string | null>(null);
  const [sharedCode, setSharedCode] = useState<string | null>(urlCode);
  // Drive destination for review uploads. On the editor's machine this comes
  // from the URL; on a Language Expert's machine it comes from the shared
  // session, which is the only way their device can know where to upload.
  const [driveCtx, setDriveCtx] = useState<{ driveFolderId: string | null; parentName: string | null }>({
    driveFolderId: urlDriveFolderId,
    parentName: urlDriveParentName,
  });
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  /** The real folder name for this episode — never the sessionId. */
  const [episodeName, setEpisodeName] = useState<string | null>(null);
  const [leUploads, setLeUploads] = useState<Record<string, { fileName: string; at: string }>>({});

  const [sessionId] = useState(querySessionId || makeSessionId);
  // Needed on the shared record, otherwise a code minted from this page has no
  // editor_email and never appears in that editor's episode list.
  const identity = useMemo(() => loadIdentity(), []);
  const sharedCodeRef = useRef(sharedCode);
  sharedCodeRef.current = sharedCode;

  const automationRef = useRef<number | null>(null);
  const globalTimerRef = useRef<number | null>(null);
  const stepTimerRef = useRef<number | null>(null);
  const stepStartRef = useRef<number>(0);
  const globalStartRef = useRef<number>(0);
  const sseRef = useRef<EventSource | null>(null);
  const autoStartTriggeredRef = useRef(false);
  const resumeDriveTriggeredRef = useRef(false);
  const leAutoStartTriggeredRef = useRef(false);

  // Stable refs for SSE handlers (avoid stale closures)
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const stepsRef = useRef(state.steps);
  stepsRef.current = state.steps;
  const activateStepRef = useRef<(i: number) => void>(() => {});

  // Check backend health on mount + handle OAuth redirect
  useEffect(() => {
    checkBackendHealth().then(setBackendOnline);
    fetchUploadSession(sessionId)
      .then((data) => {
        setUploadedFiles(data.files);
        if (data.folderName) setEpisodeName((prev) => prev ?? data.folderName);
      })
      .catch(() => {});

    const params = new URLSearchParams(window.location.search);
    if (params.get('auth_success')) {
      const resuming = params.get('resume_drive') === '1';
      dispatch({
        type: 'ADD_LOG',
        entry: {
          timestamp: new Date(),
          stepName: 'Google Drive',
          message: resuming
            ? 'Connected successfully — continuing at Drive upload (skipping copy & compress)'
            : urlRole && urlRole !== 'editor'
              ? 'Google Drive connected. Choose your file and upload it again to finish this step.'
              : 'Connected successfully — you can now run the pipeline',
        },
      });
      params.delete('auth_success');
      params.delete('auth_error');
      const next = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${next ? `?${next}` : ''}`);
    } else if (params.get('auth_error')) {
      dispatch({ type: 'ADD_LOG', entry: { timestamp: new Date(), stepName: 'Google Drive', message: `Auth failed: ${params.get('auth_error')}` } });
      params.delete('auth_success');
      params.delete('auth_error');
      const next = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${next ? `?${next}` : ''}`);
    }
  }, [sessionId]);

  // On mount: rebuild where this episode left off.
  //
  // Two sources, both needed:
  //   • the local backend — authoritative for work done on THIS machine, read
  //     from disk so it survives shutting the app or the machine down;
  //   • the shared Fly.io record — the only place a Language Expert's uploads
  //     from another machine show up.
  // A step is complete if EITHER says so; completion never gets un-set.
  useEffect(() => {
    if (!urlCode && !querySessionId) return;

    (async () => {
      const [backend, shared] = await Promise.all([
        querySessionId ? fetchPipelineState(querySessionId).catch(() => null) : null,
        urlCode ? fetchSharedSession(urlCode).catch(() => null) : null,
      ]);

      setDriveCtx(prev => ({
        driveFolderId: backend?.driveFolderId ?? shared?.drive_folder_id ?? prev.driveFolderId,
        parentName: backend?.parentName ?? shared?.drive_parent_name ?? prev.parentName,
      }));

      // Keep whatever the upload session already gave us rather than nulling it.
      setEpisodeName(prev => backend?.folderName ?? shared?.folder_name ?? prev);
      setLeUploads(backend?.leUploads ?? {});

      // Reuse the code this episode already has. Without this, pressing Share on
      // a resumed episode minted a SECOND session row — a duplicate with its own
      // code, which is how one episode turned into two in the list.
      if (!urlCode && backend?.code) setSharedCode(backend.code);

      const merged = { ...(shared?.step_states ?? {}), ...(backend?.stepStates ?? {}) };

      // Dispatch even when empty — this is what activates the first pending
      // step and gives the detail pane its controls.
      if (backend || shared) {
        dispatch({ type: 'RESTORE_STEP_STATES', stepStates: merged });
      }

      // Push anything the backend knew but the shared record didn't, so the
      // editor's session list shows real progress instead of manual steps only.
      if (urlCode && backend?.stepStates && Object.keys(backend.stepStates).length > 0) {
        const missing: Record<string, string> = {};
        for (const [id, value] of Object.entries(backend.stepStates)) {
          if (shared?.step_states?.[id] !== 'complete') missing[id] = String(value);
        }
        if (Object.keys(missing).length > 0) {
          updateSharedSession(urlCode, missing).catch(() => {});
        }
      }
    })();
  // Only run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addLog = useCallback((stepName: string, message: string) => {
    dispatch({ type: 'ADD_LOG', entry: { timestamp: new Date(), stepName, message } });
  }, []);

  /**
   * Persist a completion the FRONTEND performed, to both the local backend
   * (survives closing the app) and the shared record (visible to other
   * machines). Steps this backend runs itself already record locally, so this
   * exists for simulated steps and plain "Mark as Done" ones — without it those
   * were forgotten and resume jumped back to the earliest of them.
   */
  const recordCompletion = useCallback((stepId: string) => {
    recordStepComplete(sessionId, stepId).catch(() => {});
    const code = sharedCodeRef.current;
    if (code) updateSharedSession(code, { [stepId]: 'complete' }).catch(() => {});
  }, [sessionId]);
  const recordCompletionRef = useRef(recordCompletion);
  recordCompletionRef.current = recordCompletion;

  // Global timer
  useEffect(() => {
    if (state.pipelineRunning && state.pipelineStartTime) {
      globalStartRef.current = state.pipelineStartTime;
      globalTimerRef.current = window.setInterval(() => {
        dispatch({ type: 'UPDATE_GLOBAL_ELAPSED', elapsed: Date.now() - globalStartRef.current });
      }, 100);
    }
    return () => { if (globalTimerRef.current) clearInterval(globalTimerRef.current); };
  }, [state.pipelineRunning, state.pipelineStartTime]);

  // Per-step timer
  useEffect(() => {
    const idx = state.activeStepIndex;
    if (idx >= 0 && state.steps[idx]?.status === 'running') {
      stepStartRef.current = Date.now();
      stepTimerRef.current = window.setInterval(() => {
        dispatch({ type: 'UPDATE_STEP_ELAPSED', index: idx, elapsed: Date.now() - stepStartRef.current });
      }, 100);
    }
    return () => { if (stepTimerRef.current) clearInterval(stepTimerRef.current); };
  }, [state.activeStepIndex, state.steps[state.activeStepIndex]?.status]);

  const activateStep = useCallback((index: number) => {
    dispatch({ type: 'ACTIVATE_STEP', index });
  }, []);
  activateStepRef.current = activateStep;

  const advanceAfterStepComplete = useCallback(
    (idx: number) => {
      const gap = state.demoPlayback ? 450 : 350;
      if (idx + 1 < state.steps.length) {
        setTimeout(() => activateStep(idx + 1), gap);
      } else {
        dispatch({ type: 'PIPELINE_COMPLETE' });
      }
    },
    [state.steps.length, state.demoPlayback, activateStep]
  );

  // Automated step simulation — skips backend-driven steps when backend is active
  const s = state.activeStepIndex >= 0 ? state.steps[state.activeStepIndex] : undefined;
  const automatedRunKey =
    s?.type === 'automated' && s.status === 'running' && s.simulationDuration
      ? `${state.activeStepIndex}-${s.id}-${s.simulationDuration}`
      : null;

  useEffect(() => {
    if (!automatedRunKey) return;
    const idx = state.activeStepIndex;
    const step = state.steps[idx];
    if (!step || step.type !== 'automated' || step.status !== 'running' || !step.simulationDuration) return;

    // Backend owns these steps when it's running — SSE events will drive them
    if (backendOnline && isBackendStep(step.id) && sseRef.current) return;

    const duration = step.simulationDuration;
    const messages = FAKE_LOG_MESSAGES[step.id] || ['Processing...', 'Working...', 'Done.'];
    const msgInterval = Math.max(duration / (messages.length + 1), 80);
    let msgIndex = 0;

    const startTime = Date.now();
    const progressInterval = window.setInterval(() => {
      const elapsed = Date.now() - startTime;
      dispatch({ type: 'UPDATE_STEP_PROGRESS', index: idx, progress: Math.min((elapsed / duration) * 100, 99) });
    }, 100);

    const logTimer = window.setInterval(() => {
      if (msgIndex < messages.length) {
        addLog(step.name, messages[msgIndex]);
        msgIndex++;
      }
    }, msgInterval);

    automationRef.current = window.setTimeout(() => {
      clearInterval(progressInterval);
      clearInterval(logTimer);
      addLog(step.name, 'Done.');
      dispatch({ type: 'COMPLETE_STEP', index: idx });
      // Simulated steps (word-to-srt, sls, slc, roman-script) finish here and
      // nowhere else — record them or they vanish on restart.
      recordCompletionRef.current(step.id);
      const totalSteps = state.steps.length;
      if (idx + 1 < totalSteps) {
        setTimeout(() => activateStep(idx + 1), state.demoPlayback ? 450 : 350);
      } else {
        dispatch({ type: 'PIPELINE_COMPLETE' });
      }
    }, duration);

    return () => {
      clearInterval(progressInterval);
      clearInterval(logTimer);
      if (automationRef.current) clearTimeout(automationRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automatedRunKey, state.activeStepIndex, state.steps.length, state.demoPlayback, backendOnline, addLog, activateStep]);

  // Manual step: log waiting
  useEffect(() => {
    const idx = state.activeStepIndex;
    if (idx < 0) return;
    const step = state.steps[idx];
    if (!step || step.type !== 'manual' || step.status !== 'running') return;
    addLog(step.name, 'Waiting for human action...');
  }, [state.activeStepIndex, state.steps[state.activeStepIndex]?.status, addLog]);

  // A Language Expert needs Drive access to submit at all, so surface the
  // prompt on arrival rather than after they have done the review and hit a
  // wall on upload.
  useEffect(() => {
    if (!urlRole || urlRole === 'editor') return;
    fetchAuthStatus()
      .then((status) => {
        if (!status.authenticated && status.authUrl) {
          const returnTo = `${window.location.pathname}${window.location.search}`;
          const url = new URL(status.authUrl);
          url.searchParams.set('state', `r:${btoa(returnTo).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`);
          setGoogleAuthUrl(url.toString());
        }
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // LE auto-start: activate first non-completed step after restore settles
  const isLERole = urlRole && urlRole !== 'editor';
  useEffect(() => {
    if (!isLERole || leAutoStartTriggeredRef.current) return;
    // Wait briefly so RESTORE_STEP_STATES (which is async) can run first
    const timer = window.setTimeout(() => {
      if (leAutoStartTriggeredRef.current) return;
      // RESTORE_STEP_STATES normally activates the first pending step already.
      // Only step in if it didn't (e.g. the shared session couldn't be reached),
      // otherwise this races the restore and activates the wrong step.
      if (stepsRef.current.some(s => s.status === 'running')) return;
      leAutoStartTriggeredRef.current = true;
      dispatch({ type: 'START_PIPELINE', demo: false });
      window.setTimeout(() => {
        const firstPending = stepsRef.current.findIndex(s => s.status !== 'completed');
        if (firstPending >= 0) activateStepRef.current(firstPending);
        else dispatch({ type: 'PIPELINE_COMPLETE' });
      }, 300);
    }, 900);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLERole]);

  // Fly.io session poll — every 15 s when a code is active
  useEffect(() => {
    const code = sharedCodeRef.current;
    if (!code) return;
    setSyncStatus('syncing');

    async function doPoll() {
      const c = sharedCodeRef.current;
      if (!c) return;
      setSyncStatus('syncing');
      try {
        const data = await pollSharedSession(c);
        // Apply what came back — this is how the editor learns that a Language
        // Expert on another machine finished their step. The reducer refuses to
        // disturb a step running locally, so folding this in is safe.
        if (data.step_states && Object.keys(data.step_states).length > 0) {
          dispatchRef.current({ type: 'RESTORE_STEP_STATES', stepStates: data.step_states });
        }
        setLastSyncAt(Date.now());
        setSyncStatus('synced');
      } catch {
        setSyncStatus('error');
      }
    }

    doPoll();
    const id = window.setInterval(doPoll, 15_000);
    return () => clearInterval(id);
  }, [sharedCode]);

  function openSSE(sid: string) {
    const es = new EventSource(`/api/pipeline/events?sessionId=${sid}`);

    es.addEventListener('log', (e: MessageEvent) => {
      const { stepId, message } = JSON.parse(e.data);
      const step = stepsRef.current.find(s => s.id === stepId);
      const stepName = step ? step.name : stepId;
      dispatchRef.current({ type: 'ADD_LOG', entry: { timestamp: new Date(), stepName, message } });
    });

    es.addEventListener('progress', (e: MessageEvent) => {
      const { stepId, progress } = JSON.parse(e.data);
      const idx = stepsRef.current.findIndex(s => s.id === stepId);
      if (idx >= 0) dispatchRef.current({ type: 'UPDATE_STEP_PROGRESS', index: idx, progress });
    });

    es.addEventListener('step_complete', (e: MessageEvent) => {
      const { stepId } = JSON.parse(e.data);
      // Mirror automated completions into the shared record. Without this only
      // manual steps ever reached Fly.io, so the session list under-reported
      // progress and resume sent the editor back to re-run finished work.
      const code = sharedCodeRef.current;
      if (code) updateSharedSession(code, { [stepId]: 'complete' }).catch(() => {});

      const idx = stepsRef.current.findIndex(s => s.id === stepId);
      if (idx >= 0) {
        dispatchRef.current({ type: 'COMPLETE_STEP', index: idx });
        setTimeout(() => {
          const next = idx + 1;
          if (next < stepsRef.current.length) activateStepRef.current(next);
          else dispatchRef.current({ type: 'PIPELINE_COMPLETE' });
        }, 350);
      }
    });

    es.addEventListener('step_error', (e: MessageEvent) => {
      const { stepId, error } = JSON.parse(e.data);
      const idx = stepsRef.current.findIndex(s => s.id === stepId);
      if (idx >= 0) dispatchRef.current({ type: 'ERROR_STEP', index: idx });
      dispatchRef.current({ type: 'ADD_LOG', entry: { timestamp: new Date(), stepName: 'Pipeline', message: `Error: ${error}` } });
    });

    // Without this, a backend crash was swallowed: the server sent
    // pipeline_error, nothing listened, and the step spun at 0% indefinitely.
    es.addEventListener('pipeline_error', (e: MessageEvent) => {
      const { error, stepId } = JSON.parse(e.data);
      const idx = stepId
        ? stepsRef.current.findIndex(s => s.id === stepId)
        : stepsRef.current.findIndex(s => s.status === 'running');
      if (idx >= 0) dispatchRef.current({ type: 'ERROR_STEP', index: idx });
      dispatchRef.current({
        type: 'ADD_LOG',
        entry: { timestamp: new Date(), stepName: 'Pipeline', message: `Failed: ${error}` },
      });
      dispatchRef.current({ type: 'STOP_PIPELINE' });
    });

    es.addEventListener('pipeline_stopped', () => {
      dispatchRef.current({ type: 'STOP_PIPELINE' });
    });

    es.addEventListener('auth_required', (e: MessageEvent) => {
      const { authUrl } = JSON.parse(e.data);
      setGoogleAuthUrl(authUrl);
    });

    es.onerror = () => {
      // SSE dropped — future steps will fall back to simulation
    };

    return es;
  }

  const handleRun = useCallback(async () => {
    setIdlePreviewIndex(null);

    const online = await checkBackendHealth();
    setBackendOnline(online);

    const hasFiles = uploadedFiles.length > 0;
    const useBackend = online && hasFiles;

    if (useBackend) {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      // Open SSE before dispatching so the effect guard (sseRef.current check) works
      sseRef.current = openSSE(sessionId);
    }

    dispatch({ type: 'START_PIPELINE', demo: false });
    addLog('Pipeline', useBackend
      ? 'Pipeline started — backend active'
      : online && !hasFiles
        ? 'Pipeline started — no files uploaded, running simulation'
        : 'Pipeline started — backend offline, running simulation'
    );
    // Continue from the first unfinished step, not step 0 — on a resumed
    // session restarting at 0 would overwrite the restored completions.
    const resumeFrom = Math.max(stepsRef.current.findIndex(s => s.status !== 'completed'), 0);
    setTimeout(() => activateStep(resumeFrom), 200);

    if (useBackend) {
      try {
        await startPipeline(
          sessionId,
          uploadedFiles.map(f => f.id),
          selectedStepIds ?? undefined,
          driveCtx.driveFolderId,
          sharedCodeRef.current,
        );
      } catch (err) {
        addLog('Pipeline', `Backend error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [addLog, activateStep, sessionId, uploadedFiles]);

  const handleResumeDriveAfterAuth = useCallback(async () => {
    setIdlePreviewIndex(null);
    setGoogleAuthUrl(null);

    const online = await checkBackendHealth();
    setBackendOnline(online);
    if (!online) {
      addLog('Pipeline', 'Cannot resume Google Drive — backend offline');
      throw new Error('Backend offline');
    }

    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    sseRef.current = openSSE(sessionId);

    dispatch({ type: 'RESUME_AFTER_GOOGLE_AUTH' });
    addLog('Pipeline', 'Resuming at Google Drive — using existing compressed files (no re-copy, no re-compress)');

    try {
      await resumeDrivePipeline(sessionId);
      sessionStorage.setItem(`akashvani-resume-drive-done:${sessionId}`, '1');
      const p = new URLSearchParams(window.location.search);
      p.delete('resume_drive');
      p.delete('auth_success');
      p.delete('auth_error');
      const next = p.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${next ? `?${next}` : ''}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog('Pipeline', `Resume failed: ${msg}`);
      const iDrive = stepsRef.current.findIndex((s) => s.id === 'upload-gdrive');
      if (iDrive >= 0) dispatch({ type: 'ERROR_STEP', index: iDrive });
      throw err;
    }
  }, [addLog, sessionId]);

  useEffect(() => {
    if (!shouldAutoStart || shouldResumeDrive || autoStartTriggeredRef.current) return;
    if (uploadedFiles.length === 0) return;
    autoStartTriggeredRef.current = true;
    handleRun();
  }, [shouldAutoStart, shouldResumeDrive, uploadedFiles.length, handleRun]);

  useEffect(() => {
    if (!shouldResumeDrive || resumeDriveTriggeredRef.current) return;
    if (sessionStorage.getItem(`akashvani-resume-drive-done:${sessionId}`) === '1') return;
    resumeDriveTriggeredRef.current = true;
    void handleResumeDriveAfterAuth().catch(() => {
      resumeDriveTriggeredRef.current = false;
    });
  }, [shouldResumeDrive, sessionId, handleResumeDriveAfterAuth]);

  const handleRunDemo = useCallback(() => {
    setIdlePreviewIndex(null);
    dispatch({ type: 'START_PIPELINE', demo: true });
    addLog('Pipeline', 'Showcase run started — slower automated steps (~2 min); manual steps need Mark as Done');
    setTimeout(() => activateStep(0), 200);
  }, [addLog, activateStep]);

  const handleMarkDone = useCallback(() => {
    const idx = state.activeStepIndex;
    if (idx < 0) return;
    const step = state.steps[idx];
    addLog(step.name, 'Marked as complete by user');
    dispatch({ type: 'COMPLETE_STEP', index: idx });

    // Persist locally AND to the shared record. Upload-backed steps already
    // record server-side, but plain Mark-as-Done ones (final-qc) do not.
    recordStepComplete(sessionId, step.id).catch(() => {});
    const code = sharedCodeRef.current;
    if (code) {
      const nextStep = idx + 1 < state.steps.length ? state.steps[idx + 1].id : null;
      updateSharedSession(code, { [step.id]: 'complete' }, nextStep).catch(() => {});
    }

    // After LE1 uploads their Word file, auto-complete the alignment step
    const alignIdx = state.steps.findIndex(s => s.id === 'align-srt');
    if (step.id === 'review-pass1' && alignIdx >= 0 && idx + 1 === alignIdx) {
      const gap = state.demoPlayback ? 450 : 350;
      setTimeout(() => {
        activateStep(alignIdx);
        setTimeout(() => {
          addLog(state.steps[alignIdx].name, 'Auto-completed — alignment handled by LE 1 Word-to-SRT conversion');
          dispatch({ type: 'COMPLETE_STEP', index: alignIdx });
          recordStepComplete(sessionId, 'align-srt').catch(() => {});
          if (code) updateSharedSession(code, { 'align-srt': 'complete' }).catch(() => {});
          advanceAfterStepComplete(alignIdx);
        }, 600);
      }, gap);
    } else {
      advanceAfterStepComplete(idx);
    }
  }, [state.activeStepIndex, state.steps, state.demoPlayback, sessionId, addLog, activateStep, advanceAfterStepComplete]);

  const handleStop = useCallback(async () => {
    // Tear the stream down first so no in-flight step_complete arrives after
    // the user has already stopped and re-marks a step as running.
    if (automationRef.current) clearTimeout(automationRef.current);
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }

    dispatch({ type: 'STOP_PIPELINE' });
    addLog('Pipeline', 'Stopping — finishing work is halted, completed steps are kept.');

    try {
      const { encodesKilled } = await stopPipeline(sessionId);
      addLog('Pipeline', encodesKilled > 0
        ? `Stopped. ${encodesKilled} running encode(s) cancelled.`
        : 'Stopped.');
    } catch {
      // Backend already gone or unreachable — the UI is stopped either way.
      addLog('Pipeline', 'Stopped locally (backend did not confirm).');
    }
  }, [addLog, sessionId]);

  const handleReset = useCallback(() => {
    if (automationRef.current) clearTimeout(automationRef.current);
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    setIdlePreviewIndex(null);
    setGoogleAuthUrl(null);
    sessionStorage.removeItem(`akashvani-resume-drive-done:${sessionId}`);
    resumeDriveTriggeredRef.current = false;
    autoStartTriggeredRef.current = false;
    dispatch({ type: 'RESET' });
  }, [sessionId]);

  const handleSelectSidebarStep = useCallback(
    (index: number) => {
      if (state.completed) return;
      // Clicking the step that's already active clears the preview and returns
      // to it, so the sidebar is never a dead control.
      setIdlePreviewIndex(index === state.activeStepIndex ? null : index);
    },
    [state.activeStepIndex, state.completed]
  );

  // A sidebar pick wins over the active step. The old order put activeStepIndex
  // first, so after a resume (which sets it) clicking a step changed nothing.
  const displayStepIndex =
    idlePreviewIndex ?? (state.activeStepIndex >= 0 ? state.activeStepIndex : -1);
  const displayStep = displayStepIndex >= 0 ? state.steps[displayStepIndex] : null;
  const isPreviewOnly =
    !state.completed && idlePreviewIndex !== null && idlePreviewIndex !== state.activeStepIndex;

  // Memoised so it doesn't get a new identity on every 100ms timer tick.
  const shareSessionData = useMemo(() => ({
    sessionId,
    // Was `sessionId` here, which wrote a random id like s-1786524574976-p5i6zo
    // into the episode list as if it were the episode's name.
    folderName: episodeName,
    episodeCount: 1,
    selectedSteps: selectedStepIds ?? state.steps.map(s => s.id),
    stepStates: Object.fromEntries(
      state.steps.filter(s => s.status === 'completed').map(s => [s.id, 'complete'])
    ),
    currentStep: state.steps[state.activeStepIndex]?.id ?? null,
    editorEmail: identity?.email ?? null,
    officeName: identity?.officeName ?? null,
    driveFolderId: driveCtx.driveFolderId,
    driveParentName: driveCtx.parentName,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [sessionId, episodeName, selectedStepIds, state.steps, state.activeStepIndex,
       identity, driveCtx.driveFolderId, driveCtx.parentName]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <TopBar
        pipelineRunning={state.pipelineRunning}
        completed={state.completed}
        demoPlayback={state.demoPlayback}
        elapsedMs={state.pipelineElapsedMs}
        onRun={handleRun}
        onRunDemo={handleRunDemo}
        onReset={handleReset}
        onStop={handleStop}
        stopped={state.stopped}
        role={urlRole}
        syncCode={sharedCode}
        syncStatus={syncStatus}
        lastSyncAt={lastSyncAt}
        onShare={() => setShareDialogOpen(true)}
      />
      {googleAuthUrl && (
        <GoogleAuthBanner authUrl={googleAuthUrl} onDismiss={() => setGoogleAuthUrl(null)} />
      )}
      {shareDialogOpen && (
        <ShareSessionDialog
          sessionData={shareSessionData}
          existingCode={sharedCode}
          onCodeGenerated={setSharedCode}
          onClose={() => setShareDialogOpen(false)}
        />
      )}
      <div className="flex flex-1 overflow-hidden">
        <StepSidebar
          steps={state.steps}
          activeStepIndex={displayStepIndex}
          onSelectStep={handleSelectSidebarStep}
          selectionWhileIdle={!state.completed}
        />
        <div className="flex-1 flex flex-col overflow-hidden">
          {state.completed ? (
            <SummaryPanel
              steps={state.steps}
              totalElapsedMs={state.pipelineElapsedMs}
              onReset={handleReset}
            />
          ) : (
            <StepDetail
              step={displayStep}
              stepIndex={displayStepIndex}
              totalSteps={state.steps.length}
              isPreviewOnly={isPreviewOnly}
              onBackToCurrent={
                state.activeStepIndex >= 0 ? () => setIdlePreviewIndex(null) : undefined
              }
              onMarkDone={handleMarkDone}
              sessionId={sessionId}
              role={urlRole}
              syncCode={sharedCode}
              onShare={() => setShareDialogOpen(true)}
              drive={driveCtx}
              leUploads={leUploads}
            />
          )}
          <LogPanel logs={state.logs} onClear={() => dispatch({ type: 'CLEAR_LOGS' })} />
        </div>
      </div>
    </div>
  );
}
