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

  test('the three Phase 1 graphs declare condition triggers, owner, goal and a legacy marker', () => {
    const retro = readTriggerDecl('graphs/triggers/op-retro.yaml', REPO);
    expect([retro.graphId, retro.cron, retro.owner, retro.goal.kind]).toEqual(['op-retro', undefined, 'OP', 'file-mtime']);
    // 출처: RFC-loop-agents-graph-runner-topology §19b — literals copied from the graph YAML declarations under test.
    expect(retro.condition).toEqual({ predicate: { kind: 'all', of: [{ kind: 'minute-at-least', minute: 15 },
      { kind: 'not-updated-since', path: '{seatState}/OP/retro/ELN-OP-RETRO-{date}.md', since: 'hour-start' }] },
    // 출처: RFC-loop-agents-graph-runner-topology §19b — literals copied from the graph YAML declarations under test.
      cooldownMin: 30, maxWaitMin: 70, onMaxWait: 'fire' });
    expect(retro.legacy).toEqual({ kind: 'marker', path: '{seatState}/OP/tools/.graph-cutover/op-retro' });
    const bulletin = readTriggerDecl('graphs/triggers/op-bulletin.yaml', REPO);
    expect(bulletin.condition).toEqual({ predicate: { kind: 'state-changed', parts: ['landed-count', 'idle-seats', 'hands-up-count'] },
    // 출처: RFC-loop-agents-graph-runner-topology §19b — literals copied from the graph YAML declarations under test.
      cooldownMin: 15, maxWaitMin: 30, onMaxWait: 'fire' });
    expect(bulletin.goal.path).toBe('{seatState}/OPS/BULLETIN-NOW.md');
    const idle = readTriggerDecl('graphs/triggers/op-idle-triage.yaml', REPO);
    expect(idle.condition).toEqual({ predicate: { kind: 'idle-with-open-cell', status: 'yellow', idleMin: 10 }, cooldownMin: 10, onMaxWait: 'fire' });
    expect(idle.goal).toEqual({ kind: 'ledger-line', path: '{stateRoot}/loops/idle-triage.jsonl', contains: '"window":"{window}"' });
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
