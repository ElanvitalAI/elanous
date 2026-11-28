import { describe, expect, test } from 'bun:test';
import { withPolicies } from '../policy-context.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseKnowhowItems } from '../../seat-loop/seat-knowhow.js';
import { loadCard } from '../card.js';
import { fileAgentMemory } from '../memory.js';
import { tickAgent, type AgentPorts } from '../runtime.js';
import type { Proc, ReapCandidate } from '../../guardian-agent/reaper.js';
import { createBody, type MacrophageDeps } from './macrophage.js';
import { scrapFacts, type ScrapDeps, type WorktreeInfo } from './macrophage-scrap.js';
/** scrapFacts reads the macrophage policies (stale_* · oneshot_grace_h) — run it under the card's own values. */
const scrapUnder = (deps: ScrapDeps, nowMs: number): Promise<string[]> => withPolicies(loadCard('macrophage').policies, async () => scrapFacts(deps, nowMs));

// The body delegates to the guardian reaper (decision 11-27): these tests fake the reaper's plan · kill · audit · lock and
// check the card's own contract — one reap per target, a guardian-reaped target skipped, a kill mismatch is a failure.
const T0 = new Date('2026-11-27T10:00:00Z');
const HOUR = 3_600_000;
const proc = (pid: number, ageMs: number, command: string): Proc => ({ pid, ppid: 1, pgid: pid, ageMs, cpu: 0, command });

function world(opts: { guardianReaped?: number[]; killMismatch?: boolean } = {}) {
  const procs = [proc(4101, 3 * HOUR, 'bun test --test-state-dir /tmp/u1/a.test.ts'), proc(4102, HOUR / 2, 'bun test /tmp/young.test.ts')];
  const audit: Array<Record<string, unknown>> = []; const kills: number[] = []; let locks = 0;
  const reaped = new Set((opts.guardianReaped ?? []).map(p => `mbp:${p}`));
  const deps: MacrophageDeps = {
    hosts: () => ['mbp'],
    procs: () => procs.filter(p => !kills.includes(p.pid)),
    registry: () => [],
    self: () => new Set<number>(),
    plan: (ps, _reg, _now) => ps.filter(p => p.ageMs > 2 * HOUR).map((p): ReapCandidate => ({ pid: p.pid, pgid: p.pgid, ageMs: p.ageMs, cpu: p.cpu, command: p.command, why: 'test-universe orphan > 2h' })),
    recentReaps: () => new Set([...reaped, ...audit.map(a => `${String(a.host)}:${String(a.pid)}`)]),
    kill: (_h, c) => { if (opts.killMismatch) return { killed: [], skipped: [c.pid] }; kills.push(c.pid); return { killed: [c.pid], skipped: [] }; },
    audit: row => { audit.push(row); },
    lock: fn => { locks += 1; return fn(); },
  };
  return { deps, audit, kills, locks: () => locks };
}

function harness(w: ReturnType<typeof world>) {
  const root = mkdtempSync(join(tmpdir(), 'mp-'));
  const card = loadCard('macrophage');
  const memory = fileAgentMemory(root, card.id, card.supervisor);
  const posts: Array<{ key: string; to: string }> = [];
  const ports: AgentPorts = { memory, post(key, to) { if (posts.some(p => p.key === key)) return null; posts.push({ key, to }); return posts.length; }, beat: () => {}, speak: () => {}, llm: null };
  return { card, memory, posts, ports, body: createBody({ stateRoot: root, card }, w.deps) };
}

describe('macrophage → guardian reaper (delegated body)', () => {
  test('the 3 h orphan is reaped once by exact PID inside the shared lock · one audit row by MACROPHAGE · the young one untouched', async () => {
    const w = world(); const h = harness(w);
    const r1 = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r1.kpi).toBe(1);
    expect(r1.acted).toEqual(['reap:mbp:4101']);
    expect(w.kills).toEqual([4101]);
    expect(w.audit.map(a => `${String(a.pid)}|${String(a.by)}`)).toEqual(['4101|MACROPHAGE']);
    expect(w.locks()).toBe(1);
    const r2 = await tickAgent(h.card, h.body, h.ports, new Date(T0.getTime() + 31 * 60_000));
    expect(r2.kpi).toBe(0);
    expect(w.kills).toEqual([4101]);
  });
  test('a target the guardian already reaped is not reaped again', async () => {
    const w = world({ guardianReaped: [4101] }); const h = harness(w);
    const r = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r.kpi).toBe(0);
    expect(r.acted).toEqual([]);
    expect(w.kills).toEqual([]);
  });
  test('a kill the reaper refuses (command mismatch) is a failure, never an audit row', async () => {
    const w = world({ killMismatch: true }); const h = harness(w);
    const r = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r.failed).toEqual(['reap:mbp:4101']);
    expect(w.audit).toEqual([]);
  });
});

describe('macrophage observation parity (Terra #40447 must-fix 4 · 5)', () => {
  test('one unreadable host = KPI unknown, even when another host has candidates', async () => {
    const w = world(); const h = harness(w);
    w.deps.hosts = () => ['mbp', 'node-b'];
    const procs = w.deps.procs;
    w.deps.procs = host => (host === 'node-b' ? null : procs(host));
    const r = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r.kpi).toBeNull();
    expect(r.acted).toEqual(['reap:mbp:4101']); // the readable host is still worked
  });
  test('launchd one-shots · past cron · stale worktrees · old stashes are reported as fact lines (no action)', async () => {
    const w = world(); const h = harness(w);
    const day = 86_400_000;
    w.deps.scrap = {
      launchdJobs: () => [{ label: 'com.elanous.resinfra.pinch124662', plistPath: '/x.plist', oneShotAtMs: T0.getTime() - 3 * day, loaded: true }],
      crontab: () => '5 4 1 11 * /bin/echo past\n*/5 * * * * /bin/echo every\n',
      worktrees: () => [{ path: '/Users/u/elanous-hq/worktrees/old', branch: 'feat/old', head: 'a'.repeat(40), lastCommitMs: T0.getTime() - 20 * day, clean: true }],
      stashes: () => [{ ref: 'stash@{0}', atMs: T0.getTime() - 30 * day, subject: 'wip' }],
      knownWorktreePath: () => true,
    };
    const r = await tickAgent(h.card, h.body, h.ports, T0);
    expect(r.acted).toEqual(['reap:mbp:4101']);
    const facts = (await withPolicies(h.card.policies, async () => h.body.observe({ now: T0, card: h.card, state: h.memory.readState(), recall: null, level: 'live' }))).facts.join(' | ');
    expect(facts).toContain('지난 일회성 launchd 1 (com.elanous.resinfra.pinch124662)');
    expect(facts).toContain('지난 날짜 크론 1');
    expect(facts).toContain('14일 넘은 깨끗한 worktree 1 · 14일 넘은 stash 1');
  });
});

describe('macrophage scrap: a partial read is «모름», never a partial count (Terra #40447 r2)', () => {
  const day = 86_400_000;
  const base: ScrapDeps & { worktrees: () => WorktreeInfo[] } = {
    launchdJobs: () => [], crontab: () => '', stashes: () => [], knownWorktreePath: () => true,
    worktrees: (): WorktreeInfo[] => [{ path: '/Users/u/elanous-hq/worktrees/old', branch: 'feat/old', head: 'a'.repeat(40), lastCommitMs: T0.getTime() - 20 * day, clean: true }],
  };
  test('launchd reader returns null (one plist unreadable) → «지난 일회성 launchd 모름»', async () => {
    expect((await scrapUnder({ ...base, launchdJobs: () => null }, T0.getTime()))[0]).toContain('지난 일회성 launchd 모름');
  });
  test('an old worktree whose git status failed → the worktree count is «모름», not the readable ones', async () => {
    const facts = await scrapUnder({ ...base, worktrees: () => [...base.worktrees(), { path: '/Users/u/elanous-hq/worktrees/locked', branch: 'feat/x', head: 'b'.repeat(40), lastCommitMs: T0.getTime() - 30 * day, clean: null }] }, T0.getTime());
    expect(facts[1]).toContain('14일 넘은 깨끗한 worktree 모름');
    expect((await scrapUnder(base, T0.getTime()))[1]).toContain('14일 넘은 깨끗한 worktree 1');
  });
});

describe('macrophage card', () => {
  test('card loads · knowhow parses ≥3', () => {
    const c = loadCard('macrophage');
    expect(c).toMatchObject({ id: 'macrophage', address: 'MACROPHAGE', supervisor: 'RES', kpi: { name: 'orphans_over_2h', target: 0, dir: 'at_most' } });
    expect(c.rights.actions).toEqual(['reap']);
    const kh = readFileSync(resolve(import.meta.dir, '../../../graphs/loop-agents/macrophage/knowhow.md'), 'utf8');
    expect(parseKnowhowItems(kh, 'MACROPHAGE').length).toBeGreaterThanOrEqual(3);
  });
});
