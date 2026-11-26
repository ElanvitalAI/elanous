// GOAL-ORCHESTRATION-NL — sim world (seeds 1–3) over all five patterns plus the edges: planner picks the wrong
// pattern → the person changes it; a worker CLI missing; budget hit; goal not met → second round; stop mid-run;
// spawn cap; paid VM refused; NL layout/control phrases; the feed the els tile view reads.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simBackend } from './backends.js';
import { parseControlText } from './cli.js';
import { applyLayout, feedWriter, parseLayoutCommand } from './layout.js';
import { heuristicPattern, planFromGoal } from './planner.js';
import { runOrchestration, type ControlCommand } from './runner.js';
import { parseSpecYaml, validateSpec, type OrchestrationSpec } from './spec.js';
import { templateFor } from './templates.js';
import { parseStageFeed } from '../els/tile-view.js';
import { dispatchOrchestrate } from './tool.js';

const PATTERN_LIST = ['map-reduce', 'pipeline', 'panel', 'supervisor-workers', 'loop-until'] as const;
const spec = (p: (typeof PATTERN_LIST)[number], over: Record<string, unknown> = {}): OrchestrationSpec => {
  const r = validateSpec({ ...templateFor(p, 'sim goal', p === 'map-reduce' ? ['a', 'b', 'c'] : []), ...over });
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.spec!;
};

describe('sim world · five patterns × seeds 1–3', () => {
  for (const seed of [1, 2, 3]) {
    for (const p of PATTERN_LIST) {
      test(`${p} seed ${seed} reaches a result`, async () => {
        const events: Record<string, unknown>[] = [];
        const backend = simBackend({ seed, strong: true, votes: ['A'] });
        const r = await runOrchestration(spec(p, { reduce: { method: p === 'pipeline' || p === 'loop-until' ? 'last' : 'concat', success: 'all-ok' } }), { backend, feed: (e) => events.push(e) });
        expect(r.status).toBe('met');
        expect(r.rounds.length).toBe(1);
        expect(r.result.length).toBeGreaterThan(100);
        expect(events[0]!.phase).toBe('plan');
        expect(events.at(-1)!.phase).toBe('done');
        expect(String(events.at(-1)!.receipt)).toStartWith('MET · 1 round(s)');
        const expectedCalls = { 'map-reduce': 3, pipeline: 3, panel: 3, 'supervisor-workers': 3, 'loop-until': 1 }[p];
        expect(backend.launched.length).toBe(expectedCalls);
      });
    }
  }
});

describe('edges', () => {
  test('planner picks the wrong pattern → the person forces another', async () => {
    const wrong = await planFromGoal('Write and review a 1-page README for X', { llm: async () => '{"pattern":"panel","reason":"x","workers":[{"kind":"eln"},{"kind":"codex"}]}' });
    expect(wrong.spec.pattern).toBe('panel');
    const fixed = await planFromGoal('Write and review a 1-page README for X', { pattern: 'pipeline' });
    expect(fixed.spec.pattern).toBe('pipeline');
    expect(fixed.spec.tasks.length).toBe(3);
  });
  test('model answer unusable → heuristic plan, with the reason', async () => {
    const p = await planFromGoal('Compare 3 note-taking apps and recommend one', { llm: async () => 'sorry' });
    expect(p.source).toBe('heuristic');
    expect(p.spec.pattern).toBe('map-reduce');
    expect(p.spec.tasks.length).toBe(3);
    expect(heuristicPattern('Write and review a 1-page README for X').pattern).toBe('pipeline');
    expect(heuristicPattern('Should we debate pros and cons of remote work').pattern).toBe('panel');
    expect(heuristicPattern('keep fixing until the tests pass').pattern).toBe('loop-until');
  });
  test('worker CLI missing → runs on eln instead, noted', async () => {
    const r = await runOrchestration(spec('map-reduce', { reduce: { method: 'concat', success: 'all-ok' } }), { backend: simBackend({ seed: 1, strong: true, missing: ['codex'] }) });
    expect(r.status).toBe('met');
    expect(r.workers.map((w) => w.kind)).toEqual(['eln', 'eln', 'claude']);
    expect(r.notes).toContain('codex CLI not found: codex-analyst runs on eln instead');
  });
  test('budget hit → no more launches, status budget', async () => {
    const backend = simBackend({ seed: 2, strong: true });
    const r = await runOrchestration(spec('map-reduce', { limits: { budgetUsd: 0.04, maxParallel: 1 }, reduce: { method: 'concat', success: 'min-items:3' } }), { backend });
    expect(backend.launched.length).toBe(2);
    expect(r.status).toBe('budget');
    expect(r.notes).toContain('budget $0.04 reached — no more workers launched');
  });
  test('goal not met in round 1 → second round with refined tasks → met', async () => {
    const backend = simBackend({ seed: 3 });
    const r = await runOrchestration(spec('loop-until', { reduce: { method: 'last', success: 'min-length:200' } }), { backend });
    expect(r.rounds.map((x) => x.met)).toEqual([false, true]);
    expect(r.status).toBe('met');
    expect(backend.launched).toEqual(['r1-iter', 'r2-iter']);
  });
  test('not met after max rounds → not-met report', async () => {
    const r = await runOrchestration(spec('pipeline', { limits: { maxRounds: 2 }, reduce: { method: 'last', success: 'contains:NEVER-THERE' } }), { backend: simBackend({ seed: 1, strong: true }) });
    expect(r.status).toBe('not-met');
    expect(r.rounds.length).toBe(2);
    expect(r.why).toBe('result does not mention «NEVER-THERE»');
  });
  test('stop mid-run → stopped, every worker closed', async () => {
    const backend = simBackend({ seed: 1, delayMs: 400 });
    const queue: ControlCommand[] = [];
    setTimeout(() => queue.push({ op: 'stop' }), 150);
    const r = await runOrchestration(spec('panel'), { backend, control: () => queue.splice(0) });
    expect(r.status).toBe('stopped');
    expect(backend.closed()).toBe(1);
    expect(r.notes).toContain('stopped by the user');
  });
  test('add 2 more workers mid-panel → they answer in the same round; cap 12 holds', async () => {
    const backend = simBackend({ seed: 2, delayMs: 200, strong: true });
    const queue: ControlCommand[] = [{ op: 'add-workers', count: 2, kind: 'claude' }];
    const r = await runOrchestration(spec('panel', { reduce: { method: 'vote', success: 'all-ok' } }), { backend, control: () => queue.splice(0) });
    expect(backend.launched.length).toBe(5);
    expect(r.workers.length).toBe(5);
    const capped = await runOrchestration(spec('panel'), { backend: simBackend({ seed: 1, strong: true }), control: (() => { let q: ControlCommand[] = [{ op: 'add-workers', count: 50 }]; return () => q.splice(0); })() });
    expect(capped.workers.length).toBe(12);
    expect(capped.notes).toContain('add-workers: capped at 12 workers (41 refused)');
  });
});

describe('spec safety', () => {
  test('caps and paid VMs are refused, aliases fold', () => {
    const r = validateSpec({ goal: 'g', pattern: 'debate', workers: [{ kind: 'eln', host: 'gcp1' }, { kind: 'gpt' }], limits: { maxParallel: 40, budgetUsd: 999 } });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('workers[0].host: only local workers run here — paid VMs (gcp1) are never started automatically');
    expect(r.errors).toContain('workers[1].kind must be eln | codex | claude (got "gpt")');
    expect(r.errors).toContain('limits.maxParallel must be 1..8');
    expect(r.errors).toContain('limits.budgetUsd must be >0 and ≤ 20');
    const y = parseSpecYaml('api: orchestration/v1\ngoal: g\npattern: debate\nworkers:\n  - {kind: eln}\n  - {kind: claude}\n');
    expect(y.ok).toBe(true);
    expect(y.spec!.pattern).toBe('panel');
    expect(y.spec!.reduce.method).toBe('vote');
  });
});

describe('words → layout and control', () => {
  test('layout phrases', () => {
    expect(parseLayoutCommand('타일 3x3으로')).toEqual({ grid: '3x3' });
    expect(parseLayoutCommand('리스크 탭 확대')).toEqual({ zoom: '리스크' });
    expect(parseLayoutCommand('zoom in on risk')).toEqual({ zoom: 'risk' });
    expect(parseLayoutCommand('다음 페이지')).toEqual({ page: 'next' });
    expect(parseLayoutCommand('전체 스페이스 보여줘')).toEqual({ level: 'spaces' });
    expect(parseLayoutCommand('show all tabs')).toEqual({ level: 'all' });
    expect(parseLayoutCommand('hello there')).toBeUndefined();
  });
  test('control phrases', () => {
    expect(parseControlText('stop')).toEqual({ op: 'stop' });
    expect(parseControlText('멈춰')).toEqual({ op: 'stop' });
    expect(parseControlText('add 2 more workers')).toEqual({ op: 'add-workers', count: 2 });
    expect(parseControlText('add 1 codex worker')).toEqual({ op: 'add-workers', count: 1, kind: 'codex' });
    expect(parseControlText('spotlight risk')).toEqual({ op: 'spotlight', target: 'risk' });
  });
  test('feed carries layout; els tile view parses it; page/zoom are one-shot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-feed-'));
    try {
      const path = join(dir, 'feed.jsonl');
      const w = feedWriter(path);
      w.emit({ phase: 'work', nodes: ['plan', 'work'] });
      applyLayout(path, { grid: '3x3' });
      applyLayout(path, { page: 'next' });
      w.emit({ phase: 'reduce' });
      const feed = parseStageFeed(readFileSync(path, 'utf8'));
      expect(feed?.phase).toBe('reduce');
      expect(feed?.layout).toEqual({ seq: 2, grid: '3x3', page: 'next' });
      applyLayout(path, { level: 'spaces' });
      expect(parseStageFeed(readFileSync(path, 'utf8'))?.layout).toEqual({ seq: 3, grid: '3x3', level: 'spaces' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Orchestrate tool', () => {
  test('plan → run (headless for a non-OP seat in els) → status → control', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-tool-'));
    try {
      const env = { ELANOUS_STATE_DIR: dir, ELANOUS_ELS_SOCKET: '/tmp/x.sock', ELANOUS_SEAT: 'TC', PATH: process.env.PATH };
      const plan = await dispatchOrchestrate({ action: 'plan', goal: 'Compare 3 note-taking apps and recommend one' }, { env, llm: async () => 'no json' });
      expect(plan.ok).toBe(true);
      expect(plan.pattern).toBe('map-reduce');
      const spawned: string[][] = [];
      const run = await dispatchOrchestrate({ action: 'run', file: plan.file }, { env, spawnRun: (f, a) => spawned.push([f, ...a]) });
      expect(run.backend).toBe('headless');
      expect(spawned[0]!.slice(1, 2)).toEqual(['--run-id']);
      expect(spawned[0]!.at(-1)).toBe('--headless');
      const bad = await dispatchOrchestrate({ action: 'status' }, { env });
      expect(bad).toEqual({ ok: false, error: 'runId is required' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('presets and the publish node', () => {
  test('«내일 아침 시장 브리핑…» → market-brief preset: four data desks, visible reduce, publish node', async () => {
    const p = await planFromGoal('내일 아침 시장 브리핑 만들어서 음성으로 들려줘', { llm: async () => { throw new Error('not called'); } });
    expect(p.source).toBe('preset');
    expect(p.spec.pattern).toBe('map-reduce');
    expect(p.spec.workers.map((w) => w.id)).toEqual(['news', 'x-pulse', 'youtube', 'prices']);
    expect(p.spec.workers.every((w) => typeof w.fetch === 'string')).toBe(true);
    expect(p.spec.publish?.title).toBe('Publish · PDF + voice → Telegram');
    expect(p.spec.voice).toBe(true);
  });
  test('publish runs after the criterion holds, with its own phase', async () => {
    const events: string[] = [];
    const ran: string[] = [];
    const backend = { ...simBackend({ seed: 1, strong: true }), runCommand: async (job: { title: string }, command: string) => { ran.push(`${job.title}|${command}`); return { ok: true, text: 'PDF ✓\nTelegram ✓ message 7' }; } };
    const r = await runOrchestration(spec('loop-until', { reduce: { method: 'last', success: 'all-ok' }, publish: { command: 'echo publish' } }), { backend, feed: (e) => events.push(String(e.phase)) });
    expect(ran).toEqual(['ORCH·publish|echo publish']);
    expect(events).toContain('publish');
    expect(r.notes).toContain('publish ok: PDF ✓ · Telegram ✓ message 7');
  });
});

describe('review round 1 (Terra) regressions', () => {
  test('budget cut short + all-ok → budget, never met, no publish', async () => {
    const ran: string[] = [];
    const backend = { ...simBackend({ seed: 2, strong: true }), runCommand: async () => { ran.push('publish'); return { ok: true, text: '' }; } };
    const r = await runOrchestration(spec('map-reduce', { limits: { budgetUsd: 0.04, maxParallel: 1 }, reduce: { method: 'concat', success: 'all-ok' }, publish: { command: 'x' } }), { backend });
    expect(r.status).toBe('budget');
    expect(r.rounds[0]!.met).toBe(false);
    expect(ran).toEqual([]);
  });
  test('an llm-summary reduce that would cross the budget joins answers without a model', async () => {
    let calls = 0;
    const r = await runOrchestration(spec('loop-until', { limits: { budgetUsd: 0.01, maxRounds: 1 }, reduce: { method: 'llm-summary', success: 'all-ok' } }), { backend: simBackend({ seed: 1, strong: true }), llm: async () => { calls++; return 'x'; } });
    expect(calls).toBe(0);
    expect(r.status).toBe('budget');
    expect(r.result).toStartWith('Summary (no model available — answers joined):');
  });
  test('publish failure is recorded and the goal result is kept', async () => {
    const backend = { ...simBackend({ seed: 3, strong: true }), runCommand: async () => ({ ok: false, text: 'PDF ✗ both failed' }) };
    const r = await runOrchestration(spec('loop-until', { reduce: { method: 'last', success: 'all-ok' }, publish: { command: 'x' } }), { backend });
    expect(r.status).toBe('met');
    expect(r.notes).toContain('publish failed: PDF ✗ both failed');
    expect(r.result.length).toBeGreaterThan(100);
  });
  test('unzoom drops the carried spotlight so the view does not re-apply it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-zoom-'));
    try {
      const path = join(dir, 'feed.jsonl');
      applyLayout(path, { zoom: 'risk' });
      expect(parseStageFeed(readFileSync(path, 'utf8'))?.spotlightPane).toBe('risk');
      applyLayout(path, { zoom: '' });
      const feed = parseStageFeed(readFileSync(path, 'utf8'));
      expect(feed?.spotlightPane).toBeUndefined();
      expect(feed?.layout).toEqual({ seq: 2, zoom: '' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('headless backend reaps the whole pipeline', () => {
  test('stop kills the worker group (no orphaned fetch) and the run reports a failure, not success', async () => {
    const { headlessBackend } = await import('./backends.js');
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'orch-pg-'));
    try {
      const backend = headlessBackend({ dir, timeoutSec: 60 });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 600);
      const started = Date.now();
      const o = await backend.run({ id: 'r1-x', title: 'ORCH·x', round: 1, prompt: 'p', worker: { id: 'x', kind: 'eln', role: 'w', fetch: 'sleep 37.25' } }, ac.signal);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(o.ok).toBe(false);
      let left = 0;
      for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 200)); left = spawnSync('pgrep', ['-f', 'sleep 37.25']).status === 0 ? 1 : 0; if (!left) break; }
      expect(left).toBe(0);                                                  // gone within the 3 s SIGKILL grace at the latest
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test('killGroup SIGKILLs a descendant that ignores SIGTERM after the leader exits, and resolves once the group is gone', async () => {
  const { killGroup } = await import('./backends.js');
  const { spawn, spawnSync } = await import('node:child_process');
  const child = spawn('bash', ['-c', "bash -c 'trap \"\" TERM; sleep 43.75' & wait"], { stdio: 'ignore', detached: true });
  await new Promise((r) => setTimeout(r, 400));
  await killGroup(child, 600);
  expect(spawnSync('pgrep', ['-f', 'sleep 43.75']).status).toBe(1);
});
