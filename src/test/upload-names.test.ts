// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import multer from 'multer';
import type { Server } from 'http';
import { fixUploadName, withUtf8Names } from '../../server/uploadNames.js';

const latin1 = (s: string) => Buffer.from(s, 'utf8').toString('latin1');

describe('fixUploadName', () => {
  it('leaves plain ASCII names alone', () => {
    expect(fixUploadName('Episode 01 (final) #2 & more.mp4')).toBe('Episode 01 (final) #2 & more.mp4');
  });

  it('restores names that were decoded as Latin-1', () => {
    for (const name of ['नमस्ते दुनिया.mp4', 'Café.mp4', 'Café.mp4', '日本語.mp4', 'தமிழ்.srt', 'ਪੰਜਾਬੀ.docx']) {
      expect(fixUploadName(latin1(name))).toBe(name);
    }
  });

  it('keeps the decomposed accent as it was sent, so the disk name matches the Finder name', () => {
    const sent = 'Café.mp4';
    expect(fixUploadName(latin1(sent))).toBe(sent);
    expect(fixUploadName(latin1(sent))).not.toBe(sent.normalize('NFC'));
  });

  it('leaves a name that is not valid UTF-8 alone', () => {
    expect(fixUploadName('café.mp4')).toBe('café.mp4');
  });

  it('copes with missing values', () => {
    expect(fixUploadName(undefined as unknown as string)).toBeUndefined();
    expect(fixUploadName('')).toBe('');
  });
});

describe('through a real multipart upload', () => {
  let server: Server;
  afterEach(() => new Promise<void>((r) => server?.close(() => r())));

  async function upload(filter: ReturnType<typeof withUtf8Names> | undefined, name: string) {
    const names: string[] = [];
    const app = express();
    const mw = multer({ storage: multer.memoryStorage(), ...(filter ? { fileFilter: filter } : {}) });
    app.post('/', mw.single('f'), (req, res) => { names.push(req.file!.originalname); res.json({ ok: true }); });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
    const port = (server.address() as { port: number }).port;

    const form = new FormData();
    form.append('f', new Blob(['x']), name);
    await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: form });
    return names[0];
  }

  it('shows the problem without the fix: a Hindi name arrives garbled', async () => {
    const got = await upload(undefined, 'नमस्ते.mp4');
    expect(got).not.toBe('नमस्ते.mp4');
    expect(got).toBe(latin1('नमस्ते.mp4'));
  });

  it('delivers the real name with the fix', async () => {
    for (const name of ['नमस्ते.mp4', 'Café.mp4', 'plain name.mp4']) {
      expect(await upload(withUtf8Names(), name)).toBe(name);
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('still runs the filter it wraps, with the corrected name', async () => {
    let seen = '';
    const filter = withUtf8Names((_req, file, cb) => { seen = file.originalname; cb(null, true); });
    await upload(filter, 'वीडियो.mp4');
    expect(seen).toBe('वीडियो.mp4');
  });
});
