import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { seatReport as report } from './seat-report.js';
import type { SeatReportDeps } from './seat-report.js';
import { runSeatLoopOnce, seatLedgerPath, type SeatEntry } from './seat-loop.js';

const m = { launches24h: null, launched: null, unmeasured: null, sourceIncomplete: false, linked: null, autoLanded: null, autoRate: null, secondSiblingMedianHours: null, salvaged: null, salvageUnmeasured: null };
const seatReport = (seat: string, deps: SeatReportDeps = {}) => report(seat, {
  draftMetrics: async () => ({ inventory: 0, oldestAgeHours: null, needsOwner: 0, converted48h: 0, cohort48h: 0, conversion48h: null }),
  overlapMetrics: async () => ({ ...m, launches24h: 0, launched: 3, unmeasured: 0, linked: 0, autoLanded: 0 }),
  salvagedToday: async () => 0,
  coverLogs: () => [],
  ...deps,
});

const now = new Date('2026-10-02T23:20:00Z');

test('report: launch, decision, skip in one paragraph; without --post no sending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    const path = seatLedgerPath('TC', root, now);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      { seat: 'TC', at: now.toISOString(), status: 'launched', item: { source: 'checklist', id: 'K1', title: 'build', text: 'build', version: '0.2.9' }, runId: 'run-12345678-1234-1234-1234-123456789abc' },
      { seat: 'TC', at: now.toISOString(), status: 'hitl', item: { source: 'checklist', id: 'K2', title: '게시', text: '게시' } },
      { seat: 'TC', at: now.toISOString(), status: 'skipped-budget', item: { source: 'request', id: 'a', title: 'wait', text: 'wait' } },
    ].map((v) => JSON.stringify(v)).join('\n') + '\n');
    const calls: unknown[] = [];
    const deps = { root, now: () => now, runningRuns: () => ({ running: 0, unknown: 0 }), config: { mode: 'shadow' as const, reportPr: 16815 }, send: async (...args: unknown[]) => { calls.push(args); } };
    const result = await seatReport('TC', deps);
    expect(result.body).toContain('발사 0.2.9 K1 build (run-12345678-1234-1234-1234-123456789abc)');
    expect(result.body).toContain('결정 상정 K2 게시');
    expect(result.body).toContain('건너뜀 skipped-budget a wait');
    expect(result.body.split('\n')).toHaveLength(1);
    expect(result.body).toStartWith('**[TC]** {{TS}} → 보고');
    expect(calls).toHaveLength(0);
    expect((await seatReport('TC', { ...deps, post: true })).posted).toBe(true);
    expect(calls).toEqual([[result.body, 'TC', 16815]]);
    expect((await seatReport('TC', { ...deps, config: { mode: 'shadow' }, post: true })).posted).toBe(false);
    expect(calls).toHaveLength(1);
    writeFileSync(path, JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'outcome-unknown',
      item: { source: 'request', id: 'b', title: 'verify', text: 'verify' } }) + '\n');
    expect((await seatReport('TC', deps)).body).toContain('결과 확인 필요 outcome-unknown b verify');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hourly OP report includes exactly one formatted land cover line, preserves the other seats, and posts the same body', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-cover-'));
  try {
    const seen: string[] = [];
    const sent: string[] = [];
    const result = await seatReport('OP', { root, now: () => now, config: { mode: 'shadow', reportPr: 16815 }, post: true,
      coverLogs: (query) => {
        seen.push(query.exactCategories![0]!);
        const payloads = query.exactCategories?.[0] === 'task-agent'
          ? [{ kind: 'land', result: 'done' }, { kind: 'land', result: 'shadow' }]
          : [{ step: 'merge', ok: true }, { step: 'merge', ok: true }];
        return payloads.map((data) => ({ category: query.exactCategories![0], event: query.events![0], data: JSON.stringify(data) }) as import('../mss/logging/log-store.js').LogStoreRow);
      }, send: (body) => { sent.push(body); },
    });
    expect(seen).toEqual(['task-agent', 'pr.land']);
    expect(result.body.match(/TASK-AGENT cover /g)).toHaveLength(1);
    expect(result.body).toContain('TASK-AGENT cover land: TA 1/2 (50.0%) · live 1 · shadow 1 · steward-transition observed');
    expect(result.body.split('\n')).toHaveLength(1);
    expect(sent).toEqual([result.body]);
    const other = await seatReport('TC', { root, now: () => now, coverLogs: () => { throw Error('TC must not read cover'); } });
    expect(other.body).toBe('**[TC]** {{TS}} → 보고 2026-10-03: 원장 기록 없음 · 도는 런 0');
    expect(existsSync(seatLedgerPath('OP', root, now))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OP cover does not invent a denominator when one source fails or reaches its bound', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-cover-'));
  try {
    const base = { root, now: () => now, config: { mode: 'shadow' as const } };
    const unreadable = await seatReport('OP', { ...base, coverLogs: (query) => {
      if (query.exactCategories?.[0] === 'pr.land') throw Error('unavailable');
      return [{ category: 'task-agent', event: 'action', data: JSON.stringify({ kind: 'land', result: 'done' }) } as import('../mss/logging/log-store.js').LogStoreRow];
    } });
    expect(unreadable.body).toContain('TASK-AGENT cover land: TA 1/- (-) · live 1 · shadow 0 · steward-transition unmeasured');
    const bounded = await seatReport('OP', { ...base, coverLogs: (query) => ({
      rows: query.exactCategories?.[0] === 'task-agent'
        ? [{ category: 'task-agent', event: 'action', data: JSON.stringify({ kind: 'land', result: 'done' }) } as import('../mss/logging/log-store.js').LogStoreRow]
        : [{ category: 'pr.land', event: 'step', data: JSON.stringify({ step: 'merge', ok: true }) } as import('../mss/logging/log-store.js').LogStoreRow],
      limitReached: query.exactCategories?.[0] === 'pr.land', unreadableStores: 0, storesRead: 1,
    }) });
    expect(bounded.body).toContain('TASK-AGENT cover land: TA 1/- (-) · live 1 · shadow 0 · steward-transition unmeasured');
    const partial = await seatReport('OP', { ...base, coverLogs: (query) => ({
      rows: query.exactCategories?.[0] === 'task-agent'
        ? [{ category: 'task-agent', event: 'action', data: JSON.stringify({ kind: 'land', result: 'done' }) } as import('../mss/logging/log-store.js').LogStoreRow]
        : [{ category: 'pr.land', event: 'step', data: JSON.stringify({ step: 'merge', ok: true }) } as import('../mss/logging/log-store.js').LogStoreRow],
      limitReached: false, unreadableStores: 1, storesRead: 1,
    }) });
    expect(partial.body).toContain('TASK-AGENT cover land: TA 1/1 (100.0%) · live 1 · shadow 0 · steward-transition observed (logs.db 1개 못 읽음)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hourly OP report reaches draft census and preserves other seat formatting and ledger', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    const calls: string[] = [];
    const draftMetrics = async (clock: Date) => {
      calls.push(clock.toISOString());
      return { inventory: 3, oldestAgeHours: 49, needsOwner: 1, converted48h: 2, cohort48h: 4, conversion48h: 0.5 };
    };
    const report = await seatReport('OP', { root, now: () => now, draftMetrics, config: { mode: 'shadow' } });
    expect(calls).toEqual([now.toISOString()]);
    expect(report.body).toContain('원장 기록 없음 · draft 재고 3 · 최장 나이 49.0h · needs-owner 1 · 48h 전환율 50.0% (2/4)');
    expect(existsSync(seatLedgerPath('OP', root, now))).toBe(false);
    expect((await seatReport('TC', { root, now: () => now, draftMetrics, config: { mode: 'shadow' } })).body)
      .not.toContain('draft 재고');
    expect(calls).toHaveLength(1);
    const failed = await seatReport('OP', { root, now: () => now, config: { mode: 'shadow' },
      draftMetrics: async () => { throw Error('GitHub unavailable'); } });
    expect(failed.body).toContain('원장 기록 없음 · draft 지표 못 읽음');
    expect(failed.posted).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hourly OP report carries the overlap line next to the draft line; unmeasured never prints as 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    const base = { root, now: () => now, config: { mode: 'shadow' as const } };
    const measured = await seatReport('OP', { ...base, overlapMetrics: async (clock) => {
      expect(clock).toEqual(now);
      return { ...m, launches24h: 4, launched: 10, unmeasured: 0, linked: 3, autoLanded: 2, autoRate: 2 / 3, secondSiblingMedianHours: 3.5 };
    } });
    expect(measured.body).toContain('48h 전환율 표본 없음 · 겹침 발사 24h 4 (발사 10) · 겹침 자동 착지 66.7% (2/3) · 둘째 형제 착지 중앙값 3.5h');
    expect((await seatReport('OP', base)).body).toContain('겹침 발사 24h 0 (발사 3) · 겹침 자동 착지 표본 없음 · 둘째 형제 착지 중앙값 표본 없음');
    // A capped open-PR scan is «못 잼», so the overlap count is only a lower bound.
    expect((await seatReport('OP', { ...base, overlapMetrics: async () => ({ ...m, launches24h: 2, launched: 9, unmeasured: 5 }) })).body)
      .toContain('겹침 발사 24h 2 이상 (발사 9 중 5 못 잼) · 겹침 자동 착지 못 잼 · 둘째 형제 착지 중앙값 못 잼');
    for (const metrics of [m, { ...m, sourceIncomplete: true }]) {
      const body = (await seatReport('OP', { ...base, overlapMetrics: async () => metrics })).body;
      expect(body).toContain('겹침 발사 24h 못 잼(원천 불완전)');
      expect(body).not.toContain('겹침 발사 24h 0');
    }
    const failed = await seatReport('OP', { ...base, overlapMetrics: async () => { throw Error('logs unavailable'); } });
    expect(failed.body).toContain('48h 전환율 표본 없음 · 겹침 지표 못 읽음');
    expect((await seatReport('TC', base)).body).not.toContain('겹침');
    // DRAFT-NOT-ARCHIVE salvage siblings are «not landed»; an unreadable salvage source says «못 잼», never 0.
    expect((await seatReport('OP', { ...base, overlapMetrics: async () => ({ ...m, launches24h: 3, launched: 5, unmeasured: 0, linked: 2, autoLanded: 1, autoRate: 0.5, secondSiblingMedianHours: 2, salvaged: 1, salvageUnmeasured: 0 }) })).body)
      .toContain('겹침 자동 착지 50.0% (1/2) · 둘째 형제 착지 중앙값 2.0h · 수확 가지 형제 1(미착지) · 수확 가지 오늘 0');
    expect((await seatReport('OP', { ...base, overlapMetrics: async () => ({ ...m, launches24h: 1, launched: 1, unmeasured: 0, linked: 0, autoLanded: 0, salvaged: null, salvageUnmeasured: 1 }) })).body)
      .toContain('수확 가지 1 못 잼');
    const day = await seatReport('OP', { ...base, salvagedToday: async (dayStart, clock) => {
      expect(dayStart.toISOString()).toBe('2026-10-02T15:00:00.000Z');
      expect(clock).toEqual(now);
      return 4;
    } });
    expect(day.body).toContain('수확 가지 오늘 4');
    for (const salvagedToday of [async () => null, async () => { throw Error('logs unavailable'); }]) {
      const body = (await seatReport('OP', { ...base, salvagedToday })).body;
      expect(body).toContain('수확 가지 오늘 못 잼');
      expect(body).not.toContain('수확 가지 오늘 0');
    }
    expect((await seatReport('TC', base)).body).not.toContain('수확 가지');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OP report: four shadow judgments split into two card candidates and two OP todos without raising decisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    const path = seatLedgerPath('OP', root, now);
    mkdirSync(dirname(path), { recursive: true });
    const candidates: NonNullable<SeatEntry['candidate']>[] = [
      { kind: 'release-readiness', version: '0.2.9', verdict: 'not-ready', red: ['R1'], undecided: [], blocked: [] },
      { kind: 'unassigned-cell', version: '0.2.9', id: 'U1', title: '담당 빈 칸', status: 'yellow', verdict: 'assign' },
      { kind: 'decision-delegation', id: 'D-money', title: '결제 승인', category: 'money', verdict: 'review-delegation' },
      { kind: 'decision-delegation', id: 'D-security', title: '접근 보안', category: 'security', verdict: 'review-delegation' },
    ];
    writeFileSync(path, candidates.map((candidate) => JSON.stringify({ seat: 'OP', at: now.toISOString(), status: 'shadow', candidate })).join('\n') + '\n');
    const calls: unknown[] = [];
    const report = await seatReport('OP', { root, now: () => now, config: { mode: 'shadow' },
      send: (...args) => { calls.push(args); } });
    expect(report.body).toContain('결정 카드 후보: 결정 대리 D-money 결제 승인 (money) / 결정 대리 D-security 접근 보안 (security)');
    expect(report.body).toContain('OP 가 할 일: 판올림 준비 0.2.9 · not-ready · 빨강 R1 · 미결 없음 · 차단 없음 / 빈 칸 분배 0.2.9 U1 담당 빈 칸');
    expect(report.body.split('\n')).toHaveLength(1);
    expect(report.posted).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(join(root, 'decisions', 'decisions.jsonl'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OP report keeps every unassigned cell distinct and a later none clears them all', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    const path = seatLedgerPath('OP', root, now);
    mkdirSync(dirname(path), { recursive: true });
    const append = (candidate: NonNullable<SeatEntry['candidate']>) =>
      writeFileSync(path, `${JSON.stringify({ seat: 'OP', at: now.toISOString(), status: 'shadow', candidate })}\n`, { flag: 'a' });
    append({ kind: 'unassigned-cell', version: '0.2.9', id: 'U1', title: '첫 칸', verdict: 'assign' });
    append({ kind: 'unassigned-cell', version: '0.2.9', id: 'U2', title: '둘째 칸', verdict: 'assign' });
    append({ kind: 'unassigned-cell', version: '0.2.10', id: 'U1', title: '다른 판', verdict: 'assign' });
    const deps = { root, now: () => now, config: { mode: 'shadow' as const } };
    const before = (await seatReport('OP', deps)).body;
    expect(before).toContain('빈 칸 분배 0.2.9 U1 첫 칸 / 빈 칸 분배 0.2.9 U2 둘째 칸 / 빈 칸 분배 0.2.10 U1 다른 판');
    append({ kind: 'unassigned-cell', version: null, id: null, verdict: 'none' });
    expect((await seatReport('OP', deps)).body).not.toContain('빈 칸 분배');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OP loop ledger judgments reach the OP seat report without decisions raise', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    const calls: string[][] = [];
    const result = await runSeatLoopOnce('OP', { root, now: () => now, config: { mode: 'shadow', seats: ['OP'] },
      schedules: () => [{ version: '0.2.9', cutAt: '2026-10-05T00:00:00Z' }],
      checklistItems: () => [{ id: 'U1', title: '담당 빈 칸', status: 'yellow' }],
      pendingDecisions: () => [{ id: 'D1', title: '결제 승인', category: 'money' }],
      run: async (args) => { calls.push(args); throw Error('shadow executed'); } });
    expect(result.status).toBe('shadow');
    const body = (await seatReport('OP', { root, now: () => now, config: { mode: 'shadow' } })).body;
    expect(body).toContain('결정 카드 후보: 결정 대리 D1 결제 승인 (money)');
    expect(body).toContain('OP 가 할 일: 판올림 준비 0.2.9');
    expect(body).toContain('빈 칸 분배 0.2.9 U1 담당 빈 칸');
    expect(calls).toEqual([]);
    expect(existsSync(join(root, 'decisions', 'decisions.jsonl'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OP loop D1 closes then D2 opens: the report removes the stale D1 card without raising decisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    let pending: Array<{ id: string; title: string; category: 'money' | 'security' }> = [
      { id: 'D1', title: '결제 승인', category: 'money' },
    ];
    const calls: string[][] = [];
    const deps = { root, now: () => now, config: { mode: 'shadow' as const, seats: ['OP'] },
      schedules: () => [], checklistItems: () => [], pendingDecisions: () => pending,
      run: async (args: string[]) => { calls.push(args); throw Error('shadow executed'); } };
    await runSeatLoopOnce('OP', deps);
    expect((await seatReport('OP', { root, now: () => now, config: { mode: 'shadow' } })).body)
      .toContain('결정 카드 후보: 결정 대리 D1 결제 승인 (money)');
    pending = [{ id: 'D2', title: '접근 보안', category: 'security' }];
    await runSeatLoopOnce('OP', deps);
    const body = (await seatReport('OP', { root, now: () => now, config: { mode: 'shadow' } })).body;
    expect(body).toContain('결정 카드 후보: 결정 대리 D2 접근 보안 (security)');
    expect(body).not.toContain('D1 결제 승인');
    const candidates = readFileSync(seatLedgerPath('OP', root, now), 'utf8').trim().split('\n')
      .map((line) => (JSON.parse(line) as SeatEntry).candidate).filter((candidate) => candidate?.kind === 'decision-delegation');
    expect(candidates).toEqual([
      { kind: 'decision-delegation', id: 'D1', title: '결제 승인', category: 'money', verdict: 'review-delegation' },
      { kind: 'decision-delegation', id: 'D2', title: '접근 보안', category: 'security', verdict: 'review-delegation' },
      { kind: 'decision-delegation', id: 'D1', verdict: 'none' },
    ]);
    expect(calls).toEqual([]);
    expect(existsSync(join(root, 'decisions', 'decisions.jsonl'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OP loop writes all unassigned cells for the report and none removes them when assigned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    let items = [
      { id: 'U1', title: '첫 칸', status: 'yellow', owner: '' },
      { id: 'U2', title: '둘째 칸', status: 'red', owner: '' },
    ];
    const calls: string[][] = [];
    const deps = { root, now: () => now, config: { mode: 'shadow' as const, seats: ['OP'] },
      schedules: () => [{ version: '0.2.9', cutAt: '2026-10-05T00:00:00Z' }],
      checklistItems: () => items, pendingDecisions: () => [],
      run: async (args: string[]) => { calls.push(args); throw Error('shadow executed'); } };
    await runSeatLoopOnce('OP', deps);
    const path = seatLedgerPath('OP', root, now);
    const first = (await seatReport('OP', { root, now: () => now, config: { mode: 'shadow' } })).body;
    expect(first).toContain('빈 칸 분배 0.2.9 U1 첫 칸 / 빈 칸 분배 0.2.9 U2 둘째 칸');
    await runSeatLoopOnce('OP', deps);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(4);
    items = items.map((item) => item.id === 'U1' ? { ...item, owner: 'TC' } : item);
    await runSeatLoopOnce('OP', deps);
    const partial = (await seatReport('OP', { root, now: () => now, config: { mode: 'shadow' } })).body;
    expect(partial).not.toContain('빈 칸 분배 0.2.9 U1 첫 칸');
    expect(partial).toContain('빈 칸 분배 0.2.9 U2 둘째 칸');
    items = items.map((item) => ({ ...item, owner: 'TC' }));
    await runSeatLoopOnce('OP', deps);
    const second = (await seatReport('OP', { root, now: () => now, config: { mode: 'shadow' } })).body;
    expect(second).not.toContain('빈 칸 분배');
    expect(readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line).candidate)
      .filter((candidate) => candidate.kind === 'unassigned-cell').map((candidate) => candidate.verdict)).toEqual(['assign', 'assign', 'none', 'none']);
    expect(calls).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('OP report: decision category boundary and most recent changed judgment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    const path = seatLedgerPath('OP', root, now);
    mkdirSync(dirname(path), { recursive: true });
    const candidates: NonNullable<SeatEntry['candidate']>[] = [
      { kind: 'release-readiness', version: null, verdict: 'no-open-release', red: [], undecided: [], blocked: [] },
      { kind: 'unassigned-cell', version: null, id: null, verdict: 'none' },
      { kind: 'decision-delegation', id: 'D1', title: '범위 확인', category: 'scope', verdict: 'review-delegation' },
      { kind: 'decision-delegation', id: 'D2', title: '삭제 승인', category: 'irreversible', verdict: 'review-delegation' },
      { kind: 'decision-delegation', id: 'D3', title: '바깥 게시', category: 'publish', verdict: 'review-delegation' },
      { kind: 'decision-delegation', id: 'D4', title: '비밀 확인', category: 'secret', verdict: 'review-delegation' },
      { kind: 'decision-delegation', id: 'D1', title: '범위 확인 완료', category: 'other', verdict: 'review-delegation' },
    ];
    writeFileSync(path, candidates.map((candidate) => JSON.stringify({ seat: 'OP', at: now.toISOString(), status: 'shadow', candidate })).join('\n') + '\n');
    const body = (await seatReport('OP', { root, now: () => now, config: { mode: 'shadow' } })).body;
    expect(body).toContain('결정 카드 후보: 결정 대리 D2 삭제 승인 (irreversible) / 결정 대리 D3 바깥 게시 (publish) / 결정 대리 D4 비밀 확인 (secret)');
    expect(body).toContain('OP 가 할 일: 결정 대리 D1 범위 확인 완료 (other)');
    expect(body).not.toContain('범위 확인 (scope)');
    expect(body).not.toContain('no-open-release');
    expect(body).not.toContain('빈 칸 분배');
    writeFileSync(path, `${JSON.stringify({ seat: 'OP', at: now.toISOString(), status: 'shadow',
      candidate: { kind: 'decision-delegation', id: null, verdict: 'none' } })}\n`, { flag: 'a' });
    const cleared = (await seatReport('OP', { root, now: () => now, config: { mode: 'shadow' } })).body;
    expect(cleared).not.toContain('결정 카드 후보:');
    expect(cleared).not.toContain('결정 대리');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('report: one line per item, last state wins — attempting then launched is not «unconfirmed»', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    const path = seatLedgerPath('TC', root, now);
    mkdirSync(dirname(path), { recursive: true });
    const k1 = { source: 'checklist', id: 'K1', title: 'build', text: 'build', version: '0.2.9' };
    const k2 = { source: 'checklist', id: 'K2', title: 'ship', text: 'ship', version: '0.2.9' };
    writeFileSync(path, [
      { seat: 'TC', at: now.toISOString(), status: 'attempting', item: k1 },
      { seat: 'TC', at: now.toISOString(), status: 'launched', item: k1, runId: 'run-12345678-1234-1234-1234-123456789abc' },
      { seat: 'TC', at: now.toISOString(), status: 'attempting', item: k2 },
    ].map((v) => JSON.stringify(v)).join('\n') + '\n');
    const body = (await seatReport('TC', { root, now: () => now, runningRuns: () => ({ running: 0, unknown: 0 }), config: { mode: 'on' } })).body;
    expect(body).toContain('발사 0.2.9 K1 build');
    expect(body).not.toContain('결과 확인 필요 attempting 0.2.9 K1');
    expect(body).toContain('결과 확인 필요 attempting 0.2.9 K2 ship');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('report counts distinct launched runIds for every seat and appends the running field after existing detail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    for (const seat of ['MK', 'OP', 'TC', 'UX']) {
      const path = seatLedgerPath(seat, root, now);
      mkdirSync(dirname(path), { recursive: true });
      const item = (id: string) => ({ source: 'checklist', id, title: id, text: id });
      writeFileSync(path, [
        { seat, at: now.toISOString(), status: 'launched', item: item('K1'), runId: 'r1' },
        { seat, at: now.toISOString(), status: 'launched', item: item('K2'), runId: 'r2' },
        { seat, at: now.toISOString(), status: 'launched', item: item('K3'), runId: 'r3' },
        { seat, at: now.toISOString(), status: 'launched', item: item('K4'), runId: 'r1' },
        { seat, at: now.toISOString(), status: 'hitl', item: item('K5'), runId: 'ignored' },
        { seat, at: now.toISOString(), status: 'launched', item: item('K6') },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      const received: string[][] = [];
      const body = (await seatReport(seat, { root, now: () => now, runningRuns: (ids) => {
        received.push([...ids]);
        return { running: 2, unknown: 1 };
      } })).body;
      expect(received).toEqual([['r1', 'r2', 'r3']]);
      const prefix = `**[${seat}]** {{TS}} → 보고 2026-10-03: 발사 K1 K1 (r1) · 발사 K2 K2 (r2) · 발사 K3 K3 (r3) · 발사 K4 K4 (r1) · 결정 상정 K5 K5 · 발사 K6 K6 (runId 없음)`;
      expect(body.startsWith(prefix)).toBe(true);
      if (seat === 'OP') {
        expect(body).toContain(' · 수확 가지 오늘 0 · TASK-AGENT cover land: TA 0/0 (-) · live 0 · shadow 0 · steward-transition unmeasured · 도는 런 2(불확실 1)');
      }
      else expect(body).toBe(`${prefix} · 도는 런 2(불확실 1)`);
      expect(body).toEndWith(' · 도는 런 2(불확실 1)');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('report default lookup follows isolated run-ledger start and termination records', () => {
  const home = mkdtempSync(join(tmpdir(), 'seat-report-real-ledger-'));
  try {
    const state = join(home, '.elanous');
    const runId = `run-${randomUUID()}`;
    const script = `
      import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      import { seatReport } from ${JSON.stringify(join(import.meta.dir, 'seat-report.ts'))};
      import { seatLedgerPath } from ${JSON.stringify(join(import.meta.dir, 'seat-loop.ts'))};
      import { upsertPtyManifest, markPtyManifestClosed } from ${JSON.stringify(join(import.meta.dir, '../pty-shell/pty-manifest.ts'))};
      const state = ${JSON.stringify(state)};
      const id = ${JSON.stringify(runId)};
      const now = new Date(${JSON.stringify(now.toISOString())});
      const seatPath = seatLedgerPath('TC', state, now);
      mkdirSync(dirname(seatPath), { recursive: true });
      writeFileSync(seatPath, JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'launched',
        item: { source: 'checklist', id: 'K1', title: 'build', text: 'build' }, runId: id }) + '\\n');
      const ledgerPath = join(state, 'run-ledger', id + '.jsonl');
      mkdirSync(dirname(ledgerPath), { recursive: true });
      const record = (event, data) => appendFileSync(ledgerPath,
        JSON.stringify({ timestamp: new Date().toISOString(), runId: id, event, data }) + '\\n');
      record('start', {});
      upsertPtyManifest({ id: 'seat-report-live', kind: 'shell', cmd: 'test fixture', startedAt: Date.now(), now: Date.now() });
      const before = (await seatReport('TC', { root: state, now: () => now })).body;
      record('run-status', { runStatus: 'failed' });
      const terminatedWithPty = (await seatReport('TC', { root: state, now: () => now })).body;
      markPtyManifestClosed('seat-report-live', 0, Date.now());
      const after = (await seatReport('TC', { root: state, now: () => now })).body;
      console.log(JSON.stringify({ before, terminatedWithPty, after }));
    `;
    const child = spawnSync('bun', ['-e', script], {
      cwd: join(import.meta.dir, '../..'), encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: state, ELANOUS_CONFIG_DIR: state, ELANOUS_RUN_ID: runId },
    });
    expect(child.status, child.stderr).toBe(0);
    const { before, terminatedWithPty, after } = JSON.parse(child.stdout.trim().split('\n').at(-1)!) as { before: string; terminatedWithPty: string; after: string };
    expect(before).toEndWith(' · 도는 런 1(불확실 0)');
    expect(terminatedWithPty).toEndWith(' · 도는 런 0(불확실 1)');
    expect(after).toEndWith(' · 도는 런 0(불확실 0)');
    expect(before.slice(0, before.lastIndexOf(' · 도는 런'))).toBe(after.slice(0, after.lastIndexOf(' · 도는 런')));
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 150_000);

test('report distinguishes failed or null running lookup from no launched runs without querying the empty set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    const path = seatLedgerPath('TC', root, now);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'launched',
      item: { source: 'checklist', id: 'K1', title: 'build', text: 'build' }, runId: 'r1' }) + '\n');
    const base = { root, now: () => now };
    const failed = (await seatReport('TC', { ...base, runningRuns: () => { throw Error('ledger unavailable'); } })).body;
    expect(failed).toBe('**[TC]** {{TS}} → 보고 2026-10-03: 발사 K1 build (r1) · 도는 런 못 잼');
    expect((await seatReport('TC', { ...base, runningRuns: () => null })).body).toEndWith(' · 도는 런 못 잼');
    expect((await seatReport('TC', { ...base, runningRuns: () => ({ running: 0, unknown: 0 }) })).body)
      .toEndWith(' · 도는 런 0(불확실 0)');
    writeFileSync(path, JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'hitl',
      item: { source: 'checklist', id: 'K1', title: 'build', text: 'build' }, runId: 'r1' }) + '\n');
    let lookups = 0;
    const empty = (await seatReport('TC', { ...base, runningRuns: () => { lookups += 1; return null; } })).body;
    expect(lookups).toBe(0);
    expect(empty).toBe('**[TC]** {{TS}} → 보고 2026-10-03: 결정 상정 K1 build · 도는 런 0');
    expect(failed).not.toBe(empty);
    writeFileSync(path, JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'launched',
      item: { source: 'checklist', id: 'K2', title: 'unidentified', text: 'unidentified' } }) + '\n');
    const missingId = (await seatReport('TC', { ...base, runningRuns: () => { lookups += 1; return null; } })).body;
    expect(lookups).toBe(0);
    expect(missingId).toBe('**[TC]** {{TS}} → 보고 2026-10-03: 발사 K2 unidentified (runId 없음) · 도는 런 0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
