// SIM-WORLD smart-merge · GH-BUDGET-GOVERNOR (0.3.39 P0 · 11-28 19:0x · 20:0x KST GitHub secondary limit on the land graph).
// Device GH-GOVERNOR-WORLD = a temp state root ⊕ a fake GitHub (a gh shim answering pr list / api graphql, recording every call)
// driven through the real door code: governGhRun (cooldown · budget · ledger) · readOpenPrSnapshot (shared snapshot, lock) ·
// tickLand (the land graph body). The five-seat race runs five real bun processes against one state root.
// Expected values are literals from the scene (call counts · outcomes), never re-derived from src/kit/gh-governor.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  activeCooldown, ghGovernorPolicyPath, governGhRun, ledgerPath, parseGhGovernorPolicy, type GhGovernorPolicy, type RawGhRun,
} from '../../../kit/gh-governor/index.js';
import { invalidateOpenPrSnapshot, readOpenPrSnapshot, type SnapshotRun } from '../../../kit/gh-governor/open-pr-snapshot.js';
import { tickLand, type LandDeps, type PrInfo } from '../../../land-graph/land-graph.js';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

export const GH_GOV_DEVICE = 'GH-GOVERNOR-WORLD';
export interface GhGovDevice { tmp(): string; disposeAll(): void }

export const ghGovernorDevice: SimWorldDeviceDef<GhGovDevice> = {
  id: GH_GOV_DEVICE,
  title: 'temp state root + fake GitHub (gh shim: pr list / api graphql · call log) under the real gh door (cooldown · budget · shared snapshot)',
  create: () => {
    const all: string[] = [];
    return { tmp: () => { const r = mkdtempSync(join(tmpdir(), 'gh-gov-world-')); all.push(r); return r; }, disposeAll: () => { for (const r of all.splice(0)) rmSync(r, { recursive: true, force: true }); } };
  },
};

const REPO = resolve(import.meta.dir, '../../../..');
const T0 = Date.parse('2026-11-28T11:00:00.000Z'); // 20:00 KST
const LIMIT = 'GraphQL: API rate limit already exceeded for user ID 19355785.';
const TARGET = { slug: 'acme/widget' };
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const policyText = () => readFileSync(ghGovernorPolicyPath(REPO), 'utf8');
const prRows = (n: number, seed: number) => Array.from({ length: n }, (_, i) => ({
  number: 40000 + i, headRefOid: `${(seed * 7 + i).toString(16).padStart(2, '0')}`.repeat(20), headRefName: `b${i}`, baseRefName: 'main',
  isDraft: false, state: 'OPEN', title: `pr ${i}`, author: { login: 'tc' }, body: `칸: GH-${i}`, labels: [],
}));
const filesAnswer = (q: string, rows: ReturnType<typeof prRows>) => ({ data: { repository: Object.fromEntries([...q.matchAll(/p(\d+): pullRequest/g)].map(m => {
  const r = rows.find(x => x.number === Number(m[1]))!;
  return [`p${r.number}`, { headRefOid: r.headRefOid, files: { nodes: [{ path: `src/f${r.number}.ts` }], pageInfo: { hasNextPage: false } } }];
})) } });
const asSnapRun = (r: RawGhRun & { refused?: 'cooldown' | 'budget' }): SnapshotRun =>
  ({ ok: r.status === 0, exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, ...(r.refused ? { refused: r.refused } : {}) });
async function withGov(ctx: SimWorldScenarioContext, body: (d: GhGovDevice) => Promise<SimWorldScenarioOutcome>): Promise<SimWorldScenarioOutcome> {
  const d = ctx.device<GhGovDevice>(GH_GOV_DEVICE);
  try { return await body(d); } finally { d.disposeAll(); }
}

/** One child = one seat process: the real snapshot reader over the real door decision, gh = the shim. */
const CHILD = `
const [root, shim, seat, repo] = process.argv.slice(1);
const fs = require('node:fs'); const cp = require('node:child_process');
const gov = await import(repo + '/src/kit/gh-governor/index.ts');
const snap = await import(repo + '/src/kit/gh-governor/open-pr-snapshot.ts');
const policy = gov.parseGhGovernorPolicy(fs.readFileSync(gov.ghGovernorPolicyPath(repo), 'utf8'));
const g = { stateRoot: root, now: Date.now, seat, policy };
const run = (args) => { const r = gov.governGhRun(g, args, () => { const x = cp.spawnSync(shim, args, { env: { ...process.env, SEAT: seat } }); return { status: x.status, stdout: x.stdout, stderr: x.stderr }; });
  return { ok: r.status === 0, exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr, ...(r.refused ? { refused: r.refused } : {}) }; };
const s = snap.readOpenPrSnapshot({ slug: 'acme/widget' }, { stateRoot: root, now: Date.now, policy, run, sleep: snap.sleepSync });
console.log(JSON.stringify({ seat, source: s.source, n: s.prs.length }));
`;

function runChild(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    const c = spawn(process.execPath, ['-e', CHILD, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    c.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    c.once('close', (code) => done({ code, out, err }));
  });
}

export const ghGovernorScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SM-GH-SNAPSHOT-5SEATS',
    title: 'five seat processes ask the full open-PR list at once → one real GitHub list read (shared snapshot · one refresher)',
    devices: [GH_GOV_DEVICE],
    run: (ctx) => withGov(ctx, async (d) => {
      const root = d.tmp();
      const rows = prRows(2 + (ctx.seed % 5), ctx.seed);
      writeFileSync(join(root, 'list.json'), JSON.stringify(rows));
      writeFileSync(join(root, 'files.json'), JSON.stringify(filesAnswer(rows.map(r => `p${r.number}: pullRequest`).join(' '), rows)));
      const shim = join(root, 'gh');
      writeFileSync(shim, `#!/bin/sh\necho "$SEAT $1 $2" >> '${join(root, 'calls.log')}'\nsleep 1\ncase "$1" in pr) cat '${join(root, 'list.json')}';; api) cat '${join(root, 'files.json')}';; *) exit 2;; esac\n`);
      chmodSync(shim, 0o755);
      // Warm the per-head files cache once (an earlier refresh), then the snapshot expires: the race reads the list only.
      const warm = spawnSync(process.execPath, ['-e', CHILD, root, shim, 'WARM', REPO], { encoding: 'utf8', timeout: 60_000 });
      if (warm.status !== 0) return fail('warm-refresh', warm.stderr.slice(0, 300));
      invalidateOpenPrSnapshot(root, TARGET);
      rmSync(join(root, 'calls.log'), { force: true });
      const seats = ['HAND-A', 'HAND-B', 'JUD', 'UX', 'HAND-TUI-D'].sort(() => ctx.random() - 0.5);
      const outs = await Promise.all(seats.map(s => runChild([root, shim, s, REPO])));
      const reads = outs.map(o => { try { return JSON.parse(o.out.trim().split('\n').pop() ?? '') as { seat: string; source: string; n: number }; } catch { return null; } });
      const calls = existsSync(join(root, 'calls.log')) ? readFileSync(join(root, 'calls.log'), 'utf8').trim().split('\n') : [];
      ctx.recorder.event('smart-merge:gh-snapshot-5seats', { calls, sources: reads.map(r => r?.source ?? null) });
      if (reads.some(r => r === null)) return fail('child-failed', JSON.stringify(outs.map(o => [o.code, o.err.slice(0, 200)])));
      if (calls.length !== 1 || !/^\S+ pr list$/.test(calls[0]!)) return fail('github-calls', JSON.stringify(calls));
      const sources = reads.map(r => r!.source).sort();
      if (JSON.stringify(sources) !== JSON.stringify(['cache', 'cache', 'cache', 'cache', 'fresh'])) return fail('sources', JSON.stringify(sources));
      return reads.every(r => r!.n === rows.length) ? { ok: true } : fail('rows', JSON.stringify(reads));
    }),
  },
  {
    id: 'SM-GH-SECONDARY-COOLDOWN',
    title: 'GitHub answers «rate limit already exceeded» → global cooldown: every seat skips without calling · the land graph tick is skipped once, then normal',
    devices: [GH_GOV_DEVICE],
    run: (ctx) => withGov(ctx, async (d) => {
      const root = d.tmp();
      const policy: GhGovernorPolicy = parseGhGovernorPolicy(policyText());
      const rows = prRows(1 + (ctx.seed % 4), ctx.seed);
      let now = T0; let limited = true; const calls: string[] = [];
      const exec = (seat: string) => (args: string[]) => governGhRun({ stateRoot: root, now: () => now, seat, policy }, args, () => {
        calls.push(`${seat} ${args[0]} ${args[1]}`);
        if (limited) return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(LIMIT) };
        const body = args[0] === 'pr' ? JSON.stringify(rows) : JSON.stringify(filesAnswer(args.find(a => a.startsWith('query='))!, rows));
        return { status: 0, stdout: Buffer.from(body), stderr: Buffer.alloc(0) };
      });
      const landRun = exec('LAND-STEWARD');
      const deps: LandDeps = {
        now: () => new Date(now), stateRoot: root, mode: 'shadow', slots: 1,
        listPrs: async () => readOpenPrSnapshot(TARGET, { stateRoot: root, now: () => now, policy, run: a => asSnapRun(landRun(a)), sleep: () => {} }).prs
          .map((p): PrInfo => ({ number: p.number, head: p.headRefOid, base: p.baseRefName ?? 'main', draft: !!p.isDraft, state: 'OPEN', title: p.title ?? '', author: 'TC', files: p.files.map(f => f.path) })),
        prNow: async () => null, receipt: () => null, olderReceiptHead: () => null, focused: () => 'unreadable', security: () => [],
        land: async () => ({ rc: 1, text: 'sim' }), post: () => {}, record: () => {},
      };
      const t1 = await tickLand(deps);
      const lastTick = () => { try { return JSON.parse(readFileSync(join(root, 'land-graph', 'last-tick.json'), 'utf8')) as Record<string, unknown>; } catch { return null; } };
      const tick1File = lastTick();
      const cool = activeCooldown({ stateRoot: root, now: () => now });
      const afterHit = calls.length;
      now = T0 + 30_000;
      const seats = ['HAND-A', 'HAND-C', 'JUD', 'UX', 'MVP-B'];
      const seatOuts = seats.map((s, i) => exec(s)(i % 2 ? ['pr', 'ready', String(40000 + i)] : ['pr', 'view', String(40000 + i), '--json', 'number']));
      now = (cool?.until ?? T0) + 1_000; limited = false;
      const t2 = await tickLand(deps);
      const tick2File = lastTick();
      ctx.recorder.event('smart-merge:gh-cooldown', { t1: t1.skipped ?? null, t2: t2.error ?? null, calls, refused: seatOuts.map(o => o.refused ?? null), tick1File, tick2File });
      if (t1.skipped !== 'gh-error' || !t1.error?.startsWith('gh-error: ')) return fail('tick1-not-skipped', JSON.stringify(t1));
      // The skipped wake still stamps last-tick.json (at · skipped · lastSkipped with its reason) — never «틱 정지» while cooling.
      const skipWhy = (tick1File?.lastSkipped as { at?: string; why?: string } | undefined);
      if (tick1File?.at !== '2026-11-28T11:00:00.000Z' || tick1File?.skipped !== 'gh-error' || skipWhy?.at !== '2026-11-28T11:00:00.000Z'
        || !skipWhy?.why?.startsWith('gh-error: gh pr list rc=1: GraphQL: API rate limit already exceeded')) return fail('tick1-last-tick', JSON.stringify(tick1File));
      // The next full tick rewrites the file whole: its own time · its numbers · no skip marks.
      if (tick2File?.at !== new Date(now).toISOString() || tick2File?.decisions !== rows.length || 'skipped' in tick2File || 'lastSkipped' in tick2File) return fail('tick2-last-tick', JSON.stringify(tick2File));
      if (!cool || cool.durationSec !== 120 || cool.seat !== 'LAND-STEWARD') return fail('cooldown', JSON.stringify(cool));
      if (afterHit !== 1) return fail('hit-calls', JSON.stringify(calls));
      if (!seatOuts.every(o => o.status === 75 && o.refused === 'cooldown')) return fail('seats-not-cooled', JSON.stringify(seatOuts.map(o => [o.status, o.refused])));
      if (t2.error || t2.skipped || t2.decisions.length !== rows.length) return fail('tick2-not-normal', JSON.stringify(t2));
      return calls.length === 3 && calls.slice(1).join('|') === 'LAND-STEWARD pr list|LAND-STEWARD api graphql' ? { ok: true } : fail('calls-after', JSON.stringify(calls));
    }),
  },
  {
    id: 'SM-GH-HEAD-MOVED-MID-REFRESH',
    title: 'one of many open PRs is pushed between the list and its files read → the snapshot is still written without that PR (meta skipped 1) · the land graph judges the rest · the next refresh has it',
    devices: [GH_GOV_DEVICE],
    run: (ctx) => withGov(ctx, async (d) => {
      const root = d.tmp();
      const policy: GhGovernorPolicy = parseGhGovernorPolicy(policyText());
      const rows = prRows(30 + (ctx.seed % 7), ctx.seed); // more than one files batch (25)
      const moved = rows[Math.floor(ctx.random() * rows.length)]!;
      const newHead = 'f'.repeat(40);
      let now = T0; let pushAfterList = true; const calls: string[] = [];
      const run = (args: string[]): SnapshotRun => asSnapRun(governGhRun({ stateRoot: root, now: () => now, seat: 'LAND-STEWARD', policy }, args, () => {
        calls.push(`${args[0]} ${args[1]}`);
        const body = args[0] === 'pr' ? JSON.stringify(rows) : JSON.stringify(filesAnswer(args.find(a => a.startsWith('query='))!, rows));
        // the smart-merge finisher pushes this PR while the list answer is in flight
        if (args[0] === 'pr' && pushAfterList) { moved.headRefOid = newHead; pushAfterList = false; }
        return { status: 0, stdout: Buffer.from(body), stderr: Buffer.alloc(0) };
      }));
      const deps: LandDeps = {
        now: () => new Date(now), stateRoot: root, mode: 'shadow', slots: 1,
        listPrs: async () => readOpenPrSnapshot(TARGET, { stateRoot: root, now: () => now, policy, run, sleep: () => {} }).prs
          .map((p): PrInfo => ({ number: p.number, head: p.headRefOid, base: p.baseRefName ?? 'main', draft: !!p.isDraft, state: 'OPEN', title: p.title ?? '', author: 'TC', files: p.files.map(f => f.path) })),
        prNow: async () => null, receipt: () => null, olderReceiptHead: () => null, focused: () => 'unreadable', security: () => [],
        land: async () => ({ rc: 1, text: 'sim' }), post: () => {}, record: () => {},
      };
      const t1 = await tickLand(deps);
      const file = JSON.parse(readFileSync(join(root, 'gh-governor', 'open-prs-acme_widget.json'), 'utf8')) as { prs: Array<{ number: number }>; skipped?: Array<{ number: number; why: string }> };
      now = T0 + 61_000;
      const t2 = await tickLand(deps);
      ctx.recorder.event('smart-merge:gh-head-moved', { moved: moved.number, t1: t1.decisions.length, t2: t2.decisions.length, skipped: file.skipped ?? null, calls: calls.length });
      if (t1.error || t1.skipped) return fail('tick1-failed', JSON.stringify(t1.error));
      if (file.prs.length !== rows.length - 1 || file.prs.some(p => p.number === moved.number)) return fail('snapshot-rows', JSON.stringify(file.prs.map(p => p.number)));
      if (JSON.stringify(file.skipped) !== JSON.stringify([{ number: moved.number, head: `${(ctx.seed * 7 + rows.indexOf(moved)).toString(16).padStart(2, '0')}`.repeat(20), why: 'head-moved' }])) return fail('skipped-meta', JSON.stringify(file.skipped));
      if (t1.decisions.length !== rows.length - 1 || t1.decisions.some(x => x.pr === moved.number)) return fail('tick1-decisions', JSON.stringify(t1.decisions.map(x => x.pr)));
      // next refresh: the moved PR back with its new head · one list ⊕ one files read (that PR only)
      const back = t2.decisions.find(x => x.pr === moved.number);
      if (t2.error || t2.decisions.length !== rows.length || back?.head !== newHead) return fail('tick2', JSON.stringify({ err: t2.error, n: t2.decisions.length, back }));
      return calls.join('|') === 'pr list|api graphql|api graphql|pr list|api graphql' ? { ok: true } : fail('calls', calls.join('|'));
    }),
  },
  {
    id: 'SM-GH-SEAT-BUDGET',
    title: 'a seat over its hourly GraphQL budget → one refusal naming the git alternative · writes and other seats still pass',
    devices: [GH_GOV_DEVICE],
    run: (ctx) => withGov(ctx, async (d) => {
      const root = d.tmp();
      const cap = 3 + (ctx.seed % 5);
      const policy = parseGhGovernorPolicy(policyText().replace(/graphql_per_seat_per_hour: \d+/, `graphql_per_seat_per_hour: ${cap}`));
      let spawned = 0;
      const ok = () => { spawned++; return { status: 0, stdout: Buffer.from('{}'), stderr: Buffer.alloc(0) }; };
      const g = (seat: string) => ({ stateRoot: root, now: () => T0 + spawned * 1000, seat, policy });
      const reads = Array.from({ length: cap }, (_, i) => governGhRun(g('HAND-A'), ['pr', 'view', String(i)], ok).status);
      const over = governGhRun(g('HAND-A'), ['pr', 'view', '99'], ok);
      const write = governGhRun(g('HAND-A'), ['pr', 'ready', '99'], ok);
      const other = governGhRun(g('JUD'), ['pr', 'view', '99'], ok);
      const ledger = readFileSync(ledgerPath(root, T0), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { s: string; o: string });
      ctx.recorder.event('smart-merge:gh-budget', { cap, over: over.refused ?? null, spawned });
      if (reads.some(s => s !== 0)) return fail('under-cap', JSON.stringify(reads));
      if (over.status !== 75 || over.refused !== 'budget' || !over.stderr.toString().includes(`GraphQL budget ${cap}/${cap} per hour`) || !over.stderr.toString().includes('git ls-remote')) return fail('refusal', over.stderr.toString());
      if (write.status !== 0 || other.status !== 0) return fail('write-or-other', JSON.stringify([write.status, other.status]));
      const refusals = ledger.filter(r => r.o === 'budget');
      return refusals.length === 1 && refusals[0]!.s === 'HAND-A' && spawned === cap + 2 ? { ok: true } : fail('ledger', JSON.stringify({ refusals, spawned }));
    }),
  },
];
