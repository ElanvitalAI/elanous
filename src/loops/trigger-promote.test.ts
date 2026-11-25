import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { listTriggers, openTriggerRegistry, promoteTrigger, registerTrigger, rollbackTrigger, tickTriggers,
  type TriggerDecl, type TriggerTickDeps } from './trigger-registry.js';

let dir: string;
let db: Database;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'trigger-promote-')); mkdirSync(join(dir, 'seat'), { recursive: true }); db = openTriggerRegistry(join(dir, 'state')); });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function decl(overrides: Partial<TriggerDecl> = {}): TriggerDecl {
  return { graphId: 'g-promo', file: 'graphs/triggers/g.yaml', owner: 'OWNER-P', cron: '10 * * * *',
    // 출처: RFC-loop-agents-graph-runner-topology §19b — fixture-only policy literals (independent of DEFAULT_POLICY).
    goal: { kind: 'file-mtime', path: '{seatState}/done-{date}.md' }, goalDeadlineMin: 20, maxAttempts: 2, backoffSec: [300],
    cutoverAfter: 2, staleAfterMin: 20, legacy: { kind: 'marker', path: '{seatState}/OP/tools/.graph-cutover/g-promo' }, ...overrides };
}

function deps(log: string[], extra: Partial<TriggerTickDeps> = {}): TriggerTickDeps {
  return { now: () => new Date('2026-11-25T12:11:00Z'), vars: { seatState: join(dir, 'seat'), stateRoot: join(dir, 'state') },
    runGraph: async (_d, input) => { log.push(`run:${input.stage}`); return { status: 'done', runId: 'r1' }; },
    postCard: async () => 'msg#1', scheduleAction: async (action, id) => { log.push(`${action}:${id}`); }, ...extra };
}

const marker = () => join(dir, 'seat', 'OP', 'tools', '.graph-cutover', 'g-promo');

describe('manual promote', () => {
  test('writes the legacy marker first, then turns live, with a manual-promote cutover event', async () => {
    registerTrigger(db, decl());
    let stageWhenMarkerSeen = '';
    const d = deps([]);
    const { row, events } = await promoteTrigger(db, 'g-promo', { ...d, vars: d.vars }, 'ceo 20:5x');
    stageWhenMarkerSeen = existsSync(marker()) ? 'marker-present' : 'missing';
    expect(stageWhenMarkerSeen).toBe('marker-present');
    expect(row.stage).toBe('live');
    expect(events.map(e => e.event)).toEqual(['cutover']);
    expect(events[0]!.detail).toContain('manual promote: ceo 20:5x');
  });

  test('schedule legacy is disabled before stage flips; failure leaves shadow', async () => {
    registerTrigger(db, decl({ legacy: { kind: 'schedule', id: 'old-7' } }));
    const log: string[] = [];
    await promoteTrigger(db, 'g-promo', deps(log, { scheduleAction: async (a, id) => { log.push(`${a}:${id}:${listTriggers(db)[0]!.stage}`); } }));
    expect(log).toEqual(['disable:old-7:shadow']);
    expect(listTriggers(db)[0]!.stage).toBe('live');
    db.query(`UPDATE graph_trigger_registry SET stage = 'shadow'`).run();
    await expect(promoteTrigger(db, 'g-promo', deps([], { scheduleAction: async () => { throw new Error('crontab locked'); } }))).rejects.toThrow('crontab locked');
    expect(listTriggers(db)[0]!.stage).toBe('shadow');
  });

  test('unknown id is refused; promote then demote restores marker-free shadow', async () => {
    await expect(promoteTrigger(db, 'nope', deps([]))).rejects.toThrow('trigger not registered: nope');
    registerTrigger(db, decl());
    await promoteTrigger(db, 'g-promo', deps([]));
    const back = await rollbackTrigger(db, 'g-promo', deps([]));
    expect(back.stage).toBe('shadow');
    expect(existsSync(marker())).toBe(false);
  });
});

describe('cutoverAfter override', () => {
  test('override 0 cuts over on the first tick, before the window fires, so the run is live', async () => {
    registerTrigger(db, decl());
    const log: string[] = [];
    const events = await tickTriggers(db, deps(log, { cutoverAfterOverride: 0 }));
    expect(events[0]!.event).toBe('cutover');
    expect(existsSync(marker())).toBe(true);
    expect(log).toEqual(['run:live']);
  });

  test('no override keeps shadow on the first tick', async () => {
    registerTrigger(db, decl());
    const log: string[] = [];
    await tickTriggers(db, deps(log));
    expect(log).toEqual(['run:shadow']);
    expect(existsSync(marker())).toBe(false);
  });
});
