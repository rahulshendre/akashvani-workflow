import { describe, it, expect } from 'vitest';
import { STEPS_CONFIG } from '@/lib/pipeline';
import { ROLE_STEPS } from '@/lib/session-sync';

// Two structural decisions managers asked for after reviewing the workflow:
// the first Language Expert pass must sit immediately behind the AI subtitle
// file, and the second pass is out of the pipeline. Both are easy to undo by
// accident while editing STEPS_CONFIG, so they are pinned here.

const ids = STEPS_CONFIG.map(s => s.id);

describe('pipeline structure', () => {
  it('runs the LE 1 pass immediately after the AI subtitle file is added', () => {
    expect(ids[ids.indexOf('upload-feltiv-srt') + 1]).toBe('review-pass1');
  });

  it('keeps the automatic alignment step attached to the LE 1 upload', () => {
    // review-pass1's own description says the step "below" ticks itself off,
    // and the server marks both complete in one go.
    expect(ids[ids.indexOf('review-pass1') + 1]).toBe('align-srt');
  });

  it('has no second Language Expert pass', () => {
    expect(ids).not.toContain('review-pass2');
    expect(Object.keys(ROLE_STEPS)).not.toContain('le2');
    expect(Object.values(ROLE_STEPS).flat()).not.toContain('review-pass2');
  });

  it('leaves the final quality check to the editor, not a Language Expert', () => {
    // It used to be owned by LE 2. With that role gone it must still belong to
    // someone, or the episode can never be signed off.
    expect(Object.values(ROLE_STEPS).flat()).not.toContain('final-qc');
  });

  it('still orders the editor-side steps sensibly around the review', () => {
    expect(ids.indexOf('upload-prproj')).toBeGreaterThan(ids.indexOf('align-srt'));
    expect(ids.indexOf('word-to-srt')).toBeGreaterThan(ids.indexOf('review-pass1'));
    expect(ids.indexOf('final-qc')).toBeLessThan(ids.indexOf('review-pass3'));
  });
});
