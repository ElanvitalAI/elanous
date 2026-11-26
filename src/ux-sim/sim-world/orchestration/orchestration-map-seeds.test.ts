// ORCHESTRATE-MAP-GENERAL sim — seeds 1..3: `eln orchestrate map` against simulated children whose failures come from a
// seeded generator (timeout · missing worker CLI · empty answer · els refusal), plus cross-pattern edges: the subagent
// spawn guard cap holding while a map runs, a second map firing mid-run (loop trigger during a map), and a cancel.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMap, type ChildRunner } from '../../../orchestrate/map.js';
import { AgentSpawnGuard, guardedAgentSpawn } from '../../../skills/tools/agent-spawn-guard.js';

const rng = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
const tmp = () => mkdtempSync(join(tmpdir(), 'orc-sim-'));

function seededRunner(seed: number): { runChild: ChildRunner; plan: Map<string, string> } {
  const r = rng(seed), plan = new Map<string, string>();
  const runChild: ChildRunner = async (s, c) => {
    const key = `${s.n}:${s.attempt}`;
    const roll = r();
    const fate = roll < 0.15 ? 'timeout' : roll < 0.22 ? 'missing' : roll < 0.3 ? 'empty' : roll < 0.38 && c.els ? 'els-refused' : 'ok';
    plan.set(key, fate);
    await new Promise((d) => setTimeout(d, 1 + Math.floor(r() * 5)));
    if (fate === 'timeout') return { code: 124, text: '', pane: 'headless', durationMs: 5, error: 'timed out after 1s' };
    if (fate === 'missing') return { code: 127, text: '', pane: 'none', durationMs: 0, error: `worker CLI «${s.worker}» not on PATH` };
    if (fate === 'empty') return { code: 0, text: '', pane: 'headless', durationMs: 5, error: 'empty answer' };
    return { code: 0, text: `answer\nVERDICT: ${r() < 0.75 ? 'yes' : 'no'}`, pane: c.els ? 'els:w/t/p' : 'headless', durationMs: 5,
      ...(fate === 'els-refused' ? { elsError: 'els new: denied — verified tool seat required' } : {}) };
  };
  return { runChild, plan };
}

describe.each([1, 2, 3])('orchestrate map sim · seed %i', (seed) => {
  test('seeded failures: retry once (not for a missing CLI), partial reduce lists every failure, receipt adds up', async () => {
    const { runChild, plan } = seededRunner(seed);
    const items = Array.from({ length: 12 }, (_, i) => `item ${i + 1}`);
    const r = await runMap({ task: 't {item}', items, workers: ['eln', 'codex', 'claude'], reducer: 'consensus', maxParallel: 3, outDir: tmp(), runChild,
      els: { cli: ['true'], env: {}, ws: 'w' }, log: () => {} });
    expect(r.ok + r.failed).toBe(12);
    for (const c of r.children) {
      const first = plan.get(`${c.n}:1`)!;
      if (first === 'missing') expect(c.attempts).toBe(1);
      if (['timeout', 'empty'].includes(first)) expect(c.attempts).toBe(2);
    }
    expect(r.failures.map((f) => f.n)).toEqual(r.children.filter((c) => !c.ok).map((c) => c.n));
    expect(r.reduce.partial).toBe(r.failed > 0);
    if ([...plan.values()].includes('els-refused')) expect(r).toMatchObject({ mode: 'headless', modeNote: expect.stringContaining('verified tool seat required') });
  });

  test('spawn guard cap 3 holds while a map runs; a map never runs more than max-parallel', async () => {
    let live = 0, peak = 0;
    const slow: ChildRunner = async () => { live++; peak = Math.max(peak, live); await new Promise((d) => setTimeout(d, 10)); live--; return { code: 0, text: 'VERDICT: y', pane: 'headless', durationMs: 10 }; };
    const tasks = new Map<string, { state: string }>();
    const guard = new AgentSpawnGuard({ now: () => 1_000_000, taskState: (id) => tasks.get(id) });
    let n = 0;
    const spawn = (d: string) => guardedAgentSpawn({ description: d, prompt: `survey ${d} ${seed} module`, reason: 'parallel' }, async () => { const taskId = `t${++n}`; tasks.set(taskId, { state: 'running' }); return { taskId, background: true }; }, guard, 'OP');
    const map = runMap({ task: 't', items: Array.from({ length: 6 }, (_, i) => `x${i}`), workers: ['sim'], reducer: 'vote', maxParallel: 2 + (seed % 2), outDir: tmp(), runChild: slow, log: () => {} });
    await spawn('alpha'); await spawn('beta'); await spawn('gamma');
    await expect(spawn('delta')).rejects.toThrow('limit 3');
    const r = await map;
    expect(peak).toBeLessThanOrEqual(2 + (seed % 2));
    expect(r.ok).toBe(6);
  });

  test('a loop trigger fires a second map mid-run: both finish, separate run folders and receipts', async () => {
    const out = tmp();
    const ok: ChildRunner = async (s) => { await new Promise((d) => setTimeout(d, 3 * seed)); return { code: 0, text: `VERDICT: ${s.item}`, pane: 'headless', durationMs: 3 }; };
    const first = runMap({ task: 't', items: ['a', 'a', 'b'], workers: ['sim'], reducer: 'vote', outDir: out, id: `m1s${seed}`, runChild: ok, log: () => {} });
    await new Promise((d) => setTimeout(d, 2));
    const second = runMap({ task: 'loop', items: ['z'], workers: ['sim'], reducer: 'vote', outDir: out, id: `m2s${seed}`, runChild: ok, log: () => {} });
    const [a, b] = await Promise.all([first, second]);
    expect(a.reduce.label).toBe('a');
    expect(b.reduce.label).toBe('z');
    expect(a.paths.dir).not.toBe(b.paths.dir);
  });

  test('cancel mid-map: remaining children are cancelled, opened tabs are listed for closing', async () => {
    const ctl = new AbortController();
    const opened: string[] = [];
    const runChild: ChildRunner = async (s, c) => { c.onTab(`t${s.n}`); opened.push(`t${s.n}`); if (s.n === seed) ctl.abort(); return c.signal.aborted ? { code: 130, text: '', pane: 'els:w', durationMs: 1, error: 'cancelled' } : { code: 0, text: 'VERDICT: y', pane: 'els:w', durationMs: 1 }; };
    const r = await runMap({ task: 't', items: ['a', 'b', 'c', 'd'], workers: ['sim'], reducer: 'concat', maxParallel: 1, outDir: tmp(), runChild, signal: ctl.signal, els: { cli: ['true'], env: {}, ws: 'w' }, log: () => {} });
    expect(r.cancelled).toBe(true);
    expect(r.ok).toBe(seed - 1);
    expect(opened).toHaveLength(seed);
  });
});
