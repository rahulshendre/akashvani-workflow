// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { supportDir, logDir } from '../../server/appDirs.js';

describe('per-user folders', () => {
  describe('Windows', () => {
    const home = 'C:\\Users\\editor';

    it('uses LOCALAPPDATA when it is set', () => {
      const env = { LOCALAPPDATA: 'D:\\Profiles\\editor\\Local' };
      expect(supportDir('win32', env, home)).toBe('D:\\Profiles\\editor\\Local\\Akashvani Workflow');
      expect(logDir('win32', env, home)).toBe('D:\\Profiles\\editor\\Local\\Akashvani Workflow\\logs');
    });

    it('falls back to AppData\\Local under the home folder', () => {
      expect(supportDir('win32', {}, home)).toBe('C:\\Users\\editor\\AppData\\Local\\Akashvani Workflow');
      expect(logDir('win32', {}, home)).toBe('C:\\Users\\editor\\AppData\\Local\\Akashvani Workflow\\logs');
    });
  });

  describe('macOS', () => {
    const home = '/Users/editor';

    it('keeps support files under Application Support', () => {
      expect(supportDir('darwin', {}, home)).toBe('/Users/editor/Library/Application Support/Akashvani Workflow');
    });

    it('keeps logs under Library/Logs', () => {
      expect(logDir('darwin', {}, home)).toBe('/Users/editor/Library/Logs/Akashvani Workflow');
    });

    it('ignores LOCALAPPDATA', () => {
      const env = { LOCALAPPDATA: '/somewhere/else' };
      expect(supportDir('darwin', env, home)).toBe('/Users/editor/Library/Application Support/Akashvani Workflow');
    });
  });
});
