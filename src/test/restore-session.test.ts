import { describe, it, expect } from 'vitest';
import { pipelineReducer, createInitialState } from '@/lib/pipeline';
import { parseDriveFolderId } from '@/lib/api';

// Resuming an episode the next day: the shared session says some steps are
// done, and the pane must come back ACTIONABLE rather than as a dead screen.
const SELECTED = [
  'copy', 'compress', 'upload-gdrive', 'upload-feltiv-srt',
  'upload-prproj', 'review-pass1', 'align-srt',
];

describe('RESTORE_STEP_STATES', () => {
  it('activates the first pending manual step so its controls render', () => {
    const next = pipelineReducer(createInitialState(SELECTED), {
      type: 'RESTORE_STEP_STATES',
      stepStates: {
        copy: 'complete', compress: 'complete',
        'upload-gdrive': 'complete', 'upload-feltiv-srt': 'complete',
      },
    });

    expect(next.activeStepIndex).toBe(4);
    // LE 1 now sits directly behind the AI subtitle file, so it is the first
    // thing waiting once that upload is done.
    expect(next.steps[4].id).toBe('review-pass1');
    // Regression: this used to stay 'idle', and StepDetail gates every
    // action panel on status === 'running', so nothing was clickable.
    expect(next.steps[4].status).toBe('running');
    expect(next.pipelineRunning).toBe(true);
    expect(next.completed).toBe(false);
    expect(next.steps.slice(0, 4).every(s => s.status === 'completed')).toBe(true);
  });

  it('leaves backend-driven steps idle so they get a real run, not a simulated one', () => {
    const next = pipelineReducer(createInitialState(SELECTED), {
      type: 'RESTORE_STEP_STATES',
      stepStates: { copy: 'complete' },
    });

    expect(next.steps[1].id).toBe('compress');
    expect(next.steps[1].status).toBe('idle');
    expect(next.pipelineRunning).toBe(false);
  });

  it('marks the episode complete when every selected step is done', () => {
    const all = Object.fromEntries(SELECTED.map(id => [id, 'complete']));
    const next = pipelineReducer(createInitialState(SELECTED), {
      type: 'RESTORE_STEP_STATES',
      stepStates: all,
    });

    expect(next.completed).toBe(true);
    expect(next.pipelineRunning).toBe(false);
  });

  it('does not yank the view off a step that is running locally', () => {
    const started = pipelineReducer(createInitialState(SELECTED), {
      type: 'ACTIVATE_STEP',
      index: 4,
    });
    expect(started.steps[4].status).toBe('running');

    const polled = pipelineReducer(started, {
      type: 'RESTORE_STEP_STATES',
      stepStates: { copy: 'complete', compress: 'complete' },
    });

    expect(polled.activeStepIndex).toBe(4);
    expect(polled.steps[4].status).toBe('running');
  });

  it('gives a Language Expert their own step, active, with no completions yet', () => {
    const next = pipelineReducer(createInitialState(['review-pass1', 'align-srt']), {
      type: 'RESTORE_STEP_STATES',
      stepStates: {},
    });

    expect(next.steps[0].id).toBe('review-pass1');
    expect(next.steps[0].status).toBe('running');
    expect(next.pipelineRunning).toBe(true);
  });

  it('keeps completions from a second source (an LE on another machine)', () => {
    const first = pipelineReducer(createInitialState(SELECTED), {
      type: 'RESTORE_STEP_STATES',
      stepStates: { copy: 'complete', compress: 'complete', 'upload-gdrive': 'complete' },
    });
    // A later poll reports the LE's work without repeating the earlier steps.
    const second = pipelineReducer(first, {
      type: 'RESTORE_STEP_STATES',
      stepStates: { 'upload-feltiv-srt': 'complete' },
    });

    expect(second.steps.find(s => s.id === 'copy')!.status).toBe('completed');
    expect(second.steps.find(s => s.id === 'upload-feltiv-srt')!.status).toBe('completed');
  });
});

describe('parseDriveFolderId', () => {
  const ID = '1A2b3C4d5E6f7G8h9I0jKlMnOp';

  it('reads the ID out of the shapes editors actually paste', () => {
    expect(parseDriveFolderId(`https://drive.google.com/drive/folders/${ID}`)).toBe(ID);
    expect(parseDriveFolderId(`https://drive.google.com/drive/folders/${ID}?usp=sharing`)).toBe(ID);
    expect(parseDriveFolderId(`https://drive.google.com/drive/folders/${ID}?usp=drive_link`)).toBe(ID);
    expect(parseDriveFolderId(`https://drive.google.com/drive/u/0/folders/${ID}`)).toBe(ID);
    expect(parseDriveFolderId(`https://drive.google.com/open?id=${ID}`)).toBe(ID);
    expect(parseDriveFolderId(ID)).toBe(ID);
    expect(parseDriveFolderId(`  ${ID}  `)).toBe(ID);
  });

  it('rejects things that are not a folder reference', () => {
    expect(parseDriveFolderId('')).toBeNull();
    expect(parseDriveFolderId('   ')).toBeNull();
    expect(parseDriveFolderId('not a link')).toBeNull();
    expect(parseDriveFolderId('short')).toBeNull();
  });
});
