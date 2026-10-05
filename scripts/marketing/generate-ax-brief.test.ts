import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChecklistItem } from '../../src/release-loop/checklist.js';
import type { ReleaseSchedule } from '../../src/release-loop/release-schedule.js';
import { generateAxBrief, type AxBriefSources } from './generate-ax-brief.js';

const item = (id: string, title: string, status: ChecklistItem['status'] = 'yellow'): ChecklistItem => ({
  id, title, status, owner: 'MK', evidence: '근거 #24146\n다음 줄', updatedAt: '2026-10-05T00:00:00Z', updatedBy: 'test',
});
const schedule = (version: string): ReleaseSchedule => ({
  version, cutAt: '2026-10-05T00:00:00Z', landBy: '2026-10-06T00:00:00Z',
  updatedAt: '2026-10-05T00:00:00Z', updatedBy: 'test',
});
const sources = (): AxBriefSources => ({
  now: () => new Date('2026-10-05T00:00:00Z'),
  featureMap: () => [
    '| 기능 | 성숙도 | 칸 id | 근거 PR |',
    '|---|---|---|---|',
    '| 설치 | 된다 | A | #1 |',
    '| L1 | 된다 | B | #2 |',
    '| 실험 | 베타 | C | #3 |',
    '| 다음 | 로드맵 | D | #4 |',
  ].join('\n'),
  checklist: (version) => version === '0.2.16'
    ? [item('ORCH1', '오케스트레이터'), item('ORCH2', '다음 단계'), item('FINISH-RATE', '마무리'), item('OTHER', '무관')]
    : [item('ENT-A', '기업 진입'), item('GRID-B', '그리드'), item('OTHER', '무관')],
  schedules: () => [schedule('0.2.16'), schedule('0.3.0'), schedule('0.3.1')],
  merges: () => ({ entries: [
    { runId: 'run-a', prNumber: 10, merged: true, timestamp: '2026-10-05T00:00:00Z' },
    { runId: 'run-b', prNumber: 11, merged: true, timestamp: '2026-10-05T00:00:00Z' },
    { runId: 'run-c', prNumber: 10, merged: true, timestamp: '2026-10-05T00:00:00Z' },
    { runId: 'run-d', prNumber: 12, merged: false, timestamp: '2026-10-05T00:00:00Z' },
  ], ledgerDirectoryMissing: false, unreadableLedgerCount: 0, excludedLedgerCount: 0 }),
});

const section = (brief: string, index: number): string => brief.split(new RegExp(`^## ${index}\\. `, 'm'))[1]!.split(/^## \d+\. /m)[0]!;
const rows = (text: string): string[] => text.split('\n').filter((line) => /^\| /.test(line) && !/^\| (?:기능|칸|판) \|/.test(line));

test('injected sources supply the promised feature, autonomy, roadmap rows and actual deduplicated merge count', () => {
  const brief = generateAxBrief('0.2.16', sources());
  expect(rows(section(brief, 1))).toEqual([
    '| 설치 | 된다 | A | #1 |', '| L1 | 된다 | B | #2 |', '| 실험 | 베타 | C | #3 |',
  ]);
  expect(rows(section(brief, 2))).toEqual([
    '| ORCH1 | 0.2.16 | yellow | 근거 #24146 |',
    '| ORCH2 | 0.2.16 | yellow | 근거 #24146 |',
    '| FINISH-RATE | 0.2.16 | yellow | 근거 #24146 |',
  ]);
  expect(rows(section(brief, 3))).toEqual([
    '| 0.3.0 | ENT-A | 기업 진입 |', '| 0.3.0 | GRID-B | 그리드 |',
    '| 0.3.1 | ENT-A | 기업 진입 |', '| 0.3.1 | GRID-B | 그리드 |',
  ]);
  expect(section(brief, 2)).toContain('실제 병합 수 (self-implement run-ledger 전체 기록 · 중복 PR 제외 · 외부/수동 병합 제외): 2');
  expect(section(brief, 4)).toContain('발사 대비 병합 · 사람 수확 비율');
});

test('read failures name the failing source and reason without erasing independent sections', () => {
  const input = sources();
  input.featureMap = () => { throw new Error('맵 읽기 실패'); };
  input.checklist = (version) => {
    if (version === '0.3.1') throw new Error('체크리스트 읽기 실패');
    return sources().checklist(version);
  };
  input.merges = () => { throw new Error('병합 원장 읽기 실패'); };
  const brief = generateAxBrief('0.2.16', input);
  expect(section(brief, 1)).toContain('못 읽음 · 사유: 맵 읽기 실패');
  expect(rows(section(brief, 1))).toHaveLength(0);
  expect(rows(section(brief, 2))).toHaveLength(3);
  expect(section(brief, 2)).toContain('실제 병합 수 (self-implement run-ledger 전체 기록 · 중복 PR 제외 · 외부/수동 병합 제외): 못 읽음 · 사유: 병합 원장 읽기 실패');
  expect(rows(section(brief, 3))).toHaveLength(2);
  expect(section(brief, 3)).toContain('0.3.1: 못 읽음 · 사유: 체크리스트 읽기 실패');
  input.schedules = () => { throw new Error('일정 읽기 실패'); };
  expect(section(generateAxBrief('0.2.16', input), 3)).toContain('못 읽음 · 사유: 일정 읽기 실패');
  input.checklist = () => { throw new Error('현재 판 읽기 실패'); };
  expect(section(generateAxBrief('0.2.16', input), 2)).toContain('못 읽음 · 사유: 현재 판 읽기 실패');
});

test('missing or partially unreadable merge ledgers are not represented as a complete zero', () => {
  const input = sources();
  input.merges = () => ({ entries: [], ledgerDirectoryMissing: true, unreadableLedgerCount: 0, excludedLedgerCount: 0 });
  expect(section(generateAxBrief('0.2.16', input), 2)).toContain('실제 병합 수 (self-implement run-ledger 전체 기록 · 중복 PR 제외 · 외부/수동 병합 제외): 못 읽음 · 사유: 원장 디렉터리 없음');
  input.merges = () => ({ entries: sources().merges().entries, ledgerDirectoryMissing: false, unreadableLedgerCount: 1, excludedLedgerCount: 2 });
  expect(section(generateAxBrief('0.2.16', input), 2)).toContain('실제 병합 수 (self-implement run-ledger 전체 기록 · 중복 PR 제외 · 외부/수동 병합 제외): 못 읽음 · 사유: 원장 1건 판독 실패 · 확인된 병합 2건 (집계 불완전) · 미반영 원장: 못 읽음 1건 · 중복 병합 제외 2건');
  input.merges = () => ({ entries: [], ledgerDirectoryMissing: false, unreadableLedgerCount: 1, excludedLedgerCount: 0 });
  expect(section(generateAxBrief('0.2.16', input), 2)).toContain('실제 병합 수 (self-implement run-ledger 전체 기록 · 중복 PR 제외 · 외부/수동 병합 제외): 못 읽음 · 사유: 원장 1건 판독 실패 · 확인된 병합 0건 (집계 불완전)');
  input.merges = () => ({ entries: sources().merges().entries, ledgerDirectoryMissing: false, unreadableLedgerCount: 0, excludedLedgerCount: 2 });
  expect(section(generateAxBrief('0.2.16', input), 2)).toContain('실제 병합 수 (self-implement run-ledger 전체 기록 · 중복 PR 제외 · 외부/수동 병합 제외): 2 · 미반영 원장: 못 읽음 0건 · 중복 병합 제외 2건');
});

test('the CLI reads the isolated run ledger for the actual merge count', () => {
  const root = mkdtempSync(join(tmpdir(), 'ax-brief-merges-'));
  try {
    const ledgerDir = join(root, 'run-ledger');
    mkdirSync(ledgerDir);
    const runId = 'run-00000000-0000-0000-0000-000000000001';
    writeFileSync(join(ledgerDir, `${runId}.jsonl`), JSON.stringify({
      runId, timestamp: '2026-10-05T00:00:00Z', event: 'merged', data: { number: 24146, merged: true },
    }) + '\n');
    const result = spawnSync('bun', ['scripts/marketing/generate-ax-brief.ts', '--version', '0.2.16'], {
      encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root }, timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('실제 병합 수 (self-implement run-ledger 전체 기록 · 중복 PR 제외 · 외부/수동 병합 제외): 1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the AX brief keeps its four sections and the internal header even when every source is empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'ax-brief-'));
  try {
    const result = spawnSync('bun', ['scripts/marketing/generate-ax-brief.ts', '--version', '0.2.16'], {
      encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_CONFIG_DIR: root }, timeout: 60_000 });
    expect(result.status, result.stderr).toBe(0);
    for (const heading of ['## 1. 지금 되는 것', '## 2. 자율 단계표', '## 3. 로드맵 계단', '## 4. 도입 경로']) expect(result.stdout).toContain(heading);
    expect(result.stdout).toContain('공개 문서가 아닙니다');
    expect(result.stdout).toContain('계획 · 바뀔 수 있습니다');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
