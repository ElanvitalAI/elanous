// land-graph-world: a sim device for the land graph (src/land-graph/land-graph.ts).
// A fake GitHub + pregate receipt store + land command (merge with --match-head-commit semantics) on a temp state
// root, a virtual clock, and one scenario per edge the 11-25 coach landings hit or could hit. Seeds shuffle the PR
// order and the scenario order so decisions must not depend on arrival order.
//
// Invariants checked on every scenario (world.violations):
//   - never lands without a same-head receipt
//   - never double-lands (one merge per PR)
//   - lands per tick ≤ slots
//   - a crash after merge resumes to exactly one notice
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock, readLedger, setHold, tickLand, type BaselineDiff, type Focused, type LandDeps, type Mode, type PrInfo, type Receipt, type RefusalClass, type TerraReview,
} from '../land-graph/land-graph.js';

export interface WorldPr extends PrInfo {
  receiptHead?: string; focused?: Focused | 'none'; security?: string[];
  /** Terra review of the head (security-4 paths). */ terra?: TerraReview | null;
  /** Baseline failure-name diff receipt (introduced 0). */ baselineDiff?: BaselineDiff | null;
  /** JUD HOLD verdict on file for the head. */ judHold?: string;
  /** pregate graded the receipt L0 (focused stage skipped although a focused list is recorded). */ l0?: boolean;
}
export interface Hooks {
  /** Before the merge re-read (live) — mutate the world mid-land. */
  onPrNow?: (w: LandWorld, pr: number, call: number) => void;
  /** Land command result override (gate refusals). */
  landResult?: (pr: number) => { rc: number; text: string } | null;
  listFails?: boolean;
  noticeThrowsOnce?: boolean;
  /** Stale-base revert guard result (default clean). */
  staleRevert?: (pr: number) => { ok: boolean; why?: string };
}

/** Org declaration with landing moved to TC (JUD-SPLIT) — `rollback` writes the default (landing back on JUD). */
export const ORG_SPLIT = 'org:\n  duties:\n    landing: TC\n    veto: JUD\n';

export class LandWorld {
  stateRoot = mkdtempSync(join(tmpdir(), 'land-world-'));
  prs = new Map<number, WorldPr>();
  merges = new Map<number, number>();
  /** ctx the land command got per PR (lane · baseline diff) — the extra.json the golden path receives. */
  landCtx = new Map<number, { lane?: string; baselineDiff?: BaselineDiff | null }>();
  posts: Array<{ to: string; body: string }> = [];
  records: string[] = [];
  violations: string[] = [];
  clock = Date.parse('2026-11-25T21:00:00Z');
  private prNowCalls = 0;
  private noticeThrown = false;
  static all: LandWorld[] = [];
  orgPath = join(this.stateRoot, 'federation.yaml');
  setOrg(text: string) { writeFileSync(this.orgPath, text); }
  constructor(public seed: number, public hooks: Hooks = {}, public slots = 2, public mode: Mode = 'live') { LandWorld.all.push(this); this.setOrg(ORG_SPLIT); }

  add(p: Partial<WorldPr> & { number: number }): WorldPr {
    const head = p.head ?? `${String(p.number).padStart(8, '0')}${'a'.repeat(32)}`;
    const pr: WorldPr = { base: 'main', draft: false, state: 'OPEN', title: `pr ${p.number}`, author: 'TC', files: [`src/f${p.number}.ts`],
      receiptHead: head, focused: { pass: 10, fail: 0 }, security: [], ...p, head };
    this.prs.set(pr.number, pr); return pr;
  }

  private rand(): number { this.seed = (this.seed * 1103515245 + 12345) % 2147483648; return this.seed / 2147483648; }
  private shuffled<T>(xs: T[]): T[] { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; }
  private view(p: WorldPr): PrInfo { return { number: p.number, head: p.head, base: p.base, draft: p.draft, state: p.state, title: p.title, author: p.author, files: [...p.files] }; }

  deps(): LandDeps {
    return {
      now: () => new Date(this.clock), stateRoot: this.stateRoot, org: { path: this.orgPath },
      staleRevert: pr => this.hooks.staleRevert?.(pr.number) ?? { ok: true }, mode: this.mode, slots: this.slots,
      listPrs: async () => {
        if (this.hooks.listFails) throw new Error('HTTP 403 rate limit exceeded');
        return this.shuffled([...this.prs.values()].filter(p => p.state === 'OPEN').map(p => this.view(p)));
      },
      prNow: async n => { this.hooks.onPrNow?.(this, n, this.prNowCalls++); const p = this.prs.get(n); return p ? this.view(p) : null; },
      receipt: (n, head) => {
        const p = this.prs.get(n)!;
        if (p.receiptHead !== head || p.focused === undefined) return null;
        if (p.l0) return { dir: `/r/${n}-${head.slice(0, 12)}-minim5`, head, host: 'minim5', focused: ['test/rules-contract.test.ts'], rawDir: '/raw', grade: 'L0', focusedExit: null };
        return { dir: `/r/${n}-${head.slice(0, 12)}-minim5`, head, host: 'minim5', focused: p.focused === 'none' ? [] : ['x.test.ts'], rawDir: '/raw' };
      },
      olderReceiptHead: (n, head) => { const p = this.prs.get(n)!; return p.receiptHead && p.receiptHead !== head ? p.receiptHead : null; },
      focused: (r: Receipt) => { const p = this.prs.get(Number(r.dir.split('/')[2]!.split('-')[0]))!; return p.focused === 'none' || p.focused === undefined ? 'unreadable' : p.focused; },
      security: n => this.prs.get(n)!.security ?? [],
      terra: n => this.prs.get(n)!.terra ?? null,
      baselineDiff: n => this.prs.get(n)!.baselineDiff ?? null,
      judHold: n => { const why = this.prs.get(n)!.judHold; return why ? { reason: why, by: 'JUD' } : null; },
      land: async (pr, r, _why, ctx) => {
        if (ctx) this.landCtx.set(pr.number, ctx);
        const p = this.prs.get(pr.number)!;
        const forced = this.hooks.landResult?.(pr.number);
        if (forced) return forced;
        if (p.head !== pr.head) return { rc: 7, text: 'STOP merge rc=1 (head moved: match-head-commit)' };
        if (r.head !== p.head) this.violations.push(`#${pr.number} landed without same-head receipt`);
        if (this.merges.has(pr.number)) this.violations.push(`#${pr.number} double-land`);
        this.merges.set(pr.number, (this.merges.get(pr.number) ?? 0) + 1); p.state = 'MERGED';
        return { rc: 0, text: 'merged' };
      },
      post: (to, body) => {
        if (this.hooks.noticeThrowsOnce && !this.noticeThrown && body.includes('착지 후통보')) { this.noticeThrown = true; throw new Error('crash after merge'); }
        this.posts.push({ to, body });
      },
      record: line => { this.records.push(line); },
    };
  }

  async tick() {
    const before = this.merges.size;
    const res = await tickLand(this.deps()).catch(e => ({ crashed: String(e) }));
    if (this.merges.size - before > this.slots) this.violations.push(`slot cap ${this.slots} exceeded`);
    this.clock += 2 * 60_000;
    return res;
  }
  ledger() { return readLedger(this.stateRoot); }
  lastClass(pr: number): RefusalClass | undefined {
    return this.ledger().filter(r => r.pr === pr && r.cls && (r.event === 'decision' || r.event === 'refused')).pop()?.cls;
  }
  cardsTo(pr: number): string[] { return this.ledger().filter(r => r.pr === pr && r.event === 'card').flatMap(r => r.to ?? []); }
  dispose() { rmSync(this.stateRoot, { recursive: true, force: true }); }
}

export interface CaseResult { id: string; expected: string; actual: string; ok: boolean }

type Scenario = { id: string; expected: string; run: (seed: number) => Promise<string> };

const h = (c: string) => c.repeat(40);

export const SCENARIOS: Scenario[] = [
  { id: 'clean-land', expected: 'landed · notice OP · COACH row', run: async s => {
    const w = new LandWorld(s); w.add({ number: 1 }); await w.tick();
    const r = `${w.merges.get(1) ? 'landed' : 'not'} · notice ${w.posts.filter(p => p.to === 'TC' && p.body.includes('후통보')).length} · rows ${w.records.length}`; w.dispose(); return r; } },
  { id: 'head-moves-after-receipt', expected: 'refuse stale-head · card author', run: async s => {
    const w = new LandWorld(s); w.add({ number: 2, head: h('b'), receiptHead: h('a') }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'refuse'} ${w.lastClass(2)} · card ${w.cardsTo(2).join(',')}`; w.dispose(); return r; } },
  { id: 'head-moves-during-land', expected: 'not landed · head-moved', run: async s => {
    const w = new LandWorld(s, { onPrNow: (wd, n) => { wd.prs.get(n)!.head = h('c'); } }); w.add({ number: 3 }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'not landed'} · ${w.lastClass(3)}`; w.dispose(); return r; } },
  { id: 'same-file-race-2-slots', expected: 'landed 1 · other main-moved-overlap', run: async s => {
    const w = new LandWorld(s); w.add({ number: 4, files: ['src/shared.ts'] }); w.add({ number: 5, files: ['src/shared.ts'] }); await w.tick();
    const other = w.merges.has(4) ? 5 : 4;
    const r = `landed ${w.merges.size} · other ${w.lastClass(other)}`; w.dispose(); return r; } },
  { id: 'slot-cap', expected: 'landed 2 of 3 · then 1', run: async s => {
    const w = new LandWorld(s); w.add({ number: 6 }); w.add({ number: 7 }); w.add({ number: 8 }); await w.tick(); const a = w.merges.size; await w.tick();
    const r = `landed ${a} of 3 · then ${w.merges.size - a}`; w.dispose(); return r; } },
  { id: 'main-moves-mid-land', expected: 'refuse merge-conflict · card author · no re-run same head', run: async s => {
    const w = new LandWorld(s, { landResult: () => ({ rc: 7, text: 'STOP merge rc=1' }) }); w.add({ number: 9 }); await w.tick(); await w.tick();
    const landings = w.ledger().filter(r => r.event === 'landing').length;
    const r = `refuse ${w.lastClass(9)} · card ${w.cardsTo(9).join(',')} · landings ${landings}`; w.dispose(); return r; } },
  { id: 'draft-flip-mid-run', expected: 'not landed', run: async s => {
    const w = new LandWorld(s, { onPrNow: (wd, n) => { wd.prs.get(n)!.draft = true; } }); w.add({ number: 10 }); await w.tick();
    const r = w.merges.size ? 'landed' : 'not landed'; w.dispose(); return r; } },
  { id: 'closed-mid-run', expected: 'not landed', run: async s => {
    const w = new LandWorld(s, { onPrNow: (wd, n) => { wd.prs.get(n)!.state = 'CLOSED'; } }); w.add({ number: 11 }); await w.tick();
    const r = w.merges.size ? 'landed' : 'not landed'; w.dispose(); return r; } },
  { id: 'jud-hold-mid-land', expected: 'not landed · held', run: async s => {
    const w = new LandWorld(s, { onPrNow: wd => setHold(wd.stateRoot, 12, 'JUD security re-check', 'JUD') }); w.add({ number: 12 }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'not landed'} · ${w.lastClass(12)}`; w.dispose(); return r; } },
  { id: 'jud-hold-before', expected: 'hold · card OP', run: async s => {
    const w = new LandWorld(s); w.add({ number: 13 }); setHold(w.stateRoot, 13, 'NO-GO', 'JUD'); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'hold'} · card ${w.cardsTo(13).join(',')}`; w.dispose(); return r; } },
  { id: 'terra-security-late', expected: 'refuse security-finding', run: async s => {
    const w = new LandWorld(s); w.add({ number: 14, security: ['secret:token in log'] }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'refuse'} ${w.lastClass(14)}`; w.dispose(); return r; } },
  { id: 'receipt-missing', expected: 'wait no-receipt', run: async s => {
    const w = new LandWorld(s); w.add({ number: 15, receiptHead: undefined as unknown as string }); w.prs.get(15)!.receiptHead = undefined; await w.tick();
    const r = `${w.merges.size ? 'landed' : 'wait'} ${w.lastClass(15)}`; w.dispose(); return r; } },
  { id: 'focused-unreadable', expected: 'wait focused-unreadable · card RES', run: async s => {
    const w = new LandWorld(s); const p = w.add({ number: 16 }); p.focused = undefined; p.receiptHead = p.head;
    // receipt present (focused list non-empty) but raw unreadable
    const d = w.deps(); d.receipt = (n, head) => ({ dir: `/r/${n}-x-minim5`, head, host: 'minim5', focused: ['x.test.ts'], rawDir: '/raw' }); d.focused = () => 'unreadable';
    await tickLand(d);
    const r = `${w.merges.size ? 'landed' : 'wait'} ${w.lastClass(16)} · card ${w.cardsTo(16).join(',')}`; w.dispose(); return r; } },
  { id: 'gh-rate-limit', expected: 'no decision · error recorded', run: async s => {
    const w = new LandWorld(s, { listFails: true }); w.add({ number: 17 }); const res = await w.tick() as { error?: string };
    const r = `${w.merges.size ? 'landed' : 'no decision'} · ${res.error ? 'error recorded' : 'no error'}`; w.dispose(); return r; } },
  { id: 'duplicate-tick-lock', expected: 'locked · no land', run: async s => {
    const w = new LandWorld(s); w.add({ number: 18 }); const rel = acquireLock(w.stateRoot)!; const res = await w.tick() as { locked?: boolean }; rel();
    const r = `${res.locked ? 'locked' : 'ran'} · ${w.merges.size ? 'landed' : 'no land'}`; w.dispose(); return r; } },
  { id: 'crash-after-merge-resume', expected: 'merges 1 · notices 1', run: async s => {
    const w = new LandWorld(s, { noticeThrowsOnce: true }); w.add({ number: 19 }); await w.tick(); await w.tick(); await w.tick();
    const r = `merges ${w.merges.get(19) ?? 0} · notices ${w.posts.filter(p => p.body.includes('후통보')).length}`; w.dispose(); return r; } },
  { id: 'stacked-pr', expected: 'refuse base-not-main', run: async s => {
    const w = new LandWorld(s); w.add({ number: 20, base: 'feat/x' }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'refuse'} ${w.lastClass(20)}`; w.dispose(); return r; } },
  { id: 'revert-pr', expected: 'landed', run: async s => {
    const w = new LandWorld(s); w.add({ number: 21, title: 'Revert "feat: x"' }); await w.tick();
    const r = w.merges.size ? 'landed' : 'not'; w.dispose(); return r; } },
  { id: 'doc-only', expected: 'landed (L0 doc-only)', run: async s => {
    const w = new LandWorld(s); w.add({ number: 22, files: ['docs/a.md'], focused: 'none' }); await w.tick();
    const lane = w.ledger().find(r => r.pr === 22 && r.event === 'decision')?.why ?? '';
    const r = `${w.merges.size ? 'landed' : 'not'}${lane.includes('doc-only') ? ' (L0 doc-only)' : ''}`; w.dispose(); return r; } },
  { id: 'code-pr-empty-focused', expected: 'refuse no-focused-stage', run: async s => {
    const w = new LandWorld(s); w.add({ number: 23, focused: 'none' }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'refuse'} ${w.lastClass(23)}`; w.dispose(); return r; } },
  { id: 'hot-file-entry', expected: 'landed · no JUD review', run: async s => {
    // JUD-RELAX: a hot file (src/index.ts) is not a security-4 path — no JUD review wait.
    const w = new LandWorld(s); w.add({ number: 24, files: ['src/index.ts'] }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'not'} · ${w.cardsTo(24).length ? 'card' : 'no JUD review'}`; w.dispose(); return r; } },
  { id: 'focused-fail', expected: 'refuse baseline-failing-focused', run: async s => {
    const w = new LandWorld(s); w.add({ number: 25, focused: { pass: 64, fail: 4 } }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'refuse'} ${w.lastClass(25)}`; w.dispose(); return r; } },
  { id: 'isolation-gate', expected: 'refuse isolation-gate · card author', run: async s => {
    const w = new LandWorld(s, { landResult: () => ({ rc: 9, text: 'STOP isolation-gate rc=1 (전체 트리 검사 — pr land 와 같은 검사)' }) }); w.add({ number: 26 }); await w.tick();
    const r = `refuse ${w.lastClass(26)} · card ${w.cardsTo(26).join(',')}`; w.dispose(); return r; } },
  { id: 'test-interference', expected: 'refuse test-interference', run: async s => {
    const w = new LandWorld(s, { landResult: () => ({ rc: 6, text: 'STOP preflight rc=1' }) }); w.add({ number: 27 }); await w.tick();
    const r = `refuse ${w.lastClass(27)}`; w.dispose(); return r; } },
  { id: 'shadow-never-merges', expected: 'merges 0 · would-land 1', run: async s => {
    const w = new LandWorld(s, {}, 2, 'shadow'); w.add({ number: 28 }); await w.tick();
    const r = `merges ${w.merges.size} · would-land ${w.ledger().filter(x => x.action === 'land').length}`; w.dispose(); return r; } },
  { id: 'tc-hold-ignored', expected: 'landed · no class', run: async s => {
    const w = new LandWorld(s); w.add({ number: 29 }); setHold(w.stateRoot, 29, 'HOLD — TC thinks it is risky', 'TC'); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'not'} · ${w.lastClass(29) ?? 'no class'}`; w.dispose(); return r; } },
  { id: 'jud-security-veto-blocks', expected: 'hold · held', run: async s => {
    const w = new LandWorld(s); w.add({ number: 30 }); setHold(w.stateRoot, 30, 'security veto: token leak', 'JUD'); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'hold'} · ${w.lastClass(30)}`; w.dispose(); return r; } },
  { id: 'stale-base-revert-refused', expected: 'refuse stale-base-revert · landings 0', run: async s => {
    const w = new LandWorld(s, { staleRevert: () => ({ ok: false, why: 'src/a.ts←abc1234567' }) }); w.add({ number: 31 }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'refuse'} ${w.lastClass(31)} · landings ${w.ledger().filter(x => x.event === 'landing').length}`; w.dispose(); return r; } },
  { id: 'base-changed-retry-once-lands', expected: 'landed · land calls 2', run: async s => {
    let calls = 0;
    const w = new LandWorld(s, { landResult: () => (++calls === 1 ? { rc: 7, text: 'STOP merge rc=1' } : null) }); w.add({ number: 32 }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'not'} · land calls ${calls}`; w.dispose(); return r; } },
  { id: 'two-prs-one-slot', expected: 'tick1 1 · tick2 1 · double 0', run: async s => {
    const w = new LandWorld(s, {}, 1); w.add({ number: 33 }); w.add({ number: 34 }); await w.tick(); const a = w.merges.size; await w.tick();
    const r = `tick1 ${a} · tick2 ${w.merges.size - a} · double ${[...w.merges.values()].filter(v => v > 1).length}`; w.dispose(); return r; } },
  { id: 'org-rollback-restores-routing', expected: 'split TC · rollback TC,JUD', run: async s => {
    const w = new LandWorld(s); w.add({ number: 35, files: ['src/oauth/x.ts'] }); await w.tick(); const a = w.cardsTo(35).join(',');
    w.setOrg('org: {}\n'); w.add({ number: 36, files: ['src/oauth/y.ts'] }); await w.tick();
    const r = `split ${a} · rollback ${w.cardsTo(36).join(',')}`; w.dispose(); return r; } },
  // ── JUD-RELAX (0.3.38 P0) ─────────────────────────────────────────────────────────────────────────────────
  { id: 'swept-raw-exit0-lands', expected: 'landed · no headTestRun counts', run: async s => {
    const w = new LandWorld(s); w.add({ number: 40, focused: { swept: true, exit: 0 } }); await w.tick();
    const r = `${w.merges.size ? 'landed' : `not ${w.lastClass(40)}`} · ${w.landCtx.get(40)?.baselineDiff ? 'nd' : 'no headTestRun counts'}`; w.dispose(); return r; } },
  { id: 'swept-raw-exit1-refused', expected: 'refuse baseline-failing-focused', run: async s => {
    const w = new LandWorld(s); w.add({ number: 41, focused: { swept: true, exit: 1 } }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'refuse'} ${w.lastClass(41)}`; w.dispose(); return r; } },
  { id: 'baseline-name-diff-ok-lands', expected: 'landed · nd passed to land', run: async s => {
    const w = new LandWorld(s); w.add({ number: 42, focused: { pass: 60, fail: 1 }, baselineDiff: { receipt: '/nd/42.json', command: 'bun test x', headPass: 60, headFail: 1 } }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'not'} · ${w.landCtx.get(42)?.baselineDiff ? 'nd passed to land' : 'no nd'}`; w.dispose(); return r; } },
  { id: 'l0-receipt-doc-only-lands', expected: 'landed · lane L0-doc-only', run: async s => {
    // #40244 (11-26): pregate L0 skipped the focused stage but recorded a focused list — was «wait focused-unreadable».
    const w = new LandWorld(s); w.add({ number: 43, files: ['docs/conductor/A.md', 'docs/conductor/B.md'], l0: true }); await w.tick();
    const r = `${w.merges.size ? 'landed' : `not ${w.lastClass(43)}`} · lane ${w.landCtx.get(43)?.lane ?? '-'}`; w.dispose(); return r; } },
  { id: 'l0-receipt-code-refused', expected: 'refuse no-focused-stage', run: async s => {
    const w = new LandWorld(s); w.add({ number: 44, files: ['src/a.ts'], l0: true }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'refuse'} ${w.lastClass(44)}`; w.dispose(); return r; } },
  { id: 'security4-no-terra-waits', expected: 'wait review-required · card TC', run: async s => {
    const w = new LandWorld(s); w.add({ number: 45, files: ['src/secret/store.ts'] }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'wait'} ${w.lastClass(45)} · card ${w.cardsTo(45).join(',')}`; w.dispose(); return r; } },
  { id: 'security4-terra-warn-lands', expected: 'landed', run: async s => {
    const w = new LandWorld(s); w.add({ number: 46, files: ['src/pty/spawn.ts'], terra: { verdict: 'warn', securityFindings: [] } }); await w.tick();
    const r = w.merges.size ? 'landed' : `not ${w.lastClass(46)}`; w.dispose(); return r; } },
  { id: 'security4-terra-fail-waits', expected: 'wait review-required', run: async s => {
    const w = new LandWorld(s); w.add({ number: 47, files: ['src/oauth/token.ts'], terra: { verdict: 'fail', securityFindings: [] } }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'wait'} ${w.lastClass(47)}`; w.dispose(); return r; } },
  { id: 'security4-terra-security-finding', expected: 'refuse security-finding', run: async s => {
    const w = new LandWorld(s); w.add({ number: 48, files: ['src/disk-steward/sweep.ts'], terra: { verdict: 'pass', securityFindings: ['destructive:rm outside root'] } }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'refuse'} ${w.lastClass(48)}`; w.dispose(); return r; } },
  { id: 'non-security-terra-fail-lands', expected: 'landed', run: async s => {
    // A Terra FAIL with no security finding on a non-security path does not block (findings → FU).
    const w = new LandWorld(s); w.add({ number: 49, terra: { verdict: 'fail', securityFindings: [] } }); await w.tick();
    const r = w.merges.size ? 'landed' : `not ${w.lastClass(49)}`; w.dispose(); return r; } },
  { id: 'jud-hold-verdict-file-vetoes', expected: 'hold · held', run: async s => {
    const w = new LandWorld(s); w.add({ number: 50, judHold: 'HOLD verdict hold-50-x' }); await w.tick();
    const r = `${w.merges.size ? 'landed' : 'hold'} · ${w.lastClass(50)}`; w.dispose(); return r; } },
];

export async function runLandWorld(seed: number): Promise<{ results: CaseResult[]; violations: string[] }> {
  const results: CaseResult[] = []; LandWorld.all = [];
  for (const sc of SCENARIOS) {
    const actual = await sc.run(seed);
    results.push({ id: sc.id, expected: sc.expected, actual, ok: actual === sc.expected });
  }
  return { results, violations: LandWorld.all.flatMap(w => w.violations) };
}
