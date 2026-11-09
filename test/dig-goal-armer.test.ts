// R5 — dig goal armer (dig-engine v2 · Layer2 편입). Covers: strict-true
// double-gate no-op, goal arming artifacts (dir/ACTIVE.md/budget.json/
// AutoModeState + termination preset), singleton yield, daily cap,
// finalize paths (done → dig_reports + notify · abandoned · TTL expire),
// and source-level wire guards ([[feedback_dep_inject_seam_must_be_wired]]).

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  digAutoGoalEnabled, ensureDigGoalRunTable, finalizeDigGoalRuns,
  digGoalArmerTick,
} from '../src/dispatch/dig-goal-armer.js';
import { ensureDigTables } from '../src/domains/dig-engine.js';
import {
  getAutoModeState, setAutoModeState, resetAutoModeForTest,
} from '../src/auto-research/auto-mode/session.js';
import { INACTIVE_AUTO_MODE_STATE } from '../src/auto-research/auto-mode/types.js';
import type { UserConfig } from '../src/user-config/types.js';
import type { ObsidianVault } from '../src/auto-research/obsidian-bridge.js';

const cfgWith = (autoGoal: unknown): UserConfig =>
  ({ finance: { enabled: true, dig: { autoGoal } }, raw: {} }) as unknown as UserConfig;

const ARMED = { enabled: true, maxPerDay: 2, maxTurns: 6 };

let db: Database;
let vaultRoot: string;
let vault: ObsidianVault;

beforeEach(() => {
  db = new Database(':memory:');
  ensureDigTables(db);
  ensureDigGoalRunTable(db);
  vaultRoot = mkdtempSync(join(tmpdir(), 'dig-armer-'));
  vault = { root: vaultRoot, isSimulated: true, label: 'test' };
  resetAutoModeForTest();
});

afterEach(() => {
  db.close();
  rmSync(vaultRoot, { recursive: true, force: true });
  resetAutoModeForTest();
});

function seedQueueItem(id = 'signal:1', sector = 'semis', score = 9): void {
  db.prepare(`INSERT INTO dig_queue(id, topic, sector, score, created_at, status) VALUES (?,?,?,?,?, 'queued')`)
    .run(id, `테스트 신호 — ${sector} 급변`, sector, score, new Date().toISOString());
}

describe('gating', () => {
  test('strict-true only — absent/false/truthy-string never arm', () => {
    expect(digAutoGoalEnabled(cfgWith(undefined))).toBe(false);
    expect(digAutoGoalEnabled(cfgWith({ enabled: false }))).toBe(false);
    expect(digAutoGoalEnabled(cfgWith({ enabled: 'true' }))).toBe(false);
    expect(digAutoGoalEnabled(cfgWith({ enabled: true }))).toBe(true);
  });

  test('disarmed tick is a pure no-op (state untouched, nothing armed)', async () => {
    seedQueueItem();
    const r = await digGoalArmerTick(cfgWith({ enabled: false }), { db, vault });
    expect(r.action).toBe('disarmed');
    expect(getAutoModeState().active).toBe(false);
    expect((db.prepare(`SELECT COUNT(*) n FROM dig_goal_runs`).get() as any).n).toBe(0);
  });

  test('singleton — any active goal (even non-dig) yields busy', async () => {
    seedQueueItem();
    setAutoModeState({ ...INACTIVE_AUTO_MODE_STATE, active: true, goalSlug: 'someone-elses-goal', terminationRule: { kind: 'summary_written', path: 'X.md' } });
    const r = await digGoalArmerTick(cfgWith(ARMED), { db, vault });
    expect(r.action).toBe('busy');
  });
});

describe('arming', () => {
  test('armed tick promotes top queue item to a well-formed auto-mode goal', async () => {
    seedQueueItem('signal:7', 'semis', 9);
    const r = await digGoalArmerTick(cfgWith(ARMED), { db, vault, now: () => Date.parse('2026-07-07T04:00:00Z') });
    expect(r.action).toBe('armed');
    expect(r.goalSlug).toMatch(/^dig-semis-\d{8}-\d{4}$/);

    // AutoModeState — kind/termination preset/maxTurns from config.
    const s = getAutoModeState();
    expect(s.active).toBe(true);
    expect(s.goalSlug).toBe(r.goalSlug!);
    expect(s.goalKind).toBe('analysis');
    expect(s.maxTurns).toBe(6);
    // termination preset('analysis') = ANALYSIS.md ≥300자 — 같은 PR 동봉 (RESEARCH L182).
    expect(s.terminationRule).toEqual({ kind: 'summary_written', path: 'ANALYSIS.md', minChars: 300 });

    // Goal dir artifacts: ACTIVE.md (READ-ONLY 분석 지시) + budget.json (화로가드 spec).
    const goalRoot = join(vaultRoot, 'goals', r.goalSlug!);
    const active = readFileSync(join(goalRoot, 'ACTIVE.md'), 'utf-8');
    expect(active).toContain('goalKind: analysis');
    expect(active).toContain('매매 지시·주문은 금지');
    const budget = JSON.parse(readFileSync(join(goalRoot, 'budget.json'), 'utf-8'));
    expect(budget.spec.tokens).toBeGreaterThan(0);

    // Queue + run bookkeeping.
    expect((db.prepare(`SELECT status FROM dig_queue WHERE id='signal:7'`).get() as any).status).toBe('goal');
    expect((db.prepare(`SELECT status FROM dig_goal_runs WHERE goal_slug=?`).get(r.goalSlug!) as any).status).toBe('running');
  });

  test('maxPerDay cap counts today arming (including failed runs)', async () => {
    seedQueueItem();
    db.prepare(`INSERT INTO dig_goal_runs(goal_slug, queue_id, topic, sector, armed_at, status) VALUES ('dig-a-1','q1','t','s1',datetime('now'),'done')`).run();
    db.prepare(`INSERT INTO dig_goal_runs(goal_slug, queue_id, topic, sector, armed_at, status) VALUES ('dig-a-2','q2','t','s2',datetime('now'),'expired')`).run();
    const r = await digGoalArmerTick(cfgWith(ARMED), { db, vault });
    expect(r.action).toBe('daily-cap');
    expect(getAutoModeState().active).toBe(false);
  });

  test('empty queue → no-item (no state ignition)', async () => {
    const r = await digGoalArmerTick(cfgWith(ARMED), { db, vault });
    expect(r.action).toBe('no-item');
    expect(getAutoModeState().active).toBe(false);
  });
});

describe('finalize', () => {
  async function armOne(): Promise<string> {
    seedQueueItem('signal:9', 'energy', 8);
    const r = await digGoalArmerTick(cfgWith(ARMED), { db, vault });
    expect(r.action).toBe('armed');
    return r.goalSlug!;
  }

  test('inactive run with ANALYSIS.md ≥300자 → done + dig_reports + notify', async () => {
    const slug = await armOne();
    // Agent finished + ExitAutoMode reset the singleton.
    resetAutoModeForTest();
    writeFileSync(join(vaultRoot, 'goals', slug, 'ANALYSIS.md'), '분석. '.repeat(100), 'utf-8');
    const sent: string[] = [];
    const n = finalizeDigGoalRuns(db, vault, { notify: (t) => { sent.push(t); } });
    expect(n).toBe(1);
    expect((db.prepare(`SELECT status FROM dig_goal_runs WHERE goal_slug=?`).get(slug) as any).status).toBe('done');
    expect((db.prepare(`SELECT status FROM dig_queue WHERE id='signal:9'`).get() as any).status).toBe('done');
    expect((db.prepare(`SELECT COUNT(*) n FROM dig_reports WHERE confidence='goal-v2'`).get() as any).n).toBe(1);
    expect(sent[0]).toContain('자율 디깅(goal) 완료');
  });

  test('inactive run without analysis → abandoned + queue requeued', async () => {
    const slug = await armOne();
    resetAutoModeForTest();
    const n = finalizeDigGoalRuns(db, vault, { notify: () => {} });
    expect(n).toBe(1);
    expect((db.prepare(`SELECT status FROM dig_goal_runs WHERE goal_slug=?`).get(slug) as any).status).toBe('abandoned');
    expect((db.prepare(`SELECT status FROM dig_queue WHERE id='signal:9'`).get() as any).status).toBe('queued');
  });

  test('active run past TTL → force-released (expired) + singleton freed', async () => {
    const slug = await armOne();
    expect(getAutoModeState().active).toBe(true);
    const n = finalizeDigGoalRuns(db, vault, {
      notify: () => {},
      now: () => Date.now() + 3 * 60 * 60 * 1000, // +3h > TTL 2h
    });
    expect(n).toBe(1);
    expect(getAutoModeState().active).toBe(false);
    expect((db.prepare(`SELECT status FROM dig_goal_runs WHERE goal_slug=?`).get(slug) as any).status).toBe('expired');
  });

  test('active run within TTL → left alone', async () => {
    await armOne();
    const n = finalizeDigGoalRuns(db, vault, { notify: () => {} });
    expect(n).toBe(0);
    expect(getAutoModeState().active).toBe(true);
  });
});

describe('wire (source-level)', () => {
  test('nexus daemon gates the armer on dispatch block + strict-true autoGoal flag', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src/nexus/index.ts'), 'utf-8');
    expect(src).toMatch(/finance\?\.dig\?\.autoGoal/);
    expect(src).toMatch(/digCfg\?\.enabled === true/);
    expect(src).toMatch(/import\(['"]\.\.\/dispatch\/dig-goal-armer\.js['"]\)/);
    expect(src).toMatch(/clearInterval\(digArmerHandle\)/);
  });

  test('user-config parses finance.dig.autoGoal with strict-true + clamps', () => {
    const types = readFileSync(join(import.meta.dir, '..', 'src/user-config/types.ts'), 'utf-8');
    const reader = readFileSync(join(import.meta.dir, '..', 'src/user-config.ts'), 'utf-8');
    expect(types).toMatch(/dig\?: \{ autoGoal\?:/);
    expect(reader).toMatch(/autoGoal[\s\S]{0,200}enabled === true/);
  });
});
