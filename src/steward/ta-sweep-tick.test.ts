import { expect, test } from 'bun:test';
import { afterEach, beforeAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { readTaskCard, writeTaskCards } from '../task-agent/task-card-state.js';
import type { TaskCard } from '../task-agent/task-hand.js';
import { TA_SKIP_NOTE_EVENT, type TaRecycleOutcome } from '../task-agent/launch-result-loop.js';
import { taSweepTick, TA_SWEEP_TICK_EVENT, type TaSweepTickDeps } from './ta-sweep-tick.js';

/**
 * TA-SWEEP-PERIODIC(FU of TA-LAUNCH-RESULT-LOOP · 칸 0.3.33) — 회수 스윕의 주기 루프.
 * `tasks show` 관측에만 도는 회수를 스튜어드 그래프 틱(15분)에 편승해 전체 카드 원장으로 돌린다.
 * 완료 경계(관측 의존 탈피): 무진척 발사가 관측 없이도 한 틱 안에 회수 후보로 오른다.
 * 기본 끔(사람이 taskAgent.sweepEveryMinutes 로 켠다) · due=직전 시작 ≥ 간격−2분(틱 시작 지터) ·
 * 실패는 관측 한 줄로 fail-soft(exit 0) · 매 틱 debug.log('loop.steward', 'ta-sweep-tick', …) 1줄.
 */

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const AT = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString();

const dirs: string[] = [];
afterEach(() => {
  resetElanousConfigDir();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 시험 본문 안 저장소 모듈 동적 import는 interference ratchet(body-dynamic-import)에 걸린다 — 데워 둔다. */
let reloadUserConfig: typeof import('../user-config.js').reloadUserConfig;
beforeAll(async () => {
  ({ reloadUserConfig } = await import('../user-config.js'));
}, 120_000); // 출처: #39483 데우기 한도 — test/helpers/nexus-boot-guard.ts NEXUS_WARM_TIMEOUT_MS 관례(hook 한도)

function card(fields: Partial<TaskCard> & { id: string }): TaskCard {
  return {
    text: fields.text ?? '시범 칸 본문',
    status: fields.status ?? 'launched',
    history: fields.history ?? [],
    createdAt: fields.createdAt ?? AT(30 * 60_000),
    ...fields,
  } as TaskCard;
}

const hist = (rows: NonNullable<TaskCard['history']>): NonNullable<TaskCard['history']> => rows;

type RecycleCall = { cards: readonly TaskCard[]; nowMs: number };

function harness(
  config: { sweepEveryMinutes?: number } | undefined,
  opts: { stamp?: string; cards?: readonly TaskCard[]; recycleThrow?: boolean; outcomes?: readonly TaRecycleOutcome[] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'ta-sweep-tick-'));
  dirs.push(dir);
  const stampPath = join(dir, 'steward', 'ta-sweep-tick.json');
  if (opts.stamp) { mkdirSync(join(dir, 'steward'), { recursive: true }); writeFileSync(stampPath, JSON.stringify({ startedAt: opts.stamp })); }
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const calls: RecycleCall[] = [];
  const outcome: TaRecycleOutcome = {
    cardId: 'ta-stale', runId: 'r-stale', cause: 'grounding', minutesStalled: 20, // 출처: #39483 fixture 관측값 — 마지막 live-move(AT(20 * 60_000)) 20분 후 경과(15분 무진척 상한의 초과분), 게이트 상한 아님
    stopRecorded: true, skipNote: 'failed/recycled/grounding: 15분 무진척(20분) — 정확 runId r-stale stop · 재발사는 사람/판단부 몫',
  };
  const cards: readonly TaskCard[] | undefined = opts.cards; // const 포획 — 파라미터 속성 좁힘은 클로저에서 살지 않는다
  const deps: TaSweepTickDeps = {
    now: () => new Date(NOW),
    config: () => config,
    stampPath,
    ...(cards !== undefined ? { cards: () => cards } : {}),
    recycle: (cardsList: readonly TaskCard[], nowMs: number) => {
      calls.push({ cards: cardsList, nowMs });
      if (opts.recycleThrow) throw new Error('recycle exploded');
      return (opts.outcomes ?? [outcome]).map((row) => ({ ...row }));
    },
    log: (event: string, data: Record<string, unknown>) => { logs.push({ event, data }); },
  };
  return { dir, stampPath, logs, calls, deps };
}

test('off by default: no interval configured → disabled, nothing swept, one observation line', () => {
  const h = harness(undefined);
  const result = taSweepTick(h.deps);
  expect(result).toMatchObject({ decision: 'disabled', everyMinutes: null });
  expect(h.calls).toHaveLength(0);
  expect(existsSync(h.stampPath)).toBe(false);
  expect(h.logs.map((row) => [row.event, row.data.decision])).toEqual([[TA_SWEEP_TICK_EVENT, 'disabled']]);
});

test('0 minutes is off too', () => {
  const h = harness({ sweepEveryMinutes: 0 });
  expect(taSweepTick(h.deps).decision).toBe('disabled');
  expect(h.calls).toHaveLength(0);
  expect(existsSync(h.stampPath)).toBe(false);
});

test('due with no stamp: sweeps ALL cards, stamps the start, one observation line', () => {
  const cards = [
    card({ id: 'ta-stale', runId: 'r-stale', checklistId: 'CELL-A', history: hist([{ at: AT(20 * 60_000), event: 'live-move', detail: 'x' }]) }),
    card({ id: 'ta-fresh', runId: 'r-fresh', history: hist([{ at: AT(60_000), event: 'live-move', detail: 'x' }]) }),
    card({ id: 'ta-landed', runId: 'r-done', status: 'landed' }),
  ];
  const h = harness({ sweepEveryMinutes: 30 }, { cards });
  const result = taSweepTick(h.deps);
  expect(result).toMatchObject({ decision: 'ran', everyMinutes: 30, cards: 3, recycled: 1 });
  expect(result.outcomes).toHaveLength(1);
  expect(result.outcomes?.[0]).toMatchObject({ cardId: 'ta-stale', runId: 'r-stale', cause: 'grounding' });
  // 스윕은 전체 카드를 회수에 넘긴다(관측 고리 `tasks show` 의 한 카드가 아니다).
  expect(h.calls).toEqual([{ cards, nowMs: NOW }]);
  expect(JSON.parse(readFileSync(h.stampPath, 'utf8'))).toEqual({ startedAt: '2026-11-21T12:00:00.000Z' });
  expect(h.logs.at(-1)?.data.decision).toBe('ran');
});

// JUD-C HOLD #39483 — recordStop 가 false 를 돌려준 outcome(stopRecorded=false)은 회수 성공이 아니다.
// recycled 집계는 성공(stopRecorded)만 세고, stop 기록 실패는 별도 관측치(stopRecordFailed)로 나간다.
test('mixed outcomes: only the stop-recorded outcome counts as recycled; the failed stop attempt is stopRecordFailed', () => {
  const h = harness({ sweepEveryMinutes: 30 }, {
    outcomes: [
      { cardId: 'ta-ok', runId: 'r-ok', cause: 'grounding', minutesStalled: 20, stopRecorded: true, // 출처: #39483 fixture 관측값 — 15분 무진척 상한 초과 표본(20분), 게이트 상한 아님
        skipNote: 'failed/recycled/grounding: 15분 무진척(20분) — 정확 runId r-ok stop · 재발사는 사람/판단부 몫' },
      { cardId: 'ta-fail', runId: 'r-fail', cause: 'grounding', minutesStalled: 16, stopRecorded: false, // 출처: #39483 fixture 관측값 — 15분 무진척 상한 1분 초과 표본(16분), 게이트 상한 아님
        skipNote: 'stop-record-failed/grounding: 정확 runId stop 기록 실패 — 재시도 대상 유지(15분 무진척 16분 · runId r-fail)' },
    ],
  });
  const result = taSweepTick(h.deps);
  expect(result.decision).toBe('ran');
  expect(result.recycled).toBe(1); // 성공만 — stop 기록 실패는 recycled 성공 수에 못 들어간다
  expect(result.stopRecordFailed).toBe(1); // 실패 stop 시도의 별도 관측치
  expect(result.outcomes).toHaveLength(2); // 증거 목록은 그대로(성공·실패 판별은 outcome.stopRecorded)
  expect(h.logs.at(-1)?.data).toMatchObject({ decision: 'ran', recycled: 1, stopRecordFailed: 1 });
});

test('every stop record failed: recycled 0 — a sweep of only failures never claims recycled success', () => {
  const h = harness({ sweepEveryMinutes: 30 }, {
    outcomes: [
      { cardId: 'ta-none', runId: 'r-none', cause: 'grounding', minutesStalled: 16, stopRecorded: false, // 출처: #39483 fixture 관측값 — 15분 무진척 상한 1분 초과 표본(16분), 게이트 상한 아님
        skipNote: 'stop-record-failed/grounding: 정확 runId stop 기록 실패 — 재시도 대상 유지(15분 무진척 16분 · runId r-none)' },
    ],
  });
  expect(taSweepTick(h.deps)).toMatchObject({ decision: 'ran', recycled: 0, stopRecordFailed: 1 });
});

test('not due inside the interval; due again at interval minus jitter (a 15-minute tick at 29:30 still fires)', () => {
  const early = harness({ sweepEveryMinutes: 30 }, { cards: [], stamp: '2026-11-21T11:45:00Z' });
  const late = harness({ sweepEveryMinutes: 30 }, { cards: [], stamp: '2026-11-21T11:30:30Z' });
  expect(taSweepTick(early.deps).decision).toBe('not-due');
  expect(early.calls).toHaveLength(0);
  expect(taSweepTick(late.deps).decision).toBe('ran');
  expect(late.calls).toHaveLength(1);
});

test('a card-ledger read that throws is a failed tick — no cadence claim, the next tick retries', () => {
  const h = harness({ sweepEveryMinutes: 30 });
  const boom = { ...h.deps, cards: () => { throw new Error('ledger unreadable'); } };
  const result = taSweepTick(boom);
  expect(result).toMatchObject({ decision: 'failed', reason: 'ledger unreadable' });
  expect(existsSync(h.stampPath)).toBe(false); // 주장 전 실패 — cadence 를 태우지 않는다
  expect(h.calls).toHaveLength(0);
});

test('a corrupt existing stamp is a failed tick, not a silent first tick (a missing one is)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-sweep-corrupt-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'steward'), { recursive: true });
  const stampPath = join(dir, 'steward', 'ta-sweep-tick.json');
  writeFileSync(stampPath, 'not-json');
  const deps = {
    now: () => new Date(NOW),
    config: () => ({ sweepEveryMinutes: 30 }),
    stampPath,
    cards: () => [],
    recycle: () => [],
    log: () => { /* 관측만 */ },
  };
  expect(taSweepTick(deps)).toMatchObject({ decision: 'failed' });
});

test('a recycle that throws is a failed tick, never a crash (claim already made — this tick does not retry)', () => {
  const h = harness({ sweepEveryMinutes: 30 }, { cards: [card({ id: 'ta-x', runId: 'r-x' })], recycleThrow: true });
  const result = taSweepTick(h.deps);
  expect(result.decision).toBe('failed');
  expect(typeof result.reason).toBe('string');
  expect(existsSync(h.stampPath)).toBe(true); // 주장 뒤 실패 — 다음 틱은 cadence 를 따른다
  expect(h.logs.at(-1)?.data.decision).toBe('failed');
});

test('user-config carries taskAgent.sweepEveryMinutes and drops non-numbers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-sweep-config-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ taskAgent: { sweepEveryMinutes: 20 } }));
  expect(reloadUserConfig(path).taskAgent).toEqual({ sweepEveryMinutes: 20 });
  writeFileSync(path, JSON.stringify({ taskAgent: { liveMoves: ['review'], sweepEveryMinutes: '20' } }));
  expect(reloadUserConfig(path).taskAgent).toEqual({ liveMoves: ['review'] });
});

test('default wiring: reads the whole card ledger and recycles a stalled launch end-to-end (run-ledger stop + skip-note)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-sweep-e2e-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const priorStateDir = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root; // 런 원장도 같은 격리 뿌리(기록기 = 정본 recordRunStop)
  try {
    const statePath = join(root, 'task-agent-actions.json');
    const staleAt = new Date(NOW - 20 * 60_000).toISOString();
    writeTaskCards(statePath, [card({
      id: 'ta-sweep-e2e', runId: 'r-sweep-e2e', checklistId: 'CELL-E2E', createdAt: staleAt,
      history: hist([{ at: staleAt, event: 'live-move', detail: 'x' }]),
    })]);
    // 런 원장 디렉터리 — recordRunStop 는 디렉터리를 스스로 만들지 않는다(형제 stopdup/stoplive 시험과 같은 사전 생성 패턴).
    mkdirSync(join(root, 'run-ledger'), { recursive: true });
    const stampPath = join(root, 'steward', 'ta-sweep-tick.json');
    const result = taSweepTick({
      now: () => new Date(NOW),
      config: () => ({ sweepEveryMinutes: 30 }),
      stampPath,
      statePath,
      log: () => { /* 관측만 */ },
    });
    expect(result).toMatchObject({ decision: 'ran', everyMinutes: 30, cards: 1, recycled: 1 });
    expect(result.outcomes?.[0]).toMatchObject({ cardId: 'ta-sweep-e2e', runId: 'r-sweep-e2e', stopRecorded: true });
    // 카드 원장 — 회수 skip-note 한 줄(runId 결속).
    const after = readTaskCard('ta-sweep-e2e', statePath);
    const last = after?.history?.at(-1) as { event?: string; detail?: string } | undefined;
    expect(last?.event).toBe(TA_SKIP_NOTE_EVENT);
    expect(String(last?.detail)).toContain('failed/recycled/');
    // 런 원장 — 정확히 그 runId 의 stop 한 줄(관측 고리와 같은 기록기).
    const ledgerPath = join(root, 'run-ledger', 'r-sweep-e2e.jsonl');
    const stopLines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string }).filter((entry) => entry.event === 'stop');
    expect(stopLines).toHaveLength(1);
  } finally {
    if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = priorStateDir;
  }
});