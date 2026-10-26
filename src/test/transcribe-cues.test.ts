// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildSegments, segmentToCues, splitUnits, fmtSrtTime, buildSrt } from '../../server/services/transcribe.js';

/**
 * The cue rules were tuned against a real episode in the Python prototype and
 * signed off on the output. This file pins the parts of that behaviour that are
 * pure logic, so the timing and splitting can't drift without someone noticing.
 *
 * Nothing here touches the network or ffmpeg.
 */

describe('silence → speech segments', () => {
  it('takes the complement of the silences and pads outwards', () => {
    // 10 s of audio, one silence from 4 s to 5 s.
    const segs = buildSegments([[4, 5]], 10);
    expect(segs).toHaveLength(2);
    // SEG_PAD widens each side by 0.10 s, clamped to the clip.
    expect(segs[0][0]).toBeCloseTo(0, 5);
    expect(segs[0][1]).toBeCloseTo(4.1, 5);
    expect(segs[1][0]).toBeCloseTo(4.9, 5);
    expect(segs[1][1]).toBeCloseTo(10, 5);
  });

  it('merges phrases separated by a very short pause', () => {
    // 0.1 s gap is under MERGE_GAP (0.30), and the result stays under MERGE_MAX.
    const segs = buildSegments([[1.0, 1.1]], 2);
    expect(segs).toHaveLength(1);
  });

  it('refuses to merge past MERGE_MAX, so a cue never grows unreadable', () => {
    // Two 4 s phrases with a 0.1 s gap: merging would make 8 s, over the 5 s cap.
    const segs = buildSegments([[4.0, 4.1]], 8);
    expect(segs).toHaveLength(2);
  });

  it('splits anything over the API length cap', () => {
    // 100 s of unbroken speech must come back in chunks the REST endpoint accepts.
    const segs = buildSegments([], 100);
    expect(segs.length).toBeGreaterThan(1);
    for (const [s, e] of segs) expect(e - s).toBeLessThanOrEqual(29.0);
  });

  it('drops blips too short to be speech', () => {
    // Leaves a 0.05 s sliver between two silences — below MIN_SEG (0.25).
    const segs = buildSegments([[0, 1], [1.05, 2]], 2);
    expect(segs.every(([s, e]) => e - s >= 0.25)).toBe(true);
  });
});

describe('transcript → cues', () => {
  it('keeps a short line as one cue on the measured segment times', () => {
    const cues = segmentToCues(1.5, 3.25, 'चंपा।');
    expect(cues).toEqual([{ start: 1.5, end: 3.25, text: 'चंपा।' }]);
  });

  it('drops the labels the model hallucinates over music', () => {
    expect(segmentToCues(0, 1, '[Music]')).toEqual([]);
    expect(segmentToCues(0, 1, 'संगीत')).toEqual([]);
    expect(segmentToCues(0, 1, '  ')).toEqual([]);
  });

  it('splits a long transcript and shares the segment duration by text length', () => {
    const long = 'यह पहला वाक्य है और यह काफ़ी लंबा है। यह दूसरा वाक्य है जो भी लंबा है।';
    const cues = segmentToCues(10, 20, long);

    expect(cues.length).toBeGreaterThan(1);
    // Cue timing must stay inside the segment the audio was actually cut from.
    expect(cues[0].start).toBe(10);
    expect(cues[cues.length - 1].end).toBe(20);
    // Contiguous, no gaps and no overlaps.
    for (let i = 0; i < cues.length - 1; i++) {
      expect(cues[i].end).toBeCloseTo(cues[i + 1].start, 9);
    }
    // No cue should be wider than a readable line.
    for (const c of cues) expect(c.text.length).toBeLessThanOrEqual(42);
  });

  it('breaks a run-on phrase with no punctuation at word boundaries', () => {
    const units: string[] = splitUnits('a'.repeat(20) + ' ' + 'b'.repeat(20) + ' ' + 'c'.repeat(20));
    expect(units.length).toBeGreaterThan(1);
    for (const u of units) expect(u.length).toBeLessThanOrEqual(42);
    // Nothing invented and nothing lost.
    expect(units.join(' ').replace(/\s+/g, '')).toBe(('a'.repeat(20) + 'b'.repeat(20) + 'c'.repeat(20)));
  });
});

describe('SRT output', () => {
  it('formats timestamps to the millisecond', () => {
    expect(fmtSrtTime(0)).toBe('00:00:00,000');
    expect(fmtSrtTime(1.5)).toBe('00:00:01,500');
    expect(fmtSrtTime(98.279)).toBe('00:01:38,279');
    expect(fmtSrtTime(3661.004)).toBe('01:01:01,004');
    expect(fmtSrtTime(-5)).toBe('00:00:00,000');
  });

  it('writes well-formed, CRLF-terminated SRT blocks', () => {
    const srt: string = buildSrt([
      { start: 1, end: 2.5, text: 'पहली पंक्ति' },
      { start: 3, end: 4, text: 'दूसरी पंक्ति' },
    ]);
    expect(srt).toContain('\r\n');
    const blocks = srt.trim().split('\r\n\r\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].split('\r\n')[0]).toBe('1');
    expect(blocks[0].split('\r\n')[1]).toBe('00:00:01,000 --> 00:00:02,500');
    expect(blocks[1].split('\r\n')[0]).toBe('2');
  });

  it('pads a cue too short to read', () => {
    // 0.1 s is below MIN_CUE_DURATION (0.5) — a player would flash it.
    const srt: string = buildSrt([{ start: 1, end: 1.1, text: 'हाँ' }]);
    expect(srt).toContain('00:00:01,000 --> 00:00:01,500');
  });

  it('clamps rather than overlaps when padding runs into the next cue', () => {
    // Padding the first cue to 0.5 s would push it past the second's start.
    const srt: string = buildSrt([
      { start: 1, end: 1.05, text: 'हाँ' },
      { start: 1.2, end: 2, text: 'ठीक' },
    ]);
    expect(srt).toContain('00:00:01,000 --> 00:00:01,200');
    // Overlapping cues make a player show two lines at once.
    expect(srt).not.toContain('00:00:01,000 --> 00:00:01,500');
  });
});
