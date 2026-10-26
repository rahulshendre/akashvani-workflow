// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseEnv, fillBlankKeys, seedConfig } from '../../server/configSeed.js';

describe('fillBlankKeys', () => {
  it('fills a blank key', () => {
    expect(fillBlankKeys('A=\nB=2\n', { A: 'one' })).toBe('A=one\nB=2\n');
  });

  it('leaves a value somebody typed alone', () => {
    const text = 'SARVAM_API_KEY=mine\n';
    expect(fillBlankKeys(text, { SARVAM_API_KEY: 'baked-in' })).toBe(text);
  });

  it('appends a key the file has never heard of', () => {
    expect(fillBlankKeys('A=1\n', { B: 'two' })).toBe('A=1\n\nB=two\n');
  });

  it('does not write a blank default', () => {
    const text = 'A=\n';
    expect(fillBlankKeys(text, { A: '', B: '   ' })).toBe(text);
  });

  it('does not touch commented lines or other keys', () => {
    const text = '# A=old\nA=\nOTHER=keep\n';
    expect(fillBlankKeys(text, { A: 'new' })).toBe('# A=old\nA=new\nOTHER=keep\n');
  });

  it('fills several keys in one pass', () => {
    expect(fillBlankKeys('A=\nB=\n', { A: '1', B: '2' })).toBe('A=1\nB=2\n');
  });
});

describe('parseEnv', () => {
  it('reads keys, skips comments, strips quotes and spaces around =', () => {
    expect(parseEnv('# note\nA = "x"\n\nB=y\nnot a line\n')).toEqual({ A: 'x', B: 'y' });
  });
});

describe('seedConfig', () => {
  let dir: string;
  const paths = () => ({
    configPath: join(dir, 'support', 'config.env'),
    templatePath: join(dir, 'config.env.template'),
    defaultsPath: join(dir, 'config.defaults.env'),
  });

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akashvani-seed-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates config.env from the template with the baked-in keys filled', () => {
    const p = paths();
    writeFileSync(p.templatePath, 'PORT=3001\nSARVAM_API_KEY=\n');
    writeFileSync(p.defaultsPath, 'SARVAM_API_KEY=abc123\n');
    seedConfig(p);
    expect(readFileSync(p.configPath, 'utf8')).toBe('PORT=3001\nSARVAM_API_KEY=abc123\n');
  });

  it('keeps the file private to the user', () => {
    const p = paths();
    writeFileSync(p.templatePath, 'A=\n');
    seedConfig(p);
    expect(statSync(p.configPath).mode & 0o077).toBe(0);
  });

  it('on a later launch only fills what is still blank', () => {
    const p = paths();
    writeFileSync(p.templatePath, 'PORT=3001\nSARVAM_API_KEY=\nANTHROPIC_API_KEY=\n');
    writeFileSync(p.defaultsPath, 'SARVAM_API_KEY=baked\nANTHROPIC_API_KEY=baked2\n');
    seedConfig(p);
    const edited = readFileSync(p.configPath, 'utf8').replace('PORT=3001', 'PORT=4000').replace('SARVAM_API_KEY=baked', 'SARVAM_API_KEY=typed');
    writeFileSync(p.configPath, edited);
    seedConfig(p);
    expect(readFileSync(p.configPath, 'utf8')).toBe('PORT=4000\nSARVAM_API_KEY=typed\nANTHROPIC_API_KEY=baked2\n');
  });

  it('works with no template and no defaults', () => {
    const p = paths();
    seedConfig(p);
    expect(existsSync(p.configPath)).toBe(true);
    expect(readFileSync(p.configPath, 'utf8')).toBe('');
  });
});
