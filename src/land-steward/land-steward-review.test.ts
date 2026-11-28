// Terra r1 on #40386 — each must-fix pinned by a case (identity · plan errors · measure time · finisher dedupe · refs · cards).
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retryHost } from '../cli/land-graph-cli.js';
import { readLedger, type LandDeps, type PrInfo, type TickResult } from '../land-graph/land-graph.js';
import { answer as answerWith } from '../land-graph/voice.js';
import { landMetrics as measure } from '../land-graph/metrics.js';
import { lanes } from '../land-graph/lane-order.js';
import { landGraphAgentTick, landVoiceView } from '../loop-agent/v3/land-graph-kind.js';
import { kpiBreaches } from '../loop-agent/v3/kpi-voice.js';
import { verifyLevelCaller } from './cli.js';
import { fileMemory, loadCards, STEWARD_ID, STEWARD_SEAT, STEWARD_SUPERVISOR, type StewardCards } from './memory.js';

// CODE-BODY-TO-KIND: the steward = the land-graph.tick ⊕ kpi-voice kinds with the land-steward package
const stewardTick = (d: LandDeps, p: Parameters<typeof landGraphAgentTick>[1], c: StewardCards) => landGraphAgentTick(d, p, c, { id: STEWARD_ID, address: STEWARD_SEAT, l0Fallback: STEWARD_SUPERVISOR });
const voiceView = (d: LandDeps) => landVoiceView(d, STEWARD_SEAT);
const answer = (q: string, v: Parameters<typeof answerWith>[1], c?: StewardCards) => answerWith(q, v, { id: STEWARD_ID, l0: STEWARD_SUPERVISOR, ...(c ? { soulText: c.soulText, knowhowText: c.knowhowText } : {}) });

const ORG = join(mkdtempSync(join(tmpdir(), 'lr-org-')), 'federation.yaml');
writeFileSync(ORG, 'org:\n  duties:\n    landing: TC\n    veto: JUD\n');
const hx = (n: number, c = 'a') => `${String(n).padStart(6, '0')}${c.repeat(34)}`;
const mk = (n: number, o: Partial<PrInfo> = {}): PrInfo => ({ number: n, head: hx(n), base: 'main', draft: false, state: 'OPEN', title: `pr ${n}`, author: 'UX', files: [`src/f${n}.ts`], headRef: `b${n}`, ...o });
const NO_PROXY = { ok: false as const, line: 'no proxy grant' };

describe('level: --by is bound to the verified caller', () => {
  test('a UX process claiming TC is refused · TC as TC passes · UX as UX is not allowed · proxy only as CLAUDE-OP', () => {
    expect(verifyLevelCaller('TC', { callerSeat: 'UX', proxy: NO_PROXY })).toEqual({ ok: false, line: 'land steward level: --as TC refused — this process is seat UX' });
    expect(verifyLevelCaller('TC', { callerSeat: 'TC', proxy: NO_PROXY })).toEqual({ ok: true, seat: 'TC' });
    expect(verifyLevelCaller(undefined, { callerSeat: 'OP', proxy: NO_PROXY })).toEqual({ ok: true, seat: 'OP' });
    expect(verifyLevelCaller('UX', { callerSeat: 'UX', proxy: NO_PROXY })).toMatchObject({ ok: false, line: 'land steward level: UX may not change the level (TC · OP · CLAUDE-OP)' });
    expect(verifyLevelCaller('CLAUDE-OP', { callerSeat: null, proxy: NO_PROXY })).toEqual({ ok: false, line: 'no proxy grant' });
    expect(verifyLevelCaller('CLAUDE-OP', { callerSeat: null, proxy: { ok: true } })).toEqual({ ok: true, seat: 'CLAUDE-OP' });
    expect(verifyLevelCaller('TC', { callerSeat: null, proxy: NO_PROXY }).ok).toBe(false);
  });
});

const base = (s: string, o: Partial<LandDeps> = {}): LandDeps => ({
  now: () => new Date('2026-11-27T01:00:00Z'), stateRoot: s, mode: 'live', slots: 2, org: { path: ORG },
  listPrs: async () => [mk(1001)], prNow: async () => null, receipt: () => null, olderReceiptHead: () => null,
  focused: () => 'unreadable', security: () => [], land: async () => ({ rc: 0, text: '' }), post: () => {}, record: () => {}, ...o,
});

describe('refused agent definition', () => {
  test('real strict loader rejects unknown root key and tick reports L0 without side effects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr-yaml-'));
    const source = join(import.meta.dir, '../../graphs/loop-agents/land-steward');
    for (const file of ['soul.md', 'knowhow.md']) writeFileSync(join(dir, file), readFileSync(join(source, file)));
    const yaml = readFileSync(join(source, 'agent.yaml'), 'utf8');
    writeFileSync(join(dir, 'agent.yaml'), yaml);
    expect(loadCards(dir).source).toBe('agent.yaml');
    writeFileSync(join(dir, 'agent.yaml'), `${yaml}\nunknown_definition_key: true\n`);
    const cards = loadCards(dir);
    expect(cards.refused?.join('\n')).toContain('unknown agent key unknown_definition_key');
    const state = mkdtempSync(join(tmpdir(), 'lr-state-'));
    const effects: string[] = [];
    const reports: Array<{ key: string; to: string; body: string }> = [];
    const result = await stewardTick(base(state, { listPrs: async () => { effects.push('list'); return []; } }), {
      memory: fileMemory(state), channel: () => effects.push('channel'), cellSweep: async () => { effects.push('sweep'); throw new Error('unexpected'); },
      report: (key, to, body) => reports.push({ key, to, body }),
    }, cards);
    expect(result.error).toBe('agent.yaml refused; agent down');
    expect(effects).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.to).toBe('TC');
    expect(reports[0]?.key).toStartWith('agent-yaml-refused:land-steward:');
    expect(reports[0]?.body).toContain('기본 몸도 돌지 않는다');
  });
  test('reports L0 and never runs the body', async () => {
    const s = mkdtempSync(join(tmpdir(), 'lr-refused-'));
    let listed = false;
    const reports: Array<{ to: string; body: string }> = [];
    const result = await stewardTick(base(s, { listPrs: async () => { listed = true; return []; } }), {
      memory: fileMemory(s), channel: () => {}, report: (_key, to, body) => reports.push({ to, body }),
    }, { ...loadCards(), compiled: null, refused: ['invalid definition'] });
    expect(listed).toBe(false);
    expect(result.error).toBe('agent.yaml refused; agent down');
    expect(result.refused).toEqual(['invalid definition']);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.to).toBe('TC');
    expect(reports[0]?.body).toContain('invalid definition');
  });
});

describe('voice never answers from a failed plan', () => {
  test('gh list failure → voiceView throws (no «closed» / «nothing blocked»)', async () => {
    const s = mkdtempSync(join(tmpdir(), 'lr-v-'));
    await expect(voiceView(base(s, { listPrs: async () => { throw new Error('gh: 502'); } }))).rejects.toThrow('body plan failed — gh-error: gh: 502');
  });
  test('answers carry evidence refs · knowhow and identity come from the cards', async () => {
    const s = mkdtempSync(join(tmpdir(), 'lr-v2-'));
    const v = await voiceView(base(s));
    expect(answer('왜 #1001 안 들어가?', v).evidence).toEqual(['pr:#1001']);
    const cards = loadCards();
    expect(answer('노하우?', v, cards).text.split('\n')[1]).toBe('T1 같은 핫파일을 고치는 PR 은 직렬로 착지한다. 한 틱에 파일당 하나만, 다음 것은 새 main 위에서 다시 preflight 한다 → `tickLand` 같은 파일 겹침 = `main-moved-overlap` · `lane-order.ts` lanes');
    expect(answer('?', v, cards).text).toContain('착지 집사(서브 조율자 급, OP 직속. L0 감독 = **TC**');
  });
});

describe('measurement time = after the body tick', () => {
  test('a land recorded during a long tick counts in lands/h', async () => {
    const s = mkdtempSync(join(tmpdir(), 'lr-t-'));
    let t = Date.parse('2026-11-27T01:00:00Z');
    const p = mk(7); let merged = false;
    const d = base(s, {
      now: () => new Date(t), listPrs: async () => (merged ? [] : [p]), prNow: async () => ({ ...p, state: merged ? 'MERGED' : 'OPEN' }),
      receipt: (n, h) => ({ dir: `/r/${n}-${h.slice(0, 12)}-minim5`, head: h, host: 'minim5', focused: ['a.test.ts'], rawDir: '', focusedExit: 0 }),
      focused: () => ({ pass: 3, fail: 0 }),
      land: async () => { t += 20 * 60_000; merged = true; return { rc: 0, text: '' }; }, // a 20-minute land
    });
    const r = await stewardTick(d, { memory: fileMemory(s), channel: () => {} }, loadCards());
    expect(r.landed).toEqual([7]);
    expect(r.at).toBe('2026-11-27T01:20:00.000Z');
    expect(r.kpi!.landsLastHour).toBe(1);
    expect(readLedger(s).find(x => x.event === 'landed')?.doneAt).toBe('2026-11-27T01:20:00.000Z'); // real merge time, not the tick start
  });
});

describe('finisher wait: once per PR head · resolved heads drop', () => {
  const now = new Date('2026-11-27T02:00:00Z');
  const prs = [mk(1), mk(2), mk(3)];
  const tick = (actions: Record<number, 'land' | 'wait'>): Pick<TickResult, 'decisions' | 'ready'> =>
    ({ decisions: prs.map(p => ({ pr: p.number, head: p.head, action: actions[p.number]!, why: 'x' })), ready: 0 });
  const book = { jobs: { a: { pr: 1, head: hx(1), kind: 'pregate' as const, state: 'running' as const, at: '2026-11-27T01:20:00Z' } } };
  const rows = [
    { at: '2026-11-27T01:00:00Z', pr: 1, head: hx(1), mode: 'live' as const, event: 'card' as const, cls: 'needs-finisher' as const },
    { at: '2026-11-27T01:30:00Z', pr: 2, head: hx(2), mode: 'live' as const, event: 'card' as const, cls: 'needs-finisher' as const },
    { at: '2026-11-27T01:50:00Z', pr: 3, head: hx(3), mode: 'live' as const, event: 'card' as const, cls: 'needs-finisher' as const },
    { at: '2026-11-27T03:00:00Z', pr: 9, head: hx(9), mode: 'live' as const, event: 'landed' as const },
  ];
  test('job ⊕ card on #1 count once (earliest) · #3 now lands → dropped · a future-dated land never counts', () => {
    const k = measure({ rows, tick: tick({ 1: 'wait', 2: 'wait', 3: 'land' }), book, prs, now });
    expect([k.needsFinisherOpen, k.needsFinisherWaitP50Min]).toEqual([2, 45]); // #1 60 min · #2 30 min
    expect(k.landsLastHour).toBe(0);
  });
});

describe('retry host: route freshness', () => {
  test('future-dated route is not fresh · a fresh route other than the timed-out host wins · same host falls through', () => {
    const s = mkdtempSync(join(tmpdir(), 'lr-r-')); mkdirSync(join(s, 'res'));
    const nowMs = Date.parse('2026-11-27T02:00:00Z'); const none = () => null;
    writeFileSync(join(s, 'res', 'route.json'), JSON.stringify({ host: 'mbp', at: '2026-11-27T03:00:00Z' }));
    expect(retryHost('node-b', ['node-b', 'minim5', 'mbp'], { stateRoot: s, nowMs, pick: none })).toBe('minim5');
    writeFileSync(join(s, 'res', 'route.json'), JSON.stringify({ host: 'mbp', at: '2026-11-27T01:55:00Z' }));
    expect(retryHost('node-b', ['node-b', 'minim5', 'mbp'], { stateRoot: s, nowMs, pick: none })).toBe('mbp');
    expect(retryHost('mbp', ['node-b', 'minim5', 'mbp'], { stateRoot: s, nowMs, pick: () => 'minim5' })).toBe('minim5');
  });
});

// ── Terra r2 ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r2: author keeps its card even when it is TC', () => {
  test('a TC-authored PR with a focused failure: TC gets the author card, no extra landing-owner copy', async () => {
    const s = mkdtempSync(join(tmpdir(), 'lr2-a-')); const posts: string[] = [];
    const p = mk(2001, { author: 'TC' });
    await stewardTick(base(s, {
      listPrs: async () => [p], receipt: (n, h) => ({ dir: `/r/${n}-${h.slice(0, 12)}-minim5`, head: h, host: 'minim5', focused: ['a.test.ts'], rawDir: '', focusedExit: 1 }),
      focused: () => ({ pass: 3, fail: 1 }), post: (to, b) => { posts.push(`${to} ${b.split(' «')[0]}`); },
    }), { memory: fileMemory(s), channel: () => {} }, loadCards());
    expect(posts).toEqual(['TC [land-graph · baseline-failing-focused] #2001']);
  });
});

describe('r2: a failed body tick is not «0 lands»', () => {
  test('error propagates · no KPI · no channel line · breach state and cases untouched', async () => {
    const s = mkdtempSync(join(tmpdir(), 'lr2-e-')); const lines: string[] = [];
    const mem = fileMemory(s);
    mem.writeState({ lastTickAt: '2026-11-27T00:50:00Z', ticks: 1, breaches: { lands: '2026-11-27T00:50:00Z' } });
    const r = await stewardTick(base(s, { listPrs: async () => { throw new Error('gh: 502'); } }), { memory: mem, channel: l => { lines.push(l); } }, loadCards());
    expect([r.error, r.skipped, r.kpi, lines.length, mem.cases().length]).toEqual(['gh-error: gh: 502', 'gh-error', null, 0, 0]);
    // GH-BUDGET-GOVERNOR: a skipped tick is a wake (lastTickAt moves — no «틱 정지»), breach state and ticks untouched.
    expect(mem.readState()).toEqual({ lastTickAt: '2026-11-27T01:00:00.000Z', ticks: 1, breaches: { lands: '2026-11-27T00:50:00Z' } });
    expect(JSON.parse(readFileSync(join(s, 'land-graph', 'last-tick.json'), 'utf8'))).toEqual({ at: '2026-11-27T01:00:00.000Z', mode: 'live', skipped: 'gh-error', lastSkipped: { at: '2026-11-27T01:00:00.000Z', why: 'gh-error: gh: 502' } });
  });
});

describe('r2: KPI judged on raw values', () => {
  test('ratio 0.499 breaches 0.5 · p50 30.4 min breaches 30', async () => {
    const kpis = loadCards().compiled!.kpis;
    const k = { landsLastHour: 10, landsToday: 10, ready: 499, judged: 1000, landableRatio: 0.499, needsFinisherWaitP50Min: 30.4, needsFinisherOpen: 2, refusalsWithoutNext: [], waitingForSlot: 0 };
    expect(kpiBreaches(kpis, { kpi: k }).map(b => b.key)).toEqual(['landable', 'finisher-wait']);
    expect(kpiBreaches(kpis, { kpi: k }).map(b => b.line)).toEqual(['착지 가능 50% < 50% (499/1000)', '마무리 대기 p50 30분 > 30 (2건)']);
  });
});

describe('CODE-BODY-TO-KIND: no silent defaults', () => {
  test('a package without agent.yaml is refused (no v2 goal.yaml fallback · no built-in numbers)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-c-'));
    const c = loadCards(dir);
    expect([c.compiled, c.source, c.refused?.[0]?.startsWith('no agent.yaml in ')]).toEqual([null, 'default', true]);
  });
  test('a kpi-voice KPI without its breach line is refused by lint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lr2-k-'));
    const source = join(import.meta.dir, '../../graphs/loop-agents/land-steward');
    for (const file of ['soul.md', 'knowhow.md']) writeFileSync(join(dir, file), readFileSync(join(source, file)));
    writeFileSync(join(dir, 'agent.yaml'), readFileSync(join(source, 'agent.yaml'), 'utf8').replace(/key: lands,\n\s+breach: "[^"]*" \}/u, 'key: lands }'));
    expect(loadCards(dir).refused?.join('\n')).toContain('kpis lands_per_hour: the kpi-voice node needs from · key · breach');
  });
});

describe('r2: lanes count drafts', () => {
  test('a draft on the same file makes it a lane', async () => {
    expect(lanes([mk(3001, { files: ['src/hot.ts'] }), mk(3002, { files: ['src/hot.ts'], draft: true })])).toEqual([{ file: 'src/hot.ts', prs: [3001, 3002] }]);
  });
});

describe('r3: PR numbers in questions', () => {
  test('«#12» and a bare 7-digit number are read as PRs', async () => {
    const s = mkdtempSync(join(tmpdir(), 'lr3-'));
    const v = await voiceView(base(s));
    expect(answer('왜 #12 안 들어가?', v).evidence[0]).toBe('pr:#12');
    expect(answer('1234567 왜 막혀?', v).evidence[0]).toBe('pr:#1234567');
  });
});
