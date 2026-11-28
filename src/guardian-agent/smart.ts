// 수호자 v3 스마트 — reflect · plan · learn-knowhow · retro on the pulse (GUARDIAN-V3-SMART · LOOP-AGENT-V3-SMART-2 follow-up).
//
// S: the nine supervisors got the v3 hooks on the generic shell (#40557); the guardian is a bespoke body (thin pulse ⊕ seven
//    subs) outside that shell, so its sub actions and cards never looked back: the same failing action ran every cadence
//    forever, and nobody wrote down why it never worked.
// C: a per-agent TS branch would be the copy the kit rule forbids; the shell's hooks need a TickRun the pulse does not have.
// A: the SAME executor functions (src/loop-agent/v3/smart.ts: shellPlan · beginSmart · retroDue · writeRetro) driven from the
//    pulse — the data is the guardian agent.yaml (hook nodes · actions with fallback · soul · policies):
//      plan(action, target, kind) — before a sub acts: a knowhow line this agent learned («an action keeps failing on a
//                                   kind · cause») with the agent.yaml fallback → the fallback runs instead, citing the
//                                   knowhow id · the soul's do_not refuses an action it names.
//      record(...)                — every decided sub action is an outcome row (a pending one is judged at the NEXT pulse)
//                                   ⊕ one journal row (the retro and `eln loop agent journal` read it).
//      finish(kpi, outcome)       — reflect → same action failed lesson_repeat_min× in a row on one subject kind → ONE lesson
//                                   with the cause → ONE knowhow line (capped · marker-deduped) · KPI history · retro every
//                                   retro_every_h (the voice quotes the latest).
// 세 얼굴: 관측 = `<home>/v3/{actions.jsonl,lessons.json,retros.jsonl}` ⊕ journal ⊕ `plan`/`knowhow-learned`/`retro` cases /
//          판단 근거 = agent.yaml (no number in this file) / 수복과 인계 = every hook fail-open — a broken store never stops the pulse.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileAgentMemory, type AgentMemory } from '../loop-agent/memory.js';
import { appendJournal, type JournalRow } from '../loop-agent/journal.js';
import { beginSmart, fileSmartStore, humanMemory, readRetros, retroDue, retroLine, shellIntent, shellPlan, smartConfig, type ActionRow, type OutcomePort, type PlanLine, type SmartConfig } from '../loop-agent/v3/smart.js';
import type { GuardianDef } from './def.js';

export const GUARDIAN_KPI = 'unnormalized_cases';

export interface GuardianActRow {
  readonly action: string; readonly target: string; readonly kind: string; readonly ok: boolean; readonly line: string; readonly why?: string;
  /** judged later by the outcome port (at the next pulse) */
  readonly pending?: boolean;
  /** the failure cause the lesson ⊕ knowhow line carry (pending rows: the cause if the outcome is «not back») */
  readonly cause?: string;
}
export interface GuardianSmartReport { readonly plans: readonly PlanLine[]; readonly created: readonly string[]; readonly promoted: readonly string[]; readonly retro: string | null; readonly resolved: { acted: number; unacted: number } }
export interface GuardianSmart {
  readonly cfg: SmartConfig;
  /** The action to run for one planned sub action (the body's choice unless knowhow ⊕ fallback or the soul says otherwise). */
  plan(action: string, target: string, kind: string, why: string): PlanLine;
  record(row: GuardianActRow): void;
  finish(kpi: number | null, outcome?: OutcomePort): GuardianSmartReport;
}

/** The pulse's v3 session — null when the agent.yaml declares no hook node (or is not clean this process). */
export function openGuardianSmart(i: { stateRoot: string; now: Date; def: GuardianDef; l0: string; address?: string }): GuardianSmart | null {
  const cfg = i.def.compiled ? smartConfig(i.def.compiled) : null;
  if (!cfg) return null;
  const at = i.now.toISOString(); const address = i.address ?? 'GUARDIAN';
  const mem: AgentMemory = fileAgentMemory(i.stateRoot, 'guardian', i.l0);
  const store = fileSmartStore(mem.root);
  // the seed pack (graphs/loop-agents/guardian/knowhow.md · agent.yaml memory.knowhow) — hash-compared, written once per change
  try { const seed = i.def.compiled?.knowhowText ?? ''; if (seed.trim()) mem.seedKnowhow(seed, i.now); } catch { /* fail-open */ }
  const rows: ActionRow[] = []; const journal: JournalRow[] = []; const plans: PlanLine[] = [];
  let pack: { blocks: string[]; human: ReturnType<typeof humanMemory> } | null = null;
  const knowhowPack = () => {
    if (pack) return pack;
    let text = ''; try { text = mem.knowhow().text; } catch { text = ''; }
    let learnedText = ''; try { learnedText = readFileSync(join(mem.root, 'knowhow', 'learned.md'), 'utf8'); } catch { /* none yet */ }
    let lessons: ReturnType<AgentMemory['lessons']> = []; try { lessons = mem.lessons(); } catch { lessons = []; }
    pack = { blocks: text.split(/^(?=##\s+K-)/mu), human: humanMemory({ learnedText, lessons, self: address }) };
    return pack;
  };
  return {
    cfg,
    plan(action, target, kind, why) {
      const body: PlanLine = { action, target, why, cites: [], by: 'body' };
      try {
        const k = knowhowPack();
        const knowhowId = (marker: string): string | null => /^##\s+(K-[A-Z0-9-]+-\d+)/u.exec(k.blocks.find(b => b.includes(marker)) ?? '')?.[1] ?? null;
        const sp = shellPlan({ cfg, lessons: store.lessons(), knowhowId, planned: [{ action, target, why, kind: shellIntent(kind) }], human: k.human, failedOn: () => false });
        const line = sp.lines[0] ?? body;
        plans.push(line);
        if (line.from || line.refused) mem.appendCase({ at, kind: 'plan', subject: `${line.from ?? line.action}:${target}`, why: `${line.refused ? 'refused' : `→ ${line.action}`} · ${line.why}`.slice(0, 400), refs: [...line.cites].slice(0, 4), decidedBy: address, supervisedBy: i.l0 });
        return line;
      } catch { return body; }
    },
    record(r) {
      rows.push({ at, intent: shellIntent(r.kind), action: r.action, to: 'self', key: `${r.action}:${r.target}:${at}`,
        ...(r.pending ? {} : { outcome: r.ok ? 'acted' as const : 'unacted' as const, resolvedAt: at }), ...(r.cause || !r.ok ? { cause: (r.cause ?? r.line).slice(0, 200) } : {}) });
      journal.push({ v: 1, at, agent: 'guardian', status: r.ok ? 'acted' : 'failed', action: r.action, target: r.target, what: r.line.slice(0, 300), why: (r.why ?? '').slice(0, 300),
        before: null, after: null, evidence: [], undo: null, source: 'tick', by: address });
    },
    finish(kpi, outcome) {
      let created: string[] = []; let promoted: string[] = []; let resolved = { acted: 0, unacted: 0 }; let retroText: string | null = null;
      try {
        if (rows.length) store.writeActions([...store.actions(), ...rows]);
        // a row taken THIS pulse is judged at the next one (the world above is from before the action)
        const port: OutcomePort = row => (row.at === at ? null : outcome?.(row) ?? null);
        const s = beginSmart({ cfg, store, now: i.now, l0: i.l0, readings: [{ name: GUARDIAN_KPI, value: kpi }], outcome: port,
          knowhow: cfg.learn ? { text: () => mem.knowhow().text, add: (item, by, now) => mem.addKnowhow(item, by, now) } : null });
        s.save();
        created = [...s.learned.created]; promoted = [...s.learned.promoted]; resolved = s.reflection.resolved;
        for (const kid of promoted) mem.appendCase({ at, kind: 'knowhow-learned', subject: kid, why: s.lessons.find(l => l.promoted === kid)?.text.slice(0, 300) ?? kid, decidedBy: address, supervisedBy: i.l0 });
      } catch { /* fail-open */ }
      try { if (journal.length) appendJournal(mem.root, journal); } catch { /* fail-soft: cases keep the trace */ }
      try { const st = mem.readState(); st.kpiHistory = [...st.kpiHistory, { at, v: kpi }]; st.lastKpi = kpi; mem.writeState(st); } catch { /* fail-open */ }
      try {
        const st = store.state();
        if (retroDue(cfg, st, i.now)) {
          const k = i.def.kpis.find(x => x.name === GUARDIAN_KPI);
          const { writeRetro } = require('../loop-agent/runtime.js') as typeof import('../loop-agent/runtime.js');
          const e = writeRetro({ memory: mem, card: { id: 'guardian', kpi: { name: GUARDIAN_KPI, target: k?.target ?? 0, dir: k?.dir ?? 'at_most', unit: k?.unit ?? '' }, address, supervisor: i.l0 }, actions: cfg.actions, now: i.now, windowH: cfg.retroEveryH });
          retroText = retroLine(e); st.lastRetroAt = at;
        }
        store.writeState(st);
      } catch { /* fail-open */ }
      return { plans, created, promoted, retro: retroText, resolved };
    },
  };
}

/** The voice cards (soul.md ⊕ the agent.yaml soul block · goal ⊕ KPIs ⊕ done-when ⊕ never ⊕ the latest retro) — the voice
 *  prompt's first context (LOOP-AGENT §1 ② 영혼). */
export function guardianVoiceCards(def: GuardianDef, soulMd: string, stateRoot: string | null): { soulText: string; goalText: string; perHour: number } {
  const s = def.soul;
  const soulBlock = s ? ['## 영혼 (agent.yaml soul)', `- 목적: ${s.purpose}`, `- 가치: ${s.values.join(' · ')}`, `- 하지 않는 것: ${s.doNot.join(' · ')}`, `- 말투: ${s.voice}`, `- 섬기는 이: ${s.serves.join(' · ')}`].join('\n') : '';
  let retro = '';
  if (stateRoot) { try { const last = readRetros(join(stateRoot, 'loop-agents', 'guardian'), 1)[0]; retro = last ? retroLine(last) : ''; } catch { retro = ''; } }
  const goalText = [`목표: ${def.goal}`, ...def.kpis.map(k => `- KPI ${k.name} ${k.dir === 'at_most' ? '≤' : '≥'} ${k.target}${k.unit ? ` ${k.unit}` : ''}`),
    ...(def.doneWhen.length ? ['완료 조건:', ...def.doneWhen.map(d => `- ${d}`)] : []), ...(def.neverAuto.length ? ['스스로 하지 않음:', ...def.neverAuto.map(d => `- ${d}`)] : []),
    ...(def.subs.length ? [`서브 ${def.subs.length}: ${def.subs.map(x => `${x.name}(${x.id})`).join(' · ')}`] : []),
    ...(retro ? ['', `## 최근 회고 (eln loop agent guardian retro)`, retro] : [])].join('\n');
  return { soulText: [soulMd.trim() || '수호자 (guardian) — 자원국 · L0 = RES', soulBlock].filter(Boolean).join('\n\n'), goalText, perHour: def.voicePerHour || 0 };
}
