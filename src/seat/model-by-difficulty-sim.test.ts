/**
 * SIM — MODEL-BY-DIFFICULTY (CEO 11-27 07:3x: 12 of 19 hands on glm-5.3, 7 on terra, whatever the cell). Seeds 1–5 draw
 * cells from tonight's shapes (hot files · security-4 · RED/tsc ids · docs/tests · prior attempts) and a codex window
 * between 50% and 99% used. Expect: the tier follows the facts (literal table), an account over 95% steps down with a
 * note (never a stall), the directive is written on assign and the SAME session switches provider/model at its next turn
 * (no relaunch) — once per directive, and back when the next cell is easy.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionProvider, setSessionProvider } from '../tui-client/session-provider.js';
import type { ChecklistItem } from '../release-loop/checklist.js';
import { applySeatModelDirective, cellDifficulty, directiveFor, directiveLine, handPlan, pickHandModel, readSeatModelDirective, usedShareFromSnapshot, writeSeatModelDirective } from './model-by-difficulty.js';
import { seatAssign, type SeatAssignDeps } from './seat-assign.js';

import { resetLlmAccountPackCache } from '../kit/resource-facts/llm-accounts.js';
import { resetLlmDecisionCache } from '../kit/resource-facts/llm-decide.js';

const root = mkdtempSync(join(tmpdir(), 'model-by-difficulty-'));
// Hermetic pack: the repo pack, no live overlay, an empty ledger (the host's ~/.elanous never decides a test).
const PACK_ENV = ['LLM_ACCOUNT_POLICY_PACK', 'LLM_ACCOUNT_POLICY_OVERLAY', 'RESOURCE_FACTS_LEDGER', 'ELANOUS_STATE_DIR'] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of PACK_ENV) savedEnv[k] = process.env[k];
  const dir = join(root, 'policy'); mkdirSync(dir, { recursive: true });
  copyFileSync(join(import.meta.dir, '../../graphs/policies/llm-accounts.yaml'), join(dir, 'pack.yaml'));
  process.env.LLM_ACCOUNT_POLICY_PACK = join(dir, 'pack.yaml'); process.env.LLM_ACCOUNT_POLICY_OVERLAY = join(dir, 'no-overlay.yaml');
  process.env.RESOURCE_FACTS_LEDGER = join(dir, 'events.jsonl'); process.env.ELANOUS_STATE_DIR = join(root, 'state');
  resetLlmAccountPackCache(); resetLlmDecisionCache();
});
afterAll(() => {
  for (const k of PACK_ENV) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  resetLlmAccountPackCache(); resetLlmDecisionCache();
  rmSync(root, { recursive: true, force: true });
});
function rng(seed: number): () => number { let a = seed; return () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; }; }

describe('difficulty from facts — literal table', () => {
  test.each([
    ['ELS-ATTACH-FIX', ['src/attach/attach-app.ts', 'src/els/server.ts'], 0, 'hard'],
    ['TUI-ENTRY-X', ['src/tui/entry.ts'], 1, 'hard'],
    ['MAIN-RED-SIM-CATALOG', ['src/sim/a.test.ts'], 0, 'medium'],
    ['AUTH-TOKEN-ROTATE', ['src/oauth/codex-account-store.ts'], 0, 'medium'],
    ['WIDE-REFACTOR', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'], 0, 'medium'],
    ['DOCS-UMBRELLA-SYNC', ['docs/handbook/OPERATIONS.md', 'docs/x.md'], 0, 'easy'],
    ['COPY-EN-SWEEP', ['src/els/copy.ts'], 0, 'easy'],
    ['TEST-ONLY', ['src/x/a.test.ts', 'src/x/b.test.ts', 'src/x/c.test.ts'], 0, 'easy'],
  ] as const)('%s → %s', (cellId, paths, prior, tier) => {
    expect(cellDifficulty({ cellId, paths: [...paths], priorAttempts: prior }).tier).toBe(tier);
  });
});

describe('SIM model routing — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: tier by facts · budget step-down with a note · the same session switches at its next turn`, async () => {
      const r = rng(seed);
      const used = 0.5 + r() * 0.49;
      const share = (p: string) => (p === 'openai-codex' ? used : null);
      // budget: over 95% → hard/medium step down to glm with a note; under → as scored
      for (const tier of ['hard', 'medium', 'easy'] as const) {
        const m = pickHandModel(tier, share);
        if (used >= 0.95 && tier !== 'easy') { expect(m.model).toBe('glm-5.3'); expect(m.note).toContain('budget: openai-codex at'); }
        else expect(m.tier).toBe(tier);
      }
      // seatAssign writes the directive and puts the tier in the mail
      const seat = `TC-H-CX-${seed}`;
      const hard: ChecklistItem = { id: `ELS-ATTACH-${seed}`, title: `대상 경로: src/attach/attach-app.ts · src/els/server.ts`, status: 'yellow', priority: 'P0', updatedAt: '2026-11-26T10:00:00.000Z', updatedBy: 'OP' } as ChecklistItem;
      const easy: ChecklistItem = { id: `DOCS-${seed}`, title: `대상 경로: docs/handbook/OPERATIONS.md`, status: 'yellow', priority: 'P1', updatedAt: '2026-11-26T10:00:00.000Z', updatedBy: 'OP' } as ChecklistItem;
      const items = new Map([[hard.id, hard], [easy.id, easy]]);
      let now = Date.parse('2026-11-27T07:40:00.000Z');
      const posted: string[] = [];
      const deps: SeatAssignDeps = {
        now: () => new Date(now), coordinators: () => ({ hq: 'OP', spaces: ['TC'] }), federationSeats: () => new Set(['OP', 'TC', seat]),
        findCell: (id) => (items.has(id) ? { version: '0.3.38', item: items.get(id)! } : undefined), writers: () => [],
        assign: () => ({ from: null, outcome: 'assigned' }), post: (mail) => { posted.push(mail.body); return { id: posted.length }; },
        wake: async () => ({ result: 'injected' }), pool: () => ({ hosts: ['minim5'], scope: 'x', source: 'code-default' }),
        modelFor: (s, item, paths) => { const d = directiveFor({ seat: s, cell: item.id, facts: { cellId: item.id, paths }, usedShare: share, by: 'seat-assign', now: new Date(now) }); writeSeatModelDirective(root, d!); return { line: directiveLine(d!), tier: d!.tier }; },
      };
      const sessionId = `sess-${seed}`;
      const sel = (id: string, x: { provider: string; model: string }) => setSessionProvider(id, x as Parameters<typeof setSessionProvider>[1]);
      setSessionProvider(sessionId, { provider: 'glm', model: 'glm-5.3' }); // the hand started on glm
      expect((await seatAssign({ seat, cellId: hard.id, actor: 'OP' }, deps)).ok).toBe(true);
      const want = used >= 0.95 ? 'glm-5.3' : 'gpt-6.1-terra';
      expect(posted[0]).toContain(`→ ${used >= 0.95 ? 'glm/glm-5.3' : 'openai-codex/gpt-6.1-terra'}`);
      expect(readSeatModelDirective(root, seat)?.cell).toBe(hard.id);
      // the hand's next turn: the same session switches (no relaunch), once
      const first = applySeatModelDirective({ root, seat, sessionId, lastAppliedAt: null, select: sel });
      expect(first?.model).toBe(want);
      expect(getSessionProvider(sessionId)?.model).toBe(want);
      expect(applySeatModelDirective({ root, seat, sessionId, lastAppliedAt: first!.at, select: sel })).toBe(null);
      // next cell is docs → back to glm on the same session
      now += 60_000;
      expect((await seatAssign({ seat, cellId: easy.id, actor: 'OP' }, deps)).ok).toBe(true);
      const second = applySeatModelDirective({ root, seat, sessionId, lastAppliedAt: first!.at, select: sel });
      expect(second?.tier).toBe('easy');
      expect(getSessionProvider(sessionId)).toEqual({ provider: 'glm', model: 'glm-5.3' });
    });
  }
});

// GLM-QUOTA (11-27 · status line «glm 5h 0% · week 100% ⚠») ⊕ FALLBACK-SUBSCRIPTION-FIRST (대표 11-28 12:3x): easy = glm under its
// cap; at/over it → a SUBSCRIPTION with headroom (codex luna) before any paid credits; OpenRouter's z-ai/glm-5.3 only once codex is
// full too. Read from the same snapshot the status line draws.
describe('easy tier under the Z.ai glm quota', () => {
  const snap = (zaiWeek: number, orLeft: number | null, orStatus = 'ok', codex: [number, number] = [76, 57]) => ({ ts: 1, accounts: [
    { provider: 'codex', account: 'team', usedPercent: codex[0], status: 'ok' }, { provider: 'codex', account: 'third', usedPercent: codex[1], status: 'ok' },
    { provider: 'codex', account: 'default', usedPercent: null, status: 'error' },
    ...(orLeft === null ? [] : [{ provider: 'openrouter', account: 'credits', usedPercent: null, leftUsd: orLeft, status: orStatus }]),
    { provider: 'zai', account: '5h', usedPercent: 0, status: 'ok' }, { provider: 'zai', account: 'week', usedPercent: zaiWeek, status: 'ok' },
  ] });
  test('snapshot reads: codex = best account · glm = fullest window · openrouter = balance gone → 1', () => {
    expect(usedShareFromSnapshot(snap(100, 895), 'openai-codex')).toBe(0.57);
    expect(usedShareFromSnapshot(snap(100, 895), 'glm')).toBe(1);
    expect(usedShareFromSnapshot(snap(100, 895), 'openrouter')).toBe(0);
    expect(usedShareFromSnapshot(snap(100, 0), 'openrouter')).toBe(1);
    expect(usedShareFromSnapshot(snap(100, 5, 'error'), 'openrouter')).toBe(1);
    expect(usedShareFromSnapshot(null, 'glm')).toBe(null);
  });
  const noCodexCredits = { creditsAllowed: (payer: string) => payer === 'openrouter' };
  test.each([
    [40, 895, [76, 57], 'glm', 'glm-5.3', undefined],
    [100, 895, [76, 57], 'openai-codex', 'gpt-6-luna', 'budget: glm at 100% (cap 95%) → openai-codex/gpt-6-luna (subscription headroom)'],
    [100, 0, [76, 57], 'openai-codex', 'gpt-6-luna', 'budget: glm at 100% (cap 95%) → openai-codex/gpt-6-luna (subscription headroom)'],
    [100, 895, [99, 98], 'openrouter', 'z-ai/glm-5.3', 'budget: glm at 100% (cap 95%) · openai-codex at 98% (cap 95%) → openrouter/z-ai/glm-5.3 (paid credits — no subscription headroom)'],
  ] as const)('glm week %d%% · OR $%d · codex %j → %s/%s', (week, left, codex, provider, model, note) => {
    const s = snap(week, left, 'ok', [...codex]);
    const m = pickHandModel('easy', (p) => usedShareFromSnapshot(s, p), noCodexCredits);
    expect([m.provider, m.model]).toEqual([provider, model]);
    expect(m.note).toBe(note);
    if (m.none) throw new Error('expected a model');
    expect(directiveLine({ ...m, reasons: ['docs/tests only'] })).toBe(`model: ${m.tier} → ${provider}/${model} (docs/tests only)${note ? ` · ${note}` : ''} — your tab switches at its next turn`);
  });
  // Terra #40656 r1 ④: every candidate refused → an explicit «none» (no directive) — never the list's last paid model as a bypass
  test('every account over cap and OpenRouter balance gone → none · no paid bypass · no directive', () => {
    const m = pickHandModel('easy', () => 1, noCodexCredits);
    expect([m.none, m.provider, m.model]).toEqual([true, undefined, undefined]);
    expect(m.note).toBe('budget: no candidate (glm at 100% (cap 95%) · openai-codex at 100% (cap 95%) · openrouter at 100% (cap 95%)) — no paid bypass · no directive');
    for (const tier of ['hard', 'medium'] as const) expect(pickHandModel(tier, () => 1, noCodexCredits).none).toBe(true);
    expect(directiveFor({ seat: 'S', cell: 'C', facts: { cellId: 'C', paths: ['docs/a.md'] }, usedShare: () => 1, by: 't', now: new Date(0), pick: noCodexCredits })).toBe(null);
  });
  // Terra #40656 r1 ⑤: a tier whose every model is forbidden for the use → none — never the forbidden first model
  test('only GLM in the plan · review → none (GLM never returned)', () => {
    const glmOnly = { tiers: { hard: handPlan().tiers.easy.slice(0, 2), medium: handPlan().tiers.easy.slice(0, 2), easy: handPlan().tiers.easy.slice(0, 2) }, fallback: handPlan().fallback, source: 'pack' as const };
    const m = pickHandModel('easy', () => 0, { use: 'review', plan: glmOnly, ...noCodexCredits });
    expect([m.none, m.model]).toEqual([true, undefined]);
    expect(m.note).toBe('budget: no model of easy may serve review (glm/glm-5.3 never for review · openrouter/z-ai/glm-5.3 never for review) — no directive');
  });
  test('unknown usage is said as unknown, never as headroom', () => {
    const m = pickHandModel('easy', () => null, noCodexCredits);
    expect([m.provider, m.model, m.via, m.note]).toEqual(['glm', 'glm-5.3', 'subscription-headroom', undefined]);
    const n = pickHandModel('easy', (p) => (p === 'glm' ? 1 : null), noCodexCredits);
    expect(n.note).toBe('budget: glm at 100% (cap 95%) → openai-codex/gpt-6-luna (subscription — usage unknown)');
  });
  test('the plan comes from the pack (hand_models) — tiers and fallback steps are YAML', () => {
    expect(handPlan().source).toBe('pack');
    expect(handPlan().fallback).toEqual(['subscription-headroom', 'credits-by-balance']);
    expect(handPlan().tiers.easy.map(m => `${m.provider}/${m.model}@${m.accounts}`)).toEqual(['glm/glm-5.3@zai', 'openrouter/z-ai/glm-5.3@openrouter', 'openai-codex/gpt-6-luna@openai-codex']);
  });
  test('review never runs GLM (zai or OpenRouter) — whatever the budget', () => {
    for (const tier of ['hard', 'medium', 'easy'] as const) {
      const m = pickHandModel(tier, (p) => (p === 'openai-codex' ? 1 : 0), { use: 'review', ...noCodexCredits });
      expect((m.model ?? '').includes('glm')).toBe(false);
    }
  });
});
