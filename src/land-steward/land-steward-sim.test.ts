// 착지 집사 — sims replaying the 11-27 queue (seeds A·B·C·D). Fake ports only: no gh, no ssh, no mail store.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLedger, type Focused, type LandDeps, type PrInfo, type Receipt } from '../land-graph/land-graph.js';
import { answer as answerWith } from '../land-graph/voice.js';
import { landGraphAgentTick, landVoiceView } from '../loop-agent/v3/land-graph-kind.js';
import { fileMemory, loadCards, STEWARD_ID, STEWARD_SEAT, STEWARD_SUPERVISOR, type StewardCards } from './memory.js';
import { fileAgentMemory } from '../loop-agent/memory.js';
import { BESPOKE_AGENTS, hasBody } from '../loop-agent/registry.js';
import { lanes, loadLandPolicy, trainOrderOf } from '../land-graph/lane-order.js';

// CODE-BODY-TO-KIND: the steward = the land-graph.tick ⊕ kpi-voice kinds with the land-steward package
const stewardTick = (d: LandDeps, p: Parameters<typeof landGraphAgentTick>[1], c: StewardCards) => landGraphAgentTick(d, p, c, { id: STEWARD_ID, address: STEWARD_SEAT, l0Fallback: STEWARD_SUPERVISOR });
const voiceView = (d: LandDeps) => landVoiceView(d, STEWARD_SEAT);
const answer = (q: string, v: Parameters<typeof answerWith>[1]) => answerWith(q, v, { id: STEWARD_ID, l0: STEWARD_SUPERVISOR });
const trainOrder = trainOrderOf(loadLandPolicy()!.laneOrder.train!);

const ORG = join(mkdtempSync(join(tmpdir(), 'ls-org-')), 'federation.yaml');
writeFileSync(ORG, 'org:\n  duties:\n    landing: TC\n    veto: JUD\n');
const hx = (n: number, c = 'a') => `${String(n).padStart(6, '0')}${c.repeat(34)}`;
const mk = (n: number, o: Partial<PrInfo> = {}): PrInfo => ({ number: n, head: hx(n), base: 'main', draft: false, state: 'OPEN', title: `pr ${n}`, author: 'UX', files: [`src/f${n}.ts`], headRef: `b${n}`, createdAt: '2026-11-27T05:00:00Z', ...o });
const rc = (pr: number, head: string, o: Partial<Receipt> = {}): Receipt => ({ dir: `/r/${pr}-${head.slice(0, 12)}-minim5`, head, host: 'minim5', focused: [`src/f${pr}.test.ts`], rawDir: '', focusedExit: 0, ...o });
const NOW = new Date('2026-11-27T00:00:00Z'); // 09:00 KST
const cards = loadCards();

interface World { prs: PrInfo[]; receipts: Map<number, Receipt>; focused: Map<number, Focused>; nd: Set<number>; tsc: Set<number>; terra?: Map<number, string> }
function deps(s: string, w: World, posts: string[], o: Partial<LandDeps> = {}): LandDeps {
  const merged = new Set<number>();
  return {
    now: () => NOW, stateRoot: s, mode: 'live', slots: 2, org: { path: ORG },
    listPrs: async () => w.prs.filter(p => !merged.has(p.number)).map(p => ({ ...p })),
    prNow: async n => { const p = w.prs.find(x => x.number === n); return p ? { ...p, state: merged.has(n) ? 'MERGED' : p.state } : null; },
    receipt: (n, h) => (w.receipts.get(n)?.head === h ? w.receipts.get(n)! : null), olderReceiptHead: () => null,
    focused: r => w.focused.get(Number(r.dir.split('/')[2]!.split('-')[0])) ?? { pass: 5, fail: 0 }, security: () => [],
    baselineDiff: n => (w.nd.has(n) ? { receipt: `/e/nd${n}/namediff.json`, command: 'bun test x', headPass: 40, headFail: 2 } : null),
    terra: n => (w.terra?.has(n) ? { verdict: w.terra.get(n)!, securityFindings: [] } : null),
    land: async p => { if (w.tsc.has(p.number)) return { rc: 10, text: 'STOP tsc-preflight rc=1 (land-enqueue …)' }; merged.add(p.number); return { rc: 0, text: 'merged' }; },
    post: (to, b) => { posts.push(`${to} ${b}`); }, record: () => {},
    finisher: { launchPregate: () => ({ ok: true, pid: 9 }), alive: () => true, refresh: () => ({ result: 'error' }) },
    ...o,
  };
}
const lines: string[] = [];
const ports = (s: string) => ({ memory: fileMemory(s), channel: (l: string) => { lines.push(l); } });

describe('seed A — 11-27 08:4x queue (the stopgap runner list)', () => {
  const w: World = {
    prs: [mk(39891, { title: '\u{1F451} sidetab consumer', files: ['src/msg/a.ts'] }), mk(40355, { files: ['src/session-autopilot/x.ts'] }), mk(39794, { files: ['src/ux-sim/k.ts'] }),
      mk(40157, { files: ['src/ux-sim/s.ts'] }), mk(39960, { author: 'RES', files: ['src/resources/l.ts'] }), mk(40085)],
    receipts: new Map(), focused: new Map(), nd: new Set([39891]), tsc: new Set([39960]),
  };
  w.receipts.set(39891, rc(39891, hx(39891), { focusedExit: 1, red: { failed: [{ name: 'focused', exit: 1 }, { name: 'baseline-focused', exit: 1 }] }, focusedBaseline: { mine: 2, onMain: 1, newFailures: ['(fail) x'] } }));
  w.focused.set(39891, { swept: true, exit: 1 });
  w.receipts.set(40355, rc(40355, hx(40355), { red: { failed: [{ name: 'changed-tsc', exit: 124 }] } }));
  w.focused.set(40355, { swept: true, exit: 0 });
  for (const n of [39794, 40157, 39960]) w.receipts.set(n, rc(n, hx(n)));

  test('lands the stopgap cases · every refusal has a next owner · no land mail to TC/OP · voice answers from records', async () => {
    const s = mkdtempSync(join(tmpdir(), 'ls-a-')); const posts: string[] = [];
    // 11-26 legacy sticky guard-error row on #39794's head and a closed PR's history (#39114)
    appendLedger(s, { at: '2026-11-26T22:28:00Z', pr: 39794, head: hx(39794), mode: 'live', event: 'refused', cls: 'stale-base-revert', why: 'guard error: Error: git merge-tree --write-tree 3987 1d73 fai' });
    appendLedger(s, { at: '2026-11-26T22:04:11Z', pr: 39114, head: hx(39114), mode: 'live', event: 'refused', cls: 'stale-base-revert', why: 'guard error: …' });
    const d = deps(s, w, posts, { slots: 4 });
    const r = await stewardTick(d, ports(s), cards);
    expect(fileMemory(s).readState()).toMatchObject({ lastTickAt: NOW.toISOString(), ticks: 1 });
    expect(fileAgentMemory(s, 'land-steward', 'TC').readState()).toMatchObject({ lastTickAt: NOW.toISOString(), ticks: 1 });
    expect(BESPOKE_AGENTS['land-steward']).toBe('eln land steward status|tick|voice');
    expect(hasBody('land-steward')).toBe(false);
    expect(r.landed).toEqual([39891, 39794, 40157]); // crown first; #39960 tsc-refused at land time
    expect(r.decisions.filter(x => x.action !== 'land').every(x => !!x.next)).toBe(true);
    expect(r.kpi!.refusalsWithoutNext).toEqual([]);
    expect(posts.filter(p => /^(TC|OP) /.test(p))).toEqual([]); // terminal owner: author cards only
    expect(posts.some(p => p.startsWith('RES ') && p.includes('[land-graph · tsc] #39960'))).toBe(true);
    const v = await voiceView(d);
    expect(answer('왜 #39114 안 들어가?', v).text).toContain('열린 PR 목록에 없다');
    expect(answer('#40355 왜 안 들어가?', v).text).toMatch(/tsc-timeout[\s\S]*다음: land-graph \(finisher pregate-retry\)/u);
    const b = answer('지금 막힌 것?', v);
    expect(b.kind).toBe('blocked');
    expect(b.text).toContain('RES · tsc: 1 (#39960)');
    expect(answer('다음 1시간 몇 건?', v).text).toMatch(/^다음 1시간 예상 \d+건/u);
  });
});

describe('seed B — hot-file lane (train manager)', () => {
  test('crown → age order · one PR per hot file per tick · the rest wait with the graph as next owner', async () => {
    const s = mkdtempSync(join(tmpdir(), 'ls-b-')); const posts: string[] = [];
    const w: World = {
      prs: [mk(40401, { files: ['src/hot.ts'], createdAt: '2026-11-26T20:00:00Z' }), mk(40402, { files: ['src/hot.ts', 'docs/x.md'], createdAt: '2026-11-26T19:00:00Z' }),
        mk(40403, { files: ['src/hot.ts'], title: '\u{1F451} P0 fix', createdAt: '2026-11-27T00:00:00Z' }), mk(40404, { files: ['src/cold.ts'] })],
      receipts: new Map(), focused: new Map(), nd: new Set(), tsc: new Set(),
    };
    for (const p of w.prs) w.receipts.set(p.number, rc(p.number, p.head));
    expect(trainOrder(w.prs, [], NOW.getTime()).map(p => p.number)).toEqual([40403, 40402, 40401, 40404]);
    expect(lanes(w.prs)).toEqual([{ file: 'src/hot.ts', prs: [40401, 40402, 40403] }]);
    const r = await stewardTick(deps(s, w, posts, { slots: 3 }), ports(s), cards);
    expect(r.landed).toEqual([40403, 40404]);
    expect(r.decisions.filter(x => x.cls === 'main-moved-overlap').map(x => [x.pr, x.next?.owner])).toEqual([[40402, 'land-graph'], [40401, 'land-graph']]);
    expect(r.lanes[0]!.file).toBe('src/hot.ts');
  });
});

describe('seed C — KPI breach line (signal diet)', () => {
  test('one channel line per breach key per 30 min · no mail · recovery forgets the key · shadow = plain body, no line', async () => {
    const s = mkdtempSync(join(tmpdir(), 'ls-c-')); const posts: string[] = []; lines.length = 0;
    const w: World = { prs: [mk(40501), mk(40502)], receipts: new Map(), focused: new Map(), nd: new Set(), tsc: new Set() };
    const d = deps(s, w, posts);
    const r1 = await stewardTick(d, ports(s), cards); // nothing landable: lands 0 < 10 · landable 0%
    expect(r1.posted.map(l => l.split(' (')[0])).toEqual(['[착지 집사 · KPI] 착지 0/h < 10', '[착지 집사 · KPI] 착지 가능 0% < 50%']);
    expect(lines).toHaveLength(2);
    await stewardTick(d, ports(s), cards);
    expect(lines).toHaveLength(2); // same window: no repeat
    expect(posts.filter(p => /^(TC|OP) /.test(p))).toEqual([]);
    const later = deps(s, w, posts, { now: () => new Date(NOW.getTime() + 31 * 60_000) });
    await stewardTick(later, ports(s), cards);
    // window passed: the two keys post again · the finisher pregates launched at 09:00 are now 31 min old (p50 > 30)
    expect(lines.slice(2).map(l => l.split(' (')[0])).toEqual(['[착지 집사 · KPI] 착지 0/h < 10', '[착지 집사 · KPI] 착지 가능 0% < 50%', '[착지 집사 · KPI] 마무리 대기 p50 31분 > 30']);
    fileMemory(s).setLevel('shadow', 'TC', 'sim');
    const r4 = await stewardTick(deps(s, w, posts, { now: () => new Date(NOW.getTime() + 70 * 60_000) }), ports(s), cards);
    expect([r4.level, lines.length]).toEqual(['shadow', 5]);
    expect(() => fileMemory(s).setLevel('off', 'UX', 'x')).toThrow(/only TC\/OP\/CLAUDE-OP may/u);
  });
});

describe('seed D — policy exception stays mail', () => {
  test('security-4 path without Terra → review-required card still reaches the landing owner', async () => {
    const s = mkdtempSync(join(tmpdir(), 'ls-d-')); const posts: string[] = [];
    const w: World = { prs: [mk(40601, { files: ['src/auth/token.ts'] })], receipts: new Map(), focused: new Map(), nd: new Set(), tsc: new Set() };
    w.receipts.set(40601, rc(40601, hx(40601)));
    const r = await stewardTick(deps(s, w, posts), ports(s), cards);
    expect(r.decisions[0]).toMatchObject({ action: 'wait', cls: 'review-required' });
    expect(posts.some(p => p.startsWith('TC ') && p.includes('review-required'))).toBe(true);
  });
});
