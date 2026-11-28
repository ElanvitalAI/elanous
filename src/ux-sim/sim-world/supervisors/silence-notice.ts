// SIM-WORLD supervisors · SILENCE-NOTICE-NOT-REQUEST (0.3.39 · 대표 11-28 17:3x «루프 에이전트 임무 완수» · KPI 123 in breach 27 h)
//   SUP-SILENCE-NOTICE — on a REAL message ledger (MsgStore in the universe) with the real card ⊕ runtime and the live deps
//   (only the bell, the readers, the post port and the cell history are fakes): 10 notices still stored as requests
//   (4 work-block cards ⊕ 3 info ⊕ 3 coord, needsAck=1 as before the notice policy) + 5 requests (3 of them answered in the
//   cell ledger) → the first tick counts 5 (notices never), settles 3, closes all 10 notices (TC 7 · UX 3) and rings TC once
//   for its 2 open requests — no bell for UX (notices only); the next tick counts 2. close-notice is undone exactly by
//   reopen-notice (the ack row goes back to «none»), a reopened notice is never closed again, and a work-block card posted
//   now is stored needsAck=0 (the post path's shared default). 5 seeds · legacy (tickAgent) + graph (agent.yaml step graph).
// Expectations are independent literals (rule 11).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCard } from '../../../loop-agent/card.js';
import { fileAgentMemory } from '../../../loop-agent/memory.js';
import { readJournal } from '../../../loop-agent/journal.js';
import { tickAgent, type AgentPorts, type TickReport } from '../../../loop-agent/runtime.js';
import { supervisorTick } from '../../../loop-agent/v3/supervisor.js';
import { createBody, ledgerAnswerFrom, liveDeps, type CellEvent, type SilenceDeps } from '../../../loop-agent/bodies/silence-watch.js';
import { MsgStore } from '../../../msg/msg-store.js';
import type { SimWorldScenario, SimWorldScenarioContext, SimWorldScenarioOutcome } from '../types.js';

const MIN = 60_000;
const fail = (reason: string, diff: string): SimWorldScenarioOutcome => ({ ok: false, reason, diff });
const seedsOf = (ctx: SimWorldScenarioContext): number[] => [0, 1, 2, 3, 4].map(i => ctx.seed + i);
const sortNum = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

interface World { readonly store: MsgStore; readonly requests: number[]; readonly answered: number[]; readonly notices: { TC: number[]; UX: number[] }; readonly fresh: number }

/** The ledger as the live census found it: notices stored as requests before the policy, real asks next to them. */
function seedLedger(db: string, seed: number): World {
  mkdirSync(join(db, '..'), { recursive: true });
  const store = new MsgStore(db);
  const requests: number[] = []; const answered: number[] = [];
  for (let i = 0; i < 5; i++) {
    const cell = i < 3 ? [`cell:SIM-NOTICE-${seed}-${i}`] : [];
    const m = store.post({ from: 'OP', to: 'TC', body: `work ${i} (seed ${seed})`, kind: 'request', intent: 'request', needsAck: true, ...(cell.length ? { refs: cell } : {}) });
    requests.push(m.id); if (i < 3) answered.push(m.id);
  }
  const TC: number[] = []; const UX: number[] = [];
  for (let i = 0; i < 4; i++) TC.push(store.append({ from: 'ORCHESTRATOR', to: 'TC', body: `[행정관 · OP] 칸 SIM-B${i} 이(가) TC-H-${i} 을(를) 기다립니다`, kind: 'steward-exception', intent: 'request', needsAck: true, refs: [`cell:SIM-B${i}`, `blocked-on:TC-H-${i}`, 'steward:OP'] }).id);
  for (let i = 0; i < 3; i++) TC.push(store.post({ from: 'UX', to: 'TC', body: `fyi ${i}`, kind: 'info', intent: 'request', needsAck: true }).id);
  for (let i = 0; i < 3; i++) UX.push(store.post({ from: 'TC', to: 'UX', body: `coord ${i}`, kind: 'coord', intent: 'request', needsAck: true }).id);
  // the post path today: the same work-block card without an explicit needsAck → the shared notice default
  const fresh = store.append({ from: 'ORCHESTRATOR', to: 'TC', body: '[행정관 · OP] 칸 SIM-NEW 이(가) TC-H-9 을(를) 기다립니다', kind: 'steward-exception', intent: 'request', refs: ['cell:SIM-NEW', 'blocked-on:TC-H-9', 'steward:OP'] }).id;
  return { store, requests, answered, notices: { TC, UX }, fresh };
}

export const simWorldScenarios: SimWorldScenario[] = [
  {
    id: 'SUP-SILENCE-NOTICE',
    title: 'silence-watch on a real ledger: 10 notices + 5 requests (3 answered in the cell ledger) → KPI 5 then 2 · settles 3 · 10 notices closed (TC 7 · UX 3) · one bell to TC, none for notices · reopen-notice is the exact undo · a new work-block card stores needsAck=0',
    async run(ctx) {
      for (const seed of seedsOf(ctx)) {
        const root = join(ctx.universeRoot, `silence-notice-${ctx.engine}-s${seed}`);
        const db = join(root, 'msg', 'messages.db');
        const w = seedLedger(db, seed);
        const t0 = Date.now() + (40 + seed) * MIN; // every mail is past the 30-min SLA, all inside the 24 h window
        const cellAnswered = new Set(w.answered.map((_, i) => `SIM-NOTICE-${seed}-${i}`));
        const history = (cell: string): readonly CellEvent[] => (cellAnswered.has(cell) ? [{ at: new Date(t0 - 10 * MIN).toISOString(), by: 'TC', field: 'evidence', to: 'done in the cell' }] : []);
        const rung: Array<[string, number]> = [];
        const deps: SilenceDeps = {
          ...liveDeps(root, 'SILENCE-WATCH', db),
          readers: (_now, addrs) => new Map(addrs.map(a => [a, true] as const)),
          stalled: () => [],
          ring: (to, id) => { rung.push([to, id]); return true; },
          post: () => null,
          ledgerAnswer: m => ledgerAnswerFrom(m, history),
        };
        const card = loadCard('silence-watch');
        mkdirSync(root, { recursive: true });
        const memory = fileAgentMemory(root, 'silence-watch', 'OP');
        memory.setLevel('live', 'OP', 'sim: live');
        const ports: AgentPorts = { memory, post: () => null, beat: () => undefined, speak: () => undefined, llm: null };
        const body = createBody({ stateRoot: root, card }, deps);
        const tick = async (at: number): Promise<TickReport> => (ctx.engine === 'graph' ? (await supervisorTick(card, body, ports, new Date(at))).report : tickAgent(card, body, ports, new Date(at)));
        const r1 = await tick(t0);
        const r2 = await tick(t0 + 5 * MIN);
        const store = w.store;
        const settled = w.requests.filter(id => store.listReceipts({ messageId: id }).some(r => r.state === 'done'));
        const closedTC = w.notices.TC.filter(id => store.explicitAck('TC', id) === 'done');
        const closedUX = w.notices.UX.filter(id => store.explicitAck('UX', id) === 'done');
        const open = w.requests.filter(id => !w.answered.includes(id));
        const rows = readJournal(memory.root, t0 - 60 * MIN, t0 + 60 * MIN).filter(r => r.status === 'acted');
        ctx.recorder.event('sup:silence-notice', { seed, engine: ctx.engine, kpi: [r1.kpi, r2.kpi], settled: settled.length, closed: [closedTC.length, closedUX.length], rung, acted: rows.map(r => `${r.action}:${r.target}`) });
        if (r1.kpi !== 5 || r2.kpi !== 2) { store.close(); return fail('kpi', `seed ${seed}/${ctx.engine}: KPI ${r1.kpi} → ${r2.kpi} (want 5 → 2)`); }
        if (JSON.stringify(sortNum(settled)) !== JSON.stringify(sortNum(w.answered))) { store.close(); return fail('settle', `seed ${seed}/${ctx.engine}: settled ${JSON.stringify(settled)} (want the 3 ledger-answered ${JSON.stringify(w.answered)})`); }
        if (closedTC.length !== 7 || closedUX.length !== 3) { store.close(); return fail('close-notice', `seed ${seed}/${ctx.engine}: closed TC ${closedTC.length}/7 · UX ${closedUX.length}/3 · tick1 acted ${JSON.stringify(r1.acted)} · refused ${JSON.stringify(r1.refused)}`); }
        if (rung.length !== 1 || rung[0]![0] !== 'TC' || !open.includes(rung[0]![1])) { store.close(); return fail('bells', `seed ${seed}/${ctx.engine}: rung ${JSON.stringify(rung)} (want one bell to TC for one of ${JSON.stringify(open)})`); }
        const actedKinds = rows.map(r => `${r.action}:${r.target}`).sort();
        if (JSON.stringify(actedKinds) !== JSON.stringify(['close-notice:TC', 'close-notice:UX', 'redeliver:TC', 'settle:TC'])) { store.close(); return fail('journal', `seed ${seed}/${ctx.engine}: acted ${JSON.stringify(actedKinds)}`); }
        const closeRow = rows.find(r => r.action === 'close-notice' && r.target === 'UX');
        if (!closeRow || closeRow.after !== `closed UX ${w.notices.UX.map(id => `${id}:none`).join(',')}`) { store.close(); return fail('journal-after', `seed ${seed}/${ctx.engine}: close-notice UX after «${closeRow?.after}»`); }
        // undo: reopen-notice through the body (the L0's voice path) puts the ack row back to «none»; the next tick leaves it open
        const state = memory.readState();
        const undo = await body.actions['reopen-notice']!.run(String(w.notices.UX[0]), { now: new Date(t0 + 6 * MIN), card, state, recall: null, level: 'live', obs: { kpi: 2, subjects: [], facts: [] }, by: 'OP' });
        memory.writeState(state);
        if (!undo.ok || store.explicitAck('UX', w.notices.UX[0]!) !== null) { store.close(); return fail('undo', `seed ${seed}/${ctx.engine}: reopen-notice ${JSON.stringify(undo)} · ack now ${store.explicitAck('UX', w.notices.UX[0]!)}`); }
        const r3 = await tick(t0 + 70 * MIN);
        if (store.explicitAck('UX', w.notices.UX[0]!) !== null || r3.kpi !== 2) { store.close(); return fail('reclose', `seed ${seed}/${ctx.engine}: reopened notice ack ${store.explicitAck('UX', w.notices.UX[0]!)} · KPI ${r3.kpi} (want none · 2)`); }
        if (rung.length !== 1) { store.close(); return fail('rebell', `seed ${seed}/${ctx.engine}: ${rung.length} bells after 3 ticks (want 1)`); }
        const fresh = store.getMessage(w.fresh);
        store.close();
        if (fresh?.needsAck !== false) return fail('sender-default', `seed ${seed}/${ctx.engine}: a new work-block card stored needsAck=${fresh?.needsAck} (want false)`);
      }
      return { ok: true };
    },
  },
];
