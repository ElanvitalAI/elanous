import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { nextNode } from '../graph-runner/runner.js';
import { appendWaiverEvent, createWaiverEvent, evaluateWaiverEvent, consumeWaiverEvent, consumeWaiverEventFromLedger, gateWaiverEvidence, hasExactWaiverEvidence, promoteWaiverEvent, readWaiverEvents, setWaiverDirectorySyncForTest, type WaiverEventInput } from '../release-loop/waiver-events.js';

const base: Omit<WaiverEventInput, 'mode'> = {
  kind: 'review-cap', target: 'pr:35000', head: 'a'.repeat(40), evidence: ['review-cap-allow.tsv:row-1'],
  actor: 'OP', issuedAt: 1_000, expiresAt: 86_401_000, maxUses: 1,
};

test('shadow authorization promotes to an operational one-use event and expires after consumption', () => {
  const shadow = createWaiverEvent({ ...base, mode: 'shadow' });
  expect(evaluateWaiverEvent(shadow, { target: base.target, head: base.head, now: 2_000 })).toMatchObject({ allowed: false, mode: 'shadow', reason: 'shadow-only' });

  const operational = promoteWaiverEvent(shadow, 1_500);
  expect(evaluateWaiverEvent(operational, { target: base.target, head: base.head, now: 2_000 })).toMatchObject({ allowed: true, mode: 'operational', usesRemaining: 1 });
  const consumed = consumeWaiverEvent(operational, { target: base.target, head: base.head, now: 2_001 });
  expect(evaluateWaiverEvent(consumed, { target: base.target, head: base.head, now: 2_002 })).toMatchObject({ allowed: false, expiredBy: 'used' });
  expect(() => promoteWaiverEvent(operational, 2_000)).toThrow('only an active unused shadow event can be promoted');
  const root = mkdtempSync(join(tmpdir(), 'waiver-event-transition-'));
  try {
    const ledger = join(root, 'events.jsonl');
    appendWaiverEvent(ledger, shadow);
    appendWaiverEvent(ledger, operational);
    appendWaiverEvent(ledger, consumed);
    expect(readWaiverEvents(ledger).map((event) => event.mode)).toEqual(['operational']);
    expect(JSON.parse(readFileSync(ledger, 'utf8').trim().split('\n').at(-1)!)).toMatchObject({ expiredBy: 'used', uses: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shadow and operational policy reject measured regressions, changed heads, and expired events', () => {
  for (const mode of ['shadow', 'operational'] as const) {
    const gate = createWaiverEvent({ ...base, kind: 'gate', target: 'run:run-1', mode, maxUses: 1, expiresAt: 10_000,
      evidence: ['gate-verdict.json:unmeasured'], });
    expect(evaluateWaiverEvent(gate, { target: 'run:run-1', head: base.head, now: 2_000, measuredRegression: true }))
      .toMatchObject({ allowed: false, reason: 'measured-regression' });
    const operational = mode === 'shadow' ? promoteWaiverEvent(gate, 2_000) : gate;
    expect(evaluateWaiverEvent(operational, { target: 'run:run-1', head: 'b'.repeat(40), now: 2_001 }))
      .toMatchObject({ allowed: false, expiredBy: 'head-changed' });
    expect(evaluateWaiverEvent(operational, { target: 'run:run-1', head: base.head, now: 10_000 }))
      .toMatchObject({ allowed: false, expiredBy: 'release-ended' });
    expect(evaluateWaiverEvent(operational, { target: 'run:run-1', head: base.head, now: 999 }))
      .toMatchObject({ allowed: false, reason: 'event not issued yet' });
  }
});

test('OP waiver receives its exact-head and 72-hour lifetime in the event contract', () => {
  const event = createWaiverEvent({ ...base, kind: 'op-waiver', mode: 'operational', target: 'pr:35002', maxUses: 1, expiresAt: 72_001_000 });
  expect(evaluateWaiverEvent(event, { target: event.target, head: base.head, now: 1_000 })).toMatchObject({ allowed: true });
  expect(evaluateWaiverEvent(event, { target: event.target, head: 'c'.repeat(40), now: 1_001 })).toMatchObject({ allowed: false, expiredBy: 'head-changed' });
  expect(evaluateWaiverEvent(event, { target: event.target, head: base.head, now: 72_001_000 })).toMatchObject({ allowed: false, expiredBy: 'timeout' });
});

test('release gate simulation invokes the real triage entrypoint for shadow-to-operational events', () => {
  const root = mkdtempSync(join(tmpdir(), 'waiver-event-gate-cli-'));
  const ledger = join(root, 'review-results', 'waiver-events.jsonl');
  mkdirSync(join(root, 'review-results'), { recursive: true });
  const issuedAt = Date.now();
  const gate = createWaiverEvent({ ...base, kind: 'gate', target: 'run:release-42', mode: 'shadow', maxUses: 1, issuedAt,
    expiresAt: issuedAt + 24 * 60 * 60 * 1000, evidence: ['saved-run:release-42', 'gate:incomplete-sweep'] });
  const runTriage = (runId: string, introduced: string[] = []) => {
    const context = { runId, input: { version: '0.3.6', previousVersion: '0.3.5' }, outputs: { gate: {
      outcome: 'error', commit: gate.head, introduced, preexisting: 0, fixed: null, knownEnv: 0,
      knownEnvCleared: [], stalledEnv: [], stalledShards: [{ files: ['src/a.test.ts'], reason: 'no-output' }],
      rcNonzeroNoFailures: [], durationMs: 1,
    } } };
    const result = spawnSync('bun', ['scripts/release-loop/gate-triage-node.ts'], { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) } });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as {
      outcome: string; waiverEventConsumed?: string; waiverEventObservations: Array<Record<string, unknown>>;
    };
  };
  try {
    appendWaiverEvent(ledger, gate);
    expect(runTriage('release-42').waiverEventObservations).toMatchObject([{ decision: { allowed: false, reason: 'shadow-only' } }]);
    expect(runTriage('other-run').waiverEventObservations).toMatchObject([{ decision: { allowed: false, reason: 'target-mismatch' } }]);
    const operational = promoteWaiverEvent(gate, Date.now());
    appendWaiverEvent(ledger, operational);
    const measured = runTriage('release-42', ['src/a.test.ts > measured regression']);
    expect(measured.waiverEventObservations).toMatchObject([{ decision: { allowed: false, reason: 'measured-regression' } }]);
    expect(readWaiverEvents(ledger)).toMatchObject([{ eventId: operational.eventId, uses: 0 }]);
    const triage = runTriage('release-42');
    expect(triage).toMatchObject({ outcome: 'fail',
      waiverEventObservations: [{ decision: { allowed: true, mode: 'operational' } }] });
    expect(readWaiverEvents(ledger)).toMatchObject([{ eventId: operational.eventId, uses: 0 }]);
    expect(runTriage('release-42').waiverEventObservations).toMatchObject([{ decision: { allowed: true, mode: 'operational' } }]);
    const releaseGraph = parseGraphTemplateYaml(readFileSync(join(process.cwd(), 'graphs/release/release-loop.yaml'), 'utf8'));
    expect(releaseGraph.template).toBeDefined();
    expect(nextNode(releaseGraph.template!.edges, 'gate', 'ok', 'waived')).toBe('receipt-audit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate transition rejects a fabricated consumption timestamp before shadow promotion', () => {
  const root = mkdtempSync(join(tmpdir(), 'waiver-event-time-order-'));
  try {
    const ledger = join(root, 'events.jsonl');
    const shadow = createWaiverEvent({ ...base, mode: 'shadow' });
    const operational = promoteWaiverEvent(shadow, 1_500);
    appendWaiverEvent(ledger, shadow);
    appendWaiverEvent(ledger, operational);
    const invalid = { ...operational, uses: 1, expiredBy: 'used' as const, consumedAt: 1_400 };
    expect(() => appendWaiverEvent(ledger, invalid)).toThrow('invalid waiver event transition');
    const alteredPromotion = { ...operational, uses: 1, expiredBy: 'used' as const, consumedAt: 1_600, promotedAt: 1_501 };
    expect(() => appendWaiverEvent(ledger, alteredPromotion)).toThrow('invalid waiver event transition');
    expect(() => consumeWaiverEvent(operational, { target: base.target, head: base.head, now: 1_400 }))
      .toThrow('event not promoted yet');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('competing gate consumers from the same snapshot serialize to exactly one use', () => {
  const root = mkdtempSync(join(tmpdir(), 'waiver-event-race-'));
  try {
    const ledger = join(root, 'events.jsonl');
    const event = createWaiverEvent({ ...base, kind: 'gate', target: 'run:race-1', mode: 'operational',
      expiresAt: base.expiresAt, evidence: ['gate:unmeasured'] });
    appendWaiverEvent(ledger, event);
    // Two graph workers can both observe this snapshot before either append acquires the ledger lock.
    const observedByFirst = readWaiverEvents(ledger)[0]!;
    const observedBySecond = readWaiverEvents(ledger)[0]!;
    const first = consumeWaiverEvent(observedByFirst, { target: event.target, head: event.head, now: 2_000 });
    const second = consumeWaiverEvent(observedBySecond, { target: event.target, head: event.head, now: 2_001 });
    appendWaiverEvent(ledger, first);
    expect(() => appendWaiverEvent(ledger, second)).toThrow('invalid waiver event transition');
    expect(readWaiverEvents(ledger)).toMatchObject([{ uses: 1, expiredBy: 'used', consumedAt: 2_000 }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('gate consumption binds the exact reason and approver and rejects duplicate exact grants atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'waiver-event-binding-'));
  const target = 'run:bound-1', head = base.head, now = Date.now();
  // Derive the one-use cap and expiry interval from the suite's canonical event fixture.
  const make = (reason: string, actor: string) => createWaiverEvent({ kind: 'gate', mode: 'operational', target, head,
    evidence: gateWaiverEvidence({ reason, actor, unmeasured: 'stopped before verdict' }), actor, issuedAt: now - 1,
    expiresAt: now + (base.expiresAt - base.issuedAt), maxUses: base.maxUses });
  try {
    const ledger = join(root, 'events.jsonl');
    const wrong = make('Different approval. Not this request.', 'OTHER');
    const approved = make('Approved exact reason. This is the authorized waiver.', 'OP');
    appendWaiverEvent(ledger, wrong);
    appendWaiverEvent(ledger, approved);
    const evidence = gateWaiverEvidence({ reason: 'Approved exact reason. This is the authorized waiver.', actor: 'OP', unmeasured: 'stopped before verdict' });
    consumeWaiverEventFromLedger(ledger, (event) => event.target === target && event.head === head && event.actor === 'OP'
      && evidence.every((item) => event.evidence.includes(item)), { target, head, now: () => now, measuredRegression: false });
    expect(readWaiverEvents(ledger)).toMatchObject([
      { eventId: wrong.eventId, uses: 0 }, { eventId: approved.eventId, uses: 1, expiredBy: 'used' },
    ]);

    const ambiguousLedger = join(root, 'ambiguous.jsonl');
    appendWaiverEvent(ambiguousLedger, make('Approved exact reason. This is the authorized waiver.', 'OP'));
    appendWaiverEvent(ambiguousLedger, make('Approved exact reason. This is the authorized waiver.', 'OP'));
    expect(() => consumeWaiverEventFromLedger(ambiguousLedger, (event) => event.target === target && event.head === head
      && event.actor === 'OP' && evidence.every((item) => event.evidence.includes(item)), { target, head, now: () => now, measuredRegression: false }))
      .toThrow('release gate waiver event missing, ambiguous, or mismatched');
    expect(readWaiverEvents(ambiguousLedger).every((event) => event.uses === 0)).toBe(true);

    const expiryLedger = join(root, 'expiry.jsonl');
    const expiring = make('Approved exact reason. This is the authorized waiver.', 'OP');
    appendWaiverEvent(expiryLedger, expiring);
    let clockReadUnderLock = false;
    expect(() => consumeWaiverEventFromLedger(expiryLedger, (event) => event.eventId === expiring.eventId, {
      target, head, now: () => { clockReadUnderLock = existsSync(`${expiryLedger}.lock`); return expiring.expiresAt; }, measuredRegression: false,
    })).toThrow('release gate waiver event missing, ambiguous, or mismatched');
    expect(clockReadUnderLock).toBe(true);
    expect(readWaiverEvents(expiryLedger)[0]).toMatchObject({ uses: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stale event ledger locks fail closed with a manual recovery instruction', () => {
  const root = mkdtempSync(join(tmpdir(), 'waiver-event-stale-lock-'));
  try {
    const ledger = join(root, 'events.jsonl');
    mkdirSync(root, { recursive: true });
    writeFileSync(`${ledger}.lock`, JSON.stringify({ pid: 99_999_999, createdAt: 1 }));
    const event = createWaiverEvent({ ...base, mode: 'operational' });
    expect(() => appendWaiverEvent(ledger, event)).toThrow(`verify the owner process is gone, then remove ${ledger}.lock`);
    expect(readFileSync(`${ledger}.lock`, 'utf8')).toContain('99999999');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recursive ledger directory creation fsyncs every new parent entry in creation order', () => {
  const root = mkdtempSync(join(tmpdir(), 'waiver-event-dir-durability-'));
  const ledger = join(root, 'one', 'two', 'three', 'events.jsonl');
  const synced: string[] = [];
  try {
    setWaiverDirectorySyncForTest((path) => { synced.push(path); });
    appendWaiverEvent(ledger, createWaiverEvent({ ...base, mode: 'operational' }));
    expect(synced).toEqual([root, join(root, 'one'), join(root, 'one', 'two')]);
    expect(readWaiverEvents(ledger)).toHaveLength(1);
  } finally {
    setWaiverDirectorySyncForTest(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test('directory fsync failure prevents waiver append and leaves no lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'waiver-event-dir-fsync-failure-'));
  const ledger = join(root, 'one', 'two', 'events.jsonl');
  const failingParent = join(root, 'one');
  try {
    setWaiverDirectorySyncForTest((path) => {
      if (path === failingParent) throw new Error('injected directory fsync failure');
    });
    expect(() => appendWaiverEvent(ledger, createWaiverEvent({ ...base, mode: 'operational' })))
      .toThrow('injected directory fsync failure');
    expect(readWaiverEvents(ledger)).toEqual([]);
    expect(() => readFileSync(`${ledger}.lock`, 'utf8')).toThrow();
  } finally {
    setWaiverDirectorySyncForTest(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test('gate waiver evidence must match the exact saved finding; stale supersets are rejected', () => {
  const expected = ['saved-run:/state/run.json', ...gateWaiverEvidence({ reason: 'Retry this release gate.', actor: 'OP', unmeasured: 'new failure detail' })];
  expect(hasExactWaiverEvidence({ evidence: expected }, expected)).toBe(true);
  expect(hasExactWaiverEvidence({ evidence: [...expected, 'gate-waiver:unmeasured:old failure detail'] }, expected)).toBe(false);
  expect(hasExactWaiverEvidence({ evidence: expected.filter((item) => !item.endsWith('new failure detail')) }, expected)).toBe(false);
});
