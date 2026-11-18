// ── 턴 결과 그림자 비교 시험 — 가짜 계획 상태 ⊕ 추출 fixture → missed/spurious/agree · 이벤트에 글 0 (ELN-PLAN-LEDGER-ONE) ──
import { describe, expect, test } from 'bun:test';
import { KNOWN_LOG_EVENT_NAMES } from '../../cli/log-event-names.js';
import { extractCommitments } from './commitment-extract.js';
import { NEGATIVE_COMMITMENTS, POSITIVE_COMMITMENTS } from './commitment-extract.fixtures.js';
import { COMMITMENT_LEDGER_ENV, recordReplyCommitments } from './commitment-ledger.js';
import {
  compareTurnOutcome,
  TURN_OUTCOME_MISMATCH_EVENT, type PlanOutcomeReadView,
} from './turn-outcome-shadow.js';

const OPEN_PLAN: PlanOutcomeReadView = { items: [{ id: 'a', status: 'done' }, { id: 'b', status: 'in_progress' }] };
const WAITING_PLAN: PlanOutcomeReadView = { items: [{ id: 'a', status: 'waiting' }] };
const DONE_PLAN: PlanOutcomeReadView = { items: [{ id: 'a', status: 'done' }, { id: 'b', status: 'blocked' }] };

function capture() {
  const events: { category: string; event: string; data: Record<string, unknown> }[] = [];
  return { events, emit: (category: string, event: string, data: Record<string, unknown>) => { events.push({ category, event, data }); } };
}

function patternsOf(text: string) { return extractCommitments(text).map(c => c.pattern); }

const PATTERN_NAMES = ['declared-next-step', 'continue-marker', 'pledge-ko', 'pledge-en', 'report-after-check'];

/** 이벤트에 글 0 — 문자열 값은 정해진 어휘(종류·자리·turnId·꼴 이름)뿐이고, fixture 원문·약속 내용은 어디에도 없다. */
function expectNoText(data: Record<string, unknown>, sources: readonly string[], turnId: string) {
  const allowed = new Set(['missed', 'spurious', 'TC', turnId, ...PATTERN_NAMES]);
  for (const v of Object.values(data)) {
    if (typeof v === 'string') expect(allowed.has(v)).toBe(true);
    else expect(v === null || typeof v === 'number').toBe(true);
  }
  const serialized = JSON.stringify(data);
  for (const src of sources) expect(serialized.includes(src)).toBe(false);
}

describe('turn-outcome-shadow · 판정', () => {
  test('agree — 양성 fixture ⊕ 할 일 남음 · 음성 fixture ⊕ 할 일 없음 → 이벤트 0', () => {
    const { events, emit } = capture();
    for (const f of POSITIVE_COMMITMENTS) {
      expect(compareTurnOutcome({ seat: 'TC', turnId: 't', extractedPatterns: patternsOf(f.input), plan: OPEN_PLAN }, { emit }).verdict).toBe('agree');
      expect(compareTurnOutcome({ seat: 'TC', turnId: 't', extractedPatterns: patternsOf(f.input), plan: WAITING_PLAN }, { emit }).verdict).toBe('agree');
    }
    for (const f of NEGATIVE_COMMITMENTS) {
      expect(compareTurnOutcome({ seat: 'TC', turnId: 't', extractedPatterns: patternsOf(f.input), plan: DONE_PLAN }, { emit }).verdict).toBe('agree');
    }
    expect(events).toEqual([]);
  });

  test('missed — 계획엔 할 일 · 음성 fixture(추출 0) → turn.outcome-mismatch kind missed · 글 0', () => {
    for (const f of NEGATIVE_COMMITMENTS) {
      const { events, emit } = capture();
      const r = compareTurnOutcome({ seat: 'tc', turnId: 't-1', extractedPatterns: patternsOf(f.input), plan: OPEN_PLAN }, { emit });
      expect(r).toEqual({ verdict: 'missed', extracted: 0, open: 1 });
      expect(events).toEqual([{ category: 'turn', event: TURN_OUTCOME_MISMATCH_EVENT, data: { kind: 'missed', seat: 'TC', turnId: 't-1', pattern: null, extracted: 0, open: 1 } }]);
      expectNoText(events[0]!.data, [f.input], 't-1');
    }
  });

  test('spurious — 계획 전부 done·blocked · 양성 fixture → kind spurious ⊕ 꼴 이름만 · 글 0', () => {
    for (const f of POSITIVE_COMMITMENTS) {
      const { events, emit } = capture();
      const r = compareTurnOutcome({ seat: 'TC', turnId: 't-2', extractedPatterns: patternsOf(f.input), plan: DONE_PLAN }, { emit });
      expect(r.verdict).toBe('spurious');
      expect(events.length).toBe(1);
      expect(events[0]!.data).toEqual({ kind: 'spurious', seat: 'TC', turnId: 't-2', pattern: f.pattern, extracted: r.extracted, open: 0 });
      expectNoText(events[0]!.data, [f.input, f.text], 't-2');
    }
  });

  test('no-structure — 계획 상태 없음·항목 0 이면 비교·이벤트 0', () => {
    const { events, emit } = capture();
    const pledge = patternsOf(POSITIVE_COMMITMENTS[0]!.input);
    expect(compareTurnOutcome({ seat: 'TC', turnId: 't', extractedPatterns: pledge }, { emit }).verdict).toBe('no-structure');
    expect(compareTurnOutcome({ seat: 'TC', turnId: 't', extractedPatterns: pledge, plan: { items: [] } }, { emit }).verdict).toBe('no-structure');
    expect(events).toEqual([]);
  });

  test('이벤트 이름은 allowlist 에 있다', () => {
    expect(KNOWN_LOG_EVENT_NAMES.has(TURN_OUTCOME_MISMATCH_EVENT)).toBe(true);
  });
});

describe('turn-outcome-shadow · recordReplyCommitments 이음매(기본 off)', () => {
  test('env 없으면 추출도 비교도 안 한다', () => {
    const { events, emit } = capture();
    const r = recordReplyCommitments({ seat: 'TC', sessionId: 's', finalText: POSITIVE_COMMITMENTS[0]!.input, plan: DONE_PLAN }, { env: {}, emit });
    expect(r).toEqual({ enabled: false, recorded: [], existing: [] });
    expect(events).toEqual([]);
  });

  test('켜면 missed 를 남긴다 — turnId 없으면 sessionId', () => {
    const { events, emit } = capture();
    const r = recordReplyCommitments(
      { seat: 'TC', sessionId: 's-9', finalText: NEGATIVE_COMMITMENTS[0]!.input, plan: OPEN_PLAN },
      { env: { [COMMITMENT_LEDGER_ENV]: 'shadow' }, emit },
    );
    expect(r.verdict).toBe('missed');
    expect(events.map(e => [e.event, e.data.turnId])).toEqual([[TURN_OUTCOME_MISMATCH_EVENT, 's-9']]);
  });
});
