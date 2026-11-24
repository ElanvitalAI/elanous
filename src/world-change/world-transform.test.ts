// COORD-WORLD-TRANSFORM — 세계 변경 원장 · 목표 역산 루프 단위시험.
// ① 원장 append/list/되돌리기 표시 ② 변형안 3(재배치/개조/신설) ③ 판정식: 폴러 고장 주입 → 루프 → 지표 회복 · 사람 개입 0 · 원장 기록.
import { describe, test, expect } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordWorldChange, listWorldChanges, markReverted, type WorldChangeEntry } from './world-change-ledger.js';
import { planWorldTransforms, selectWorldTransform, runWorldTransformLoop, type WorldSnapshot, type WorldGoal } from './world-transform.js';

const ISO = '2026-11-24T09:00:00Z';

function ledgerDir(): string { return mkdtempSync(join(tmpdir(), 'world-change-')); }
const draft = (i: number): Omit<WorldChangeEntry, 'id' | 'status'> => ({
  at: ISO, goal: `테스트 목표 ${i}`, handle: 'device', action: 'modify', what: '폴러 수리', why: '고장 지표 회복',
  revert: ['이전 구성 복원', '원장 되돌리기 표시'], metricsBefore: { pollerSuccessRate: 0.1 }, world: 'sim',
});

describe('① 세계 변경 원장 — JSONL append · list · 되돌리기 표시', () => {
  test('append → list 왕복: id·status(applied) 자동 채움, 파일은 JSONL', () => {
    const dir = ledgerDir();
    try {
      const file = join(dir, 'ledger.jsonl');
      const first = recordWorldChange(file, draft(1));
      expect(typeof first.id).toBe('string');
      expect(first.id.length).toBeGreaterThan(0);
      expect(first.status).toBe('applied');
      expect(listWorldChanges(file)).toEqual([first]);
      // 파일은 한 줄에 한 레코드인 JSONL 이어야 한다.
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual(first);
      const second = recordWorldChange(file, draft(2));
      expect(listWorldChanges(file)).toEqual([first, second]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('되돌리기 표시 — 대상 항목만 status=reverted, 원장 나머지는 그대로', () => {
    const dir = ledgerDir();
    try {
      const file = join(dir, 'ledger.jsonl');
      const a = recordWorldChange(file, draft(1));
      const b = recordWorldChange(file, draft(2));
      const flipped = markReverted(file, a.id);
      expect(flipped).not.toBeNull();
      expect(flipped!.id).toBe(a.id);
      expect(flipped!.status).toBe('reverted');
      const listed = listWorldChanges(file);
      expect(listed).toHaveLength(2);
      expect(listed.find((e) => e.id === a.id)?.status).toBe('reverted');
      expect(listed.find((e) => e.id === b.id)?.status).toBe('applied');
      expect(markReverted(file, 'no-such-id')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('손상된 줄은 건너뛰고 유효한 원장 항목만 읽는다', () => {
    const dir = ledgerDir();
    try {
      const file = join(dir, 'ledger.jsonl');
      const good = recordWorldChange(file, draft(1));
      appendFileSync(file, '{ broken json\n');
      expect(listWorldChanges(file)).toEqual([good]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('② 목표 역산 — 변형안 3(재배치/개조/신설), 결정적 점수', () => {
  const goal: WorldGoal = { metric: 'pollerSuccessRate', target: 0.95, withinMs: 2 * 60 * 60_000 };
  const broken: WorldSnapshot = {
    at: ISO, world: 'sim',
    metrics: { pollerSuccessRate: 0.1, queueDepth: 40 },
    failures: [{ component: 'poller', kind: 'crash' }],
  };

  test('변형안은 정확히 3개 — relocate/modify/create 각 1, 비용·위험·되돌리기 명시', () => {
    const proposals = planWorldTransforms(goal, broken);
    expect(proposals).toHaveLength(3);
    const actions = proposals.map((p) => p.action).sort();
    expect(actions).toEqual(['create', 'modify', 'relocate']);
    for (const p of proposals) {
      expect(p.cost).toBeGreaterThan(0);
      expect(p.risk).toBeGreaterThanOrEqual(0);
      expect(p.risk).toBeLessThanOrEqual(1);
      expect(p.revert.length).toBeGreaterThan(0);
      expect(p.what.length).toBeGreaterThan(0);
      expect(p.why.length).toBeGreaterThan(0);
      expect(Number.isFinite(p.score)).toBe(true);
    }
  });

  test('결정적 — 같은 입력이면 변형안·점수가 동일하다', () => {
    expect(planWorldTransforms(goal, broken)).toEqual(planWorldTransforms(goal, broken));
  });

  test('지표가 이미 목표 이상이면 변형안 없음', () => {
    expect(planWorldTransforms(goal, { ...broken, metrics: { ...broken.metrics, pollerSuccessRate: 0.99 } })).toEqual([]);
  });

  test('선택은 최고 점수 — 3안 중 결정적 승자', () => {
    const proposals = planWorldTransforms(goal, broken);
    const selected = selectWorldTransform(proposals);
    expect(selected).not.toBeNull();
    expect(proposals.every((p) => selected!.score >= p.score)).toBe(true);
    expect(selectWorldTransform([])).toBeNull();
  });
});

describe('③ 판정식 — 착지 폴러 고장 주입 → 루프 → 지표 회복 · 사람 개입 0 · 원장 기록', () => {
  test('폴러 고장 → 변형안 선택 → 41분 만에 회복 → 원장 1건, 사람 개입 0', () => {
    const dir = ledgerDir();
    try {
      const file = join(dir, 'ledger.jsonl');
      const goal: WorldGoal = { metric: 'pollerSuccessRate', target: 0.95, withinMs: 2 * 60 * 60_000 };
      const broken: WorldSnapshot = {
        at: ISO, world: 'ops',
        metrics: { pollerSuccessRate: 0.1, queueDepth: 40 },
        failures: [{ component: 'poller', kind: 'crash' }],
      };
      const run = runWorldTransformLoop({
        goal, snapshot: broken, ledgerFile: file, at: '2026-11-24T09:41:00Z',
        apply: (proposal, snap) => ({
          snapshot: { ...snap, at: '2026-11-24T09:41:00Z', metrics: { ...snap.metrics, pollerSuccessRate: 0.98 }, failures: [] },
          tookMs: 41 * 60_000,
        }),
      });
      // 2h 내 지표 회복
      expect(run.status).toBe('recovered');
      expect(run.after).toBeGreaterThanOrEqual(goal.target);
      expect(run.elapsedMs).toBeLessThanOrEqual(goal.withinMs);
      // 사람 개입 0
      expect(run.humanInterventions).toBe(0);
      // 원장에 기록 남음 — 변형안 내용과 일치
      const entries = listWorldChanges(file);
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe(run.proposal!.action);
      expect(entries[0].handle).toBe(run.proposal!.handle);
      expect(entries[0].revert.length).toBeGreaterThan(0);
      expect(entries[0].metricsBefore.pollerSuccessRate).toBe(0.1);
      expect(entries[0].world).toBe('ops');
      expect(entries[0].goal).toContain('pollerSuccessRate');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('적용 결과 지표가 여전히 목표 미달이면 회복 실패로 보고한다', () => {
    const dir = ledgerDir();
    try {
      const file = join(dir, 'ledger.jsonl');
      const goal: WorldGoal = { metric: 'pollerSuccessRate', target: 0.95, withinMs: 2 * 60 * 60_000 };
      const run = runWorldTransformLoop({
        goal,
        snapshot: { at: ISO, world: 'sim', metrics: { pollerSuccessRate: 0.1 }, failures: [{ component: 'poller', kind: 'crash' }] },
        ledgerFile: file,
        apply: (_p, snap) => ({ snapshot: snap, tookMs: 1000 }), // 고장 그대로 — 회복 안 됨
      });
      expect(run.status).toBe('failed');
      expect(listWorldChanges(file)).toHaveLength(1); // 시도 자체는 원장에 남는다
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('지표가 이미 목표 달성이면 원장에 아무것도 쓰지 않는다', () => {
    const dir = ledgerDir();
    try {
      const file = join(dir, 'ledger.jsonl');
      const goal: WorldGoal = { metric: 'pollerSuccessRate', target: 0.95, withinMs: 2 * 60 * 60_000 };
      const run = runWorldTransformLoop({
        goal,
        snapshot: { at: ISO, world: 'sim', metrics: { pollerSuccessRate: 0.99 }, failures: [] },
        ledgerFile: file,
        apply: () => { throw new Error('적용이 불러와져선 안 된다'); },
      });
      expect(run.status).toBe('nothing-to-do');
      expect(run.proposal).toBeNull();
      expect(run.humanInterventions).toBe(0);
      expect(listWorldChanges(file)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
