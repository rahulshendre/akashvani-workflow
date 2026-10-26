export type StepStatus = 'idle' | 'running' | 'completed' | 'error';
export type StepType = 'automated' | 'manual';

export interface PipelineStep {
  id: string;
  name: string;
  type: StepType;
  status: StepStatus;
  description: string;
  /** One line, in the user's terms: what this step actually does for them. */
  summary: string;
  elapsedMs: number;
  progress: number; // 0-100 for automated steps
  simulationDuration?: number; // ms, for automated
}

export interface LogEntry {
  id: string;
  timestamp: Date;
  stepName: string;
  message: string;
}

export interface PipelineState {
  steps: PipelineStep[];
  logs: LogEntry[];
  activeStepIndex: number;
  pipelineRunning: boolean;
  pipelineStartTime: number | null;
  pipelineElapsedMs: number;
  completed: boolean;
  /** When true, automated steps use longer showcase pacing; manual steps still require Mark as Done. */
  demoPlayback: boolean;
  /** IDs of the steps chosen on the Setup page. null = all steps. */
  selectedStepIds: string[] | null;
  /** User pressed Stop. Completed work is kept; Resume continues from here. */
  stopped: boolean;
}

export type PipelineAction =
  | { type: 'START_PIPELINE'; demo?: boolean }
  | { type: 'RESUME_AFTER_GOOGLE_AUTH' }
  | { type: 'ACTIVATE_STEP'; index: number }
  | { type: 'UPDATE_STEP_PROGRESS'; index: number; progress: number }
  | { type: 'UPDATE_STEP_ELAPSED'; index: number; elapsed: number }
  | { type: 'COMPLETE_STEP'; index: number }
  | { type: 'ERROR_STEP'; index: number }
  | { type: 'ADD_LOG'; entry: Omit<LogEntry, 'id'> }
  | { type: 'CLEAR_LOGS' }
  | { type: 'UPDATE_GLOBAL_ELAPSED'; elapsed: number }
  | { type: 'PIPELINE_COMPLETE' }
  | { type: 'RESET' }
  | { type: 'STOP_PIPELINE' }
  | { type: 'RESTORE_STEP_STATES'; stepStates: Record<string, string> };

let logCounter = 0;

/**
 * Steps the local Node backend actually performs (via SSE). Resuming these
 * requires a real run, so RESTORE_STEP_STATES must not fake them as 'running' —
 * that would let the simulation mark real work complete without doing it.
 */
const BACKEND_DRIVEN_STEP_IDS = new Set(['copy', 'compress', 'upload-gdrive']);

export const STEPS_CONFIG: Omit<PipelineStep, 'status' | 'elapsedMs' | 'progress' | 'simulationDuration'>[] = [
  {
    id: 'copy',
    name: 'Copy videos into the workspace',
    type: 'automated',
    summary: 'Copies your videos from the external drive onto this computer.',
    description:
      'Creates the Akashvani folder structure and copies every video from the folder you selected into "raw footage". ' +
      'Your original files on the external drive are never moved or changed — this only makes a working copy.',
  },
  {
    id: 'compress',
    name: 'Compress and add the watermark',
    type: 'automated',
    summary: 'Makes a smaller, watermarked copy of each video.',
    description:
      'Re-encodes each copied video at a lower bitrate and burns the watermark on top, saving the result into "source file". ' +
      'The raw footage stays untouched, so the full-quality copy is always still there. This is the slowest step — a long video can take a while.',
  },
  {
    id: 'upload-gdrive',
    name: 'Upload the videos to Google Drive',
    type: 'automated',
    summary: 'Puts the compressed videos into your Drive folder.',
    description:
      'Inside the Google Drive folder you chose, creates "<episode name> / episode - N / Source Video" and uploads the ' +
      'compressed, watermarked videos there. This is what the Language Experts will be able to see.',
  },
  {
    id: 'upload-feltiv-srt',
    name: 'Generate the AI subtitles',
    type: 'manual',
    summary: 'The app transcribes the episode itself — no separate transcription tool.',
    description:
      'Listens to the episode\'s own audio and writes the subtitles in the spoken language, cutting the cues at the real ' +
      'pauses so the timings line up. This runs on its own as part of the pipeline; if it could not (no key, Drive not ' +
      'connected, service down) you can start it here or upload an .srt yourself. ' +
      'Both the .srt and a Word version of it are saved to the "AI Subtitles" folder on Drive — the Word file is what the Language Expert will correct.',
  },
  {
    id: 'review-pass1',
    name: 'Language Expert review — first pass',
    type: 'manual',
    summary: 'LE 1 corrects the subtitles and uploads the Word file.',
    description:
      'The Language Expert opens the Word document, fixes the subtitle text, and uploads it here. ' +
      'It is saved to the "LE 1" folder on Drive, converted to a subtitle file, and that .srt is placed in the Editor folder. ' +
      'The alignment step below is then ticked off automatically.',
  },
  {
    id: 'align-srt',
    name: 'Align the subtitles in Premiere Pro',
    type: 'manual',
    summary: 'Nothing to do — completed automatically after LE 1 uploads.',
    description:
      'The subtitle file produced from the LE 1 Word document already carries the correct timings, so no manual alignment is needed. ' +
      'This step completes on its own.',
  },
  {
    id: 'upload-prproj',
    name: 'Add the Premiere Pro project file',
    type: 'manual',
    summary: 'Upload the .prproj you used to edit this episode.',
    description:
      'Saves the Premiere Pro project into the "Editor" folder for this episode, so the edit can be reopened later by whoever picks it up.',
  },
  {
    id: 'word-to-srt',
    name: 'Turn the Word file back into subtitles',
    type: 'automated',
    summary: 'Converts the corrected Word document into a subtitle file.',
    description:
      'Reads the Word document and writes a matching .srt with the same timings, ready to drop into Premiere Pro.',
  },
  {
    id: 'final-qc',
    name: 'Final quality check',
    type: 'manual',
    summary: 'Check timings, line length and style before sign-off.',
    description:
      'Go through the finished subtitles once more: timings line up with the audio, no line is too long to read, ' +
      'and the wording follows the style guide. Mark this done when you are satisfied.',
  },
  {
    id: 'review-pass3',
    name: 'Language Expert review — final pass',
    type: 'manual',
    summary: 'LE 3 uploads the final approved subtitle file.',
    description:
      'The last Language Expert uploads the final .srt for this episode. This is the version that goes forward to processing.',
  },
  {
    id: 'sls',
    name: 'SLS — subtitle language processing',
    type: 'automated',
    summary: 'Runs the Subtitle Language Service over the final subtitles.',
    description:
      'Processes the approved subtitle file through the Subtitle Language Service.',
  },
  {
    id: 'slc',
    name: 'SLC — compliance check',
    type: 'automated',
    summary: 'Checks the subtitles against the compliance rules.',
    description:
      'Runs Subtitle Language Compliance checks — character limits, reading speed and formatting rules.',
  },
  {
    id: 'roman-script',
    name: 'Convert to Roman script',
    type: 'manual',
    summary: 'Writes the finished subtitles in Roman letters, in the same words.',
    description:
      'Takes the final subtitle file from the last Language Expert pass and writes it in Roman letters — ' +
      'the same words written out in English script, not a translation. The timings are copied across untouched, ' +
      "and PlanetRead's agreed spellings are applied from the language's dictionary. Both the .srt and a review " +
      'Word file showing every correction are saved to the "AI Subtitles" folder on Drive.',
  },
];

export function createInitialState(selectedStepIds?: string[] | null): PipelineState {
  const stepsToUse =
    selectedStepIds && selectedStepIds.length > 0
      ? STEPS_CONFIG.filter(s => selectedStepIds.includes(s.id))
      : STEPS_CONFIG;
  return {
    steps: stepsToUse.map(s => ({
      ...s,
      status: 'idle' as StepStatus,
      elapsedMs: 0,
      progress: 0,
    })),
    logs: [],
    activeStepIndex: -1,
    pipelineRunning: false,
    pipelineStartTime: null,
    pipelineElapsedMs: 0,
    completed: false,
    demoPlayback: false,
    selectedStepIds: selectedStepIds ?? null,
    stopped: false,
  };
}

export function pipelineReducer(state: PipelineState, action: PipelineAction): PipelineState {
  switch (action.type) {
    case 'START_PIPELINE':
      return {
        ...state,
        stopped: false,
        pipelineRunning: true,
        pipelineStartTime: Date.now(),
        pipelineElapsedMs: 0,
        completed: false,
        demoPlayback: action.demo ?? false,
      };
    case 'RESUME_AFTER_GOOGLE_AUTH': {
      const iDrive = state.steps.findIndex((s) => s.id === 'upload-gdrive');
      if (iDrive < 0) return state;
      const steps = state.steps.map((s) => {
        if (s.id === 'copy' || s.id === 'compress') {
          return { ...s, status: 'completed' as StepStatus, progress: 100 };
        }
        if (s.id === 'upload-gdrive') {
          return { ...s, status: 'running' as StepStatus, progress: 0, elapsedMs: 0, simulationDuration: undefined };
        }
        return { ...s, status: 'idle' as StepStatus, progress: 0, elapsedMs: 0, simulationDuration: undefined };
      });
      return {
        ...state,
        steps,
        activeStepIndex: iDrive,
        pipelineRunning: true,
        pipelineStartTime: Date.now(),
        pipelineElapsedMs: 0,
        completed: false,
        demoPlayback: false,
      };
    }
    case 'ACTIVATE_STEP': {
      // Demo: ~2+ minutes for all 7 automated steps (17–22.5s each + short gaps); manual steps are never auto-skipped.
      const autoDuration = state.demoPlayback
        ? 17000 + Math.random() * 5500
        : 3000 + Math.random() * 5000;
      const steps = state.steps.map((s, i) =>
        i === action.index
          ? {
              ...s,
              status: 'running' as StepStatus,
              elapsedMs: 0,
              progress: 0,
              simulationDuration: s.type === 'automated' ? autoDuration : undefined,
            }
          : s
      );
      return { ...state, steps, activeStepIndex: action.index };
    }
    case 'UPDATE_STEP_PROGRESS': {
      const steps = state.steps.map((s, i) =>
        i === action.index ? { ...s, progress: action.progress } : s
      );
      return { ...state, steps };
    }
    case 'UPDATE_STEP_ELAPSED': {
      const steps = state.steps.map((s, i) =>
        i === action.index ? { ...s, elapsedMs: action.elapsed } : s
      );
      return { ...state, steps };
    }
    case 'COMPLETE_STEP': {
      const steps = state.steps.map((s, i) =>
        i === action.index ? { ...s, status: 'completed' as StepStatus, progress: 100 } : s
      );
      return { ...state, steps };
    }
    case 'ERROR_STEP': {
      const steps = state.steps.map((s, i) =>
        i === action.index ? { ...s, status: 'error' as StepStatus } : s
      );
      return { ...state, steps };
    }
    case 'ADD_LOG':
      return { ...state, logs: [...state.logs, { ...action.entry, id: `log-${++logCounter}` }] };
    case 'CLEAR_LOGS':
      return { ...state, logs: [] };
    case 'UPDATE_GLOBAL_ELAPSED':
      return { ...state, pipelineElapsedMs: action.elapsed };
    case 'PIPELINE_COMPLETE':
      return { ...state, pipelineRunning: false, completed: true };
    case 'STOP_PIPELINE': {
      // Freeze the run without losing progress. The step that was mid-flight
      // goes back to idle so its simulation timer tears down and it can be
      // re-run cleanly; every completed step keeps its tick.
      const steps = state.steps.map(s =>
        s.status === 'running'
          ? { ...s, status: 'idle' as StepStatus, progress: 0, simulationDuration: undefined }
          : s
      );
      return { ...state, steps, pipelineRunning: false, stopped: true };
    }
    case 'RESET':
      logCounter = 0;
      return createInitialState(state.selectedStepIds);
    case 'RESTORE_STEP_STATES': {
      // Mark everything the shared session says is finished. Never downgrade a
      // step that is already running or completed locally — a poll must not
      // undo work happening on this machine right now.
      const restored = state.steps.map(step => {
        if (action.stepStates[step.id] === 'complete' && step.status !== 'completed') {
          return { ...step, status: 'completed' as StepStatus, progress: 100 };
        }
        return step;
      });

      // Something is live on THIS machine — fold in the remote completions and
      // change nothing else. Moving activeStepIndex here would drag the user off
      // the step they are working on (a poll must never interrupt local work).
      if (state.activeStepIndex >= 0 && restored[state.activeStepIndex]?.status === 'running') {
        return { ...state, steps: restored, completed: false };
      }
      const runningIndex = restored.findIndex(s => s.status === 'running');
      if (runningIndex >= 0) {
        return { ...state, steps: restored, activeStepIndex: runningIndex, completed: false };
      }

      const firstPending = restored.findIndex(s => s.status !== 'completed');

      // Whole episode is done — show the summary.
      if (firstPending === -1) {
        return {
          ...state,
          steps: restored,
          activeStepIndex: -1,
          pipelineRunning: false,
          completed: true,
        };
      }

      const pending = restored[firstPending];

      // Steps the local backend owns can't be resumed by flipping a flag —
      // they need a real run, so leave them idle and let TopBar offer Run.
      if (BACKEND_DRIVEN_STEP_IDS.has(pending.id)) {
        return {
          ...state,
          steps: restored,
          activeStepIndex: firstPending,
          pipelineRunning: false,
          completed: false,
        };
      }

      // Activate the first unfinished step. Without this it stays 'idle' and
      // StepDetail renders no upload button, no Mark as Done, and no
      // share-code panel — a dead screen after resuming.
      const activated = restored.map((s, i) =>
        i === firstPending
          ? {
              ...s,
              status: 'running' as StepStatus,
              elapsedMs: 0,
              progress: 0,
              simulationDuration: s.type === 'automated' ? 3000 + Math.random() * 5000 : undefined,
            }
          : s
      );

      return {
        ...state,
        steps: activated,
        activeStepIndex: firstPending,
        pipelineRunning: true,
        pipelineStartTime: state.pipelineStartTime ?? Date.now(),
        completed: false,
      };
    }
    default:
      return state;
  }
}

export function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export const FAKE_LOG_MESSAGES: Record<string, string[]> = {
  'compress': ['Scanning input directory...', 'Found 12 episode files', 'Compressing batch_01.mp4...', 'Compressing batch_02.mp4...', 'Verifying output integrity...', 'Compression complete'],
  'copy': ['Initializing file transfer...', 'Copying compressed files to /system/intake/', 'Transferred 4.2 GB...', 'Verifying checksums...', 'Copy complete'],
  'upload-gdrive': ['Authenticating with Google Drive API...', 'Creating folder structure...', 'Uploading episode_01.mp4 (1.2 GB)...', 'Uploading episode_02.mp4 (980 MB)...', 'Upload verification passed', 'All files uploaded successfully'],
  'word-to-srt': ['Parsing Word document...', 'Extracting text blocks...', 'Converting timestamps to SRT format...', 'Validating subtitle timing...', 'Generated 847 subtitle entries', 'SRT conversion complete'],
  'sls': ['Initializing SLS engine...', 'Loading language models...', 'Processing subtitle segments...', 'Running linguistic analysis...', 'SLS processing complete'],
  'slc': ['Starting compliance checks...', 'Checking character limits...', 'Validating reading speed...', 'Verifying formatting rules...', 'All compliance checks passed'],
  'roman-script': ['Loading transliteration models...', 'Converting Devanagari to Roman script...', 'Processing 847 entries...', 'Validating transliteration accuracy...', 'Roman script conversion complete'],
};
