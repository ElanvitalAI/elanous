// SIM-WORLD smart-merge — SMART-MERGE (CEO 11-27 10:0x · 10:2x) on real temp git repos with synthetic events.
// Each scenario replays one of today's stacks or one edge: a bare origin, a land-side clone (the finisher) and an author
// clone (hands). Seeds pick file names and landing orders; expected values are literals written from the scenario
// (file lists, line texts, results), never re-derived from src/git-smart.
import { planStalePrCards, type CardReceipt } from '../../../steward/stale-pr-reap.js';
import { GitWorld } from '../../../git-smart/fixture.js';
import { deltaSince, prDelta } from '../../../git-smart/delta.js';
import { preflightMergeHistory } from '../../../agent-substrate/review-runner-guard.js';
import { discoverParents, smartRefresh, smartRefreshSync, type SmartRefreshResult } from '../../../git-smart/smart-refresh.js';
import { carriesOwnDiff, patchIdOf, reuseByPatchId } from '../../../cli/land-graph-cli.js';
import { detectStaleBaseRevert, parseDeclaredRemovals } from '../../../land-guard/stale-base-revert.js';
import { reviewRangeDelta } from '../../../agent-substrate/self-review-cli.js';
import type { GitRun } from '../../../git-fs/smart-run.js';
import { finishKindFor, runFinisher, type FinishBook, type FinishDeps } from '../../../land-graph/finisher.js';
import { decide, type PrInfo, type Receipt } from '../../../land-graph/land-graph.js';
import { deliverGateBisectOwnerMail, uniqueAssociatedPullRequest } from '../../../../scripts/release-loop/gate-bisect-owner-mail.js';
import { runGateBisect, type GateBisectPlan } from '../../../../scripts/release-loop/gate-bisect.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SimWorldDeviceDef, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';
import { ghGovernorDevice, ghGovernorScenarios, type GhGovDevice } from './gh-governor-scenes.js';
import { ghProxyDevice, ghProxyScenarios, type GhProxyDevice } from './gh-proxy-scenes.js';

const DEVICE = 'SMART-MERGE-GIT-WORLD';
interface Device { world(files: Record<string, string>): GitWorld; disposeAll(): void }

export const simWorldDevices: readonly SimWorldDeviceDef<Device | GhGovDevice | GhProxyDevice>[] = [{
  id: DEVICE,
  title: 'temp git origin + land clone + author clone · real squash-land / force-push / fault-injected git runner',
  create: () => {
    const all: GitWorld[] = [];
    return { world: (files) => { const w = new GitWorld(files); all.push(w); return w; }, disposeAll: () => { for (const w of all.splice(0)) w.dispose(); } };
  },
}, ghGovernorDevice, ghProxyDevice];

const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const tagOf = (ctx: SimWorldScenarioContext) => `s${ctx.seed}x${Math.floor(ctx.random() * 1000)}`;
function shuffle<T>(xs: T[], r: () => number): T[] { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; }
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b);
const res = (r: SmartRefreshResult) => `${r.result}${'why' in r ? ` (${r.why})` : ''}${'card' in r ? ` ${r.card.split('\n')[0]}` : ''}`;
const refresh = (w: GitWorld, pr: number, head: string, branch: string, extra: Partial<Parameters<typeof smartRefreshSync>[0]> = {}) =>
  smartRefreshSync({ repo: w.land, pr, head, branch, lockDir: w.lockDir, ...extra });
/** A runner that fails `cmd` (first arg) in the land clone — network loss mid-way. */
const failing = (w: GitWorld, cmd: string): ((cwd: string) => GitRun) => (cwd) => {
  const g = w.landRun;
  return cwd === w.land ? (args, o) => (args[0] === cmd ? { status: 128, stdout: '', stderr: `simulated ${cmd} failure: network unreachable` } : g(args, o)) : (args, o) => g(['-C', cwd, ...args], o);
};
const leftoverWorktrees = (w: GitWorld) => w.l(['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree ')).length - 1;

async function withDevice(ctx: SimWorldScenarioContext, body: (d: Device) => Promise<SimWorldScenarioOutcome>): Promise<SimWorldScenarioOutcome> {
  const d = ctx.device<Device>(DEVICE);
  try { return await body(d); } finally { d.disposeAll(); }
}

// ── LAND10-FINISHER-WAIT (대표 11-28 18:1x): receipt key = the PR-own change · no full-required lane ─────────────────────────
const GATE_TIER = join(import.meta.dir, '../../../../graphs/loop-agents/land-steward/gate-tier.yaml');
const greenReceipt = (pr: number, head: string, grade?: string): Receipt =>
  ({ dir: `/r/${pr}-${head.slice(0, 12)}-host`, head, host: 'host-a', focused: ['a.test.ts'], rawDir: '', focusedExit: 0, ...(grade ? { grade } : {}) });
const prOf = (pr: number, head: string, files: string[]): PrInfo => ({ number: pr, head, base: 'main', draft: false, state: 'OPEN', title: 'x', author: 'TC', files, headRef: 'pr' });
/** What the land graph does with this head this tick: decide() on the receipt it would find · the finisher pregates it would launch. */
function landTick(w: GitWorld, pr: PrInfo, receipts: Receipt[]): { action: string; cls?: string; why: string; rechecks: number; via?: string } {
  const r = receipts.find(x => x.head === pr.head) ?? reuseByPatchId(receipts, pr.head, s => patchIdOf(w.land, s), old => carriesOwnDiff(w.land, old, pr.head));
  const dec = decide({ pr, receipt: r, olderReceiptHead: r ? null : receipts[0]?.head ?? null, focused: r ? { pass: 3, fail: 0 } : null, hold: null, security: [], landedBefore: false });
  const fk = finishKindFor(dec.cls, {});
  const deps: FinishDeps = { now: () => new Date(0), launchPregate: () => ({ ok: true }), alive: () => false, hasReceipt: () => null, refresh: () => ({ result: 'busy' }) };
  const out = fk ? runFinisher({ jobs: {} }, [{ pr, kind: fk }], deps, false) : [];
  return { action: dec.action, ...(dec.cls ? { cls: dec.cls } : {}), why: dec.why, rechecks: out.filter(o => o.state === 'would-run').length, ...(r?.reusedVia ? { via: r.reusedVia } : {}) };
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'SM-STALE-PR-REAP',
    title: 'unreceipted stale PR owner card, 24h unanswered OP escalation, normal PR silence',
    devices: [DEVICE],
    run: async (ctx) => {
      const now = 200 * 3600_000;
      const prs = [
        { number: 42, owner: 'HAND', open: true, updatedAt: now - 12 * 3600_000, receipt: false, dirty: true, red: false },
        { number: 43, owner: 'NORMAL', open: true, updatedAt: now - 12 * 3600_000, receipt: true, dirty: false, red: false },
      ];
      const receipts: CardReceipt[] = [];
      const tick = (at: number) => {
        const cards = planStalePrCards(prs, receipts, at, 6 * 3600_000);
        for (const card of cards) receipts.push({ key: card.key, createdAt: at, respondedAt: null });
        return cards;
      };
      const owner = tick(now);
      const repeat = tick(now);
      const early = tick(now + 24 * 3600_000 - 1);
      const op = tick(now + 24 * 3600_000);
      const final = tick(now + 25 * 3600_000);
      const observed = { owner, repeat, early, op, final };
      const expected = {
        owner: [{ key: 'stale-pr:42:owner', to: 'HAND', pr: 42, action: 'commit-push-pregate-or-return' }],
        repeat: [], early: [],
        op: [{ key: 'stale-pr:42:op', to: 'OP', pr: 42, action: 'unanswered-owner' }],
        final: [],
      };
      ctx.recorder.event('smart-merge:stale-pr-reap', { observed, expected });
      return JSON.stringify(observed) === JSON.stringify(expected) ? { ok: true } : fail('stale-pr-cards', JSON.stringify({ observed, expected }));
    },
  },
  {
    id: 'SM-STACK-4DEEP',
    title: 'squash-land then a 4-deep stack (#40352→#40362→#40370→#40372→#40385 shape): each layer rebuilt onto main with only its own file',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const t = tagOf(ctx);
      const files = [0, 1, 2, 3, 4].map(k => `src/${t}-layer${k}.ts`);
      const w = d.world({ 'src/shared.ts': 'a\nb\nc\n' });
      const heads: string[] = [];
      heads.push(w.onBranch('p0', { [files[0]!]: 'layer 0\n', 'src/shared.ts': 'a\nb\nc\nfrom-layer-0\n' }, 'layer 0', 'main'));
      for (let k = 1; k <= 4; k++) heads.push(w.onBranch(`p${k}`, { [files[k]!]: `layer ${k}\n` }, `layer ${k}`, `p${k - 1}`));
      const landed: string[] = [];
      for (let k = 0; k < 4; k++) {
        landed.push(w.remoteHead(`p${k}`));
        w.squashLand(`p${k}`);
        // a follow-up on main right after the land edits next to the landed line — a plain main merge into the child conflicts
        if (k === 0) w.onMain({ 'src/shared.ts': 'a\nb\nc-edited\nfrom-layer-0\n' }, 'follow-up');
        const r = refresh(w, k + 1, w.remoteHead(`p${k + 1}`), `p${k + 1}`, { parentHeads: landed });
        ctx.recorder.event('smart-merge:stack', { layer: k + 1, result: r.result });
        if (r.result !== 'rebuilt') return fail('stack-not-rebuilt', `layer ${k + 1}: ${res(r)}`);
        const changed = w.changed('main', `p${k + 1}`);
        if (!same(changed, [files[k + 1]!])) return fail('stack-delta-wrong', `layer ${k + 1} PR diff ${JSON.stringify(changed)} ≠ ["${files[k + 1]}"]`);
      }
      w.squashLand('p4');
      for (let k = 0; k <= 4; k++) if (w.show('main', files[k]!) !== `layer ${k}`) return fail('stack-content-lost', `${files[k]} on main`);
      if (w.show('main', 'src/shared.ts') !== 'a\nb\nc-edited\nfrom-layer-0') return fail('stack-content-lost', 'src/shared.ts on main');
      return { ok: true };
    }),
  },
  {
    id: 'SM-STACK-MANUAL-MERGE',
    title: 'stack child with a manual «merge main» commit: rebuild drops the merge and the parent commits, keeps the child file',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const t = tagOf(ctx);
      const w = d.world({ 'a.ts': 'one\ntwo\n', 'c.ts': 'c\n' });
      const parent = w.onBranch('parent', { 'a.ts': 'one\ntwo\nparent\n' }, 'parent', 'main');
      w.onBranch('child', { [`${t}.ts`]: 'child\n' }, 'child', 'parent');
      w.onMain({ 'c.ts': 'c2\n' }, 'unrelated main');
      w.mergeMainInto('child'); // the hand's manual merge commit
      w.squashLand('parent');
      w.onMain({ 'a.ts': 'one\ntwo-edited\nparent\n' }, 'follow-up');
      const r = refresh(w, 2, w.remoteHead('child'), 'child', { parentHeads: [parent] });
      ctx.recorder.event('smart-merge:manual-merge', { result: r.result });
      if (r.result !== 'rebuilt') return fail('manual-merge-not-rebuilt', res(r));
      const changed = w.changed('main', 'child');
      return same(changed, [`${t}.ts`]) ? { ok: true } : fail('manual-merge-delta-wrong', JSON.stringify(changed));
    }),
  },
  {
    id: 'SM-MAIN-ONLY-MERGE',
    title: 'a head that only merged main: range-diff empty, receipt reused by patch-id, review delta reused',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
      const h1 = w.onBranch('pr', { 'a.ts': `export const a = ${2 + ctx.seed};\n` }, 'pr', 'main');
      w.onMain({ 'b.ts': 'export const b = 2;\n' });
      const h2 = w.mergeMainInto('pr');
      w.l(['fetch', '-q', 'origin']);
      const ds = deltaSince(w.landRun, h1, h2);
      const p1 = patchIdOf(w.land, h1); const p2 = patchIdOf(w.land, h2);
      const reused = reuseByPatchId([{ dir: `/r/1-${h1.slice(0, 12)}-host`, head: h1, host: 'host-a', focused: ['a.test.ts'], rawDir: '', focusedExit: 0 }], h2, s => patchIdOf(w.land, s));
      const review = reviewRangeDelta(h1, h2, { reviewGitRun: w.landRun });
      ctx.recorder.event('smart-merge:main-only', { same: 'same' in ds && ds.same, reused: !!reused, review: review?.same ?? null });
      if (!('same' in ds) || !ds.same || ds.rangeDiff !== '') return fail('range-diff-not-empty', JSON.stringify(ds).slice(0, 200));
      if (!p1 || p1 !== p2) return fail('patch-id-moved', `${p1} vs ${p2}`);
      if (reused?.reusedFrom !== h1) return fail('receipt-not-reused', JSON.stringify(reused));
      if (!review || !review.same) return fail('review-not-reused', JSON.stringify(review));
      return { ok: true };
    }),
  },
  {
    id: 'SM-HOT-FILE-5PR',
    title: 'five open PRs edit the same hot file (entry.ts) and append to its registry: serialized lands, each re-merged, nothing lost',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const sections = [0, 1, 2, 3, 4].map(k => `// section ${k}\nexport const s${k} = 0;\n// pad\n// pad\n// pad\n`).join('');
      const w = d.world({ 'src/tui/entry.ts': `${sections}// registry\n` });
      const order = shuffle([0, 1, 2, 3, 4], ctx.random);
      const heads = new Map<number, string>();
      for (const k of [0, 1, 2, 3, 4]) {
        const body = [0, 1, 2, 3, 4].map(j => `// section ${j}\nexport const s${j} = ${j === k ? 100 + k : 0};\n// pad\n// pad\n// pad\n`).join('');
        heads.set(k, w.onBranch(`hot${k}`, { 'src/tui/entry.ts': `${body}// registry\nregister('pr${k}');\n` }, `hot ${k}`, 'main'));
      }
      for (let i = 0; i < order.length; i++) {
        const k = order[i]!;
        if (i > 0) {
          const r = refresh(w, k + 1, w.remoteHead(`hot${k}`), `hot${k}`);
          ctx.recorder.event('smart-merge:hot', { pr: k, result: r.result });
          if (r.result !== 'merged') return fail('hot-not-remerged', `hot${k}: ${res(r)}`);
        }
        w.squashLand(`hot${k}`);
      }
      const expected = `${[0, 1, 2, 3, 4].map(j => `// section ${j}\nexport const s${j} = ${100 + j};\n// pad\n// pad\n// pad\n`).join('')}// registry\n${order.map(k => `register('pr${k}');`).join('\n')}`;
      const got = w.show('main', 'src/tui/entry.ts');
      return got === expected ? { ok: true } : fail('hot-file-lost-edit', got.slice(-200));
    }),
  },
  {
    id: 'SM-LIST-APPEND',
    title: 'list / registry append conflicts (multi-line list and one-line id array) are resolved structurally, both sides kept',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const t = tagOf(ctx);
      const w = d.world({ 'src/ids.ts': "export const IDS = ['memory', 'ta'] as const;\n", 'src/list.ts': "export const L = [\n  'x',\n];\n" });
      const h = w.onBranch('pr', { 'src/ids.ts': `export const IDS = ['memory', 'ta', 'pr-${t}'] as const;\n`, 'src/list.ts': `export const L = [\n  'x',\n  'pr-${t}',\n];\n` }, 'pr', 'main');
      w.onMain({ 'src/ids.ts': "export const IDS = ['memory', 'ta', 'fed-org'] as const;\n", 'src/list.ts': "export const L = [\n  'x',\n  'main',\n];\n" });
      const r = refresh(w, 1, h, 'pr');
      ctx.recorder.event('smart-merge:list', { result: r.result, rules: 'resolved' in r ? r.resolved.map(x => x.rule) : [] });
      if (r.result !== 'merged') return fail('list-not-merged', res(r));
      const rules = r.resolved.map(x => `${x.path}:${x.rule}`).sort();
      if (!same(rules, ['src/ids.ts:inline-insert', 'src/list.ts:append-union'])) return fail('list-rules', JSON.stringify(rules));
      if (w.show('pr', 'src/ids.ts') !== `export const IDS = ['memory', 'ta', 'fed-org', 'pr-${t}'] as const;`) return fail('list-content', w.show('pr', 'src/ids.ts'));
      if (w.show('pr', 'src/list.ts') !== `export const L = [\n  'x',\n  'main',\n  'pr-${t}',\n];`) return fail('list-content', w.show('pr', 'src/list.ts'));
      return { ok: true };
    }),
  },
  {
    id: 'SM-SEMANTIC-LLM',
    title: 'a real semantic conflict: the tick defers to the LLM capsule (fake LLM); the tests decide — a resolution that fails them is not pushed',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'src/limit.ts': 'export const LIMIT = 10;\n' });
      const h = w.onBranch('pr', { 'src/limit.ts': 'export const LIMIT = 30;\n' }, 'pr', 'main');
      w.onMain({ 'src/limit.ts': 'export const LIMIT = 20;\n' });
      const tick = refresh(w, 1, h, 'pr');
      if (tick.result !== 'needs-llm' || !same(tick.files, ['src/limit.ts'])) return fail('semantic-not-deferred', res(tick));
      // «tests decide»: the synthetic focused test of this PR requires LIMIT ≥ 30 (its own intent).
      const testPasses = (text: string) => Number(/LIMIT = (\d+)/.exec(text)?.[1] ?? 0) >= 30;
      const wrong = 'export const LIMIT = 20;\n';
      if (testPasses(wrong)) return fail('test-device', 'the fake test accepts the wrong resolution');
      const right = 'export const LIMIT = 30;\n';
      const r = await smartRefresh({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir, push: false, llm: async () => wrong });
      if (r.result !== 'merged') return fail('semantic-llm', res(r));
      const r2 = await smartRefresh({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir, llm: async () => right });
      ctx.recorder.event('smart-merge:semantic', { dry: r.result, live: r2.result });
      if (r2.result !== 'merged') return fail('semantic-llm', res(r2));
      return testPasses(w.show('pr', 'src/limit.ts')) ? { ok: true } : fail('semantic-test-red', w.show('pr', 'src/limit.ts'));
    }),
  },
  {
    id: 'SM-SECURITY4-SAME-LADDER',
    title: 'a conflict in a security-4 path (src/oauth/) goes through the same ladder — structural union, then the LLM step — no card (CEO 10:3x)',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'src/oauth/scopes.ts': "export const SCOPES = [\n  'read',\n];\n", 'src/oauth/ttl.ts': 'export const TTL = 60;\n' });
      const h = w.onBranch('pr', { 'src/oauth/scopes.ts': "export const SCOPES = [\n  'read',\n  'write',\n];\n", 'src/oauth/ttl.ts': 'export const TTL = 90;\n' }, 'pr', 'main');
      w.onMain({ 'src/oauth/scopes.ts': "export const SCOPES = [\n  'read',\n  'admin',\n];\n", 'src/oauth/ttl.ts': 'export const TTL = 120;\n' });
      const tick = refresh(w, 1, h, 'pr');
      if (tick.result !== 'needs-llm' || !same(tick.files, ['src/oauth/ttl.ts'])) return fail('security4-special-cased', res(tick));
      const r = await smartRefresh({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir, llm: async () => 'export const TTL = 120;\n' });
      ctx.recorder.event('smart-merge:security4', { result: r.result });
      if (r.result !== 'merged') return fail('security4-not-resolved', res(r));
      return w.show('pr', 'src/oauth/scopes.ts') === "export const SCOPES = [\n  'read',\n  'admin',\n  'write',\n];" ? { ok: true } : fail('security4-content', w.show('pr', 'src/oauth/scopes.ts'));
    }),
  },
  {
    id: 'SM-REVERT-GUARD',
    title: 'the #40355 shape: a resolution that drops 500 lines of other PRs is refused by the revert guard with evidence; nothing pushed',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'src/big.ts': 'header\nslot\nfooter\n' });
      const h = w.onBranch('pr', { 'src/big.ts': 'header\npr-line\nfooter\n' }, 'pr', 'main');
      const others = Array.from({ length: 500 }, (_, i) => `export const other${i} = ${i};`).join('\n');
      w.onMain({ 'src/big.ts': `header\n${others}\nfooter\n` }, 'other PRs');
      // A resolver that keeps only the PR side (the silent-revert failure mode).
      const r = await smartRefresh({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir, llm: async () => 'header\npr-line\nfooter\n' });
      ctx.recorder.event('smart-merge:revert-guard', { result: r.result });
      if (r.result !== 'guard') return fail('revert-not-guarded', res(r));
      if (!r.card.includes('remove 500 line(s)') || !r.card.includes('src/big.ts')) return fail('revert-evidence', r.card.split('\n').slice(0, 2).join(' | '));
      return w.remoteHead('pr') === h ? { ok: true } : fail('revert-pushed', w.remoteHead('pr'));
    }),
  },
  {
    id: 'SM-FORCE-PUSHED-UPSTREAM',
    title: 'the branch was force-pushed (before the run, and during it): head-moved, nothing pushed over the author',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'a.ts': '1\n' });
      const base = w.a(['rev-parse', 'HEAD']);
      const seen = w.onBranch('pr', { 'a.ts': '2\n' }, 'pr', 'main');
      w.onMain({ 'b.ts': 'b\n' });
      const forced = w.onBranch('pr', { 'a.ts': '3\n' }, 'amended', base); // author force-pushes a rewritten branch
      const before = refresh(w, 1, seen, 'pr');
      if (before.result !== 'head-moved' || w.remoteHead('pr') !== forced) return fail('force-before', res(before));
      // during the run: the author force-pushes between the fetch and the push
      let pushedByAuthor = '';
      const during = refresh(w, 1, forced, 'pr', { gitFor: (cwd) => { const g = w.landRun; return cwd === w.land ? (args, o) => {
        if (args[0] === 'ls-remote' && !pushedByAuthor) pushedByAuthor = w.onBranch('pr', { 'a.ts': '4\n' }, 'amended again', base);
        return g(args, o);
      } : (args, o) => g(['-C', cwd, ...args], o); } });
      ctx.recorder.event('smart-merge:force', { before: before.result, during: during.result });
      if (during.result !== 'head-moved') return fail('force-during', res(during));
      return w.remoteHead('pr') === pushedByAuthor ? { ok: true } : fail('force-overwritten', w.remoteHead('pr'));
    }),
  },
  {
    id: 'SM-PR-CLOSED-MID',
    title: 'the PR is closed while the smart-merge runs: closed, nothing pushed, no worktree left',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'a.ts': '1\n' });
      const h = w.onBranch('pr', { 'a.ts': '2\n' }, 'pr', 'main');
      w.onMain({ 'b.ts': 'b\n' });
      const r = refresh(w, 1, h, 'pr', { stillOpen: () => false });
      ctx.recorder.event('smart-merge:closed', { result: r.result });
      if (r.result !== 'closed') return fail('closed-not-seen', res(r));
      if (w.remoteHead('pr') !== h) return fail('closed-pushed', w.remoteHead('pr'));
      return leftoverWorktrees(w) === 0 ? { ok: true } : fail('worktree-left', String(leftoverWorktrees(w)));
    }),
  },
  {
    id: 'SM-FETCH-FAIL-MID',
    title: 'network failure at the fetch and right before the push: error, no partial push, no worktree left',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'a.ts': '1\n' });
      const h = w.onBranch('pr', { 'a.ts': '2\n' }, 'pr', 'main');
      w.onMain({ 'b.ts': 'b\n' });
      const atFetch = refresh(w, 1, h, 'pr', { gitFor: failing(w, 'fetch') });
      const atPush = refresh(w, 1, h, 'pr', { gitFor: failing(w, ctx.seed % 2 ? 'ls-remote' : 'push') });
      ctx.recorder.event('smart-merge:network', { atFetch: atFetch.result, atPush: atPush.result });
      if (atFetch.result !== 'error' || atPush.result !== 'error') return fail('network-not-error', `${res(atFetch)} · ${res(atPush)}`);
      if (w.remoteHead('pr') !== h) return fail('network-partial-push', w.remoteHead('pr'));
      return leftoverWorktrees(w) === 0 ? { ok: true } : fail('worktree-left', String(leftoverWorktrees(w)));
    }),
  },
  {
    id: 'SM-RACE-LOCK',
    title: 'two finishers race on one PR: the second is busy while the first holds the lock; exactly one push',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'src/t.ts': 'export const t = 1;\n' });
      const h = w.onBranch('pr', { 'src/t.ts': 'export const t = 2;\n' }, 'pr', 'main');
      w.onMain({ 'src/t.ts': 'export const t = 3;\n' });
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const first = smartRefresh({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir, llm: async () => { await gate; return 'export const t = 4;\n'; } });
      // smartRefresh takes the lock synchronously and runs up to its LLM step: the first is parked there holding it.
      const second = refresh(w, 1, h, 'pr');
      release();
      const r1 = await first;
      ctx.recorder.event('smart-merge:race', { first: r1.result, second: second.result });
      if (second.result !== 'busy') return fail('race-no-lock', res(second));
      if (r1.result !== 'merged') return fail('race-first', res(r1));
      return w.show('pr', 'src/t.ts') === 'export const t = 4;' ? { ok: true } : fail('race-content', w.show('pr', 'src/t.ts'));
    }),
  },
  {
    id: 'SM-REFUSED-BEFORE-INSTALL',
    title: 'a PR refused for merge-conflict before the smart-merge install (green pregate + old plain-merge conflict row on its head) is refreshed on the next tick',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'src/reg.ts': "export const R = [\n  'a',\n];\n" });
      const h = w.onBranch('pr', { 'src/reg.ts': "export const R = [\n  'a',\n  'pr',\n];\n" }, 'pr', 'main');
      w.onMain({ 'src/reg.ts': "export const R = [\n  'a',\n  'main',\n];\n" });
      const pr: PrInfo = { number: 40428, head: h, base: 'main', draft: false, state: 'OPEN', title: 'x', author: 'TC', files: ['src/reg.ts'], headRef: 'pr' };
      // the book as it was on 11-27 15:3x: pregate pass on the head (shadowed the refresh key) + a pre-smart conflict row
      const book: FinishBook = { jobs: { [`40428@${h}`]: { pr: 40428, head: h, kind: ctx.seed % 2 ? 'pregate' : 'refresh', state: ctx.seed % 2 ? 'pass' : 'conflict', at: '2026-11-27T05:08:57Z' } } };
      const out = runFinisher(book, [{ pr, kind: 'refresh' }], {
        now: () => new Date('2026-11-27T06:40:00Z'), launchPregate: () => ({ ok: false }), alive: () => false, hasReceipt: () => null,
        refresh: (p) => { const r = refresh(w, p.number, p.head, p.headRef!); return 'newHead' in r ? { result: r.result as 'merged', newHead: r.newHead } : { result: r.result as 'conflict' }; },
      }, true);
      ctx.recorder.event('smart-merge:refused-before-install', { states: out.map(o => o.state) });
      if (!same(out.map(o => o.state), ['refreshed'])) return fail('refresh-shadowed', JSON.stringify(out));
      return w.show('pr', 'src/reg.ts') === "export const R = [\n  'a',\n  'main',\n  'pr',\n];" ? { ok: true } : fail('refresh-content', w.show('pr', 'src/reg.ts'));
    }),
  },
  {
    id: 'SM-STACK-AUTO-DISCOVER',
    title: 'no parent heads given: the squash-landed parents are discovered from the branch commits (#40382 on #40369 · #40447 on #40441→#40444) and the child is rebuilt',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'src/a.ts': 'a1\na2\n', 'src/b.ts': 'b1\nb2\n', 'src/c.ts': 'c1\nc2\n' });
      // #40441 → #40444 stacked, the child (#40447) on #40444; both parents squash-land, main then edits 3 parent files
      const p1 = w.onBranch('p1', { 'src/a.ts': 'a1\na2\np1\n', 'src/b.ts': 'b1\nb2\np1\n' }, 'p1', 'main');
      const p2 = w.onBranch('p2', { 'src/c.ts': 'c1\nc2\np2\n' }, 'p2', 'p1');
      const child = w.onBranch('child', { 'src/child.ts': `child ${ctx.seed}\n` }, 'child', 'p2');
      const owner = new Map<string, string>();
      for (const c of w.a(['rev-list', p1, '^main']).split('\n').filter(Boolean)) owner.set(c, p1);
      for (const c of w.a(['rev-list', p2, `^${p1}`]).split('\n').filter(Boolean)) owner.set(c, p2);
      w.squashLand('p1'); w.squashLand('p2');
      w.onMain({ 'src/a.ts': 'a1\na2-main\np1\n', 'src/b.ts': 'b1\nb2-main\np1\n', 'src/c.ts': 'c1\nc2-main\np2\n' }, 'main edits after the squash');
      w.l(['fetch', '-q', 'origin']);
      let lookups = 0;
      const parents = discoverParents(w.landRun, child, 'origin/main', (c) => { lookups++; return owner.get(c) ?? null; });
      ctx.recorder.event('smart-merge:discover', { parents: parents.length, lookups });
      if (!same([...parents].sort(), [p1, p2].sort()) && !same(parents, [p2])) return fail('discover-missed', JSON.stringify(parents));
      const r = refresh(w, 3, child, 'child', { parentHeads: parents });
      if (r.result !== 'rebuilt') return fail('discover-not-rebuilt', res(r));
      const changed = w.changed('main', 'child');
      return same(changed, ['src/child.ts']) ? { ok: true } : fail('discover-delta-wrong', JSON.stringify(changed));
    }),
  },
  {
    id: 'SM-DECLARED-SUPERSEDE',
    title: 'a kit PR deletes a file another PR added on purpose (#40471 / #40401): refused until the body declares «의도된 삭제», then passes; an undeclared wipe still refuses',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const lines = Array.from({ length: 12 }, (_, i) => `"k${i}": ${i},`).join('\n');
      const w = d.world({ 'src/kit/a.ts': 'export {};\n', 'src/other.ts': 'o\n' });
      w.onBranch('kit', { 'src/kit/a.ts': 'export const kit = 1;\n' }, 'kit start', 'main');
      w.onMain({ 'src/router/route-policy.default.json': `{\n${lines}\n"end": 0\n}\n` }, 'feat: route policy (#40401)');
      w.mergeMainInto('kit');
      // the kit keeps the file but replaces its content (lines missing without an own deletion — what the guard refuses)
      w.write({ 'src/router/route-policy.default.json': '{ "kit": true }\n' });
      const head = w.commit('refactor(kit): supersede route policy (#40471)'); w.a(['push', '-q', 'origin', 'kit']);
      w.l(['fetch', '-q', 'origin']);
      const before = detectStaleBaseRevert(w.land, 'origin/main', head);
      const body = `칸: KIT\n의도된 삭제: ${ctx.seed % 2 ? 'src/router/route-policy.default.json' : '#40401'} (kit 통합으로 대체)\n`;
      const after = detectStaleBaseRevert(w.land, 'origin/main', head, { declared: parseDeclaredRemovals(body) });
      // an explicit own-commit deletion (#40444 removing tests #40373 added) needs no line
      w.a(['rm', '-q', 'src/router/route-policy.default.json']);
      const del = w.commit('chore(kit): remove the superseded policy file'); w.a(['push', '-q', 'origin', 'kit']);
      w.l(['fetch', '-q', 'origin']);
      const deleted = detectStaleBaseRevert(w.land, 'origin/main', del);
      ctx.recorder.event('smart-merge:declared', { before: before.ok, after: after.ok, deleted: deleted.ok });
      if (before.ok || !before.card?.includes('의도된 삭제: ')) return fail('supersede-not-refused', before.card ?? 'ok');
      if (!after.ok) return fail('declared-still-refused', after.card ?? '');
      return deleted.ok ? { ok: true } : fail('own-deletion-refused', deleted.card ?? '');
    }),
  },
  {
    id: 'SM-OWN-REWRITE-DECLARATION',
    title: 'own rewrite is refused with a filled declaration candidate',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const lines = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n');
      const w = d.world({ 'src/own.ts': 'base\n' });
      w.onMain({ 'src/own.ts': `base\n${lines}\n` }, 'feat: prior (#9001)');
      const head = w.onBranch('rewrite', { 'src/own.ts': 'base\nreplacement\n' }, 'refactor: rewrite', 'main');
      w.l(['fetch', '-q', 'origin']);
      const result = detectStaleBaseRevert(w.land, 'origin/main', head);
      ctx.recorder.event('smart-merge:own-rewrite', { ok: result.ok, hits: result.hits });
      return !result.ok && result.card?.includes('의도된 삭제: src/own.ts (PR 수정으로 기존 줄 대체; 의도 확인 후 사용)')
        ? { ok: true } : fail('own-rewrite-card', JSON.stringify(result));
    }),
  },
  {
    id: 'SM-RESTRUCTURE-PLUS-INSERT',
    title: 'ours restructured a function, theirs inserted 2 lines into the old body (#40447 tickAgent → TICK_STEPS): the LLM capsule gets both sides; the focused test decides',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const old = 'export function tickAgent(a) {\n  load(a);\n  run(a);\n  save(a);\n}\n';
      const w = d.world({ 'src/runtime.ts': old });
      const h = w.onBranch('pr', { 'src/runtime.ts': 'export const TICK_STEPS = [load, run, save];\nexport function tickAgent(a) {\n  for (const s of TICK_STEPS) s(a);\n}\n' }, 'refactor: TICK_STEPS', 'main');
      w.onMain({ 'src/runtime.ts': 'export function tickAgent(a) {\n  load(a);\n  if (a.parked) return;\n  pruneOlderThan(a, 7);\n  run(a);\n  save(a);\n}\n' }, 'fix: parked filter + 7-day pruning');
      const tick = refresh(w, 1, h, 'pr');
      if (tick.result !== 'needs-llm' || !same(tick.files, ['src/runtime.ts'])) return fail('restructure-not-deferred', res(tick));
      // the synthetic focused test: TICK_STEPS kept, and the parked filter + pruning still run before `run`
      const focused = (t: string) => t.includes('TICK_STEPS') && /parked/.test(t) && /pruneOlderThan\(a, 7\)/.test(t);
      let sawBoth = false;
      const resolved = 'export const TICK_STEPS = [load, (a) => { if (a.parked) return false; pruneOlderThan(a, 7); }, run, save];\nexport function tickAgent(a) {\n  for (const s of TICK_STEPS) if (s(a) === false) return;\n}\n';
      const good = await smartRefresh({ repo: w.land, pr: 1, head: h, branch: 'pr', lockDir: w.lockDir, push: false,
        llm: async (_p, text) => { sawBoth = text.includes('TICK_STEPS') && text.includes('a.parked') && text.includes('pruneOlderThan'); return resolved; } });
      // a resolver that keeps only the restructure drops theirs' two lines: under the guard's 3-line floor → the focused test catches it
      const dropped = 'export const TICK_STEPS = [load, run, save];\nexport function tickAgent(a) {\n  for (const s of TICK_STEPS) s(a);\n}\n';
      ctx.recorder.event('smart-merge:restructure', { tick: tick.result, good: good.result, sawBoth });
      if (!sawBoth) return fail('llm-missing-a-side', 'the capsule prompt did not carry both sides');
      if (good.result !== 'merged' || !focused(resolved)) return fail('restructure-good', res(good));
      return focused(dropped) ? fail('focused-test-blind', 'the dropped resolution passed the focused test') : { ok: true };
    }),
  },
  {
    id: 'SM-REVIEW-OWN-DELTA',
    title: 'a smart-merge rebuilt branch (merge commit + Smart-Merge trailer) is reviewed on its own delta, never refused as «needs-clean-branch»',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'a.ts': 'one\ntwo\n' });
      const parent = w.onBranch('parent', { 'a.ts': 'one\ntwo\nparent\n' }, 'parent', 'main');
      const child = w.onBranch('child', { [`own-${ctx.seed}.ts`]: 'own\n' }, 'child', 'parent');
      w.squashLand('parent');
      w.onMain({ 'a.ts': 'one\ntwo-edited\nparent\n' }, 'follow-up');
      const r = refresh(w, 2, child, 'child', { parentHeads: [parent] });
      if (r.result !== 'rebuilt') return fail('review-rebuild', res(r));
      w.l(['fetch', '-q', 'origin']);
      const head = w.l(['rev-parse', 'origin/child']); const main = w.l(['rev-parse', 'origin/main']);
      const trailer = w.l(['show', '-s', '--format=%B', head]);
      const pre = preflightMergeHistory({ pr: '2', head, baseTip: main, git: (args) => w.landRun(args) });
      const own = prDelta(w.landRun, head);
      const status = 'status' in pre ? pre.status : 'refused';
      ctx.recorder.event('smart-merge:review', { status, smart: 'smartMerges' in pre ? pre.smartMerges?.length ?? 0 : 0 });
      if (!/^Smart-Merge: rebuild/m.test(trailer)) return fail('review-no-trailer', trailer);
      if (status !== 'clean') return fail('review-refused', JSON.stringify(pre));
      return 'error' in own || !same(own.files, [`own-${ctx.seed}.ts`]) ? fail('review-own-delta', JSON.stringify('error' in own ? own : own.files)) : { ok: true };
    }),
  },
  {
    id: 'SM-CARRY-CONTEXT-MOVED',
    title: 'smart-merge merged main that edited a context line next to the PR hunk: patch-id moved, PR-own change the same → receipt carried · 0 rechecks · lands',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'a.ts': 'l1\nl2\nl3\nl4\nl5\n', 'b.ts': 'b\n' });
      const h1 = w.onBranch('pr', { 'a.ts': `l1\nl2\nl3-pr-${ctx.seed}\nl4\nl5\n` }, 'pr', 'main');
      w.onMain({ 'a.ts': 'l1-main\nl2\nl3\nl4\nl5\n' }, 'main edits a context line');
      const r = refresh(w, 7, h1, 'pr');
      if (r.result !== 'merged') return fail('carry-not-merged', res(r));
      w.l(['fetch', '-q', 'origin']);
      const h2 = w.l(['rev-parse', 'origin/pr']);
      const moved = patchIdOf(w.land, h1) !== patchIdOf(w.land, h2);
      const t = landTick(w, prOf(7, h2, ['a.ts']), [greenReceipt(7, h1)]);
      ctx.recorder.event('smart-merge:carry-context', { patchIdMoved: moved, ...t });
      if (!moved) return fail('carry-patch-id-did-not-move', 'the scene needs main to touch the hunk context');
      if (t.via !== 'own-diff' || t.action !== 'land' || t.rechecks !== 0) return fail('carry-refused', JSON.stringify(t));
      return t.why.includes(`receipt reused via own-diff from ${h1.slice(0, 12)}`) ? { ok: true } : fail('carry-why', t.why);
    }),
  },
  {
    id: 'SM-CARRY-OWN-CHANGED',
    title: 'the PR-own change moved after the receipt (own commit · or a merge resolved against main: -X ours) → no carry · 1 recheck each',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'a.ts': 'a\n', 'c.ts': 'c\n' });
      const h1 = w.onBranch('pr', { 'a.ts': `a-${ctx.seed}\n` }, 'pr', 'main');
      const own = w.onBranch('pr', { 'a.ts': `a-${ctx.seed}-again\n` }, 'author edit');
      const t1 = landTick(w, prOf(8, own, ['a.ts']), [greenReceipt(8, h1)]);
      // hidden resolution: main and the PR both edit c.ts → the author merges with -X ours (the own diff now reverts main)
      const w2 = d.world({ 'a.ts': 'a\n', 'c.ts': 'c\n' });
      const g1 = w2.onBranch('pr', { 'a.ts': `a-${ctx.seed}\n`, 'c.ts': 'c-pr\n' }, 'pr', 'main');
      w2.onMain({ 'c.ts': 'c-main\n' }, 'main edits c');
      w2.a(['fetch', '-q', 'origin']); w2.checkout('pr');
      w2.a(['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-edit', '-X', 'ours', 'origin/main']); w2.a(['push', '-q', 'origin', 'pr']);
      w2.l(['fetch', '-q', 'origin']);
      const g2 = w2.l(['rev-parse', 'origin/pr']);
      const t2 = landTick(w2, prOf(9, g2, ['a.ts', 'c.ts']), [greenReceipt(9, g1)]);
      ctx.recorder.event('smart-merge:carry-own-changed', { own: t1, resolved: t2 });
      for (const [k, t] of [['own-commit', t1], ['resolved-merge', t2]] as const) {
        if (t.via || t.action === 'land' || t.cls !== 'stale-head' || t.rechecks !== 1) return fail(`carry-wrongly-${k}`, JSON.stringify(t));
      }
      return { ok: true };
    }),
  },
  {
    id: 'SM-L3-LIGHT-LAND',
    title: 'no full-required lane: gate-tier.yaml puts L3 at the rehearsal · an old L3 receipt and a rehearsal-tier L2 receipt both land on the light receipt',
    devices: [DEVICE],
    run: async (ctx) => {
      const policy = parseYaml(readFileSync(GATE_TIER, 'utf8')) as { tiers?: Record<string, string> };
      const tiers = policy.tiers ?? {};
      const head = (ctx.seed.toString(16).padStart(2, '0')).repeat(20);
      const pr = prOf(10, head, ['src/x.ts']);
      const outs = (['L3', 'L2'] as const).map(g => decide({ pr, receipt: greenReceipt(10, head, g), olderReceiptHead: null, focused: { pass: 2, fail: 0 }, hold: null, security: [], landedBefore: false }));
      ctx.recorder.event('smart-merge:l3-light', { tiers, actions: outs.map(o => o.action) });
      if (tiers.L3 !== 'rehearsal' || ['L0', 'L1', 'L1d', 'L2'].some(g => tiers[g] !== 'land')) return fail('gate-tier-policy', JSON.stringify(tiers));
      return outs.every(o => o.action === 'land') ? { ok: true } : fail('l3-not-landed', JSON.stringify(outs));
    },
  },
  {
    id: 'SM-REHEARSAL-REGRESSION-CELL',
    title: 'two PRs land on light receipts · the rehearsal full gate fails · gate bisect names the culprit commit → its PR → one owner cell (the post-regression path)',
    devices: [DEVICE],
    run: (ctx) => withDevice(ctx, async (d) => {
      const w = d.world({ 'src/contract.ts': 'export const C = 1;\n', 'src/other.ts': 'o\n' });
      w.l(['fetch', '-q', 'origin']);
      const base = w.l(['rev-parse', 'origin/main']);
      const [good, bad] = ctx.seed % 2 ? [101, 102] : [102, 101];
      w.onBranch('p1', { 'src/other.ts': `o-${ctx.seed}\n` }, 'p1', 'main');
      const c1 = w.squashLand('p1', `light lane one (#${good})`);
      w.onBranch('p2', { 'src/contract.ts': 'export const C = BROKEN;\n' }, 'p2', 'main');
      const c2 = w.squashLand('p2', `light lane two (#${bad})`);
      w.l(['fetch', '-q', 'origin']);
      const file = 'test/contract.test.ts';
      const plan: GateBisectPlan = { kind: 'bisect', version: '0.3.39', baseCommit: base, cutCommit: c2, commits: [c1, c2], files: [file], introducedIds: [`${file} > contract`], host: 'sim-host' };
      const found = await runGateBisect(plan, async (_f, commit) => (w.show(commit, 'src/contract.ts').includes('BROKEN') ? 'fail' : 'pass'));
      const hit = found.findings[0];
      const subject = hit ? w.l(['log', '-1', '--format=%s', hit.firstFailingCommit]) : '';
      const pr = uniqueAssociatedPullRequest([...subject.matchAll(/\(#(\d+)\)/g)].map(m => Number(m[1])));
      const posts: string[] = [];
      const cells = await deliverGateBisectOwnerMail(hit ? [{ file, firstFailingCommit: hit.firstFailingCommit, pullRequest: pr, owner: 'author', ownerSeat: 'TC', evidence: 'rehearsal full gate' }] : [],
        { post: async (_seat, body) => { posts.push(body); return { id: `cell-${posts.length}` }; } });
      ctx.recorder.event('smart-merge:rehearsal-regression', { culprit: pr, cells: cells.map(c => c.status) });
      if (hit?.firstFailingCommit !== c2 || pr !== bad) return fail('bisect-culprit', JSON.stringify({ found, pr }));
      return cells.length === 1 && cells[0]!.status === 'delivered' && posts[0]!.includes(`#${bad}`) ? { ok: true } : fail('regression-cell', JSON.stringify(cells));
    }),
  },
  // GH-BUDGET-GOVERNOR (0.3.39 P0): the one gh door — shared open-PR snapshot · global cooldown · per-seat budget.
  ...ghGovernorScenarios,
  ...ghProxyScenarios,
];
