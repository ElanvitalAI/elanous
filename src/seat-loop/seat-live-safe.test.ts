import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { addHarnessQueue, harnessQueueOutcome, harnessQueuePath, harnessQueueReceiptPath, listHarnessQueue, reconcileHarnessQueue, removeHarnessQueue, tickHarnessQueue } from '../harness/harness-queue.js';
import { runHarnessQueueChild } from '../harness/harness-queue-child.js';
import { openMsgStore } from '../msg/msg-store.js';
import { askSeat } from '../seat-dispatch/seat-questions.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { buildUserConfig } from '../user-config.js';
import { runSeatLoopOnce, seatLedgerPath, type SeatDeps, type SeatEntry } from './seat-loop.js';

const now = new Date('2026-10-04T03:00:00Z');
const fixture = (title: string) => {
  const root = mkdtempSync(join(tmpdir(), 'seat-live-safe-'));
  const deps: SeatDeps = { root, repo: root, now: () => now, versions: () => ['0.2.9'],
    // Fixed card version: the default resolver runs `git reflog` on the real repo (≈10 s · MAIN-RED 10-06).
    resolveDecisionVersion: () => ({ released: '0.2.8', dev: '0.2.9', codename: null }),
    schedules: () => [{ version: '0.2.9', cutAt: '2099-01-01T00:00:00Z' }],
    checklistItems: () => [{ id: 'K1', title, owner: 'TC', status: 'yellow' }],
    stallChecklist: () => ({ version: '0.2.9', released: '0.2.8', dev: '0.2.9', history: [], items: [] }) };
  const ledger = (): SeatEntry[] => readFileSync(seatLedgerPath('TC', root, now), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as SeatEntry);
  return { root, deps, ledger, close: () => rmSync(root, { recursive: true, force: true }) };
};

test('seat config defaults to shadow; explicit off and live-safe round-trip', () => {
  const f = fixture('구현');
  try {
    const path = join(f.root, 'config.json');
    expect(buildUserConfig(path).loops?.seat?.mode).toBe('shadow');
    for (const mode of ['live-safe', 'off', 'on', 'shadow', 'unknown'] as const) {
      writeFileSync(path, JSON.stringify({ loops: { seat: { mode } } }));
      expect(buildUserConfig(path).loops?.seat?.mode).toBe(mode === 'unknown' ? 'shadow' : mode);
    }
  } finally { f.close(); }
});

test('default shadow observes a picked item and does not budget, enqueue or launch', async () => {
  const f = fixture('구현');
  try {
    const path = join(f.root, 'config.json');
    const calls: string[][] = [];
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { ...buildUserConfig(path).loops!.seat!, seats: ['TC'] },
      run: async (args) => { calls.push(args); throw Error('shadow ran command'); },
      enqueue: async () => { throw Error('shadow queued'); } });
    expect(result).toMatchObject({ status: 'shadow', action: 'harness', item: { id: 'K1' } });
    expect(calls).toEqual([]);
    expect(listHarnessQueue({ root: f.root })).toEqual([]);
  } finally { f.close(); }
});

test('live-safe enqueues an allowed goal through AUTOQ, with durable receipt and no direct harness say', async () => {
  const f = fixture('구현');
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const calls: string[][] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      run: async (args) => { calls.push(args); if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; } };
    const first = await runSeatLoopOnce('TC', deps);
    expect(first).toMatchObject({ status: 'queued', action: 'harness', queueId: expect.stringMatching(/^hq-/) });
    expect(f.ledger().map((row) => row.status)).toEqual(['attempting', 'queued']);
    expect(listHarnessQueue({ root: f.root })).toMatchObject([{
      id: (first as SeatEntry).queueId, seat: 'TC', kind: 'say', status: 'queued', input: '[TC 자리 · 0.2.9 체크리스트 칸 K1 · 역할 docs/roles/TC.md] 구현',
    }]);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    expect(calls.map((args) => args.slice(0, 2))).toEqual([['harness', 'budget']]);
    expect(spy.mock.calls.some(([category, event]) => category === 'seat.loop' && event === 'queued')).toBe(true);
  } finally { spy.mockRestore(); f.close(); }
});

test('AUTOQ cancellation and failed child are retryable, while successful child remains handled', async () => {
  for (const outcome of ['cancelled', 'failed', 'succeeded'] as const) {
    const f = fixture('구현');
    try {
      const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
        run: async (args) => { if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; } };
      const first = await runSeatLoopOnce('TC', deps) as SeatEntry;
      if (outcome === 'cancelled') expect(await removeHarnessQueue(first.queueId!, { root: f.root })).toBe(true);
      else {
        await tickHarnessQueue({ root: f.root, cap: () => 2, pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 2 }),
          processes: () => [], launch: async () => 501 });
        const queued = listHarnessQueue({ root: f.root })[0]!;
        const childFile = join(f.root, 'exit.ts');
        writeFileSync(childFile, `process.exitCode = ${outcome === 'failed' ? 1 : 0};`);
        expect(await runHarnessQueueChild(harnessQueueReceiptPath(f.root, queued.launchId!), childFile, []))
          .toBe(outcome === 'failed' ? 1 : 0);
      }
      const second = await runSeatLoopOnce('TC', deps) as SeatEntry;
      if (outcome === 'succeeded') {
        expect(second.status).toBe('skipped-empty');
        expect(listHarnessQueue({ root: f.root })).toHaveLength(1);
        expect(await removeHarnessQueue(first.queueId!, { root: f.root, processes: () => [], receipt: () => 'finished' })).toBe(true);
        expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
      } else {
        expect(second.status).toBe('queued');
        expect(second.queueId).not.toBe(first.queueId);
        expect(listHarnessQueue({ root: f.root }).at(-1)!.id === second.queueId).toBe(true);
      }
    } finally { f.close(); }
  }
});

test('successful uncertain AUTOQ launch stays handled after reconcile or tick removes the launching row', async () => {
  for (const cleanup of ['reconcile', 'tick'] as const) {
    const f = fixture('구현');
    try {
      const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
        run: async (args) => { if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; } };
      const first = await runSeatLoopOnce('TC', deps) as SeatEntry;
      const queueDeps = { root: f.root, cap: () => 2, pool: () => ({ running: 0, pending: 0, reserved: 0, limit: 2 }),
        processes: () => [] as const, launch: async () => { throw Error('uncertain spawn'); } };
      await expect(tickHarnessQueue(queueDeps)).rejects.toThrow('uncertain spawn');
      const launchId = listHarnessQueue({ root: f.root })[0]!.launchId!;
      const childFile = join(f.root, 'exit-zero.ts');
      writeFileSync(childFile, 'process.exitCode = 0;');
      expect(await runHarnessQueueChild(harnessQueueReceiptPath(f.root, launchId), childFile, [])).toBe(0);
      if (cleanup === 'reconcile') expect(await reconcileHarnessQueue(first.queueId!, queueDeps)).toBe('released');
      else {
        await addHarnessQueue({ seat: 'UX', say: 'next' }, { root: f.root });
        expect((await tickHarnessQueue({ ...queueDeps, launch: async () => 502 })).outcome).toBe('launched');
      }
      expect(harnessQueueOutcome(first.queueId!, { root: f.root })).toBe('succeeded');
      expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
      expect(listHarnessQueue({ root: f.root }).some((row) => row.seat === 'TC')).toBe(false);
    } finally { f.close(); }
  }
});

test('pending AUTOQ survives the day boundary and prevents duplicate even without a seat ledger receipt', async () => {
  const f = fixture('구현');
  try {
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      run: async (args) => { if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; } };
    const first = await runSeatLoopOnce('TC', deps) as SeatEntry;
    const tomorrow = new Date(now.getTime() + 8 * 24 * 60 * 60_000);
    const next = await runSeatLoopOnce('TC', { ...deps, now: () => tomorrow, ledgerFiles: () => [] }) as SeatEntry;
    expect(next.status).toBe('queued');
    expect(next.queueId).toBe(first.queueId);
    expect(listHarnessQueue({ root: f.root })).toHaveLength(1);
  } finally { f.close(); }
});

test('pending AUTOQ with the same task text but different evidence key cannot suppress refreshed work', async () => {
  const f = fixture('구현');
  let evidence = 'initial';
  try {
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      checklistItems: () => [{ id: 'K1', title: '구현', evidence, owner: 'TC', status: 'yellow' }],
      run: async (args) => { if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; } };
    const first = await runSeatLoopOnce('TC', deps) as SeatEntry;
    evidence = 'refreshed';
    const second = await runSeatLoopOnce('TC', deps) as SeatEntry;
    expect(second).toMatchObject({ status: 'queued', item: { evidence: 'refreshed' } });
    expect(second.queueId).not.toBe(first.queueId);
    expect(listHarnessQueue({ root: f.root })).toHaveLength(2);
    expect(listHarnessQueue({ root: f.root })[0]!.input).toBe(listHarnessQueue({ root: f.root })[1]!.input);
  } finally { f.close(); }
});

test('pending AUTOQ with the same key but a different task body cannot be adopted', async () => {
  const f = fixture('구현');
  try {
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      run: async (args) => { if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; } };
    const first = await runSeatLoopOnce('TC', deps) as SeatEntry;
    const nextId = 'hq-00000000-0000-4000-8000-000000000001';
    const next = await runSeatLoopOnce('TC', { ...deps, ledgerFiles: () => [],
      queueItems: (root) => listHarnessQueue({ root }).map((row) => ({ ...row, input: 'different task' })),
      enqueue: async () => ({ id: nextId }) }) as SeatEntry;
    expect(next.queueId).toBe(nextId);
    expect(next.queueId).not.toBe(first.queueId);
  } finally { f.close(); }
});

test('real AUTOQ: the same key with a different task body is refused explicitly, never adopted', async () => {
  const f = fixture('구현');
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      run: async (args) => { if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; } };
    const first = await runSeatLoopOnce('TC', deps) as SeatEntry;
    // Another writer left a queued item under this seat-loop key whose task text differs.
    const path = harnessQueuePath(f.root);
    const rows = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
    writeFileSync(path, JSON.stringify(rows.map((row) => ({ ...row, input: 'different task' }))));
    const next = await runSeatLoopOnce('TC', { ...deps, ledgerFiles: () => [] }) as SeatEntry;
    expect(next).toMatchObject({ status: 'refused', reason: expect.stringContaining('idempotency key collision') });
    expect(next.queueId).toBeUndefined();
    expect(listHarnessQueue({ root: f.root })).toEqual([expect.objectContaining({ id: first.queueId, input: 'different task' })]);
    expect(spy.mock.calls.some(([category, event, data]) => category === 'seat.loop' && event === 'refused'
      && String((data as { reason?: string }).reason).includes('collision'))).toBe(true);
  } finally { spy.mockRestore(); f.close(); }
});

test('a crash after enqueue but before the queued row is recovered by key, so a cancelled item is retried', async () => {
  const f = fixture('구현');
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const base: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      run: async (args) => { if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; } };
    const realAppend = (await import('node:fs')).appendFileSync;
    const crash = runSeatLoopOnce('TC', { ...base, append: (path, entry) => {
      if (entry.status === 'queued') throw Error('process died before the queued row');
      realAppend(path, `${JSON.stringify(entry)}\n`);
    } });
    await expect(crash).rejects.toThrow();
    // A real process death writes nothing after the intent row — keep only `attempting`.
    const ledgerPath = seatLedgerPath('TC', f.root, now);
    writeFileSync(ledgerPath, `${JSON.stringify(f.ledger().find((row) => row.status === 'attempting'))}\n`);
    expect(f.ledger().map((row) => row.status)).toEqual(['attempting']);
    const [orphan] = listHarnessQueue({ root: f.root });
    expect(orphan).toBeDefined();
    // The queue item fails (cancelled) before the seat loop runs again.
    expect(await removeHarnessQueue(orphan!.id, { root: f.root })).toBe(true);
    expect(harnessQueueOutcome(orphan!.id, { root: f.root })).toBe('retryable');
    const retry = await runSeatLoopOnce('TC', base) as SeatEntry;
    expect(retry).toMatchObject({ status: 'queued', item: { id: 'K1' } });
    expect(retry.queueId).not.toBe(orphan!.id);
    expect(spy.mock.calls.some(([category, event]) => category === 'seat.loop' && event === 'queue-recovered')).toBe(true);
  } finally { spy.mockRestore(); f.close(); }
});

test('AUTOQ idempotency key atomically reuses a waiting item across concurrent requests', async () => {
  const f = fixture('구현');
  try {
    const [a, b] = await Promise.all([addHarnessQueue({ seat: 'TC', say: 'same', idempotencyKey: 'seat:test' }, { root: f.root }),
      addHarnessQueue({ seat: 'TC', say: 'same', idempotencyKey: 'seat:test' }, { root: f.root })]);
    expect(a.id).toBe(b.id);
    expect(listHarnessQueue({ root: f.root })).toHaveLength(1);
  } finally { f.close(); }
});

test('live-safe refuses a prohibited publication but may raise its decision card, never enqueueing the publication', async () => {
  const f = fixture('마켓에 게시');
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const calls: string[][] = [];
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      run: async (args) => { calls.push(args); return args[1] === 'budget' ? '{"outcome":"proceed"}' : '{"id":"dec-1"}'; },
      enqueue: async () => { throw Error('publication queued'); } });
    expect(result).toMatchObject({ status: 'hitl', action: 'decision', reason: '게시' });
    expect(calls.map((args) => args.slice(0, 2))).toEqual([['harness', 'budget'], ['decisions', 'raise']]);
    expect(listHarnessQueue({ root: f.root })).toEqual([]);
    expect(spy.mock.calls.find(([category, event]) => category === 'seat.loop' && event === 'refused')?.[2])
      .toMatchObject({ seat: 'TC', item: 'K1', action: '게시', reason: 'execution forbidden; decision card only' });
  } finally { spy.mockRestore(); f.close(); }
});

test('live-safe sends permitted internal stall alerts without launching', async () => {
  const f = fixture('구현');
  try {
    const old = new Date(now.getTime() - 45 * 60_000).toISOString();
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      versions: () => [], stallChecklist: () => ({ version: '0.2.9', released: '0.2.8', dev: '0.2.9', history: [],
        items: [{ id: 'R1', title: 'blocked', status: 'red', owner: 'TC', updatedAt: old, updatedBy: 'TC' }] }),
      run: async () => { throw Error('unexpected command'); } });
    expect(result.status).toBe('skipped-empty');
    const mailbox = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { expect(mailbox.listByRecipient('OP')).toMatchObject([{ from: 'TC', to: 'OP', kind: 'stall-escalation' }]); }
    finally { mailbox.close(); }
  } finally { f.close(); }
});

test('live-safe ignores an injected outbound inquiry rather than delivering a non-allowlisted action', async () => {
  const f = fixture('구현');
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      inquire: async () => ({ to: 'OP', question: '근거 부탁합니다' }),
      run: async (args) => args[1] === 'budget' ? '{"outcome":"proceed"}' : Promise.reject(Error('unexpected command')) });
    expect(result).toMatchObject({ status: 'queued', action: 'harness' });
    const mailbox = openMsgStore(join(f.root, 'msg', 'messages.db'));
    try { expect(mailbox.listByRecipient('OP')).toEqual([]); }
    finally { mailbox.close(); }
  } finally { spy.mockRestore(); f.close(); }
});

test('live-safe keeps seat questions shadow-only even if question delivery is configured on', async () => {
  const f = fixture('구현');
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    askSeat(f.root, 'OP', 'TC', '상태 근거가 있나요?', 'live-safe-question');
    const result = await runSeatLoopOnce('TC', { ...f.deps, config: { mode: 'live-safe', seats: ['TC'], questions: 'on' },
      reply: async () => ({ answer: '확인' }), run: async () => { throw Error('unexpected command'); } });
    expect(result).toMatchObject({ status: 'shadow', action: 'seat-answer' });
    expect(spy.mock.calls.find(([category, event]) => category === 'seat.loop' && event === 'refused')?.[2])
      .toMatchObject({ seat: 'TC', action: 'seat-question' });
    expect(f.ledger()).toHaveLength(1);
  } finally { spy.mockRestore(); f.close(); }
});

test('three unlanded attempts of the same cell stop the fourth launch and raise one person card', async () => {
  const f = fixture('구현');
  const spy = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    let n = 0;
    const enqueued: string[] = [];
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      run: async (args) => { if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; },
      enqueue: async () => { n += 1; const id = `hq-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; enqueued.push(id); return { id }; },
      queueOutcome: () => 'retryable',
      queueItems: () => [] };
    for (let i = 0; i < 3; i++) expect((await runSeatLoopOnce('TC', deps)).status).toBe('queued');
    const fourth = await runSeatLoopOnce('TC', deps) as SeatEntry;
    expect(fourth.status).toBe('held');
    expect(fourth.reason).toBe('같은 칸 3회 착지 0 — 사람 판단');
    expect(enqueued).toHaveLength(3);
    const cards = new DecisionLedger({ stateDir: f.root }).list({ status: 'open' });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.title).toContain('K1');
    expect(spy.mock.calls.filter(([category, event]) => category === 'seat.loop' && event === 'repeat-stopped')).toHaveLength(1);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    expect(enqueued).toHaveLength(3);
    expect(new DecisionLedger({ stateDir: f.root }).list({ status: 'open' })).toHaveLength(1);
  } finally { spy.mockRestore(); f.close(); }
});

test('two unlanded attempts still launch, and a landed cell is not stopped', async () => {
  const f = fixture('구현');
  try {
    let n = 0;
    const base: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      run: async (args) => { if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; },
      enqueue: async () => { n += 1; return { id: `hq-00000000-0000-4000-8000-${String(n).padStart(12, '0')}` }; },
      queueItems: () => [] };
    expect((await runSeatLoopOnce('TC', { ...base, queueOutcome: () => 'retryable' })).status).toBe('queued');
    expect((await runSeatLoopOnce('TC', { ...base, queueOutcome: () => 'retryable' })).status).toBe('queued');
    expect(n).toBe(2);
    const landed = fixture('구현');
    try {
      let launches = 0;
      const deps: SeatDeps = { ...landed.deps, config: { mode: 'live-safe', seats: ['TC'] },
        run: async (args) => { if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; },
        enqueue: async () => { launches += 1; return { id: `hq-10000000-0000-4000-8000-${String(launches).padStart(12, '0')}` }; },
        queueOutcome: () => 'succeeded',
        queueItems: () => [] };
      for (let i = 0; i < 4; i++) expect((await runSeatLoopOnce('TC', deps)).status).toBe(i === 0 ? 'queued' : 'skipped-empty');
      expect(launches).toBe(1);
      expect(new DecisionLedger({ stateDir: landed.root }).list({ status: 'all' })).toHaveLength(0);
    } finally { landed.close(); }
  } finally { f.close(); }
});

test('repeatStop config changes the unlanded attempt limit', async () => {
  const f = fixture('구현');
  try {
    const path = join(f.root, 'config.json');
    writeFileSync(path, JSON.stringify({ loops: { seat: { mode: 'live-safe', repeatStop: 2 } } }));
    expect(buildUserConfig(path).loops?.seat?.repeatStop).toBe(2);
    writeFileSync(path, JSON.stringify({ loops: { seat: { mode: 'live-safe', repeatStop: 0 } } }));
    expect(buildUserConfig(path).loops?.seat?.repeatStop).toBeUndefined();
    let n = 0;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'], repeatStop: 2 },
      run: async (args) => { if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; },
      enqueue: async () => { n += 1; return { id: `hq-20000000-0000-4000-8000-${String(n).padStart(12, '0')}` }; },
      queueOutcome: () => 'retryable',
      queueItems: () => [] };
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('queued');
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('queued');
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('held');
    expect(n).toBe(2);
  } finally { f.close(); }
});

test('a person reopening the held cell allows one more launch', async () => {
  const f = fixture('구현');
  try {
    let n = 0;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      run: async (args) => { if (args[1] !== 'budget') throw Error('direct launch'); return '{"outcome":"proceed"}'; },
      enqueue: async () => { n += 1; return { id: `hq-30000000-0000-4000-8000-${String(n).padStart(12, '0')}` }; },
      queueOutcome: () => 'retryable',
      queueItems: () => [] };
    for (let i = 0; i < 3; i++) await runSeatLoopOnce('TC', deps);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('held');
    const ledger = new DecisionLedger({ stateDir: f.root, now: () => new Date('2026-10-04T04:00:00Z'), resolveVersion: f.deps.resolveDecisionVersion });
    const card = ledger.list({ status: 'open' })[0]!;
    ledger.decide(card.id, 'a', { kind: 'human' }, '다시 연다');
    const again = await runSeatLoopOnce('TC', { ...deps, now: () => new Date('2026-10-04T05:00:00Z') });
    expect(again.status).toBe('queued');
    expect(n).toBe(4);
  } finally { f.close(); }
});

test('live-safe cannot silently retry when AUTOQ outcome is unknown', async () => {
  const f = fixture('구현');
  try {
    let attempts = 0;
    const deps: SeatDeps = { ...f.deps, config: { mode: 'live-safe', seats: ['TC'] },
      run: async () => '{"outcome":"proceed"}', enqueue: async () => { attempts++; throw Error('queue response lost'); } };
    await expect(runSeatLoopOnce('TC', deps)).rejects.toThrow('queue response lost');
    expect(f.ledger().map((row) => row.status)).toEqual(['attempting', 'outcome-unknown']);
    expect((await runSeatLoopOnce('TC', deps)).status).toBe('skipped-empty');
    expect(attempts).toBe(1);
  } finally { f.close(); }
});
