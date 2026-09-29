import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDesignSystems } from './design-systems.js';
import { saveCustomSystem } from './design-library.js';
import { promotePaletteToSystem } from './system-from-extract.js';

describe('saveCustomSystem', () => {
  test('저장 모양이 listDesignSystems 로 읽히고 SOURCE.json commit 은 custom 이다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'design-library-'));
    try {
      const system = promotePaletteToSystem(['#ffffff', '#111111', '#2255cc'], { id: 'ink-note', name: 'Ink Note' });
      const saved = saveCustomSystem(dir, system, { systemsDir: dir });
      expect(saved.dir).toBe(join(dir, 'ink-note'));
      expect(JSON.parse(readFileSync(join(dir, 'SOURCE.json'), 'utf8'))).toEqual({ commit: 'custom' });
      const listed = listDesignSystems(dir);
      expect(listed.map((item) => item.id)).toEqual(['ink-note']);
      expect(listed[0]).toMatchObject({
        name: 'Ink Note',
        category: 'Custom',
        sourceCommit: 'custom',
        swatch: { bg: '#ffffff', fg: '#111111', accent: '#2255cc' },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('번들 id 와 테마 id 는 거부한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'design-library-'));
    try {
      const bundled = promotePaletteToSystem(['#fff', '#111'], { id: 'minimal', name: 'Nope' });
      expect(() => saveCustomSystem(dir, bundled)).toThrow(/겹친다/);
      const theme = promotePaletteToSystem(['#fff', '#111'], { id: 'nord-light', name: 'Nope' });
      expect(() => saveCustomSystem(dir, theme)).toThrow(/겹친다/);
      const bad = promotePaletteToSystem(['#fff', '#111'], { id: 'Has_Space', name: 'Nope' });
      expect(() => saveCustomSystem(dir, bad)).toThrow(/거부/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
