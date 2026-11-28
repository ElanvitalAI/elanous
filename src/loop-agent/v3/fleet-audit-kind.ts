// LOOP-AGENT v3 executor kind `fleet-audit.observe` — audit a fleet of loop agents (SUPERVISOR-AUDITOR-LOOP · 0.3.39 ·
// 대표 11-28 16:5x «스스로 돌아가도록» · 08:4x «신규 감독 = 플러그인»).
//
// S: the hourly supervisor audit and the 15-min live check ran in a Claude session cron (shell + `eln loop agent <id>` text).
// C: a new supervisor is a plugin — an agent.yaml instance on a shared kind, no agent-specific TS. Any agent.yaml whose body
//    entry node is this kind gets this body (src/loop-agent/registry.ts registerKindBody): an HQ auditor today, a kingdom's own
//    fleet auditor tomorrow, each with its own policies.
// A: observe = kit/fleet-audit over every agent home (memory.ts · journal.ts readers) ⊕ the trigger registry rows → KPI
//    `watch_only_agents` ⊕ one subject per flagged agent · plan = the kit ladder (≤ heal_max_per_tick) ⊕ one `report` per tick
//    ⊕ `notify-red` once per red episode · actions = the doors: `refire` (trigger registry requestFire — the registry's own tick
//    runs it) · `owner-card` (deduped mail to the agent's L0 with its top refusal) · `l0-hand` (✋ to this agent's L0) ·
//    `report` (ledger file ⊕ HQ bus status line ⊕ the hourly OP summary mail) · `notify-red` (OP mail ⊕ telegram, once).
//
// 세 얼굴: 관측 = the homes and the registry (fail open: an unreadable fleet = KPI «모름», never 0) / 판단 근거 = the agent.yaml
//          policies through pn() (kit fleetPolicy) / 수복과 인계 = the ladder (each rung once per episode · rung_wait_min apart)
//          ⊕ red → OP ⊕ telegram once · every door is a port (sims inject them · live = the existing doors below).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BodyEnv } from '../registry.js';
import type { ActionResult, AgentBody, Observation, PlannedAction, Subject } from '../runtime.js';
import { agentHome } from '../memory.js';
import { readJournal } from '../journal.js';
import { pn } from '../policy-context.js';
import {
  fleetPolicy, healPlan, hourKey, judgeFleet, ledgerTable, noteRung, readAuditMemory, readFleetReading, redStep, rollScores, summaryLines, writeAuditMemory,
  flagKo, whyLine, withListed, type AuditMemory, type FleetFlag, type FleetMember, type FleetPolicy, type FleetReading, type FleetVerdict, type HealStep,
} from '../../kit/fleet-audit/index.js';

export const FLEET_AUDIT_KIND = 'fleet-audit.observe';

export interface FleetAuditDeps {
  /** The fleet to audit (self excluded) · null = the definitions / registry could not be read. */
  members(): FleetMember[] | null;
  reading(m: FleetMember, now: Date, windowMin: number): FleetReading | null;
  /** Ask the trigger registry to run `trigger` on its next tick. */
  refire(trigger: string, reason: string, now: Date): { ok: boolean; line: string };
  /** Deduped mail from this agent (null = already sent · false = could not send). */
  post(key: string, to: string, body: string, kind: string): number | string | null | false;
  /** One status line into the HQ bus space (deduped by key). */
  bus(key: string, body: string, now: Date): 'posted' | 'duplicate' | 'failed';
  /** The CEO channel (telegram) — true = delivered. */
  notify(line: string, key: string): Promise<boolean> | boolean;
}

const HEAL_DESCRIBE: Readonly<Record<HealStep['action'], string>> = {
  refire: '틱이 멈춘 루프 에이전트의 트리거를 레지스트리에 한 번 요청한다(다음 레지스트리 틱이 실행 · 목표 확인·재시도·예외 카드는 레지스트리 몫) — 되돌릴 것 없음',
  'owner-card': '보기만 하는(또는 재기동으로 안 돌아온) 루프 에이전트의 L0 에 카드 한 장 — 가장 많은 거절 이유와 확인 명령',
  'l0-hand': '주인 카드 뒤에도 그대로면 이 감사관의 L0 에 ✋ 한 장',
};

export function createFleetAuditBody(env: BodyEnv, deps: FleetAuditDeps = liveFleetAuditDeps(env)): AgentBody {
  const home = agentHome(env.stateRoot, env.card.id);
  let verdicts: FleetVerdict[] = []; let steps: HealStep[] = []; let red = { red: false, due: false, sinceMin: null as number | null };
  let mem: AuditMemory = readAuditMemory(home); let policy: FleetPolicy | null = null;

  const observe = (ctx: { now: Date }): Observation => {
    const p = policy = fleetPolicy(pn);
    mem = readAuditMemory(home);
    const members = deps.members();
    if (members === null) { verdicts = []; steps = []; return { kpi: null, subjects: [], facts: ['루프 에이전트 정의·레지스트리 읽기 실패 → 모름'] }; }
    const readings: FleetReading[] = []; const unread: string[] = [];
    for (const m of members) { const r = deps.reading(m, ctx.now, p.windowMin); if (r) readings.push(r); else unread.push(m.id); }
    verdicts = judgeFleet(readings, p, ctx.now);
    rollScores(mem, verdicts, ctx.now);
    steps = healPlan(verdicts, mem, p, ctx.now);
    const watchOnly = verdicts.filter(v => v.flags.includes('watch-only')).length;
    red = redStep(mem, watchOnly, p, ctx.now);
    writeAuditMemory(home, mem);
    const subjects: Subject[] = verdicts.filter(v => v.flags.length).map(v => ({ id: v.id, kind: v.flags[0]!, summary: `${v.flags.map(flagKo).join(' · ')} · ${whyLine(v)}`.slice(0, 240), ...(v.tickAgeMin !== null ? { ageMin: v.tickAgeMin } : {}) }));
    const auditAge = mem.lastAuditAt ? Math.round((ctx.now.getTime() - Date.parse(mem.lastAuditAt)) / 60_000) : null;
    const n = (f: FleetFlag) => verdicts.filter(v => v.flags.includes(f)).length;
    const facts = [
      `루프 에이전트 ${members.length} · 읽음 ${readings.length}${unread.length ? ` · 못 읽음 ${unread.join(',')}` : ''} · 보기만 함 ${watchOnly} · 거짓 초록 ${n('false-green')} · 틱 정지 ${n('tick-stale')} · KPI 없음 ${n('kpi-missing')}`,
      `audit_age_min ${auditAge ?? '?'} · 빨강 ${red.red ? `예(${Math.round(red.sinceMin ?? 0)}분)` : '아님'} · 사다리 ${steps.map(s => `${s.action}:${s.target}`).join(', ') || '없음'}`,
    ];
    // no outcome patterns: the ladder itself is the memory (one rung per episode) — a lesson candidate per tick would be L0 noise
    return { kpi: unread.length && !readings.length ? null : watchOnly, subjects, facts };
  };

  const plan: AgentBody['plan'] = (_obs, ctx): PlannedAction[] => {
    const out: PlannedAction[] = steps.map(s => ({ action: s.action, target: s.target, why: s.why || s.episode }));
    out.push({ action: 'report', target: ctx.now.toISOString().slice(0, 16), why: '감사 원장 ⊕ HQ 상태 줄 ⊕ 매시 요약' });
    if (red.due && mem.redSince) out.push({ action: 'notify-red', target: mem.redSince, why: `보기만 함 ${verdicts.filter(v => v.flags.includes('watch-only')).length} · ${Math.round(red.sinceMin ?? 0)}분` });
    return out;
  };

  const stepOf = (action: string, target: string) => steps.find(s => s.action === action && s.target === target) ?? null;
  const verdictOf = (id: string) => verdicts.find(v => v.id === id) ?? null;
  const heal = (action: HealStep['action']) => ({
    describe: HEAL_DESCRIBE[action],
    run(target: string, ctx: { now: Date }): ActionResult {
      const s = stepOf(action, target); const v = verdictOf(target);
      if (!s || !v) return { ok: false, line: `${action}:${target}: 방금 감사의 사다리에 없는 대상` };
      const done = (ok: boolean, line: string, ref?: string): ActionResult => {
        if (ok) { mem = readAuditMemory(home); noteRung(mem, s, ctx.now); writeAuditMemory(home, mem); }
        return { ok, line: `${target}: ${line}`, ...(ref ? { ref } : {}), ...(ok ? { undo: '없음 — 요청·카드 한 장(상태 변화 없음) · 다음 감사로 확인' } : {}) };
      };
      if (action === 'refire') {
        if (!v.trigger) return done(false, '등록된 트리거가 없다 — 재기동 문 없음');
        const r = deps.refire(v.trigger, `fleet-audit: ${s.why}`.slice(0, 280), ctx.now);
        return done(r.ok, r.line, `trigger:${v.trigger}`);
      }
      const isHand = action === 'l0-hand';
      const to = isHand ? env.card.supervisor : v.l0;
      const body = isHand
        ? `✋ [${env.card.name} → L0 ${to}] ${target} — ${s.why} · 주인(${v.l0}) 카드 ${Math.round(policy?.rungWaitMin ?? 0)}분 뒤에도 그대로 · 판단: eln loop agent ${target} status · 감사: eln loop agent ${env.card.id} status`
        : `[${env.card.name} → ${to}] ${target} — ${s.why} · 다음: 행동권·몸(거절 이유) 확인 · eln loop agent ${target} status`;
      const id = deps.post(`fleet-audit:${action}:${target}:${s.episode}`, to, body.slice(0, 900), 'request');
      return id === false ? done(false, `${to} 우편 실패`) : done(true, id === null ? `${to} 카드 이미 있음(같은 사건)` : `${to} 카드 #${id}`, id === null ? undefined : `msg:${id}`);
    },
  });

  const actions: AgentBody['actions'] = {
    refire: heal('refire'), 'owner-card': heal('owner-card'), 'l0-hand': heal('l0-hand'),
    report: {
      describe: '감사 원장(표) 파일 ⊕ HQ 버스 상태 한 줄 ⊕ 매시 한 번 OP 요약 우편(≤6줄) — 되돌릴 것 없음(기록)',
      async run(target, ctx): Promise<ActionResult> {
        const p = policy ?? fleetPolicy(pn); const hour = hourKey(ctx.now);
        mem = readAuditMemory(home);
        const at = ctx.now.toISOString();
        const dir = join(home, 'audit'); const file = join(dir, `${hour.slice(11, 13)}.md`); // 24 rolling hour files (overwritten daily) ⊕ latest.md
        let ledger = 'latest.md';
        try { mkdirSync(dir, { recursive: true }); const t = ledgerTable(verdicts, mem.baseScores, at); writeFileSync(join(dir, 'latest.md'), t); writeFileSync(file, t); ledger = file; }
        catch (e) { ledger = `쓰기 실패(${e instanceof Error ? e.message.slice(0, 60) : 'error'})`; }
        const watch = verdicts.filter(v => v.flags.includes('watch-only'));
        const flagged = verdicts.filter(v => v.flags.length);
        const status = `[감독 감사 ${at.slice(11, 16)}Z] ${verdicts.length} 중 이상 ${flagged.length}${flagged.length ? ` (${flagged.slice(0, 5).map(v => `${v.id} ${v.flags.map(flagKo).join('·')}`).join(' · ')})` : ''} · 보기만 함 ${watch.length}${red.red ? ' · 🔴' : ''}`;
        const bus = deps.bus(`fleet-audit:status:${target}`, status, ctx.now);
        let mailed = 'skip';
        if (mem.lastSummaryHour !== hour) {
          let acts = '?';
          try {
            const rows = readJournal(home, ctx.now.getTime() - p.windowMin * 60_000, ctx.now.getTime()).filter(r => r.status === 'acted' && r.action !== 'report');
            const c = (a: string) => rows.filter(r => r.action === a).length;
            acts = `재기동 요청 ${c('refire')} · 주인 카드 ${c('owner-card')} · ✋ ${c('l0-hand')} · 빨강 알림 ${c('notify-red')}`;
          } catch { /* journal unreadable → «?» */ }
          const lines = summaryLines(verdicts, mem.baseScores, { hour, red: red.red, redSinceMin: red.sinceMin, ledger, actsLastHour: acts }, p);
          const id = deps.post(`fleet-audit:summary:${hour}`, env.card.supervisor, lines.join('\n'), 'info');
          if (id !== false) { mem.lastSummaryHour = hour; mailed = id === null ? 'dup' : `#${id}`; } else mailed = 'failed';
        }
        mem.lastAuditAt = at; writeAuditMemory(home, mem);
        return { ok: true, line: `원장 ${ledger} · 버스 ${bus} · 요약 ${mailed}`, ref: `file:${ledger}` };
      },
    },
    'notify-red': {
      describe: '빨강(보기만 함 ≥ red_watch_only_min 이 red_after_min 지속) — OP 우편 ⊕ 텔레그램 한 번(빨강 사건마다)',
      async run(target): Promise<ActionResult> {
        mem = readAuditMemory(home);
        if (mem.redSince !== target) return { ok: false, line: `notify-red:${target}: 지금 빨강 사건이 아니다` };
        const watch = verdicts.filter(v => v.flags.includes('watch-only'));
        const line = `🔴 [${env.card.name}] 보기만 함 ${watch.length} 이 ${Math.round(red.sinceMin ?? 0)}분 지속 — ${watch.slice(0, 4).map(v => v.id).join(', ')} · 주인 카드·✋ 사다리 진행 중 · 확인: eln loop agent ${env.card.id} status`;
        const id = deps.post(`fleet-audit:red:${target}`, env.card.supervisor, line, 'request');
        let tg = false;
        try { tg = await deps.notify(line, `fleet-audit:red:${target}`); } catch { tg = false; }
        if (id === false && !tg) return { ok: false, line: 'OP 우편·텔레그램 둘 다 실패' };
        mem.redNotified = target; writeAuditMemory(home, mem);
        return { ok: true, line: `OP ${id === false ? '실패' : id === null ? '이미' : `#${id}`} · 텔레그램 ${tg ? '보냄' : '못 보냄'}`, ...(typeof id === 'number' ? { ref: `msg:${id}` } : {}) };
      },
    },
  };
  return { observe, plan, actions };
}

// ── live doors (the existing ones — no CLI spawn, no logs.db) ───────────────────────────────────────────────────────
export function liveFleetAuditDeps(env: BodyEnv): FleetAuditDeps {
  const stateRoot = env.stateRoot;
  const registry = <T>(fn: (reg: typeof import('../../loops/trigger-registry.js'), db: ReturnType<typeof import('../../loops/trigger-registry.js').openTriggerRegistry>) => T): T => {
    const reg = require('../../loops/trigger-registry.js') as typeof import('../../loops/trigger-registry.js');
    const db = reg.openTriggerRegistry(stateRoot);
    try { return fn(reg, db); } finally { db.close(); }
  };
  let listedOf: (id: string) => import('./agent-yaml.js').CompiledAgent | null = () => null;
  return {
    members() {
      try {
        const { cardsRoot, loadCard } = require('../card.js') as typeof import('../card.js');
        const { lintSupervisor } = require('./supervisor.js') as typeof import('./supervisor.js');
        const { supervisorSeat } = require('./agent-yaml.js') as typeof import('./agent-yaml.js');
        const root = cardsRoot();
        const defs = new Map<string, { l0: string | null; trigger: string | null; cadence: number | null; v3: import('./agent-yaml.js').CompiledAgent | null }>();
        const def = (id: string) => {
          if (defs.has(id)) return defs.get(id)!;
          let card: import('../card.js').AgentCard | null = null; try { card = loadCard(id, root); } catch { card = null; }
          const r = lintSupervisor(id, root);
          const hb = r.compiled?.policies.heartbeat_every_min;
          const d = r.ok && r.compiled
            ? { l0: supervisorSeat(r.compiled.supervisor, card?.supervisor ?? env.card.supervisor), trigger: r.compiled.wake.registeredAs, cadence: typeof hb === 'number' ? hb : card?.heartbeatEveryMin ?? null, v3: card ? null : r.compiled }
            : { l0: card?.supervisor ?? null, trigger: null, cadence: card?.heartbeatEveryMin ?? null, v3: null };
          defs.set(id, d); return d;
        };
        let live: Set<string> | null = null; let retired: Set<string> | null = null;
        try { registry((reg, db) => { live = new Set(reg.listLiveTriggers(db).map(r => r.graphId)); retired = reg.retiredTriggerIds(db); }); } catch { live = null; retired = null; }
        listedOf = id => defs.get(id)?.v3 ?? null;
        return (require('../../kit/fleet-audit/index.js') as typeof import('../../kit/fleet-audit/index.js')).fleetMembers({
          defsRoot: root, stateRoot, self: env.card.id, fallbackL0: env.card.supervisor,
          l0Of: id => def(id).l0, triggerOf: id => def(id).trigger, cadenceOf: id => def(id).cadence, liveTriggers: live, retiredTriggers: retired,
        });
      } catch { return null; }
    },
    reading(m, now, windowMin) {
      const r = readFleetReading(stateRoot, m, now, windowMin);
      const v3 = listedOf(m.id);
      if (!r || !v3) return r;
      try {
        const l = (require('./listed.js') as typeof import('./listed.js')).listedRow(v3, stateRoot, env.card.supervisor);
        return withListed(r, { lastTickAt: l.lastTickAt, kpiOk: l.kpiOk, kpisRead: l.kpis.length });
      } catch { return r; }
    },
    refire(trigger, reason, now) {
      try {
        const r = registry((reg, db) => reg.requestFire(db, trigger, now, reason));
        return r ? { ok: true, line: `레지스트리에 ${trigger} 실행 요청 (창 ${r.window.slice(11, 16)}Z · 다음 레지스트리 틱)` } : { ok: false, line: `${trigger}: 레지스트리가 받지 않음(없음 · retired · 이 분 창에 이미 있음)` };
      } catch (e) { return { ok: false, line: `${trigger}: 레지스트리 열기 실패 — ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` }; }
    },
    post: (key, to, body, kind) => (require('../live.js') as typeof import('../live.js')).livePostResult(stateRoot, env.card, env.card.id)(key, to, body, kind),
    bus(key, body, now) {
      try {
        const { busPost } = require('../../op-context-bus/bus.js') as typeof import('../../op-context-bus/bus.js');
        const { BUS_HQ_SPACE } = require('../../op-context-bus/spaces.js') as typeof import('../../op-context-bus/spaces.js');
        const r = busPost(stateRoot, { type: 'status', from: env.card.address, body, key }, { space: BUS_HQ_SPACE, now: now.getTime() });
        return r.kind === 'posted' ? 'posted' : 'duplicate';
      } catch { return 'failed'; }
    },
    async notify(line) {
      const [{ sendTelegramReport }, { getUserConfig }] = await Promise.all([import('../../telegram-report.js'), import('../../user-config.js')]);
      return sendTelegramReport(getUserConfig(), line, { markdown: false, kind: 'op-report' });
    },
  };
}
