import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Database } from 'bun:sqlite';
import { goalHolds, listFires, listTriggers, openTriggerRegistry, readTriggerDecl, registerTrigger, retryWindow, rollbackTrigger,
  tickTriggers, type TriggerDecl, type TriggerTickDeps } from './trigger-registry.js';
import { idleProbe, wake } from './trigger-nodes.js';

const REPO = resolve(import.meta.dir, '../..');
let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trigger-registry-'));
  mkdirSync(join(dir, 'seat'), { recursive: true });
  db = openTriggerRegistry(join(dir, 'state'));
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function decl(overrides: Partial<TriggerDecl> = {}): TriggerDecl {
  return { graphId: 'g-retro', file: 'graphs/triggers/g.yaml', owner: 'OWNER-X', cron: '10 * * * *',
    // 출처: RFC-loop-agents-graph-runner-topology §19b — fixture-only policy literals (independent of DEFAULT_POLICY).
    goal: { kind: 'file-mtime', path: '{seatState}/retro-{date}.md' }, goalDeadlineMin: 20, maxAttempts: 2, backoffSec: [300],
    cutoverAfter: 2, staleAfterMin: 20, timeZone: 'Asia/Seoul', ...overrides };
}

describe('registration', () => {
  test('same declaration twice is one row; a changed declaration is refused without update', () => {
    expect(registerTrigger(db, decl()).created).toBe(true);
    expect(registerTrigger(db, decl()).created).toBe(false);
    expect(listTriggers(db)).toHaveLength(1);
    expect(() => registerTrigger(db, decl({ cron: '20 * * * *' }))).toThrow('already registered with a different declaration');
    const updated = registerTrigger(db, decl({ cron: '20 * * * *' }), { update: true });
    expect(updated.updated).toBe(true);
    expect(updated.row.cron).toBe('20 * * * *');
  });

  test('a legacy path starts in shadow, none starts live', () => {
    expect(registerTrigger(db, decl({ legacy: { kind: 'schedule', id: 'old-1' } })).row.stage).toBe('shadow');
    expect(registerTrigger(db, decl({ graphId: 'g-new' })).row.stage).toBe('live');
  });

  test('the Phase 1 graphs declare condition triggers, owner, goal and a legacy marker (op-retro · op-idle-triage absorbed 11-26)', () => {
    expect(existsSync(join(REPO, 'graphs/triggers/op-retro.yaml'))).toBe(false);
    expect(existsSync(join(REPO, 'graphs/triggers/op-idle-triage.yaml'))).toBe(false);
    expect(readTriggerDecl('graphs/triggers/op-pulse.yaml', REPO).absorbs).toEqual(['op-retro']);
    expect(readTriggerDecl('graphs/triggers/board-steward.yaml', REPO).absorbs).toEqual(['op-idle-triage']);
    const bulletin = readTriggerDecl('graphs/triggers/op-bulletin.yaml', REPO);
    expect(bulletin.condition).toEqual({ predicate: { kind: 'state-changed', parts: ['landed-count', 'idle-seats', 'hands-up-count'] },
    // 출처: RFC-loop-agents-graph-runner-topology §19b — literals copied from the graph YAML declarations under test.
      cooldownMin: 15, maxWaitMin: 30, onMaxWait: 'fire' });
    expect(bulletin.goal.path).toBe('{seatState}/OPS/BULLETIN-NOW.md');
  });

  test('shared YAML reader preserves legacy graph fields, aliases and trigger defaults', () => {
    const file = join(dir, 'legacy.yaml');
    writeFileSync(file, `graph_id: legacy-trigger
loop:
  owner: OP
  trigger: { cron: '  0 * * * *  ' }
  goal: &goal { kind: file-mtime, path: 'node-b' }
other_graph_metadata: *goal
nodes:
  - { node_id: legacy, kind: not-a-template-kind }
`);
    const result = readTriggerDecl(file, dir);
    expect(result.graphId).toBe('legacy-trigger');
    expect(result.cron).toBe('0 * * * *');
    expect(result.goal).toEqual({ kind: 'file-mtime', path: 'node-b' });
    // Legacy trigger policy defaults, asserted independently of DEFAULT_POLICY.
    expect(result.maxAttempts).toBe(3);
    expect(result.goalDeadlineMin).toBe(20);
    expect(result.backoffSec).toEqual([60, 300]);
    expect(result.cutoverAfter).toBe(2);
    expect(result.staleAfterMin).toBe(30);
  });

  test('shared YAML reader rejects malformed and duplicate mappings', () => {
    const file = join(dir, 'syntax.yaml');
    writeFileSync(file, 'graph_id: one\ngraph_id: two\n');
    expect(() => readTriggerDecl(file, dir)).toThrow();
    writeFileSync(file, 'graph_id: [\n');
    expect(() => readTriggerDecl(file, dir)).toThrow();
  });

  test('a trigger with both or neither of cron and condition is refused', () => {
    const both = join(dir, 'both.yaml');
    writeFileSync(both, 'graph_id: both\nloop:\n  owner: OP\n  trigger:\n    cron: "0 * * * *"\n    condition: { predicate: { kind: minute-at-least, minute: 5 } }\n  goal: { kind: file-mtime, path: x }\n');
    expect(() => readTriggerDecl(both, dir)).toThrow('exactly one of cron | condition');
    const badPred = join(dir, 'bad.yaml');
    writeFileSync(badPred, 'graph_id: bad\nloop:\n  owner: OP\n  trigger:\n    condition: { predicate: { kind: prose-match, text: done } }\n  goal: { kind: file-mtime, path: x }\n');
    expect(() => readTriggerDecl(badPred, dir)).toThrow('prose-match is not a known predicate');
  });

  test('a graph without a checkable goal is refused', () => {
    const file = join(dir, 'nogoal.yaml');
    writeFileSync(file, 'graph_id: nogoal\nloop:\n  owner: OP\n  trigger:\n    cron: "0 * * * *"\n');
    expect(() => readTriggerDecl(file, dir)).toThrow('without a checkable done-when is refused');
  });
});

describe('goal predicate', () => {
  test('file-mtime holds only when the file changed inside the window', () => {
    const vars = { seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') };
    const file = join(dir, 'seat', 'retro-20261125.md');
    const window = '2026-11-25T09:10:00.000Z';
    expect(goalHolds(decl(), window, vars).ok).toBe(false);
    writeFileSync(file, 'x');
    utimesSync(file, new Date('2026-11-25T09:00:00Z'), new Date('2026-11-25T09:00:00Z'));
    expect(goalHolds(decl(), window, vars).ok).toBe(false);
    utimesSync(file, new Date('2026-11-25T09:12:00Z'), new Date('2026-11-25T09:12:00Z'));
    expect(goalHolds(decl(), window, vars).ok).toBe(true);
  });
});

describe('trigger nodes', () => {
  test('wake in shadow writes a receipt and never posts', () => {
    const posts: string[][] = [];
    const out = wake({ graphId: 'op-retro', runId: 'r1', input: { stage: 'shadow', window: '2026-11-25T09:10:00.000Z', shadowDir: join(dir, 'sh') },
      nodeInput: { from: 'OP', to: 'OP', body: 'retro now' } }, { post: args => { posts.push(args); return { status: 0, stdout: '', stderr: '' }; } });
    expect(out.outcome).toBe('ok');
    expect(posts).toHaveLength(0);
    const receipt = JSON.parse(readFileSync(join(dir, 'sh', '2026-11-25T09_10_00.000Z.json'), 'utf8'));
    expect(receipt.wouldPost.to).toBe('OP');
    expect(receipt.wouldPost.body).toContain('retro now');
  });

  test('wake live posts once and a failed post is outcome fail', () => {
    const posts: string[][] = [];
    const ok = wake({ input: { stage: 'live', window: 'w' }, nodeInput: { from: 'OP', to: 'OP', body: 'b' } },
      { post: args => { posts.push(args); return { status: 0, stdout: 'msg#7', stderr: '' }; } });
    expect(ok.outcome).toBe('ok');
    expect(posts[0]!.slice(0, 6)).toEqual(['msg', 'post', '--from', 'OP', '--to', 'OP']);
    const bad = wake({ input: { stage: 'live', window: 'w' }, nodeInput: { from: 'OP', to: 'OP', body: 'b' } },
      { post: () => ({ status: 3, stdout: '', stderr: 'store locked' }) });
    expect(bad).toEqual({ outcome: 'fail', error: 'msg post exit 3: store locked' });
  });

  test('idle-probe records one ledger line per call with idle or busy', () => {
    const vars = { seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') };
    const act = join(dir, 'seat', 'act.md');
    writeFileSync(act, 'x');
    utimesSync(act, new Date('2026-11-25T09:00:00Z'), new Date('2026-11-25T09:00:00Z'));
    const node = { seat: 'OP', idle_min: 30, activity: ['{seatState}/act.md'], ledger: '{stateRoot}/idle.jsonl' };
    expect(idleProbe({ input: { window: 'w1', vars }, nodeInput: node }, new Date('2026-11-25T09:10:00Z')).outcome).toBe('busy');
    expect(idleProbe({ input: { window: 'w2', vars }, nodeInput: node }, new Date('2026-11-25T09:40:00Z')).outcome).toBe('idle');
    const lines = readFileSync(join(dir, 'state', 'idle.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines.map(l => [l.window, l.verdict])).toEqual([['w1', 'busy'], ['w2', 'idle']]);
  });
});

describe('manual retry and rollback', () => {
  test('retry re-arms only an exception window; rollback re-enables legacy before shadow', async () => {
    registerTrigger(db, decl({ legacy: { kind: 'schedule', id: 'old-1' } }));
    db.query(`INSERT INTO graph_trigger_fires (graph_id, window, stage, status, attempt, updated_at) VALUES ('g-retro', 'w-x', 'shadow', 'exception', 2, 'now')`).run();
    expect(retryWindow(db, 'g-retro', 'w-missing')).toBe(false);
    expect(retryWindow(db, 'g-retro', 'w-x', new Date('2026-11-25T00:00:00Z'))).toBe(true);
    expect(listFires(db, 'g-retro')[0]!.status).toBe('retry-wait');
    db.query(`UPDATE graph_trigger_registry SET stage = 'live', shadow_successes = 2`).run();
    const calls: string[] = [];
    const row = await rollbackTrigger(db, 'g-retro', { now: () => new Date(), vars: { seatState: dir, stateRoot: dir },
      scheduleAction: async (action, id) => { calls.push(`${action}:${id}`); } });
    expect(calls).toEqual(['enable:old-1']);
    expect([row.stage, row.shadowSuccesses]).toEqual(['shadow', 0]);
  });
});

describe('crash recovery', () => {
  test('a running claim that never reports is failed after the goal deadline plus grace', async () => {
    registerTrigger(db, decl({ maxAttempts: 1 }));
    db.query(`INSERT INTO graph_trigger_fires (graph_id, window, stage, status, attempt, updated_at) VALUES ('g-retro', '2026-11-25T08:10:00.000Z', 'live', 'running', 1, '2026-11-25T08:10:05.000Z')`).run();
    const cards: string[] = [];
    const deps: TriggerTickDeps = { now: () => new Date('2026-11-25T08:45:00Z'), vars: { seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') },
      runGraph: async () => ({ status: 'done', runId: 'x' }), postCard: async (owner, body) => { cards.push(`${owner}|${body}`); return 'c1'; },
      scheduleAction: async () => {} };
    const events = await tickTriggers(db, deps, { only: 'g-retro' });
    expect(events.some(e => e.event === 'exception' && e.window === '2026-11-25T08:10:00.000Z')).toBe(true);
    expect(cards[0]).toContain('OWNER-X|[graph-trigger exception] g-retro');
    expect(cards[0]).toContain('never reported');
    expect(existsSync(join(dir, 'state', 'graph-trigger-registry.db'))).toBe(true);
  });
});

describe('independent trigger cadence', () => {
  test('a subsequent scheduled tick on another connection fires the next land window while the first is pending', async () => {
    registerTrigger(db, decl({ graphId: 'a-slow' }));
    registerTrigger(db, decl({ graphId: 'z-land', cron: '*/2 * * * *' }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let clock = new Date('2026-11-25T09:10:00Z');
    const calls: string[] = [];
    const deps: TriggerTickDeps = {
      now: () => clock, vars: { seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') },
      runGraph: async (row, input, runId) => { calls.push(`${row.graphId}:${input.window}`); if (row.graphId === 'a-slow') await gate; return { status: 'done', runId }; },
      postCard: async () => 'card', scheduleAction: async () => {},
    };
    const first = tickTriggers(db, deps);
    const nextDb = openTriggerRegistry(join(dir, 'state'));
    try {
      clock = new Date('2026-11-25T09:12:00Z');
      await tickTriggers(nextDb, deps);
      expect(calls).toEqual(['a-slow:2026-11-25T09:10:00.000Z', 'z-land:2026-11-25T09:10:00.000Z', 'z-land:2026-11-25T09:12:00.000Z']);
    } finally { nextDb.close(); release(); await first; }
  });

  test('land starts while an earlier runner is pending; overlapping ticks dedupe and wait for their work', async () => {
    registerTrigger(db, decl({ graphId: 'a-slow' }));
    registerTrigger(db, decl({ graphId: 'z-land' }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const deps: TriggerTickDeps = {
      now: () => new Date('2026-11-25T09:10:00Z'),
      vars: { seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') },
      runGraph: async (row, _input, runId) => { calls.push(row.graphId); if (row.graphId === 'a-slow') await gate; return { status: 'done', runId }; },
      postCard: async () => 'card', scheduleAction: async () => {},
    };
    let settled = false;
    const first = tickTriggers(db, deps).finally(() => { settled = true; });
    try {
      expect(calls).toEqual(['a-slow', 'z-land']);
      await tickTriggers(db, deps);
      expect(calls).toEqual(['a-slow', 'z-land']);
      expect(settled).toBe(false);
    } finally { release(); await first; }
    expect(listFires(db, 'a-slow')[0]!.status).toBe('dispatched');
    expect(listFires(db, 'z-land')[0]!.status).toBe('dispatched');
  });

  for (const status of ['done', 'failed'] as const) test(`late ${status} from a stale attempt cannot overwrite recovery`, async () => {
    registerTrigger(db, decl({ graphId: 'slow', maxAttempts: 2 }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let clock = new Date('2026-11-25T09:10:00Z');
    const deps: TriggerTickDeps = {
      now: () => clock, vars: { seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') },
      runGraph: async (_row, _input, runId) => { await gate; return { status, runId }; },
      postCard: async () => 'card', scheduleAction: async () => {},
    };
    const first = tickTriggers(db, deps);
    try {
      clock = new Date('2026-11-25T09:45:00Z');
      await tickTriggers(db, deps);
      expect(listFires(db, 'slow').find(f => f.window === '2026-11-25T09:10:00.000Z')!.status).toBe('retry-wait');
    } finally { release(); await first; }
    const recovered = listFires(db, 'slow').find(f => f.window === '2026-11-25T09:10:00.000Z')!;
    expect(recovered.status).toBe('retry-wait');
    expect(recovered.error).toContain('never reported');
  });
});
