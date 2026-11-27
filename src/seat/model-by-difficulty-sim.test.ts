/**
 * SIM — MODEL-BY-DIFFICULTY (CEO 11-27 07:3x: 12 of 19 hands on glm-5.3, 7 on terra, whatever the cell). Seeds 1–5 draw
 * cells from tonight's shapes (hot files · security-4 · RED/tsc ids · docs/tests · prior attempts) and a codex window
 * between 50% and 99% used. Expect: the tier follows the facts (literal table), an account over 95% steps down with a
 * note (never a stall), the directive is written on assign and the SAME session switches provider/model at its next turn
 * (no relaunch) — once per directive, and back when the next cell is easy.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionProvider, setSessionProvider } from '../tui-client/session-provider.js';
import type { ChecklistItem } from '../release-loop/checklist.js';
import { applySeatModelDirective, cellDifficulty, directiveFor, directiveLine, pickHandModel, readSeatModelDirective, usedShareFromSnapshot, writeSeatModelDirective } from './model-by-difficulty.js';
import { seatAssign, type SeatAssignDeps } from './seat-assign.js';

const root = mkdtempSync(join(tmpdir(), 'model-by-difficulty-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
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
        modelFor: (s, item, paths) => { const d = directiveFor({ seat: s, cell: item.id, facts: { cellId: item.id, paths }, usedShare: share, by: 'seat-assign', now: new Date(now) }); writeSeatModelDirective(root, d); return { line: directiveLine(d), tier: d.tier }; },
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

// GLM-QUOTA (11-27 · status line «glm 5h 0% · week 100% ⚠»): easy = glm only under its cap; at/over it → OpenRouter's
// z-ai/glm-5.3; OpenRouter out too → step UP to luna. Read from the same snapshot the status line draws.
describe('easy tier under the Z.ai glm quota', () => {
  const snap = (zaiWeek: number, orLeft: number | null, orStatus = 'ok') => ({ ts: 1, accounts: [
    { provider: 'codex', account: 'team', usedPercent: 76, status: 'ok' }, { provider: 'codex', account: 'third', usedPercent: 57, status: 'ok' },
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
  test.each([
    [40, 895, 'glm', 'glm-5.3', undefined],
    [100, 895, 'openrouter', 'z-ai/glm-5.3', 'budget: glm at 100% (cap 95%) → openrouter/z-ai/glm-5.3'],
    [100, 0, 'openai-codex', 'gpt-6-luna', 'budget: glm at 100% (cap 95%) · openrouter at 100% (cap 95%) → openai-codex/gpt-6-luna'],
  ] as const)('glm week %d%% · OR $%d → %s/%s', (week, left, provider, model, note) => {
    const s = snap(week, left);
    const m = pickHandModel('easy', (p) => usedShareFromSnapshot(s, p));
    expect([m.provider, m.model]).toEqual([provider, model]);
    expect(m.note).toBe(note);
    expect(directiveLine({ ...m, reasons: ['docs/tests only'] })).toBe(`model: ${m.tier} → ${provider}/${model} (docs/tests only)${note ? ` · ${note}` : ''} — your tab switches at its next turn`);
  });
  test('every account over cap → the chain\'s last, noted — never a stall', () => {
    const m = pickHandModel('easy', () => 1);
    expect([m.provider, m.model]).toEqual(['openai-codex', 'gpt-6-luna']);
    expect(m.note).toContain('budget: every account over cap');
  });
});
