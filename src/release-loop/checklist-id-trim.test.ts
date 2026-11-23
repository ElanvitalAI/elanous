import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, listChecklist, setItem } from './checklist.js';

/** 출처: OP #134563 · CHECKLIST-ID-TRIM — id 앞뒤 공백 거부(영어 오류) 계약 리터럴 */
const REFUSAL = /checklist id must not carry leading or trailing whitespace/;

const roots: string[] = [];
function root(): string { const dir = mkdtempSync(join(tmpdir(), 'release-checklist-idtrim-')); roots.push(dir); setElanousConfigDir(dir); return dir; }
afterEach(() => { resetElanousConfigDir(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('CHECKLIST-ID-TRIM: release checklist add/set reject outer-whitespace ids in English', () => {
  test('add refuses a space-padded id without creating a padded row', () => {
    root();
    expect(() => addItem('9.9.9', { id: ' X ', title: 'padded cell' })).toThrow(REFUSAL);
    expect(listChecklist('9.9.9').items.find((item) => item.id === ' X ')).toBeUndefined();
  });

  test('add refuses a tab-padded id', () => {
    root();
    expect(() => addItem('9.9.9', { id: '\tX', title: 'tab-padded cell' })).toThrow(REFUSAL);
  });

  test('set refuses a space-padded id even when the trimmed id exists — no silent aliasing', () => {
    root();
    addItem('9.9.9', { id: 'X', title: 'real cell' });
    expect(() => setItem('9.9.9', ' X ', { evidence: 'must not reach the real row' }, 'HAND-TUI-D')).toThrow(REFUSAL);
    expect(listChecklist('9.9.9').items.find((item) => item.id === 'X')?.evidence ?? '').toBe('');
  });

  test('clean ids keep adding and updating — the outer-whitespace guard changes nothing else', () => {
    root();
    addItem('9.9.9', { id: 'X', title: 'clean cell' });
    setItem('9.9.9', 'X', { evidence: 'clean update' }, 'HAND-TUI-D');
    const row = listChecklist('9.9.9').items.find((item) => item.id === 'X');
    expect(row?.status).toBe('yellow');
    expect(row?.evidence).toBe('clean update');
  });
});