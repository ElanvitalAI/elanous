// SIM-WORLD supervisors — ELN-OP-CROWN-MEMORY (0.3.40 P0 · CEO 11-28 21:0x: «MK = 문서 P0 전담» (19:1x) was broken three times —
// eln OP assigned infra cells to MK). One scene drives the REAL pieces over a universe: the decisions ledger relay record
// (crownRecordInput with a directive → importRecorded) · the ONE «decision → pointer» door (legacy = pointDecisionToBus right
// after the record, as `eln decisions crown` does · graph = the decision-bus trigger node's ledger sweep as the backstop) · the
// directive card ledger ⊕ eln OP's memory file (src/memory.ts) · the REAL seatAssign with its directive check (only the mail /
// wake / owner write ports are recorded fakes) · the seat's ROLE.md. Five seeds, both engines. Expectations = independent literals.
//   CROWN-DIRECTIVE-ASSIGN-GUARD  directive 1 (MK only DOCS-*) → OP seat memory card (name crown-1128-mk-docs-only-<id> · pinned · words · seats · expiry) · S2 tail carries it on a turn without «MK» · MK ← an infra cell
//                                 refused 1 (code crown-directive · the line names the card, the words, the role) · MK ← a docs
//                                 cell assigned · another seat ← the infra cell assigned · after expiry → MK ← infra assigned ·
//                                 the expired memory card removed by the sweep
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DecisionLedger } from '../../../decisions/decision-ledger.js';
import { crownRecordInput, pointDecisionToBus } from '../../../kit/decision-bus/index.js';
import { CROWN_CARD_PREFIX, liveDirectiveRefusal, loadCrownDirectivePolicy, readDirectiveCards } from '../../../kit/crown-directive/index.js';
import { decisionBusSync } from '../../../loops/trigger-nodes.js';
import { findSeatMemory, readSeatMemoryIndex, seatMemoryDir } from '../../../seat-memory/seat-memory.js';
import { crownTurnTail } from '../../../seat-memory/seat-memory-layers.js';
import type { ChecklistItem } from '../../../release-loop/checklist.js';
import { seatAssign, type SeatAssignDeps } from '../../../seat/seat-assign.js';
import type { SimWorldEngine, SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const REPO = join(import.meta.dir, '..', '..', '..', '..');
const NOW = new Date('2026-11-28T12:00:00.000Z');
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const versions = () => ({ released: '0.3.39', dev: '0.3.40-dev.0', codename: null });
const CROWN = '\u{1F451}';
const nodeInput = (): Record<string, unknown> => {
  const g = parse(readFileSync(join(REPO, 'graphs', 'triggers', 'decision-bus.yaml'), 'utf8')) as { nodes: Array<{ input?: Record<string, unknown> }> };
  return g.nodes.find((n) => n.input)!.input!;
};
const cell = (id: string): ChecklistItem => ({ id, title: `${id} 칸`, status: 'yellow', priority: 'P0', updatedAt: '2026-11-28T00:00:00.000Z', updatedBy: 'OP' });

function deps(stateRoot: string, seatState: string, at: () => Date, calls: string[]): SeatAssignDeps {
  return {
    now: at,
    coordinators: () => ({ hq: 'OP', spaces: ['TC', 'MK', 'UX'] }),
    federationSeats: () => new Set(['OP', 'TC', 'MK', 'UX']),
    findCell: (id) => ({ version: '0.3.40', item: cell(id) }),
    writers: () => [],
    assign: (_v, id, seat) => { calls.push(`${id}→${seat}`); return { from: null, outcome: 'assigned' }; },
    post: () => ({ id: calls.length + 100 }),
    wake: async () => ({ result: 'injected' }),
    pool: () => ({ hosts: ['pool-host'], scope: 'sim', source: 'code-default' }),
    directiveRefusal: (q) => liveDirectiveRefusal(q, { stateRoot, seatState, now: at() }),
  };
}

async function guard(ctx: SimWorldScenarioContext, seed: number, engine: SimWorldEngine): Promise<SimWorldScenarioOutcome | null> {
  const tag = `crown-directive-${engine}-s${seed}`;
  const stateRoot = join(ctx.universeRoot, tag, 'state');
  const seatState = join(ctx.universeRoot, tag, 'seat-state');
  mkdirSync(join(seatState, 'MK'), { recursive: true });
  writeFileSync(join(seatState, 'MK', 'ROLE.md'), `# MK\n\n> 자리 카드\n\nMK = 마케팅·문서 자리 s${seed} — 홈페이지·문서 P0 전담.\n`);
  const recordedAt = new Date(NOW.getTime() - 10 * 60_000);
  const until = new Date(NOW.getTime() + 2 * 3_600_000).toISOString();
  const quote = `MK 는 문서 P0 만 하세요 · 인프라 주지 마세요 s${seed}`;
  const relay = crownRecordInput({ summary: `MK = 문서 P0 전담 s${seed}`, quote, at: recordedAt.toISOString(), seat: 'CLAUDE-OP',
    directive: { seats: ['MK'], only: ['DOCS-*'], never: [], until } });
  const ledger = new DecisionLedger({ stateDir: stateRoot, now: () => recordedAt, resolveVersion: versions, pointToBus: () => {} });
  const entry = ledger.importRecorded(relay.input, undefined, { kind: 'imported', source: relay.source }, relay.note);
  if (engine === 'legacy') pointDecisionToBus(stateRoot, entry, 'HQ', 'OP', recordedAt.getTime());
  else await decisionBusSync({ runId: 'sim', input: { stage: 'live', window: NOW.toISOString(), vars: { stateRoot, seatState } } as never, nodeInput: nodeInput() }, { now: recordedAt, git: null });

  const cards = readDirectiveCards(stateRoot);
  if (cards.length !== 1) return fail('cards', `${tag}: directive cards ${cards.length} (want 1)`);
  const c = cards[0]!;
  if (JSON.stringify([c.source, c.seats, c.only, c.expiresAt, c.actions]) !== JSON.stringify([`decision:${entry.id}`, ['MK'], ['DOCS-*'], until, ['assign', 'handoff']]))
    return fail('card-shape', `${tag}: ${JSON.stringify(c)}`);
  // eln OP's SEAT store (seat recall reads only it) · the name carries the action words · pinned = the index's first line
  const seatDir = seatMemoryDir('OP', join(stateRoot, 'elanous', 'memory'));
  const name = `crown-1128-mk-docs-only-${c.id.slice(3, 9)}`;
  const mem = findSeatMemory(seatDir, name);
  const wantBody = `${CROWN} 지시 카드 ${c.id} — MK = 문서 P0 전담 s${seed}\n원문: «${quote}»\n대상 자리: MK · 허용 칸 DOCS-*\n만료: ${until} · 출처: decision:${entry.id} · 배정/이관 직전 자동 대조(어긋나면 거절)`;
  if (!mem || mem.body.trim() !== wantBody || !readSeatMemoryIndex(seatDir).startsWith(`- [${name}]`)) return fail('memory-card', `${tag}: ${mem ? JSON.stringify({ name: mem.name, body: mem.body }) : `no seat card ${name}`} · index ${readSeatMemoryIndex(seatDir).slice(0, 120)}\nwant ${wantBody}`);
  // S2 — the card rides the tail of a turn whose words name neither MK nor a cell (a self-decided assign turn) · S1 — a long
  // session whose start snapshot predates the card gets the new index line too (here: only the card · S2 already carries it)
  const p = loadCrownDirectivePolicy();
  const caps = { prefix: CROWN_CARD_PREFIX, turnMaxCards: p.turnMaxCards, turnMaxChars: p.turnMaxChars, updateMaxChars: p.updateMaxChars };
  const tail = crownTurnTail({ seat: 'OP', dir: seatDir, nowMs: NOW.getTime(), snapshot: '- [older](older.md) — before the card' }, caps);
  if (!tail || JSON.stringify(tail.cards) !== JSON.stringify([name]) || !tail.text.includes(`원문: «${quote}»`) || tail.updates !== 0)
    return fail('turn-tail', `${tag}: ${JSON.stringify(tail)}`);

  let clock = NOW;
  const calls: string[] = [];
  const d = deps(stateRoot, seatState, () => clock, calls);
  const infra = `INFRA-HOST-S${seed}`;
  const refused = await seatAssign({ seat: 'MK', cellId: infra, actor: 'OP', caller: 'sim' }, d);
  const wantLine = `seat assign: ${CROWN} 지시 ${c.id} «${quote}» (범위 MK = 문서 P0 전담 s${seed} · 만료 ${until}) — ${infra} 는 MK 의 허용 칸(DOCS-*) 밖 · 자리 역할: MK = 마케팅·문서 자리 s${seed} — 홈페이지·문서 P0 전담. · assign 거절 — 다른 자리로 · 지시가 끝나면(만료·새 지시) 다시`;
  if (refused.ok || refused.code !== 'crown-directive' || refused.reason !== wantLine) return fail('refusal', `${tag}: ${JSON.stringify(refused)}\nwant ${wantLine}`);
  const docs = await seatAssign({ seat: 'MK', cellId: `DOCS-USER-FIRST-S${seed}`, actor: 'OP', caller: 'sim' }, d);
  const other = await seatAssign({ seat: 'TC', cellId: infra, actor: 'OP', caller: 'sim' }, d);
  if (!docs.ok || !other.ok) return fail('allowed', `${tag}: docs ${JSON.stringify(docs)} · TC ${JSON.stringify(other)}`);

  clock = new Date(NOW.getTime() + 3 * 3_600_000); // past the directive's expiry
  const after = await seatAssign({ seat: 'MK', cellId: infra, actor: 'OP', caller: 'sim' }, d);
  if (!after.ok) return fail('after-expiry', `${tag}: ${JSON.stringify(after)}`);
  if (JSON.stringify(calls) !== JSON.stringify([`DOCS-USER-FIRST-S${seed}→MK`, `${infra}→TC`, `${infra}→MK`])) return fail('assign-calls', `${tag}: ${JSON.stringify(calls)}`);
  // the sweep after expiry removes the memory card (the ledger card stays — history)
  await decisionBusSync({ runId: 'sim', input: { stage: 'live', window: clock.toISOString(), vars: { stateRoot, seatState } } as never, nodeInput: nodeInput() }, { now: clock, git: null });
  if (findSeatMemory(seatDir, name)) return fail('memory-expired', `${tag}: seat card ${name} still there after expiry`);
  if (crownTurnTail({ seat: 'OP', dir: seatDir, nowMs: clock.getTime(), snapshot: null }, caps)) return fail('tail-after-expiry', `${tag}: tail still carries a card`);
  ctx.recorder.event('crown-directive:guard', { seed, engine, refused: 1 });
  return null;
}

export const simWorldScenarios: readonly SimWorldScenario[] = [
  {
    id: 'CROWN-DIRECTIVE-ASSIGN-GUARD',
    title: 'CEO directive «MK = docs P0 only» → memory card (pinned) · MK ← infra cell refused 1 (card · words · role) · docs cell / other seat assigned · after expiry assigned · memory card removed',
    async run(ctx) {
      for (const seed of [0, 1, 2, 3, 4].map((i) => ctx.seed + i)) { const out = await guard(ctx, seed, ctx.engine); if (out) return out; }
      ctx.recorder.event('crown-directive:scene', { scenario: ctx.scenarioId, engine: ctx.engine, seeds: 5 });
      return { ok: true };
    },
  },
];
