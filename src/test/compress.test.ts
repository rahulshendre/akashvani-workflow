// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * Runs the real compress step against real FFmpeg (the one on PATH), so it needs
 * ffmpeg and ffprobe installed. Without them the whole file is skipped.
 */
const haveFfmpeg = ['ffmpeg', 'ffprobe'].every((c) => spawnSync(c, ['-version']).status === 0);
const BUNDLED_WATERMARK = resolve(__dirname, '../../server/assets/watermark.png');

async function load(env: Record<string, string | undefined>, watermarkPath: string | null = BUNDLED_WATERMARK) {
  vi.resetModules();
  vi.doMock('../../server/paths.js', () => ({ FFMPEG_BIN: 'ffmpeg', FFPROBE_BIN: 'ffprobe', WATERMARK_PATH: watermarkPath }));
  for (const key of ['ENCODE_MODE', 'X264_PRESET', 'WATERMARK_OPACITY', 'WATERMARK_FILE_PATH', 'WATERMARK_TEXT']) delete process.env[key];
  for (const [k, v] of Object.entries({ X264_PRESET: 'veryfast', ...env })) if (v !== undefined) process.env[k] = v;
  return import('../../server/services/compress.js');
}

const probe = (file: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }));

describe.skipIf(!haveFfmpeg)('compress step with real FFmpeg', () => {
  let dir: string; let clip: string; let out: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'akashvani-compress-'));
    clip = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=640x360:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip,
    ]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => { vi.doUnmock('../../server/paths.js'); });

  const fresh = () => { out = mkdtempSync(join(dir, 'out-')); return out; };

  it('compresses a clip to H.264 High with AAC audio', { timeout: 60000 }, async () => {
    const { compressVideos } = await load({});
    const logs: string[] = [];
    const results = await compressVideos([clip], fresh(), () => {}, (m: string) => logs.push(m));
    expect(results).toEqual([join(out, 'clip_compressed.mp4')]);
    const streams = probe(results[0]).streams;
    expect(streams.find((s: any) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', profile: 'High' });
    expect(streams.find((s: any) => s.codec_type === 'audio').codec_name).toBe('aac');
    expect(logs.join('\n')).toMatch(/Watermark: image-as-is/);
  });

  it('says which file could not be compressed instead of reporting success', { timeout: 60000 }, async () => {
    const { compressVideos } = await load({});
    const broken = join(dir, 'broken.mp4');
    writeFileSync(broken, 'this is not a video'.repeat(50));
    const logs: string[] = [];
    await expect(compressVideos([broken], fresh(), () => {}, (m: string) => logs.push(m))).rejects.toThrow(/Could not compress broken\.mp4/);
    expect(logs.join('\n')).toMatch(/CRF fallback also failed/);
  });

  it('still compresses the good files, then reports the bad one', { timeout: 60000 }, async () => {
    const { compressVideos } = await load({});
    const broken = join(dir, 'broken2.mp4');
    writeFileSync(broken, 'nope'.repeat(100));
    const target = fresh();
    await expect(compressVideos([clip, broken], target, () => {}, () => {})).rejects.toThrow(/Could not compress broken2\.mp4.*1 other file\(s\) were compressed/s);
    expect(existsSync(join(target, 'clip_compressed.mp4'))).toBe(true);
  });

  it('removes the half-written file when the encode is stopped, so a resume cannot mistake it for a finished video', { timeout: 120000 }, async () => {
    const { compressVideos, killActiveEncodes } = await load({ X264_PRESET: 'veryslow' });
    const long = join(dir, 'long.mp4');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=30:size=1920x1080:rate=24', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', long]);
    const target = fresh();
    const logs: string[] = [];
    const run = compressVideos([long], target, () => {}, (m: string) => logs.push(m));
    const settled = run.catch((e: unknown) => e);

    await vi.waitFor(() => { if (!logs.some((m) => /Encoding at/.test(m))) throw new Error('not started'); }, { timeout: 30000, interval: 100 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(killActiveEncodes()).toBeGreaterThan(0);

    expect(await settled).toMatchObject({ stopped: true });
    expect(readdirSync(target)).toEqual([]);
  });

  it('two-pass encoding runs both passes without falling back, and cleans up its pass logs', { timeout: 60000 }, async () => {
    const { compressVideos } = await load({ ENCODE_MODE: '2pass' });
    const logs: string[] = [];
    const results = await compressVideos([clip], fresh(), () => {}, (m: string) => logs.push(m));
    const text = logs.join('\n');
    expect(text).toMatch(/Pass 1\/2/);
    expect(text).toMatch(/Pass 2\/2/);
    expect(text).not.toMatch(/Encode failed|CRF fallback/);
    expect(probe(results[0]).streams.find((s: any) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', profile: 'High' });
    expect(readdirSync(out)).toEqual(['clip_compressed.mp4']);
  });

  describe('text watermark, used when there is no image', () => {
    // 1.5 is what config.env.template ships; it is a multiplier for the image watermark.
    for (const opacity of ['1.5', '0.3', '', undefined]) {
      it(`works with WATERMARK_OPACITY=${JSON.stringify(opacity)}`, { timeout: 60000 }, async () => {
        const { compressVideos } = await load({ WATERMARK_OPACITY: opacity }, null);
        const logs: string[] = [];
        const results = await compressVideos([clip], fresh(), () => {}, (m: string) => logs.push(m));
        const text = logs.join('\n');
        expect(text).toMatch(/text-only watermark/);
        expect(text).toMatch(/Watermark: text-diagonal/);
        expect(text).not.toMatch(/Encode failed/);
        expect(results).toHaveLength(1);
      });
    }
  });

  it('uses a watermark image given by WATERMARK_FILE_PATH, even with quotes around the path', { timeout: 60000 }, async () => {
    const { compressVideos } = await load({ WATERMARK_FILE_PATH: `"${BUNDLED_WATERMARK}"` }, null);
    const logs: string[] = [];
    await compressVideos([clip], fresh(), () => {}, (m: string) => logs.push(m));
    expect(logs.join('\n')).toMatch(/Using watermark override/);
    expect(logs.join('\n')).toMatch(/Watermark: image-as-is/);
  });
});
