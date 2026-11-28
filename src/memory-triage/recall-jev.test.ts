// JEV-MEMORY-RECALL — Jev recall judge, shadow ledger, and the three modes through the real buildMemoryInjectionLLM.
// Fake transports only (no real HTTP · no key file · temp memory root · temp ledger).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JevRequest, JevResponse } from '../decide/jev.js';
import { BUILTIN_JEV_SITES_FILE, jevSite, readJevSites, type JevDecideDeps } from '../kit/jev-decide/index.js';
import { buildMemoryInjectionLLM, saveMemory } from '../memory.js';
import {
  appendRecallShadow, judgeRecallWithJev, memoryRecallAudience, memoryRecallMode, readRecallShadow, recallShadowRow, summarizeRecallShadow,
  type RecallCandidate, type RecallShadowRow,
} from './recall-jev.js';

const table = readJevSites([BUILTIN_JEV_SITES_FILE]);
const site = jevSite('memory-recall', table);
const cands: RecallCandidate[] = [
  { id: 'aaaaaaaa-1111', type: 'feedback', name: 'land rule', description: 'landing goes through pr land' },
  { id: 'bbbbbbbb-2222', type: 'reference', name: 'ref repo', description: 'the reference repo for X' },
  { id: 'cccccccc-3333', type: 'user', name: 'tone', description: 'answer in Korean' },
];
const transport = (probabilities: Record<string, number>, seen?: JevRequest[]): JevDecideDeps => ({
  table,
  transport: async (req) => { seen?.push(req); return { model: 'jev-fake', answers: { useful: { type: 'choice', probabilities } } } as JevResponse; },
});

describe('judgeRecallWithJev', () => {
  test('one choice over m1..mN ⊕ none · picks p ≥ threshold (top maxSelect) · state redacted and bounded', async () => {
    const seen: JevRequest[] = [];
    const out = await judgeRecallWithJev({ message: 'how do I land? token=sk-abcdefghijklmnop', candidates: cands, audience: 'hq-seat' }, transport({ m1: 0.55, m2: 0.05, m3: 0.25, none: 0.15 }, seen));
    expect(out).toMatchObject({ ok: true, ids: ['aaaaaaaa-1111', 'cccccccc-3333'], top: 'aaaaaaaa', model: 'jev-fake' });
    const q = seen[0]!.questions.useful as { type: string; criteria: Record<string, unknown> };
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria)).toEqual(['m1', 'm2', 'm3', 'none']);
    const sent = JSON.stringify(seen[0]!.state);
    expect(sent).not.toContain('sk-abcdefghijklmnop');
    expect(sent).toContain('UNTRUSTED RECALL STATE');
    expect(site.threshold).toBe(0.2);
  });

  test('none dominant → [] · unknown keys ignored · no usable answer → no-answer · cap = maxSelect', async () => {
    expect(await judgeRecallWithJev({ message: 'hi there friend', candidates: cands, audience: 'hq-seat' }, transport({ none: 0.9, m2: 0.1 }))).toMatchObject({ ok: true, ids: [], top: 'none' });
    expect(await judgeRecallWithJev({ message: 'x y', candidates: cands, audience: 'hq-seat' }, transport({ constructor: 0.9 }))).toMatchObject({ ok: false, reason: 'no-answer' });
    const capped = await judgeRecallWithJev({ message: 'x y', candidates: cands, audience: 'hq-seat', maxSelect: 1 }, transport({ m1: 0.4, m3: 0.45, none: 0.15 })); // 출처: #40589 synthetic judge probabilities (fixture data, not a bound)
    expect(capped).toMatchObject({ ok: true, ids: ['cccccccc-3333'] });
  });

  test('member memories never go to a remote endpoint (kit egress rule)', async () => {
    let calls = 0;
    const out = await judgeRecallWithJev({ message: 'x y', candidates: cands, audience: 'member' }, {
      table, peekEndpoint: () => 'https://api.typesafe.ai/v1/systemone', resolveAccess: () => ({ ok: false }),
      callJev: async () => { calls += 1; return { model: 'm', answers: {} }; },
    });
    expect(out).toMatchObject({ ok: false, reason: 'egress-not-allowed' });
    expect(calls).toBe(0);
  });

  test('audience: a seat process (env or seats/<X> cwd) is hq-seat · anything else is member', () => {
    expect(memoryRecallAudience({ ELANOUS_SEAT: 'TC' }, '/tmp')).toBe('hq-seat');
    expect(memoryRecallAudience({}, '/Users/x/elanous-hq/seats/OP')).toBe('hq-seat');
    expect(memoryRecallAudience({}, '/Users/x/projects/app')).toBe('member');
  });

  test('the switch is the YAML flag (built-in = shadow)', () => {
    expect(memoryRecallMode(site)).toBe('shadow');
    expect(memoryRecallMode({ ...site, params: { mode: 'jev' } })).toBe('jev');
    expect(memoryRecallMode({ ...site, params: { mode: 'garbage' } })).toBe('shadow');
  });
});

describe('shadow ledger + agreement', () => {
  const jevOk = (ids: string[]) => ({ ok: true as const, ids, top: ids[0]?.slice(0, 8) ?? 'none', topP: 0.9, noneP: ids.length ? 0.1 : 0.9, probs: {}, ms: 300, model: 'jev' });
  test('row: same set (both none included) agrees · ids only, no text', () => {
    const at = new Date('2026-11-28T00:00:00Z');
    const same = recallShadowRow({ at, audience: 'hq-seat', candidates: 3, luna: ['aaaaaaaa-1111'], lunaMs: 1500, jev: jevOk(['aaaaaaaa-1111']) });
    expect(same).toMatchObject({ agree: true, bothNone: false, luna: ['aaaaaaaa'], jev: ['aaaaaaaa'] });
    expect(recallShadowRow({ at, audience: 'hq-seat', candidates: 3, luna: [], lunaMs: 1, jev: jevOk([]) })).toMatchObject({ agree: true, bothNone: true });
    expect(recallShadowRow({ at, audience: 'hq-seat', candidates: 3, luna: [], lunaMs: 1, jev: jevOk(['bbbbbbbb-2222']) })).toMatchObject({ agree: false });
    expect(recallShadowRow({ at, audience: 'hq-seat', candidates: 3, luna: null, lunaMs: 1, jev: jevOk([]) })).toMatchObject({ agree: null });
    expect(recallShadowRow({ at, audience: 'hq-seat', candidates: 3, luna: [], lunaMs: 1, jev: { ok: false, reason: 'timeout', ms: 3000 } })).toMatchObject({ jev: null, jevReason: 'timeout', agree: null });
  });

  test('summary: agreement over compared turns · ready only at ≥ flipAgreement over ≥ flipMinTurns', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'recall-shadow-')), 'memory-recall-shadow.jsonl');
    const base = Date.parse('2026-11-28T00:00:00Z');
    for (let i = 0; i < 600; i++) {
      const lunaIds = i % 10 === 0 ? ['aaaaaaaa-1111'] : [];
      const jevIds = i < 20 ? ['bbbbbbbb-2222'] : lunaIds;
      appendRecallShadow(recallShadowRow({ at: new Date(base + i * 1000), audience: 'hq-seat', candidates: 3, luna: lunaIds, lunaMs: 1500, jev: jevOk(jevIds) }), file);
    }
    appendRecallShadow(recallShadowRow({ at: new Date(base + 700_000), audience: 'hq-seat', candidates: 3, luna: [], lunaMs: 1500, jev: { ok: false, reason: 'breaker-open', ms: 0 } }), file);
    const rows = readRecallShadow(file);
    expect(rows).toHaveLength(601);
    const s = summarizeRecallShadow(rows, base, site);
    expect(s).toMatchObject({ turns: 601, compared: 600, agree: 580, jevFailed: { 'breaker-open': 1 }, lunaMsP50: 1500, jevMsP50: 300, mode: 'shadow' });
    expect(s.agreeRate).toBeCloseTo(580 / 600, 5);
    expect(s.ready).toBe(true);
    expect(summarizeRecallShadow(rows.slice(0, 100), base, site).ready).toBe(false); // < flipMinTurns
    expect(summarizeRecallShadow(rows.slice(0, 20), base, site).agreeRate).toBe(0);
  });
});

describe('buildMemoryInjectionLLM × mode (real memory root)', () => {
  function world() {
    const root = mkdtempSync(join(tmpdir(), 'recall-jev-world-'));
    const a = saveMemory({ name: 'Landing rule', description: 'landing goes through pr land only', body: 'Use pr land for every landing.', type: 'feedback' }, root);
    const b = saveMemory({ name: 'Korean replies', description: 'answer the owner in Korean', body: 'Always answer in Korean.', type: 'user' }, root);
    return { root, a, b };
  }
  const q = 'how should the landing of this pull request go';

  test('shadow: the turn uses luna and does NOT wait for Jev · the row lands after Jev answers', async () => {
    const { root, a } = world();
    let release!: (r: JevResponse) => void;
    const jevAnswer = new Promise<JevResponse>((r) => { release = r; });
    const rows: RecallShadowRow[] = [];
    const ledger = join(root, 'shadow.jsonl');
    let lunaCalls = 0;
    const inj = await buildMemoryInjectionLLM(q, {
      judge: async () => { lunaCalls += 1; return `["${a.id.slice(0, 8)}"]`; },
      recallJev: { mode: 'shadow', audience: 'hq-seat', ledgerFile: ledger, onShadow: (r) => rows.push(r), deps: { table, transport: () => jevAnswer } },
    }, root);
    expect(lunaCalls).toBe(1);
    expect(inj.injectedIds).toContain(a.id);
    expect(rows).toHaveLength(0); // Jev still pending — the turn did not wait
    release({ model: 'jev-fake', answers: { useful: { type: 'choice', probabilities: { m1: 0.1, m2: 0.1, none: 0.8 } } } });
    for (let i = 0; i < 20 && rows.length === 0; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ luna: [a.id.slice(0, 8)], jev: [], agree: false, audience: 'hq-seat' });
    expect(readRecallShadow(ledger)).toHaveLength(1);
  });

  test('jev: luna is not called · Jev picks are injected · Jev failure → keyword fallback', async () => {
    const { root, a } = world();
    let lunaCalls = 0;
    const judge = async () => { lunaCalls += 1; return '[]'; };
    const seen: JevRequest[] = [];
    const inj = await buildMemoryInjectionLLM(q, {
      judge,
      recallJev: { mode: 'jev', audience: 'hq-seat', deps: { table, transport: async (req) => {
        seen.push(req);
        const rowsSent = (req.state as { candidates: Array<{ key: string; name: string }> }).candidates;
        const key = rowsSent.find((r) => r.name === 'Landing rule')!.key;
        return { model: 'jev-fake', answers: { useful: { type: 'choice', probabilities: { [key]: 0.9, none: 0.1 } } } };
      } } },
    }, root);
    expect(lunaCalls).toBe(0);
    expect(seen).toHaveLength(1);
    expect(inj.injectedIds).toContain(a.id);
    const down = await buildMemoryInjectionLLM(q, {
      judge, recallJev: { mode: 'jev', audience: 'hq-seat', deps: { table, transport: async () => { throw new Error('Jev HTTP 503'); } } },
    }, root);
    expect(lunaCalls).toBe(0);
    expect(down.injectedIds).toContain(a.id); // keyword fallback still finds the landing memory
  });

  test('luna: Jev is not asked', async () => {
    const { root } = world();
    let jevCalls = 0;
    await buildMemoryInjectionLLM(q, {
      judge: async () => '[]', recallJev: { mode: 'luna', audience: 'hq-seat', deps: { table, transport: async () => { jevCalls += 1; return { model: 'm', answers: {} }; } } },
    }, root);
    expect(jevCalls).toBe(0);
  });
});
