import { describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HqDeps } from '../hq/hq.js';
import { fileLeaseStore } from '../hq/lease.js';
import { debug } from '../debug/log.js';
import type { Checklist } from '../release-loop/checklist.js';
import { registerReleaseCommands, type LandedButYellowDeps, type Runner } from './release-cli.js';
import type { MergedPrRunner } from '../release-loop/landed-but-yellow.js';

const mergedAt = '2026-10-04T00:00:00Z';
const prs = [
  { number: 123, title: 'landing one', body: '칸: CL-AUTO', mergedAt },
  { number: 124, title: 'landing two', body: '칸: CL-NEXT', mergedAt },
  { number: 125, title: 'incidental', body: 'CL-AUTO mentioned in passing', mergedAt },
];
function snapshot(version: string): Checklist {
  const id = version === '0.2.13' ? 'CL-AUTO' : 'CL-NEXT';
  return { version, released: '0.2.12', dev: '0.2.15-dev.1', items: [{ id, title: id, owner: 'UX', status: 'yellow', updatedAt: '2026-10-03T00:00:00Z', updatedBy: 'UX' }], history: [] };
}

type GhResult = { status: number; stdout: string; stderr: string };
function harness(versions: string[], released = '0.2.12', runImpl?: (command: string, args: readonly string[]) => GhResult, runAsync?: MergedPrRunner, cacheFile?: string) {
  const logs: string[] = [], errors: string[] = [], stdout: string[] = [];
  const gh: string[] = [], checks: string[] = [];
  const added: Array<{ id: string; version: string; ref: string }> = [];
  const observations: unknown[] = [];
  const snapshots = new Map<string, Checklist>();
  const checklist = (version: string) => {
    checks.push(version);
    if (!snapshots.has(version)) snapshots.set(version, version === '0.2.14' ? { ...snapshot(version), items: [] } : snapshot(version));
    return snapshots.get(version)!;
  };
  const output = spyOn(console, 'log').mockImplementation((line: string) => { logs.push(line); });
  const error = spyOn(console, 'error').mockImplementation((line: string) => { errors.push(line); });
  const write = spyOn(process.stdout, 'write').mockImplementation(((chunk: string, callback?: (error?: Error | null) => void) => { stdout.push(String(chunk)); callback?.(); return true; }) as typeof process.stdout.write);
  const observer = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'release.checklist' && event === 'evidence-synced') observations.push(data);
  });
  const deps: LandedButYellowDeps = {
    schedules: () => versions.map((version) => ({ version, cutAt: '', landBy: null, updatedAt: '', updatedBy: '' })),
    released: () => released,
    checklist,
    now: () => new Date('2026-10-04T09:00:00Z'),
    run: ((command, args) => { gh.push(`${command} ${args.join(' ')}`); return runImpl ? runImpl(command, args) : { status: 0, stdout: JSON.stringify(prs), stderr: '' }; }) as Runner,
    ...(runAsync ? { runAsync } : {}),
    ...(cacheFile ? { mergedPrCacheFile: () => cacheFile } : {}),
    evidenceAdd: ((id, version, ref) => { added.push({ id, version, ref }); }) as NonNullable<LandedButYellowDeps['evidenceAdd']>,
  };
  // 본부 임대 없음(no-lease) = 쓰기 허용 — 시험이 실제 판정자(ssh)에 닿지 않게 빈 파일 원장을 준다(FENCE-CLI #23632).
  const leaseDir = mkdtempSync(join(tmpdir(), 'landed-open-hq-'));
  const hq: HqDeps = { store: fileLeaseStore(join(leaseDir, 'lease.json'), () => 100), config: { hostName: 'mbp' }, localPath: join(leaseDir, 'local.json'), seenPath: join(leaseDir, 'seen-generation'), now: () => 100, log: (() => {}) as HqDeps['log'] };
  const runChecklist = async (...args: string[]) => {
    const cli = new Command(); registerReleaseCommands(cli, {}, deps, hq);
    await cli.parseAsync(['release', 'checklist', ...args], { from: 'user' });
  };
  const run = (...args: string[]) => runChecklist('landed-but-yellow', ...args);
  return { logs, errors, stdout, gh, checks, added, observations, snapshots, run, runChecklist,
    restore: () => { observer.mockRestore(); write.mockRestore(); error.mockRestore(); output.mockRestore(); } };
}

describe('landed-but-yellow --open', () => {
  test('발행 판을 빼고 빈 판을 건너뛴 뒤 한 판만 동기화 · 상태 불변 · gh 한 번 · 한 번 관측', async () => {
    const h = harness(['0.2.14', '0.2.13', '0.2.12']);
    const exit = process.exitCode;
    try {
      process.exitCode = 0;
      await h.run('--open', '--apply-evidence');
      expect(h.checks).toEqual(['0.2.13', '0.2.14']);
      expect(h.gh).toEqual(['gh pr list --state merged --search merged:>=2026-10-03 --limit 400 --json number,title,body,mergedAt']);
      expect(h.added).toEqual([{ id: 'CL-AUTO', version: '0.2.13', ref: '#123' }]);
      expect(h.snapshots.get('0.2.13')!.items[0]!.status).toBe('yellow');
      expect(h.logs).toEqual(['— 0.2.13 —', '✅ CL-AUTO 근거 #123', '붙임 1 · 건너뜀(언급만) 1', '판 1 · 붙임 합 1 · 건너뜀(언급만) 합 1']);
      expect(h.observations).toEqual([{ versions: ['0.2.13'], added: 1, skippedMention: 1 }]);
      expect(process.exitCode).toBe(0);
    } finally { process.exitCode = exit ?? 0; h.restore(); }
  });

  test('둘 열린 판은 semver 순, 판별 evidenceAdd 와 합계 · JSON 배열 plan · 중복 gh 없음', async () => {
    const h = harness(['0.2.15', '0.2.9', '0.2.13', '0.2.14', '0.2.12'], '0.2.9');
    const exit = process.exitCode;
    try {
      process.exitCode = 0;
      await h.run('--open', '--apply-evidence', '--json');
      expect(h.checks).toEqual(['0.2.12', '0.2.13', '0.2.14', '0.2.15']);
      expect(h.gh).toHaveLength(1);
      expect(h.added).toEqual([
        { id: 'CL-NEXT', version: '0.2.12', ref: '#124' },
        { id: 'CL-AUTO', version: '0.2.13', ref: '#123' },
        { id: 'CL-NEXT', version: '0.2.15', ref: '#124' },
      ]);
      expect(JSON.parse(h.stdout.join(''))).toEqual([
        { version: '0.2.12', plan: [{ id: 'CL-NEXT', ref: '#124' }] },
        { version: '0.2.13', plan: [{ id: 'CL-AUTO', ref: '#123' }] },
        { version: '0.2.15', plan: [{ id: 'CL-NEXT', ref: '#124' }] },
      ]);
      expect(h.observations).toEqual([{ versions: ['0.2.12', '0.2.13', '0.2.15'], added: 3, skippedMention: 1 }]);
      expect(h.errors).toContain('붙임 1 · 건너뜀(언급만) 1');
      expect(h.errors.some((line) => line.startsWith('판 '))).toBe(false);
    } finally { process.exitCode = exit ?? 0; h.restore(); }
  });

  test('여러 열린 판 사람 출력은 판별 머리와 기존 줄, 마지막 합계를 갖는다', async () => {
    const h = harness(['0.2.15', '0.2.13']);
    try {
      await h.run('--open', '--apply-evidence');
      expect(h.logs).toEqual([
        '— 0.2.13 —', '✅ CL-AUTO 근거 #123', '붙임 1 · 건너뜀(언급만) 1',
        '— 0.2.15 —', '✅ CL-NEXT 근거 #124', '붙임 1 · 건너뜀(언급만) 0',
        '판 2 · 붙임 합 2 · 건너뜀(언급만) 합 1',
      ]);
      expect(h.observations).toEqual([{ versions: ['0.2.13', '0.2.15'], added: 2, skippedMention: 1 }]);
    } finally { h.restore(); }
  });

  test('JSON 읽기 모드는 version/rows 배열이고 dry-run 은 쓰지 않는다', async () => {
    const h = harness(['0.2.13', '0.2.15']);
    try {
      await h.run('--open', '--json');
      const data = JSON.parse(h.stdout.at(-1)!);
      expect(data.map((entry: { version: string }) => entry.version)).toEqual(['0.2.13', '0.2.15']);
      expect(data[0].rows[0]).toMatchObject({ id: 'CL-AUTO', status: 'yellow' });
      expect(h.added).toEqual([]);
      h.logs.length = 0;
      await h.run('--open');
      expect(h.logs[0]).toBe('— 0.2.13 —');
      expect(h.logs.at(-1)).toBe('판 2 · 붙임 합 0 · 건너뜀(언급만) 합 1');
      await h.run('--open', '--dry-run', '--json');
      expect(JSON.parse(h.stdout.at(-1)!)[0]).toEqual({ version: '0.2.13', plan: [{ id: 'CL-AUTO', ref: '#123' }] });
      expect(h.added).toEqual([]);
      expect(h.observations).toEqual([]);
    } finally { h.restore(); }
  });

  test('--open + --version 오류 exit 1 · 열린 판 0은 exit 0 이며 gh 조회 0', async () => {
    const h = harness(['0.2.12', '0.2.11']);
    const exit = process.exitCode;
    try {
      process.exitCode = 0;
      await h.run('--open', '--version', '0.2.13');
      expect(process.exitCode).toBe(1);
      expect(h.errors.at(-1)).toContain('--open 과 --version');
      expect(h.gh).toEqual([]);
      process.exitCode = 0;
      await h.runChecklist('--version', '0.2.13', 'landed-but-yellow', '--open');
      expect(process.exitCode).toBe(1);
      expect(h.errors.at(-1)).toContain('--open 과 --version');
      expect(h.gh).toEqual([]);
      process.exitCode = 0;
      await h.run('--open');
      expect(h.logs.at(-1)).toBe('열린 판 없음');
      expect(process.exitCode).toBe(0);
      await h.run('--open', '--json');
      expect(JSON.parse(h.stdout.at(-1)!)).toEqual([]);
      expect(h.gh).toEqual([]);
    } finally { process.exitCode = exit ?? 0; h.restore(); }
  });

  test('open search starts at the earliest updatedAt of all open non-green cells', async () => {
    const h = harness(['0.2.13', '0.2.15']);
    try {
      h.snapshots.set('0.2.15', { ...snapshot('0.2.15'), items: [{ ...snapshot('0.2.15').items[0]!, updatedAt: '2026-09-01T12:00:00Z' }] });
      await h.run('--open', '--json');
      expect(h.gh).toEqual(['gh pr list --state merged --search merged:>=2026-09-01 --limit 400 --json number,title,body,mergedAt']);
      expect(JSON.parse(h.stdout.at(-1)!).map((entry: { version: string }) => entry.version)).toEqual(['0.2.13', '0.2.15']);
      expect(h.errors).toEqual([]);
    } finally { h.restore(); }
  });

  test('--open 없는 한 판의 기존 사람 출력·JSON rows/plan 모양 보존', async () => {
    const h = harness([]);
    try {
      await h.run('--version', '0.2.13');
      expect(h.logs[0]).toContain('CL-AUTO UX 🟡 ← #123');
      expect(h.logs.at(-1)).toBe('1칸 · 그중 근거에 없는 PR 이 있는 칸 1');
      expect(h.logs.some((line) => line.startsWith('— ') || line.startsWith('판 '))).toBe(false);
      h.logs.length = 0;
      await h.runChecklist('--version', '0.2.13', 'landed-but-yellow');
      expect(h.logs[0]).toContain('CL-AUTO UX 🟡 ← #123');
      expect(h.logs.at(-1)).toBe('1칸 · 그중 근거에 없는 PR 이 있는 칸 1');
      await h.run('--version', '0.2.13', '--json');
      expect(JSON.parse(h.stdout.at(-1)!)[0]).toMatchObject({ id: 'CL-AUTO' });
      await h.run('--version', '0.2.13', '--dry-run', '--json');
      expect(JSON.parse(h.stdout.at(-1)!)).toEqual([{ id: 'CL-AUTO', ref: '#123' }]);
      expect(h.added).toEqual([]);
    } finally { h.restore(); }
  });

  test('GREEN-SCAN-LANDED-CACHE: 같은 --open --json 두 번째 호출은 gh 호출 0 · 결과 일치', async () => {
    // One runner shared by both CLI calls, so the second call answers from the full-result cache.
    let ghCalls = 0;
    const runAsync: MergedPrRunner = async () => {
      ghCalls++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { status: 0, stdout: JSON.stringify(prs), stderr: '' };
    };
    const cacheDir = mkdtempSync(join(tmpdir(), 'landed-open-cache-'));
    const h = harness(['0.2.13', '0.2.15'], '0.2.12', undefined, runAsync, join(cacheDir, 'cache.json'));
    try {
      await h.run('--open', '--json');
      const first = h.stdout.at(-1)!;
      expect(ghCalls).toBe(1);
      await h.run('--open', '--json');
      expect(ghCalls).toBe(1); // 두 번째 호출의 gh 호출 수 0
      expect(h.stdout.at(-1)!).toBe(first); // 두 결과 일치
      const rows = JSON.parse(first) as Array<{ version: string; rows: unknown[] }>;
      expect(rows.map((entry) => entry.version)).toEqual(['0.2.13', '0.2.15']);
    } finally { h.restore(); rmSync(cacheDir, { recursive: true, force: true }); }
  });

  test('같은 판·같은 owner 에서 --version 과 --open 이 같은 병합 PR 창과 같은 결과 집합을 낸다(칸 updatedAt 보다 오래 병합된 PR 포함)', async () => {
    const older = { number: 126, title: 'older landing', body: '칸: CL-AUTO', mergedAt: '2026-09-28T00:00:00Z' };
    const runImpl = (_command: string, args: readonly string[]) => {
      const since = args[args.indexOf('--search') + 1]!.slice('merged:>='.length);
      return { status: 0, stdout: JSON.stringify([...prs, older].filter((pr) => pr.mergedAt >= since)), stderr: '' };
    };
    const h = harness(['0.2.13', '0.2.15'], '0.2.12', runImpl);
    try {
      h.snapshots.set('0.2.15', { ...snapshot('0.2.15'), items: [{ ...snapshot('0.2.15').items[0]!, updatedAt: '2026-09-26T00:00:00Z' }] });
      const searchCommand = 'gh pr list --state merged --search merged:>=2026-09-26 --limit 400 --json number,title,body,mergedAt';
      await h.run('--open', '--json', '--owner', 'UX');
      const openGh = h.gh[0]!;
      const openResults = JSON.parse(h.stdout.at(-1)!) as Array<{ version: string; rows: Array<{ id: string; prs: Array<{ number: number }> }> }>;
      const openRows = openResults.find((entry) => entry.version === '0.2.13')!.rows;
      expect(openGh).toBe(searchCommand);
      expect(openRows[0]!.prs.map((pr) => pr.number)).toContain(126);
      h.gh.length = 0; h.stdout.length = 0;
      await h.run('--version', '0.2.13', '--json', '--owner', 'UX');
      expect(h.gh).toEqual([openGh]);
      const versionRows = JSON.parse(h.stdout.at(-1)!) as Array<{ id: string; prs: Array<{ number: number }> }>;
      expect(versionRows).toEqual(openRows);
      expect(versionRows[0]!.prs.map((pr) => pr.number)).toContain(126);
    } finally { h.restore(); }
  });
});
