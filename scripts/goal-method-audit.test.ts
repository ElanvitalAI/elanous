// AUTHOR-MANUAL-SYNC — 감사기(생산 CLI)가 매뉴얼 §6 의 «사람 몫» 선언을 «문서에서» 읽는지 잰다.
// 무대 이름: 생산 CLI 실물 — `bun scripts/goal-method-audit.ts` 를 그대로 띄워 그 출력을 대조한다
// (repo-audit-weekly.ts AUDITORS 도 같은 경로로 이 스크립트를 부른다).
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectClauses, collectSlotLoads, declaredHumanSlots, readManual } from './goal-method-audit.js';

const ROOT = join(import.meta.dir, '..');
setDefaultTimeout(120_000);
const MANUAL = 'docs/manual/MANUAL-goal-authoring-method-2026-08-03.md';
const manualLines = readManual(join(ROOT, MANUAL));

describe('goal-method-audit reads the §6 human-slot declaration from the manual (AUTHOR-MANUAL-SYNC)', () => {
  test('the declaration comes from §6, not from a literal baked into the auditor', () => {
    const declared = declaredHumanSlots(manualLines);

    expect(declared).toBe('둘');
    expect(declared).not.toBe('여섯');
  });

  test('the auditor keeps reading the §6 slot notation that the manual uses', () => {
    const slots = collectSlotLoads(manualLines);

    expect(slots.map(slot => slot.slot)).toEqual(['①', '②', '①a', '①b', '①c', '①d']);
    expect(slots.find(slot => slot.slot === '①d')?.clauses).toEqual(['🅙', '🅝', '🅤', '🅑', '🅣']);
    expect(collectClauses(manualLines).length).toBeGreaterThan(0);
  });

  test('every clause still hangs on a §6 slot — the revision leaves no clause orphaned', () => {
    const mapped = new Set(collectSlotLoads(manualLines).flatMap(slot => slot.clauses));
    const unmapped = [...new Set(collectClauses(manualLines).map(clause => clause.label))]
      .filter(label => !mapped.has(label));

    expect(unmapped).toEqual([]);
  });

  test('the production entry prints the declaration it read from the manual', () => {
    const run = spawnSync(process.execPath, ['scripts/goal-method-audit.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(run.status).toBe(0);
    const slotLine = (run.stdout ?? '').split('\n').find(line => line.includes('축② 사람 칸'))!;
    expect(slotLine).toContain('§6 선언 «둘»');
    expect(slotLine).not.toContain('«여섯»');
  });

  test('the auditor self-check still passes', () => {
    const run = spawnSync(process.execPath, ['scripts/goal-method-audit.ts', '--self-check'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(run.status).toBe(0);
  });
});

describe('goal-method-audit input stays the manual file itself', () => {
  test('readManual returns the same lines the file has', () => {
    const raw = readFileSync(join(ROOT, MANUAL), 'utf8').split('\n');

    expect(manualLines.length).toBe(raw.length);
  });
});
