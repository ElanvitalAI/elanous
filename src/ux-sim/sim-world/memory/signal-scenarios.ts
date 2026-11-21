// M19–M24 memory world scenarios — the signal → collector → seat-key path (내부 문서 `MEMORY-SIGNALS`).
// M19–M23 drive the sim devices ④⑤⑥ (signals.ts) and the D17 store; M24 drives the REAL product producers (frame-memory,
// recordExternalEvent, injectUtterance) into a real surface_events db. Every expect is a literal (rule 11).
// Verdicts as M01–M12: expected red + same reason → xfail · expected red + other reason → wrong-reason-red · expected red + pass
// → promote-required · unexpected mismatch on a green row → fail · crash → infra-error.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createFrameMemoryConsumer } from '../../../capture/frame-memory.js';
import { recordExternalEvent } from '../../../context-bus/external-events.js';
import { injectUtterance, recordSelfEvent } from '../../../domains/self-awareness.js';
import { openSurfaceEventsDb } from '../../../domains/surface-events.js';
import { createLogicalClock, MemoryStoreError, SimMemoryStore } from './store.js';
import { reduceSignals, seatDisplay, seatKey, seatStoreId, SignalGenerator } from './signals.js';

export type SignalVerdictKind = 'pass' | 'xfail' | 'fail' | 'wrong-reason-red' | 'promote-required' | 'infra-error';
export interface SignalScenario {
  readonly id: string; readonly title: string; readonly checks: string; readonly expected: 'red' | 'green';
  /** The literal red reason (only read when expected is red). */
  readonly reason: string; readonly greenBy: string; readonly expect: Readonly<Record<string, unknown>>;
  run(): Promise<Record<string, unknown>>;
}
export interface SignalVerdict { readonly id: string; readonly verdict: SignalVerdictKind; readonly reason: string; readonly observed?: Record<string, unknown> }

const START = '2026-11-20T00:00:00.000Z';
const MIN = 60_000;
const world = () => { const clock = createLogicalClock(START); return { clock, gen: new SignalGenerator(clock) }; };
const step = (id: string): string => id;
const DEVICE_ONLY = '장치 자체 검증 — 제품 수집기 없음(MEMORY-SIGNALS §3)';

/** M24: the three low-signal inputs of the 2026-11-20 measurement, injected through the real producers. */
async function lowSignalRows(perKind: number): Promise<Record<string, number>> {
  const root = mkdtempSync(join(tmpdir(), 'sim-memory-m24-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  const db = openSurfaceEventsDb(':memory:');
  try {
    let tick = 0;
    const consumer = createFrameMemoryConsumer({ record: input => { recordSelfEvent(db, input); }, now: () => ++tick * 10_000 });
    for (let i = 0; i < perKind; i++) consumer.observe({ surfaceId: 'pane-1', instance: 'i-1', frameAt: i, text: `build step ${i}` } as never);
    for (let i = 0; i < perKind; i++) recordExternalEvent({ origin: 'harness-child', kind: 'exit', summary: `child ${i} exit`, source: `elanous://child/${i}` }, { db });
    for (let i = 0; i < perKind; i++) injectUtterance({ origin: 'claude-code', text: `utterance body ${i}` }, db);
    const count = (surface: string) => (db.prepare('SELECT COUNT(*) AS n FROM events WHERE surface LIKE ?').get(surface) as { n: number }).n;
    return { frame: count('ext:tui-observe'), exit: count('context:external'), utterance: count('ext:claude-code'),
      total: (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
      signals: (db.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n };
  } finally {
    db.close();
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const green = (id: string, title: string, checks: string, expect: Record<string, unknown>, run: SignalScenario['run']): SignalScenario =>
  ({ id, title, checks, expected: 'green', reason: '', greenBy: DEVICE_ONLY, expect, run });

export const SIGNAL_SCENARIOS: readonly SignalScenario[] = [
  green('M19', '시그널 생성기 · 봉투 모양', 'ta/tab/harness signals carry the envelope; a repeated shape keeps one signature, a one-off is a single row; replay is identical',
    { kinds: ['ta', 'tab', 'harness'], envelopeKeys: ['eventId', 'kind', 'at', 'tenant', 'universe', 'origin', 'subject', 'outcome', 'signature', 'refs'],
      origins: ['run-1', 'pane-1', 'child-1'], repeatRows: 5, repeatSignatures: 1, onceRows: 1, replayIdentical: true }, async () => {
      const make = () => { const { gen } = world(); return [gen.once('pregate:base-red', { kind: 'ta' }), gen.once('pregate:base-red', { kind: 'tab' }),
        gen.once('pregate:base-red', { kind: 'harness' })]; };
      const mixed = make();
      const { gen } = world();
      const repeated = gen.repeat({ signature: 'land:head-moved', count: 5, origins: 1 });
      return { kinds: mixed.map(s => s.kind), envelopeKeys: Object.keys(mixed[0]!), origins: mixed.map(s => s.origin), repeatRows: repeated.length,
        repeatSignatures: new Set(repeated.map(s => s.signature)).size, onceRows: [world().gen.once('x:one-off')].length,
        replayIdentical: JSON.stringify(make()) === JSON.stringify(mixed) };
    }),
  green('M20', '시그널 생성기 · 출처 수 지정', 'origins=1 repeated vs origins=3 repeated: distinct origin count follows the spec; ids sig-N in call order; times follow the clock',
    { oneOrigin: 1, threeOrigins: 3, ids: ['sig-1', 'sig-2', 'sig-3', 'sig-4'], firstAt: '2026-11-20T00:00:00.000Z', lastAt: '2026-11-20T00:30:00.000Z' }, async () => {
      const { gen } = world();
      const single = gen.repeat({ signature: 'a:b', count: 4, origins: 1, spanMs: 30 * MIN });
      const spread = world().gen.repeat({ signature: 'a:b', count: 4, origins: 3, spanMs: 30 * MIN });
      return { oneOrigin: new Set(single.map(s => s.origin)).size, threeOrigins: new Set(spread.map(s => s.origin)).size,
        ids: single.map(s => s.eventId), firstAt: single[0]!.at, lastAt: single.at(-1)!.at };
    }),
  green('M21', '수집기 reduce · 중복 제거·횟수·신뢰도', 'five signals of one signature from 3 origins, one eventId delivered twice: 1 fact, count 5, origins 3, confidence 0.77, evidence ≤ 20',
    { facts: 1, count: 5, distinctOrigins: 3, confidence: 0.77, candidate: true, evidence: ['sig-1', 'sig-2', 'sig-3', 'sig-4', 'sig-5'] }, async () => {
      const { gen } = world();
      const signals = gen.repeat({ signature: 'pregate:shallow-clone', count: 5, origins: 3, spanMs: 20 * MIN });
      const facts = reduceSignals([...signals, signals[1]!]);
      const fact = facts[0]!;
      return { facts: facts.length, count: fact.count, distinctOrigins: fact.distinctOrigins, confidence: fact.confidence, candidate: fact.candidate, evidence: fact.evidence };
    }),
  green('M22', '수집기 문턱 · 3회/1시간 · 출처 ≥2', 'a one-off, 2 repeats, 3 repeats from one origin and 3 repeats spread over 2h are no candidate; 3 repeats from 2 origins in 40 min is one',
    { oneOff: 'count-below-3', twice: 'count-below-3', oneOrigin: 'single-origin', twoHours: 'not-within-1h', repeated: 'repeated', candidates: 1 }, async () => {
      const why = (spec: Parameters<SignalGenerator['repeat']>[0]) => reduceSignals(world().gen.repeat(spec))[0]!;
      const oneOff = reduceSignals([world().gen.once('s:one')])[0]!;
      const facts = [oneOff, why({ signature: 's:two', count: 2, origins: 2 }), why({ signature: 's:one-origin', count: 3, origins: 1 }),
        why({ signature: 's:slow', count: 3, origins: 2, spanMs: 120 * MIN }), why({ signature: 's:ok', count: 3, origins: 2, spanMs: 40 * MIN })];
      return { oneOff: facts[0]!.why, twice: facts[1]!.why, oneOrigin: facts[2]!.why, twoHours: facts[3]!.why, repeated: facts[4]!.why,
        candidates: facts.filter(f => f.candidate).length };
    }),
  green('M23', '자리 키 {namespace:seat, id} · 다른 자리 읽기 0', 'a seat key round-trips through D17 (store id rule untouched); another seat key reads 0; a list, wildcard or opaque pane-owner token is refused',
    { display: 'seat:TC', storeId: 'seat.TC', ownRead: ['tc-fact'], otherRead: 0, badIdentities: ['refused', 'refused', 'refused', 'refused'] }, async () => {
      const store = new SimMemoryStore(createLogicalClock(START));
      const own = seatKey('TC');
      const source = await store.write({ tenant: 't-x', graphId: seatStoreId(own), runId: 'r-1', nodeId: step('n-1'), key: 'fact', text: 'tc-fact' });
      await store.promote({ tenant: 't-x', graphId: seatStoreId(own), runId: 'r-1', nodeId: step('n-p'), sourceId: source.id, to: 'template', approval: { by: 'sim-approver' } });
      const read = async (seat: string) => (await store.read({ tenant: 't-x', graphId: seatStoreId(seatKey(seat)), runId: 'r-9', scopes: ['template'] })).map(r => r.text);
      const bad = (identity: string) => { try { seatKey(identity); return 'ok'; } catch { return 'refused'; } };
      return { display: seatDisplay(own), storeId: seatStoreId(own), ownRead: await read('TC'), otherRead: (await read('OP')).length,
        badIdentities: ['TC,OP', '*', 'tc', 'pane_9f3a7c01d2b84e5fa6c9017b3d2e8f40a1b5c7d9e'].map(bad) };
    }),
  { id: 'M24', title: '저신호 수집 필터 · 기억 행 0', expected: 'green', greenBy: '시그널 저장소 분리 + 수집 필터(MEMORY-SIGNALS §2 규칙 2)',
    checks: 'tui-observe frame · context:external exit · claude-code utterance, 40 each through the real producers: 0 memory rows (surface_events)',
    reason: '',
    expect: { frame: 0, exit: 0, utterance: 0, total: 0, signals: 120 }, async run() {
      const rows = await lowSignalRows(40);
      return { ...rows, ...(rows.total > 0 ? { redReason: `surface_events 직행: 수집 필터 없음 — frame ${rows.frame} · exit ${rows.exit} · utterance ${rows.utterance} = 기억 행 ${rows.total}` } : {}) };
    } },
];

export async function runSignalScenario(scenario: SignalScenario): Promise<SignalVerdict> {
  let observed: Record<string, unknown>;
  try { observed = await scenario.run(); }
  catch (error) { return { id: scenario.id, verdict: 'infra-error', reason: `scenario-crashed: ${error instanceof MemoryStoreError ? error.code : error instanceof Error ? error.message : String(error)}` }; }
  const { redReason, ...values } = observed;
  const mismatch = Object.keys(scenario.expect).find(key => !isDeepStrictEqual(values[key], scenario.expect[key]));
  if (mismatch === undefined) return scenario.expected === 'green' ? { id: scenario.id, verdict: 'pass', reason: 'as expected', observed: values }
    : { id: scenario.id, verdict: 'promote-required', reason: 'expected red is green: flip the expectation row in this PR', observed: values };
  const actual = typeof redReason === 'string' ? redReason : `expectation-mismatch: ${mismatch}`;
  if (scenario.expected === 'green') return { id: scenario.id, verdict: 'fail', reason: actual, observed: values };
  return actual === scenario.reason ? { id: scenario.id, verdict: 'xfail', reason: actual, observed: values }
    : { id: scenario.id, verdict: 'wrong-reason-red', reason: `wrong-reason-red: ${actual}`, observed: values };
}
