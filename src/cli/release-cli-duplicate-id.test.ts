import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { addItem, listChecklist } from '../release-loop/checklist.js';
import type { Checklist } from '../release-loop/checklist.js';

const cwd = join(import.meta.dir, '..', '..');
function cli(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', '--config-dir', root, 'release', 'checklist', ...args], {
    cwd, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function legacy(root: string, version: string, id: string, title: string, owner?: string) {
  const data: Checklist = { version, released: '', dev: '0.2.10', items: [
    { id, title, status: 'yellow', ...(owner ? { owner } : {}), updatedAt: '2026-10-03T00:00:00Z', updatedBy: 'OP' },
  ], history: [] };
  const folder = join(root, 'release', version);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'checklist.json'), JSON.stringify(data));
}

describe('release checklist id collision at the real CLI entrance', () => {
  test('another release, including an unimported legacy release, refuses add with a one-line warning; opt-in allows it', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-duplicate-id-'));
    setElanousConfigDir(root);
    try {
      legacy(root, '0.2.9', 'W8', '온보딩 긴 제목 여기부터 계속된다', 'UX');
      const rejected = cli(root, 'add', 'W8', '편집기', '--owner', 'TC', '--version', '0.2.10');
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr.split('\n').filter((line) => line.startsWith('⚠ 중복 id:'))).toEqual([
        '⚠ 중복 id: W8 — 0.2.9 · 담당 UX · 온보딩 긴 제목 여기부터 계속된다',
      ]);
      expect(rejected.stderr).toContain('다른 판에 이미 있는 칸: W8');
      expect(listChecklist('0.2.10').items).toEqual([]);
      const accepted = cli(root, 'add', 'W8', '편집기', '--owner', 'TC', '--version', '0.2.10', '--allow-duplicate-id');
      expect(accepted.exitCode).toBe(0);
      expect(accepted.stderr.split('\n').filter((line) => line.startsWith('⚠ 중복 id:'))).toEqual([
        '⚠ 중복 id: W8 — 0.2.9 · 담당 UX · 온보딩 긴 제목 여기부터 계속된다',
      ]);
      expect(listChecklist('0.2.10').items[0]).toMatchObject({ id: 'W8', title: '편집기', owner: 'TC' });
      expect(listChecklist('0.2.9').items[0]).toMatchObject({ id: 'W8', title: '온보딩 긴 제목 여기부터 계속된다', owner: 'UX' });
      const sameRelease = cli(root, 'add', 'W8', '다시', '--version', '0.2.10', '--allow-duplicate-id');
      expect(sameRelease.exitCode).not.toBe(0);
      expect(sameRelease.stderr).toContain('이미 있는 칸: W8');
      expect(sameRelease.stderr).not.toContain('⚠ 중복 id:');
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  test('multiple conflicting releases still emit exactly one warning with each cell', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-multi-duplicate-'));
    setElanousConfigDir(root);
    try {
      legacy(root, '0.2.8', 'W8', '온보딩', 'UX');
      legacy(root, '0.2.9', 'W8', '편집기\n' + 'x'.repeat(50));
      const result = cli(root, 'add', 'W8', '기타', '--version', '0.2.10');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.split('\n').filter((line) => line.startsWith('⚠ 중복 id:'))).toEqual([
        `⚠ 중복 id: W8 — 0.2.8 · 담당 UX · 온보딩 / 0.2.9 · 담당 - · 편집기 ${'x'.repeat(36)}`,
      ]);
      expect(listChecklist('0.2.10').items).toEqual([]);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  test('newline-containing id is escaped on one collision warning line', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-newline-duplicate-'));
    setElanousConfigDir(root);
    try {
      const id = 'W8\nother';
      legacy(root, '0.2.9', id, '온보딩', 'UX');
      const rejected = cli(root, 'add', id, '편집기', '--version', '0.2.10');
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr.split('\n').filter((line) => line.startsWith('⚠ 중복 id:'))).toEqual([
        '⚠ 중복 id: W8\\nother — 0.2.9 · 담당 UX · 온보딩',
      ]);
      expect(rejected.stderr).not.toContain('W8\nother');
      expect(listChecklist('0.2.10').items).toEqual([]);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  test('legacy owner containing a newline stays on one collision warning line', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-owner-newline-'));
    setElanousConfigDir(root);
    try {
      legacy(root, '0.2.9', 'W8', '온보딩', 'UX\nlegacy');
      const rejected = cli(root, 'add', 'W8', '편집기', '--version', '0.2.10');
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr.split('\n').filter((line) => line.startsWith('⚠ 중복 id:'))).toEqual([
        '⚠ 중복 id: W8 — 0.2.9 · 담당 UX\\nlegacy · 온보딩',
      ]);
      expect(rejected.stderr).not.toContain('담당 UX\nlegacy');
      expect(listChecklist('0.2.10').items).toEqual([]);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  test('move refusal names the destination cell, keeps both releases and the ledger unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-move-duplicate-'));
    setElanousConfigDir(root);
    try {
      addItem('0.2.9', { id: 'W8', title: '온보딩', owner: 'UX' });
      legacy(root, '0.2.10', 'W8', '편집기 화면', 'TC');
      const refused = cli(root, 'move', 'W8', '--from', '0.2.9', '--to', '0.2.10', '--reason', 'carry');
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain('이미 있는 칸: W8 — 0.2.10 · 담당 TC · 편집기 화면');
      expect(listChecklist('0.2.9').items[0]).toMatchObject({ id: 'W8', title: '온보딩', owner: 'UX' });
      expect(listChecklist('0.2.10').items[0]).toMatchObject({ id: 'W8', title: '편집기 화면', owner: 'TC' });
      expect(listChecklist('0.2.9').history.some((entry) => entry.field === 'move')).toBe(false);
      expect(listChecklist('0.2.10').history.some((entry) => entry.field === 'move')).toBe(false);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  test('move refusal escapes legacy id and owner newlines so the destination cell stays on one reason line', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-move-newline-'));
    setElanousConfigDir(root);
    try {
      const id = 'W8\nlegacy';
      legacy(root, '0.2.9', id, '온보딩', 'UX');
      legacy(root, '0.2.10', id, '편집기 화면', 'TC\nlegacy');
      const refused = cli(root, 'move', id, '--from', '0.2.9', '--to', '0.2.10', '--reason', 'carry');
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr.split('\n').filter((line) => line.includes('이미 있는 칸:'))).toEqual([
        '❌ 이미 있는 칸: W8\\nlegacy — 0.2.10 · 담당 TC\\nlegacy · 편집기 화면',
      ]);
      expect(refused.stderr).not.toContain('담당 TC\nlegacy');
      expect(listChecklist('0.2.9').items[0]).toMatchObject({ id, title: '온보딩', owner: 'UX' });
      expect(listChecklist('0.2.10').items[0]).toMatchObject({ id, title: '편집기 화면', owner: 'TC\nlegacy' });
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  test('no collision keeps the existing add output and accepts a previously removed id', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-no-duplicate-'));
    setElanousConfigDir(root);
    try {
      const added = cli(root, 'add', 'W8', '편집기', '--version', '0.2.10');
      expect(added).toMatchObject({ exitCode: 0, stdout: '✅ W8 추가\n' });
      expect(added.stderr).not.toContain('⚠ 중복 id:');
      const json = cli(root, 'list', '--version', '0.2.10', '--json');
      expect(JSON.parse(json.stdout).items[0]).toMatchObject({ title: '편집기', status: 'yellow' });
      expect(cli(root, 'rm', 'W8', '--version', '0.2.10').exitCode).toBe(0);
      const readded = cli(root, 'add', 'W8', '새 칸', '--version', '0.2.9');
      expect(readded.exitCode).toBe(0);
      expect(readded.stderr).not.toContain('⚠ 중복 id:');
      expect(listChecklist('0.2.9').items[0]?.title).toBe('새 칸');
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
});
