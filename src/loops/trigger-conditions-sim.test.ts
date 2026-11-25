/**
 * SIM device — condition triggers on a virtual clock with fake ledgers (대표 11-25 «condition-based triggers must go in»).
 * Scenarios: predicate flips → exactly one run · flapping predicate → cooldown holds · never-true → maxWait fires once ·
 * failure → retry → card · release rocket L-1/L-2 (notes merged + red 0 + 5 GO on the cut sha → advance once; a missing
 * GO at the phase clock → NO-GO card, never a silent advance; an explicit NO-GO → recovery card, no run).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { evaluatePredicate, parsePredicate, type ConditionProbes } from './trigger-conditions.js';
import { listFires, openTriggerRegistry, registerTrigger, tickTriggers, type ConditionDecl, type TriggerDecl,
  type TriggerTickDeps } from './trigger-registry.js';

let dir: string;
let db: Database;
let clock: Date;
let runs: Array<{ window: string; reason?: string }>;
let cards: string[];
let failRuns: boolean;
// Fake ledgers.
let merged: Set<number>;
let cells: Array<{ id: string; status: string; owner?: string | null }>;
let idle: Array<{ seat: string; sinceMs: number | null }>;
let landed: number;
let pollRows: string[];
let json: Record<string, unknown>;

const probes: ConditionProbes = {
  now: () => clock,
  watch: async (w) => { const pr = Number(w.split(':')[1]); return w.startsWith('pr-merged:') && merged.has(pr) ? `PR #${pr} merged` : null; },
  mtimeMs: () => null,
  readJson: (path) => json[path],
  readLines: () => pollRows,
  cells: async () => cells,
  idleSeats: async () => idle,
  landedCount: async () => landed,
  handsUpCount: async () => 0,
  publishedVersions: async () => [],
  installedVersion: async () => null,
};

function deps(): TriggerTickDeps {
  return {
    now: () => clock, probes,
    vars: { seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') },
    runGraph: async (_d, input, runId) => {
      runs.push({ window: input.window, ...(input.reason ? { reason: input.reason } : {}) });
      return failRuns ? { status: 'failed', runId, error: 'synthetic node failure' } : { status: 'done', runId };
    },
    postCard: async (owner, body) => { cards.push(`${owner}|${body}`); return `card-${cards.length}`; },
    scheduleAction: async () => {},
  };
}

function trigger(graphId: string, condition: ConditionDecl, overrides: Partial<TriggerDecl> = {}): TriggerDecl {
  // 출처: RFC-loop-agents-graph-runner-topology §19b — sim policy literals (independent of DEFAULT_POLICY).
  return { graphId, file: 'graphs/triggers/sim.yaml', owner: 'SIM-OWNER', condition, goal: { kind: 'ledger-line', path: '{stateRoot}/none', contains: 'x' },
    goalDeadlineMin: 30, maxAttempts: 2, backoffSec: [60], cutoverAfter: 2, staleAfterMin: 30, ...overrides };
}

const at = (iso: string) => { clock = new Date(iso); };
async function tick() { return tickTriggers(db, deps()); }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trigger-cond-sim-'));
  mkdirSync(join(dir, 'seat'), { recursive: true });
  db = openTriggerRegistry(join(dir, 'state'));
  runs = []; cards = []; failRuns = false;
  merged = new Set(); cells = []; idle = []; landed = 100; pollRows = []; json = {};
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('SIM condition triggers', () => {
  test('predicate flips → exactly one run, however many ticks it stays true', async () => {
    registerTrigger(db, trigger('idle', { predicate: { kind: 'idle-with-open-cell', status: 'yellow', idleMin: 10 }, cooldownMin: 10, onMaxWait: 'fire' }),
      { now: new Date('2026-11-25T09:00:00Z') });
    cells = [{ id: 'C-1', status: 'yellow', owner: 'TC' }];
    idle = [{ seat: 'TC', sinceMs: Date.parse('2026-11-25T09:00:00Z') }];
    at('2026-11-25T09:05:00Z'); await tick(); // idle only 5 min
    expect(runs).toHaveLength(0);
    for (const t of ['09:10:00', '09:12:00', '09:14:00', '09:30:00', '09:50:00']) { at(`2026-11-25T${t}Z`); await tick(); }
    expect(runs).toHaveLength(1);
    expect(runs[0]!.reason).toBe('condition: idle with yellow cells: TC');
  });

  test('flapping predicate → cooldown holds; the next change after the cooldown fires once', async () => {
    registerTrigger(db, trigger('bulletin', { predicate: { kind: 'state-changed', parts: ['landed-count'] }, cooldownMin: 15, onMaxWait: 'fire' }),
      { now: new Date('2026-11-25T09:00:00Z') });
    at('2026-11-25T09:00:00Z'); await tick();
    const held = [];
    for (const [t, n] of [['09:02', 101], ['09:04', 102], ['09:06', 101], ['09:08', 103]] as const) {
      landed = n; at(`2026-11-25T${t}:00Z`); held.push(...await tick());
    }
    expect(runs).toHaveLength(1);
    expect(held.filter(e => e.event === 'cooldown-held')).toHaveLength(4);
    at('2026-11-25T09:16:00Z'); await tick();
    at('2026-11-25T09:18:00Z'); await tick(); // same state, no new key
    expect(runs).toHaveLength(2);
  });

  test('never-true predicate → maxWait fires once per wait period', async () => {
    registerTrigger(db, trigger('retro', { predicate: { kind: 'watch', watch: 'pr-merged:999' }, cooldownMin: 0, maxWaitMin: 30, onMaxWait: 'fire' }),
      { now: new Date('2026-11-25T09:00:00Z') });
    for (let m = 2; m < 30; m += 2) { at(`2026-11-25T09:${String(m).padStart(2, '0')}:00Z`); await tick(); }
    expect(runs).toHaveLength(0);
    for (const t of ['09:30:00', '09:32:00', '09:40:00', '09:58:00']) { at(`2026-11-25T${t}Z`); await tick(); }
    expect(runs).toHaveLength(1);
    expect(runs[0]!.reason).toBe('max-wait: pr-merged:999 not yet');
    at('2026-11-25T10:00:00Z'); await tick();
    expect(runs).toHaveLength(2);
  });

  test('condition fire that fails → retry → exception card to the owner', async () => {
    failRuns = true;
    merged.add(7);
    registerTrigger(db, trigger('flaky', { predicate: { kind: 'watch', watch: 'pr-merged:7' }, cooldownMin: 0, onMaxWait: 'fire' }),
      { now: new Date('2026-11-25T09:00:00Z') });
    at('2026-11-25T09:00:00Z'); await tick();
    at('2026-11-25T09:01:00Z'); await tick();
    at('2026-11-25T09:03:00Z'); await tick();
    expect(runs).toHaveLength(2);
    expect(listFires(db, 'flaky')[0]!.status).toBe('exception');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain('SIM-OWNER|[graph-trigger exception] flaky');
  });

  describe('release rocket L-1/L-2 (cut + 5 GO on the cut sha)', () => {
    const CUT = '{stateRoot}/cut.json';
    const VOTERS = ['REL', 'JUD', 'RES', 'UX', 'TC'];
    const l2: ConditionDecl = {
      predicate: { kind: 'all', of: [
        { kind: 'watch', watch: 'pr-merged:40200' }, // release notes PR
        { kind: 'cell-count', status: 'red', equals: 0 },
        { kind: 'poll-go', ledger: '{stateRoot}/poll.jsonl', poll: 'L-2', voters: VOTERS, sha: { path: CUT, field: 'cutSha' } },
      ] },
      cooldownMin: 0, maxWaitAt: '2026-11-26T08:30:00Z', onMaxWait: 'card',
    };
    const vote = (voter: string, answer: string, sha = 'abc123def456', evidence = 'receipt ok') =>
      pollRows.push(JSON.stringify({ poll: 'L-2', voter, answer, sha, evidence }));
    beforeEach(() => {
      registerTrigger(db, trigger('release-l2', l2, { goalDeadlineMin: 600 }), { now: new Date('2026-11-26T07:00:00Z') });
      json[join(dir, 'state', 'cut.json')] = { cutSha: 'abc123def456' };
      cells = [{ id: 'A', status: 'green' }, { id: 'B', status: 'red' }];
    });

    test('notes merged + red 0 + 5 GO bound to the cut sha → advance exactly once', async () => {
      at('2026-11-26T07:10:00Z'); await tick();
      merged.add(40200); cells = [{ id: 'A', status: 'green' }, { id: 'B', status: 'green' }];
      for (const v of VOTERS.slice(0, 4)) vote(v, 'GO');
      vote('TC', 'GO', 'abc123def456', ''); // no evidence ≠ GO
      at('2026-11-26T07:20:00Z'); await tick();
      vote('TC', 'GO', 'ffff00000000'); // another sha ≠ GO
      at('2026-11-26T07:22:00Z'); await tick();
      expect(runs).toHaveLength(0);
      vote('TC', 'GO');
      for (const t of ['07:24:00', '07:26:00', '08:00:00', '08:40:00']) { at(`2026-11-26T${t}Z`); await tick(); }
      expect(runs).toHaveLength(1);
      expect(runs[0]!.reason).toContain('poll L-2 @abc123def456: GO REL,JUD,RES,UX,TC');
      expect(cards).toHaveLength(0);
    });

    test('a GO missing at the phase clock → one NO-GO card, never a silent advance', async () => {
      merged.add(40200); cells = [{ id: 'A', status: 'green' }];
      for (const v of VOTERS.slice(0, 4)) vote(v, 'GO');
      for (const t of ['08:00:00', '08:30:00', '08:32:00', '09:30:00']) { at(`2026-11-26T${t}Z`); await tick(); }
      expect(runs).toHaveLength(0);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toContain('SIM-OWNER|[graph-trigger max-wait] release-l2: condition not met by 2026-11-26T08:30:00Z');
      expect(cards[0]).toContain('missing/unbound TC');
    });

    test('an explicit NO-GO → recovery card once, no run', async () => {
      merged.add(40200); cells = [];
      for (const v of VOTERS.slice(0, 4)) vote(v, 'GO');
      vote('TC', 'NO-GO');
      at('2026-11-26T07:30:00Z'); await tick();
      at('2026-11-26T07:32:00Z'); await tick();
      expect(runs).toHaveLength(0);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toContain('[graph-trigger NO-GO] release-l2: NO-GO from TC on L-2 @abc123def456');
    });
  });
});

describe('predicate parsing', () => {
  test('poll-go and every Phase 2 release kind parse; unknown kinds are refused', async () => {
    expect(parsePredicate({ kind: 'poll-go', ledger: 'p', poll: 'L-3', voters: ['op'], sha: 'abc' }))
      .toEqual({ kind: 'poll-go', ledger: 'p', poll: 'L-3', voters: ['OP'], sha: 'abc' });
    expect(parsePredicate({ kind: 'version-published', version: '0.3.36' })).toEqual({ kind: 'version-published', version: '0.3.36' });
    expect(parsePredicate({ kind: 'installed-version', equals: '0.3.36' })).toEqual({ kind: 'installed-version', equals: '0.3.36' });
    expect(parsePredicate({ kind: 'json-field', path: 'r.json', field: 'verdict', equals: 'PASS' }).kind).toBe('json-field');
    expect(() => parsePredicate({ kind: 'minute-at-least', minute: 75 })).toThrow('minute must be 0–59');
    at('2026-11-25T09:00:00Z');
    const r = await evaluatePredicate({ kind: 'installed-version', equals: '0.3.36' }, probes, { expand: s => s, sinceIso: '' });
    expect([r.met, r.evidence]).toEqual([false, 'installed unknown (want 0.3.36)']);
  });
});
