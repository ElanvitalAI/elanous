// JUDGE-GREEN-PR-BINDING (11-28) — a PR counts for a cell only on the PR's own word. Literal replays of the live mis-greens
// (titles · bodies · branches copied from GitHub 11-28) and the four sim-world scenes (5 seeds × legacy/graph).
// Expected values are literals (rule 11) — never rendered by the code under test.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindsCell, prCellBinding } from '../land-graph/cell-link.js';
import { pipelineCellsByPr } from '../land-graph/main-cell-link.js';
import { collectPrFacts, type CollectorDeps } from './collector.js';
import { judgeCell } from './done-when.js';
import { simWorldScenarios } from '../ux-sim/sim-world/supervisors/judge-binding.js';
import type { SimWorldEngine, SimWorldScenarioContext } from '../ux-sim/sim-world/types.js';

setDefaultTimeout(60_000);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (tag: string) => { const d = mkdtempSync(join(tmpdir(), `jgpb-${tag}-`)); dirs.push(d); return d; };

const IDS = ['WORK-NEXT-ROSTER-SCOPE-FU', 'PWA-GATE-E4-1127', 'CONTEXT-BUS-FEDERATION', 'CURRENT-RELEASE-ONE-SOURCE', 'LAND10-AUTOFIX-LANE', 'LAND10-SUPPLY', 'STEWARD-MAIL', 'COND-WATCH'].map(id => ({ id }));
const PR40622 = { title: 'test: synthetic PWA gate delta and cache lifecycle', body: '', headRef: 'tc/pwa-gate-e4-1127' };
const PR40630 = { title: 'feat(release): CURRENT-RELEASE-ONE-SOURCE — one current-board record flipped by the release graph at publish · every board reader through activeBoardVersion', body: '## 요약\n칸: CONTEXT-BUS-FEDERATION (0.3.39 P0 · owner OP/claude)\n', headRef: 'op/current-release-one-source' };
const PR40640 = { title: 'feat(bus): context bus across the federation — coordinator spaces + HQ · bus-post node for loop agents (CONTEXT-BUS-FEDERATION)', body: '칸: CONTEXT-BUS-FEDERATION (0.3.39 P0 · owner OP/claude)', headRef: 'feat/context-bus-federation' };
const PR40618 = { title: 'feat(land-graph): autofix lane — finisher fixes mechanical pregate RED', body: '칸: LAND10-AUTOFIX-LANE', headRef: 'feat/land10-autofix' };

describe('prCellBinding ⊕ bindsCell — the 11-28 live PRs', () => {
  test('#40622 belongs to PWA-GATE-E4-1127 (branch), not WORK-NEXT-ROSTER-SCOPE-FU', () => {
    const b = prCellBinding(PR40622, IDS);
    expect(b).toEqual({ declared: [], title: [], branch: ['PWA-GATE-E4-1127'], pipeline: [], selfDeclared: false, evidence: [] });
    expect(bindsCell(b, 'WORK-NEXT-ROSTER-SCOPE-FU')).toEqual({ ok: false, why: "is PWA-GATE-E4-1127's PR" });
    expect(bindsCell(b, 'PWA-GATE-E4-1127')).toEqual({ ok: true, basis: 'branch' });
  });
  test('#40630 «칸: CONTEXT-BUS-FEDERATION» under a CURRENT-RELEASE-ONE-SOURCE title/branch is mislabelled; #40640 is the real one', () => {
    const b = prCellBinding(PR40630, IDS);
    expect(b).toEqual({ declared: ['CONTEXT-BUS-FEDERATION'], title: ['CURRENT-RELEASE-ONE-SOURCE'], branch: ['CURRENT-RELEASE-ONE-SOURCE'], pipeline: [], selfDeclared: true, evidence: [] });
    expect(bindsCell(b, 'CONTEXT-BUS-FEDERATION')).toEqual({ ok: false, why: '«칸: CONTEXT-BUS-FEDERATION» but its title/branch name CURRENT-RELEASE-ONE-SOURCE — mislabelled PR (fix its 칸 line)' });
    expect(bindsCell(b, 'CURRENT-RELEASE-ONE-SOURCE')).toEqual({ ok: true, basis: 'title' });
    expect(bindsCell(prCellBinding(PR40640, IDS), 'CONTEXT-BUS-FEDERATION')).toEqual({ ok: true, basis: 'title' });
  });
  test('#40618 declares LAND10-AUTOFIX-LANE only — the umbrella LAND10-SUPPLY that cites it is not bound', () => {
    const b = prCellBinding(PR40618, IDS);
    expect(bindsCell(b, 'LAND10-AUTOFIX-LANE')).toEqual({ ok: true, basis: 'cell-line' });
    expect(bindsCell(b, 'LAND10-SUPPLY')).toEqual({ ok: false, why: "is LAND10-AUTOFIX-LANE's PR" });
  });
  test('a basis left out of goal.yaml pr_binding does not bind; a PR with no word about any cell declares none', () => {
    expect(bindsCell(prCellBinding(PR40622, IDS), 'PWA-GATE-E4-1127', ['cell-line', 'title'])).toEqual({ ok: false, why: "is PWA-GATE-E4-1127's PR" });
    expect(bindsCell(prCellBinding({ title: 'Keep warm pod preparation off HQ', body: null, headRef: 'x/y' }, IDS), 'STEWARD-MAIL')).toEqual({ ok: false, why: 'declares no cell (no «칸:» line · title · branch)' });
    expect(bindsCell(prCellBinding({ title: 'x', body: '', headRef: null }, IDS, ['STEWARD-MAIL']), 'STEWARD-MAIL')).toEqual({ ok: true, basis: 'pipeline' });
  });
});

test('pipelineCellsByPr — auto-cell and non-«칸» attach rows bind · linked and cell-ref rows do not', () => {
  const m = pipelineCellsByPr([
    { pr: 40622, action: 'auto-cell', cells: ['PWA-GATE-E4-1127'], basis: 'branch,owner:branch' },
    { pr: 40630, action: 'linked', cells: ['CONTEXT-BUS-FEDERATION'] },
    { pr: 40613, action: 'attach', cells: ['STEWARD-CAPS-SCALE'], basis: 'files' },
    { pr: 40618, action: 'attach', cells: ['LAND10-AUTOFIX-LANE'], basis: 'cell-ref' },
    { pr: 40613, action: 'linked', cells: ['STEWARD-CAPS-SCALE'] },
  ]);
  expect([...m.entries()]).toEqual([[40622, ['PWA-GATE-E4-1127']], [40613, ['STEWARD-CAPS-SCALE']]]);
});

describe('judgeCell through the collector — the two live cases replayed', () => {
  const H = (n: number) => String(n).padEnd(40, 'a');
  const metas: Record<number, typeof PR40622> = { 40622: PR40622, 40630: PR40630, 40586: { title: 'feat(commitment): condition-watch sweep', body: '칸: COND-WATCH', headRef: 'feat/cond-watch-sweep' }, 40591: { title: 'feat(kit): steward:mail shadow', body: '칸: STEWARD-MAIL', headRef: 'feat/steward-mail' } };
  const deps = (over: Partial<CollectorDeps> = {}): CollectorDeps => ({
    merged: new Map(Object.keys(metas).map(k => [Number(k), 'f'.repeat(40)] as const)), landedHead: pr => H(pr),
    prMeta: pr => ({ head: H(pr), files: [`src/p${pr}.ts`], ...metas[pr]! }),
    receipt: (pr, head) => ({ head, dir: `PREGATE-GREEN/${pr}-${head.slice(0, 12)}-node-b`, focusedFiles: 1, focused: { pass: 55, fail: 0 } }),
    security: () => [], cells: IDS, ...over,
  });
  const judge = (id: string, evidence: string, d = deps()) => judgeCell({ id, status: 'yellow', evidence }, collectPrFacts([...evidence.matchAll(/#(\d{5})/gu)].map(m => Number(m[1])), d));

  test('WORK-NEXT-ROSTER-SCOPE-FU on #40622 (22:18Z) → not green', () => {
    expect(judge('WORK-NEXT-ROSTER-SCOPE-FU', 'PR40622 is existing HAND-FED-SHARED-POOL work, NOT proof · #40622는 무관한 병합 PWA PR')).toEqual({
      kind: 'missing', missing: ['merged PR declaring «칸: WORK-NEXT-ROSTER-SCOPE-FU»'],
      why: "no merged PR of WORK-NEXT-ROSTER-SCOPE-FU — #40622 is PWA-GATE-E4-1127's PR — the PR that does this cell carries «칸: WORK-NEXT-ROSTER-SCOPE-FU»" });
  });
  test('CONTEXT-BUS-FEDERATION on #40630 (01:38Z) → not green', () => {
    expect(judge('CONTEXT-BUS-FEDERATION', 'msg:202459\n#40630').why).toBe('no merged PR of CONTEXT-BUS-FEDERATION — #40630 «칸: CONTEXT-BUS-FEDERATION» but its title/branch name CURRENT-RELEASE-ONE-SOURCE — mislabelled PR (fix its 칸 line) — the PR that does this cell carries «칸: CONTEXT-BUS-FEDERATION»');
  });
  test('STEWARD-MAIL citing #40586 (COND-WATCH) and #40591 (its own) → signed on #40591 only, #40586 named', () => {
    const v = judge('STEWARD-MAIL', '#40586 #40591');
    expect(v).toMatchObject({ kind: 'sign', evidence: [`#40591@${H(40591).slice(0, 12)} 40591-${H(40591).slice(0, 12)}-node-b focused 55/0`] });
    expect(v.why).toBe(`#40591@${H(40591).slice(0, 12)} 40591-${H(40591).slice(0, 12)}-node-b focused 55/0 · E4 없음 → FU · not this cell's: #40586`);
  });
  test('no cells given / body never read → unbound (fail-closed); the fetch cap leaves the rest for the next tick', () => {
    expect(judge('STEWARD-MAIL', '#40591', deps({ cells: undefined })).why).toBe('no merged PR of STEWARD-MAIL — #40591 PR body not read yet (binding unknown · next tick) — the PR that does this cell carries «칸: STEWARD-MAIL»');
    const cache = tmp('cache');
    writeFileSync(join(cache, 'pr-meta.json'), JSON.stringify({ 40586: { head: H(40586), files: ['a.ts'] }, 40591: { head: H(40591), files: ['b.ts'] } })); // rows from before the binding
    const fetched: number[] = [];
    const d = deps({ cacheDir: cache, metaFetchPerTick: 1, prMeta: pr => { fetched.push(pr); return { head: H(pr), files: ['x.ts'], ...metas[pr]! }; } });
    const f1 = collectPrFacts([40586, 40591], d);
    expect(fetched).toEqual([40586]);
    expect([f1.get(40586)!.binding?.declared, f1.get(40591)!.binding]).toEqual([['COND-WATCH'], null]);
    const f2 = collectPrFacts([40586, 40591], d);
    expect(fetched).toEqual([40586, 40591]); // 40586 now cached with its body
    expect(f2.get(40591)!.binding?.declared).toEqual(['STEWARD-MAIL']);
  });
});

describe('sim world — supervisors/JB-* (5 seeds · legacy + graph)', () => {
  const ctxOf = (id: string, engine: SimWorldEngine, events: Array<{ kind: string; data: unknown }>): SimWorldScenarioContext => ({
    world: 'supervisors', scenarioId: id, seed: 1, engine, universeRoot: tmp(`${id}-${engine}`),
    recorder: { event: (kind: string, data: unknown) => { events.push({ kind, data }); } },
    random: () => 0.5, device: () => { throw new Error('no device'); },
  }) as unknown as SimWorldScenarioContext;
  test('scenes registered', () => {
    expect(simWorldScenarios.map(s => s.id)).toEqual(['JB-UNRELATED', 'JB-DECLARED', 'JB-UMBRELLA', 'JB-MISLABEL', 'JB-LEGACY-OWN-EVIDENCE', 'JB-NEGATION']);
  });
  for (const id of ['JB-UNRELATED', 'JB-DECLARED', 'JB-UMBRELLA', 'JB-MISLABEL', 'JB-LEGACY-OWN-EVIDENCE', 'JB-NEGATION']) for (const engine of ['legacy', 'graph'] as const) {
    test(`${id} · ${engine}`, async () => {
      const events: Array<{ kind: string; data: unknown }> = [];
      expect(await simWorldScenarios.find(s => s.id === id)!.run(ctxOf(id, engine, events))).toEqual({ ok: true });
      expect(events.filter(e => e.kind === 'judge-binding:scene')).toEqual([{ kind: 'judge-binding:scene', data: { scenario: id, engine, seeds: 5 } }]);
    });
  }
});
