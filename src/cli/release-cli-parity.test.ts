import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { addItem, listChecklist, setItem } from '../release-loop/checklist.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

const cwd = join(import.meta.dir, '..', '..');
const version = '9.9.9';
const parityLine = '짝: PWA ✅ · 데스크톱 ✅ · 폴드 ✅ · 아이폰 ✅ · 아이패드 ✅';

function cli(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', '--config-dir', root, 'release', 'checklist', ...args], {
    cwd, env: { ...process.env, NODE_ENV: 'test' },
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe('release checklist five-surface parity at the real CLI entrance', () => {
  test('three green cells: only the screen without a parity line warns; status/list expose its id without blocking', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-cli-parity-'));
    setElanousConfigDir(root);
    try {
      addItem(version, { id: 'SCREEN-OK', title: 'complete', kind: 'screen' });
      setItem(version, 'SCREEN-OK', { evidence: parityLine }, 'TC');
      addItem(version, { id: 'SCREEN-GAP', title: 'missing', kind: 'screen' });
      addItem(version, { id: 'ORDINARY', title: 'ordinary' });
      for (const id of ['SCREEN-OK', 'SCREEN-GAP', 'ORDINARY']) {
        const result = cli(root, '--version', version, 'set', id, '--status', 'green');
        expect(result.exitCode).toBe(0);
        expect(result.stderr.includes('⚠ 짝:')).toBe(id === 'SCREEN-GAP');
        if (id === 'SCREEN-GAP') expect(result.stderr).toContain('⚠ 짝: 근거에 짝: 줄이 없다 — 근거에 «짝: PWA … · 데스크톱 … · 폴드 … · 아이폰 … · 아이패드 …» 한 줄');
      }
      expect(listChecklist(version).items.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: 'SCREEN-OK', status: 'green' }, { id: 'SCREEN-GAP', status: 'green' }, { id: 'ORDINARY', status: 'green' },
      ]);
      for (const mode of ['status', 'list']) {
        const human = cli(root, mode, '--version', version);
        expect(human.exitCode).toBe(0);
        expect(human.stdout.split('\n')).toContain('⚠ 짝 경고 1: SCREEN-GAP');
        const json = cli(root, mode, '--version', version, '--json');
        expect(json.exitCode).toBe(0);
        expect(JSON.parse(json.stdout)).toMatchObject({ green: 3, parity: [{ id: 'SCREEN-GAP', why: '근거에 짝: 줄이 없다' }] });
        expect(JSON.parse(json.stdout).parity).toHaveLength(1);
      }
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  test('resulting green state, including --kind and --evidence in the same set, warns with parityGap reason and logs it', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-cli-parity-'));
    setElanousConfigDir(root);
    try {
      addItem(version, { id: 'K1', title: 'screen later' });
      const yellow = cli(root, 'set', 'K1', '--version', version, '--kind', 'screen');
      expect(yellow.exitCode).toBe(0);
      expect(yellow.stderr).not.toContain('⚠ 짝:');
      expect(JSON.parse(cli(root, 'status', '--version', version, '--json').stdout).parity).toEqual([{ id: 'K1', why: '근거에 짝: 줄이 없다' }]);
      const warning = cli(root, 'set', 'K1', '--version', version, '--kind', 'screen', '--status', 'green', '--evidence', '짝: PWA ⏳ · 데스크톱 ✅ · 폴드 ✅ · 아이폰 ✅ · 아이패드 ✅');
      expect(warning.exitCode).toBe(0);
      expect(warning.stderr).toContain('⚠ 짝: ⏳ 에 (칸 …) 번호가 없다: PWA');
      expect(listChecklist(version).items[0]).toMatchObject({ kind: 'screen', status: 'green' });
      expect(JSON.parse(cli(root, 'status', '--version', version, '--json').stdout).parity).toEqual([{ id: 'K1', why: '⏳ 에 (칸 …) 번호가 없다: PWA' }]);
      const fixed = cli(root, 'set', 'K1', '--version', version, '--evidence', '짝: PWA ⏳ (칸 K2) · 데스크톱 ✅ · 폴드 ✅ · 아이폰 ✅ · 아이패드 ✅');
      expect(fixed.exitCode).toBe(0);
      expect(fixed.stderr).not.toContain('⚠ 짝:');
      expect(JSON.parse(cli(root, 'list', '--version', version, '--json').stdout).parity).toEqual([]);
      const red = cli(root, 'set', 'K1', '--version', version, '--status', 'red', '--evidence', 'no parity');
      expect(red.exitCode).toBe(0);
      expect(red.stderr).not.toContain('⚠ 짝:');
      expect(JSON.parse(cli(root, 'list', '--version', version, '--json').stdout).parity).toEqual([{ id: 'K1', why: '근거에 짝: 줄이 없다' }]);
    } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  }, 120_000);

  test('warning observation includes the resolved version, id, and reason', async () => {
    const { Command } = await import('commander');
    const { registerReleaseCommands } = await import('./release-cli.js');
    const root = mkdtempSync(join(tmpdir(), 'release-cli-parity-'));
    setElanousConfigDir(root);
    const observed: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
      if (category === 'release.checklist' && event === 'parity-warning') observed.push(data);
    });
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const output = spyOn(console, 'log').mockImplementation(() => {});
    try {
      addItem(version, { id: 'K1', title: 'screen', kind: 'screen' });
      const command = new Command(); registerReleaseCommands(command);
      await command.parseAsync(['release', 'checklist', 'set', 'K1', '--version', version, '--status', 'green'], { from: 'user' });
      expect(observed).toEqual([{ version, id: 'K1', why: '근거에 짝: 줄이 없다' }]);
      observed.length = 0;
      await command.parseAsync(['release', 'checklist', 'status', '--version', version], { from: 'user' });
      expect(observed).toEqual([{ version, id: 'K1', why: '근거에 짝: 줄이 없다' }]);
    } finally {
      log.mockRestore(); error.mockRestore(); output.mockRestore();
      resetElanousConfigDir(); rmSync(root, { recursive: true, force: true });
    }
  });

  test('status keeps the existing four-line summary tail for alias and seed consumers', async () => {
    const { Command } = await import('commander');
    const { registerReleaseCommands } = await import('./release-cli.js');
    const root = mkdtempSync(join(tmpdir(), 'release-cli-parity-'));
    setElanousConfigDir(root);
    const lines: string[] = [];
    const output = spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    try {
      const command = new Command(); registerReleaseCommands(command);
      await command.parseAsync(['release', 'checklist', 'status', '--version', version], { from: 'user' });
      expect(lines.at(-4)).toContain(version);
      expect(lines).toContain('⚠ 짝 경고 0: 없음');
    } finally { output.mockRestore(); resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
  });

  test('add/set help explains the five-column evidence format', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-cli-parity-'));
    try {
      for (const mode of ['add', 'set']) {
        const result = cli(root, mode, '--help');
        expect(result.exitCode).toBe(0);
        expect(result.stdout.replace(/\s+/g, ' ')).toContain('짝: PWA … · 데스크톱 … · 폴드 … · 아이폰 … · 아이패드 … 한 줄');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
