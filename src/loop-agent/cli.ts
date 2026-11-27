// `eln loop agent list` · `eln loop agent <id> card|status|tick|voice|memory|knowhow|lesson|level|policy` — the generic doors of
// every LOOP-AGENT v2 agent (내부 문서 `LOOP-AGENT`). memory/knowhow/lesson also work for the bespoke agents
// (judge-butler) because they share the home <stateRoot>/loop-agents/<id>/.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { applyPolicyChange, CARD_ID_RE, kpiLine, listCards, loadCard, policySeats, HQ_POLICY_SEATS, type AgentCard } from './card.js';
import { AGENT_LEVELS, addLesson, agentHome, decideLesson, fileAgentMemory, grepMemory, recall, type AgentLevel } from './memory.js';
import { BESPOKE_AGENTS, hasBody, loadBody } from './registry.js';
import { livePorts, liveStateRoot, refreshHome } from './live.js';
import { levelOf } from './runtime.js';

interface AgentOpts { all?: boolean; today?: boolean; since?: string; json?: boolean; by?: string; grep?: string; reason?: string; title?: string; situation?: string; prescription?: string; measure?: string; kind?: string; text?: string }

const print = (v: unknown, json: boolean | undefined, text: string): void => console.log(json ? JSON.stringify(v) : text);
const byOf = (by?: string): string => { const who = (by ?? process.env.ELANOUS_TRACK ?? '').trim().toUpperCase(); if (!who) throw new Error('who? --by <L0 seat|OP|CLAUDE-OP|CEO>'); return who; };

function cardOrNull(id: string): AgentCard | null { try { return loadCard(id); } catch { return null; } }
function supervisorOf(id: string, card: AgentCard | null): string { return card?.supervisor ?? (id === 'judge-butler' ? 'JUD' : 'OP'); }
function mayDecide(id: string, card: AgentCard | null, by: string): boolean { return card ? policySeats(card).has(by) : new Set([supervisorOf(id, null), ...HQ_POLICY_SEATS]).has(by); }

/** Read-only recall across every agent home (for `eln self recall` and `eln loop agent list --grep`). */
export function loopAgentRecall(query: string, limit = 8, stateRoot = liveStateRoot()): Array<{ agent: string; where: string; at: string; text: string; score: number }> {
  const dir = join(stateRoot, 'loop-agents');
  if (!existsSync(dir)) return [];
  const out: Array<{ agent: string; where: string; at: string; text: string; score: number }> = [];
  for (const id of readdirSync(dir)) {
    if (!CARD_ID_RE.test(id)) continue;
    try { for (const h of grepMemory(fileAgentMemory(stateRoot, id, 'OP'), query, limit)) out.push({ agent: id, ...h }); } catch { /* skip a broken home */ }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** `eln loop agent <id> retro` window when the agent.yaml names none (the retro hook's own default cadence). */
const DEFAULT_RETRO_H = 6; // 출처: 대표 11-27 «회고» 기본 6시간 (LOOP-AGENT-V3-SMART-2 policy retro_every_h 기본값)

/** The plan lines a tick printed (LOOP-AGENT-V3-SMART-2): action ← body action · why · cited memory rows. */
function planLines(p: import('./v3/smart.js').ShellPlan): string[] {
  return [...(p.purpose ? [`  목적: ${p.purpose}`] : []), ...p.lines.map(l => `  plan ${l.refused ? '✗ ' : ''}${l.action} ${l.target}${l.from ? ` ← ${l.from}` : ''} — ${l.why.slice(0, 200)}${l.cites.length ? `\n    근거: ${l.cites.join(' | ')}` : ''}`),
    ...(p.memory.length ? [`  기억(사람): ${p.memory.join(' | ')}`] : [])];
}

async function agentVerb(id: string, verb: string, args: string[], o: AgentOpts): Promise<void> {
  if (!CARD_ID_RE.test(id)) throw new Error(`bad loop agent id ${id}`);
  const card = cardOrNull(id);
  const stateRoot = liveStateRoot();
  const mem = fileAgentMemory(stateRoot, id, supervisorOf(id, card));
  const now = new Date();
  const needCard = (): AgentCard => { if (!card) throw new Error(`${id}: no v2 card graphs/loop-agents/${id}/goal.yaml${BESPOKE_AGENTS[id] ? ` — bespoke agent: ${BESPOKE_AGENTS[id]}` : ''}`); return card; };
  switch (verb) {
    case 'card': {
      const c = needCard(); refreshHome(mem, id, c);
      print(c, o.json, `${join(agentHome(stateRoot, id), 'card.md')}\n${(await import('./live.js')).renderCardMd(c)}`); return;
    }
    case 'status': {
      const c = card; const s = mem.readState(); const lvl = c ? levelOf(c, mem) : mem.level(); const pol = mem.policy();
      const lessons = mem.lessons(); const kh = mem.knowhow();
      const k = { id, level: lvl, lastTickAt: s.lastTickAt, ticks: s.ticks, kpi: s.lastKpi, kpiOk: s.kpiOk, breachSince: s.breachSince, kpiLine: c ? kpiLine(c.kpi, s.lastKpi) : null,
        lessons: { active: lessons.filter(l => l.status === 'active').length, candidate: lessons.filter(l => l.status === 'candidate').length }, knowhow: { items: kh.items.length, version: kh.meta.version }, policy: pol, body: hasBody(id) };
      const recent = mem.cases(10);
      print({ ...k, recent }, o.json, [`${c?.name ?? id} (${id}) · level ${lvl.level} (by ${lvl.by} ${lvl.at}) · last tick ${s.lastTickAt ?? '—'} · ticks ${s.ticks} · body ${hasBody(id) ? 'yes' : BESPOKE_AGENTS[id] ? `bespoke (${BESPOKE_AGENTS[id]})` : 'none'}`,
        `${k.kpiLine ?? `KPI ${s.lastKpi ?? '?'}`}${s.breachSince ? ` · 위반 시작 ${s.breachSince}` : ''} · 이력 ${s.kpiHistory.slice(-8).map(h => h.v ?? '?').join(' ')}`,
        `lessons active ${k.lessons.active} · candidate ${k.lessons.candidate} · knowhow ${k.knowhow.items} items v${k.knowhow.version}${pol.focus ? ` · focus «${pol.focus}»` : ''}${Object.keys(pol.values).length ? ` · policy ${JSON.stringify(pol.values)}` : ''}${pol.disabled.length ? ` · disabled ${pol.disabled.join(',')}` : ''}`,
        ...recent.map(r => `  ${r.at.slice(5, 16)} ${r.kind} ${r.subject} — ${r.why.slice(0, 110)}`)].join('\n'));
      return;
    }
    case 'tick': {
      const c = needCard();
      const ports = livePorts(c, { stateRoot, speak: (await import('./speak.js')).channelSpeaker(c.id) });
      try {
        const body = await loadBody(id, { stateRoot, card: c });
        // LOOP-AGENT v3: graphs/loop-agents/<id>/agent.yaml (when present and clean) is the definition — policies · step graph · L0 by duty.
        // A refused agent.yaml → the v2 card ⊕ one deduped L0 card (supervisorTick — the same entry the sims drive).
        const { def, report: r } = await (await import('./v3/supervisor.js')).supervisorTick(c, body, ports, now);
        // its own mail (address · loop:<id>): the voice answers ≤5 per tick (L1/off/shadow fold inside voiceAgent)
        let mailed = 0;
        try {
          const { voiceAgent } = await import('./runtime.js');
          const { mailInbox, openLiveStore } = await import('./live.js');
          const store = openLiveStore();
          try {
            const inbox = mailInbox(c.address, store);
            for (const m of inbox.pending(now.getTime())) { const v = await voiceAgent({ card: def.card, body, ports, now, ...(def.policies ? { policies: def.policies } : {}), ...(def.soul ? { soul: def.soul } : {}) }, m); inbox.reply(m, v.reply, v.refs); mailed += 1; }
          } finally { store.close(); }
        } catch { /* mail is best-effort; the tick already counted */ }
        if (mailed) Object.assign(r, { mailed });
        await (await import('./speak.js')).flushSpeakers(); // KPI breach / recovery lines reach loop:<id> ⊕ ws:supervisors before exit
        mkdirSync(agentHome(stateRoot, id), { recursive: true });
        writeFileSync(join(agentHome(stateRoot, id), 'last-tick.json'), JSON.stringify(r));
        print(r, o.json, [`${id} ${r.level} · ${r.kpiLine} · 대상 ${r.subjects} · 행동 ${r.acted.length}/${r.planned}${r.acted.length ? ` (${r.acted.join(', ')})` : ''}${r.failed.length ? ` · 실패 ${r.failed.join(',')}` : ''}${r.breach ? ` · breach ${r.breach}` : ''}${r.escalated ? ' · → L0' : ''}${r.candidates.length ? ` · 교훈 후보 ${r.candidates.join(',')}` : ''}${r.error ? ` · error ${r.error}` : ''}`,
          ...(r.plan ? planLines(r.plan) : []), ...(r.learned?.promoted.length ? [`  배움(노하우): ${r.learned.promoted.join(', ')}`] : []), ...(r.retro ? [`  ${r.retro}`] : [])].join('\n'));
        if (r.error) process.exitCode = 1;
      } finally { ports.close(); }
      return;
    }
    case 'voice': {
      let reply: { text: string; evidence: readonly string[]; actions: readonly string[] };
      try {
        const c = needCard();
        const ch = await import('./channel.js');
        // `--text "<말>"` = a person at the terminal (CEO 11-27 live test: the door read stdin only → empty stdin → «JSON Parse
        // error: Unexpected EOF»). Without --text the els channel adapter pipes one #40331 JSON line on stdin.
        let input: import('./channel.js').LoopVoiceInput;
        if (o.text?.trim()) input = { loop: id, from: { role: 'seat', seat: (o.by ?? process.env.ELANOUS_TRACK ?? 'CLI').trim().toUpperCase() || 'CLI' }, channel: 'cli', text: o.text.trim(), refs: [], messageId: `cli-${now.getTime()}` };
        else {
          const line = (process.stdin.isTTY ? '' : await Bun.stdin.text()).split('\n').map(l => l.trim()).find(Boolean) ?? '';
          if (!line) throw new Error('nothing to answer — --text "<말>" or one JSON line on stdin {loop, from, channel, text, refs, messageId}');
          input = ch.parseLoopVoiceInput(line, id);
        }
        const { voiceAgent } = await import('./runtime.js');
        const ports = livePorts(c, { stateRoot });
        const def = (await import('./v3/supervisor.js')).supervisorDef(c);
        try { reply = ch.toLoopVoiceReply(await voiceAgent({ card: def.card, body: await loadBody(id, { stateRoot, card: def.card }), ports, now, ...(def.policies ? { policies: def.policies } : {}), ...(def.soul ? { soul: def.soul } : {}) }, ch.toVoiceMessage(input, now))); }
        finally { ports.close(); }
      } catch (e) { reply = { text: `[${id}] 목소리 실패 — ${e instanceof Error ? e.message : String(e)} · L0 ${supervisorOf(id, card)} 에 직접`, evidence: [], actions: [] }; process.exitCode = 1; }
      process.stdout.write(`${JSON.stringify(reply)}\n`);
      return;
    }
    case 'retro': {
      // LOOP-AGENT-V3-SMART-2 «회고» on demand: `eln loop agent <id> retro [--since 6h]` — journal ⊕ KPI window → one entry (any agent
      // with a memory home · the window = agent.yaml retro_every_h, else 6 h) · `retro ls` = the latest entries.
      const { lintAgentDir } = await import('./v3/agent-yaml.js');
      const { readRetros, retroLine } = await import('./v3/smart.js');
      if (args[0] === 'ls') { const rs = readRetros(mem.root, 5); print(rs, o.json, rs.map(retroLine).join('\n') || `${id}: 회고 없음 — eln loop agent ${id} retro`); return; }
      const lint = lintAgentDir(join((await import('./card.js')).cardsRoot(), id));
      const comp = lint.compiled;
      const pol = comp?.policies.retro_every_h;
      const windowH = o.since && /^\d+h$/u.test(o.since) ? Number(o.since.slice(0, -1)) : typeof pol === 'number' && pol > 0 ? pol : DEFAULT_RETRO_H;
      const k = card?.kpi ?? (comp?.kpis[0] ? { name: comp.kpis[0].name, target: comp.kpis[0].target, dir: comp.kpis[0].dir, unit: comp.kpis[0].unit } : { name: 'kpi', target: 0, dir: 'at_most' as const, unit: '' });
      const { writeRetro } = await import('./runtime.js');
      const e = writeRetro({ memory: mem, card: { id, kpi: k, address: card?.address ?? id.toUpperCase(), supervisor: supervisorOf(id, card) }, actions: comp?.actions ?? [], now, windowH });
      print(e, o.json, retroLine(e)); return;
    }
    case 'memory': {
      refreshHome(mem, id, card);
      if (o.grep) { const hits = grepMemory(mem, o.grep, 20); print(hits, o.json, hits.map(h => `${h.where}\t${h.at.slice(0, 16)}\t${h.text}`).join('\n') || `«${o.grep}» 없음`); return; }
      const r = recall(mem, args.join(' ') || `${card?.goal ?? ''} ${card?.subject ?? ''}`, now, { mark: false });
      print(r, o.json, `${r.text || '(기억 없음)'}\n— recall ${r.chars} chars · knowhow ${r.knowhow.length} · lessons ${r.lessons.length} · cases ${r.cases}`);
      return;
    }
    case 'knowhow': {
      refreshHome(mem, id, card);
      const sub = args[0] ?? 'ls';
      const kh = mem.knowhow();
      if (sub === 'ls') { print({ meta: kh.meta, items: kh.items.map(i => ({ head: i.text.split('\n')[0], kind: i.kind, status: i.status })) }, o.json, [`knowhow v${kh.meta.version} · ${kh.items.length} items (${join(agentHome(stateRoot, id), 'knowhow')})`, ...kh.items.map(i => `  [${i.kind}·${i.status || '?'}] ${i.text.split('\n')[0]!.replace(/^##\s+/u, '')}`)].join('\n')); return; }
      if (sub === 'show') { const want = String(args[1] ?? '').toUpperCase(); const it = kh.items.find(i => i.text.toUpperCase().startsWith(`## ${want}`)); if (!it) throw new Error(`${want}: 없는 항목`); print(it, o.json, it.text); return; }
      if (sub === 'add') {
        const by = byOf(o.by);
        if (!mayDecide(id, card, by)) throw new Error(`${by} 는 ${id} 의 L0·HQ 가 아니다`);
        if (!o.title || !o.situation || !o.prescription) throw new Error('knowhow add needs --title --situation --prescription [--measure --kind]');
        const kid = mem.addKnowhow({ title: o.title, situation: o.situation, prescription: o.prescription, ...(o.measure ? { measure: o.measure } : {}), ...(o.kind ? { kind: o.kind } : {}) }, by, now);
        mem.appendCase({ at: now.toISOString(), kind: 'knowhow', subject: kid, why: o.title, decidedBy: by, supervisedBy: supervisorOf(id, card) });
        console.log(`${kid} 추가 (v${mem.knowhow().meta.version})`); return;
      }
      throw new Error('knowhow ls | show <K-id> | add');
    }
    case 'lesson': {
      const sub = args[0] ?? 'ls';
      if (sub === 'ls') { const rows = mem.lessons(); print(rows, o.json, rows.map(l => `${l.id}\t${l.status}\t${l.from}\thits ${l.hits}\t${l.text.slice(0, 120)}`).join('\n') || '교훈 없음'); return; }
      const by = byOf(o.by);
      if (!mayDecide(id, card, by)) throw new Error(`${by} 는 ${id} 의 L0·HQ 가 아니다`);
      if (sub === 'approve' || sub === 'reject') {
        const l = decideLesson(mem, String(args[1] ?? ''), sub === 'approve', by, now);
        if (!l) throw new Error(`${args[1]}: 후보 교훈 아님`);
        mem.appendCase({ at: now.toISOString(), kind: 'lesson', subject: l.id, why: `${l.status} by ${by}`, decidedBy: by, supervisedBy: supervisorOf(id, card) });
        console.log(`${l.id} → ${l.status}`); return;
      }
      if (sub === 'add') { if (!o.text) throw new Error('--text'); const l = addLesson(mem, o.text, 'cli', by, now); mem.appendCase({ at: now.toISOString(), kind: 'lesson', subject: l.id, why: l.text, decidedBy: by, supervisedBy: supervisorOf(id, card) }); console.log(`${l.id} 기록`); return; }
      throw new Error('lesson ls | approve <L-id> | reject <L-id> | add --text');
    }
    case 'level': {
      const to = String(args[0] ?? '');
      if (!(AGENT_LEVELS as readonly string[]).includes(to)) throw new Error(`level ${AGENT_LEVELS.join('|')}`);
      if (id === 'judge-butler') throw new Error('judge-butler: eln loop demote|promote judge-butler');
      const by = byOf(o.by);
      if (!mayDecide(id, card, by)) throw new Error(`${by} 는 ${id} 의 L0·HQ 가 아니다`);
      mem.setLevel(to as AgentLevel, by, o.reason ?? 'cli', now); console.log(`${id} → ${to}`); return;
    }
    case 'policy': {
      const c = needCard();
      if (!args.length) { print(mem.policy(), o.json, JSON.stringify(mem.policy())); return; }
      const by = byOf(o.by);
      if (!policySeats(c).has(by)) throw new Error(`${by} 는 ${id} 의 L0·HQ 가 아니다`);
      const raw = args.slice(1).join(' ');
      const value: unknown = /^-?\d+(\.\d+)?$/u.test(raw) ? Number(raw) : args[0] === 'rights.disable' || args[0] === 'rights.enable' ? raw.split(',') : raw;
      const r = applyPolicyChange(c, mem.policy(), args[0]!, value);
      if (!r.ok) throw new Error(r.why);
      mem.writePolicy(r.policy);
      mem.appendCase({ at: now.toISOString(), kind: 'policy', subject: args[0]!, why: `${JSON.stringify(value)} · ${o.reason ?? 'cli'}`, decidedBy: by, supervisedBy: c.supervisor });
      console.log(`${id} policy ${args[0]} = ${JSON.stringify(value)}`); return;
    }
    default: throw new Error(`unknown verb ${verb} — card|status|tick|voice|memory|knowhow|lesson|level|policy`);
  }
}

/** `eln loop agent journal <id> [--since] [--json]` · `eln loop agent journal --all --today` (SUPERVISOR-CORRECTION-JOURNAL). */
async function journalCmd(target: string | undefined, o: AgentOpts): Promise<void> {
  const j = await import('./journal.js');
  const policy = j.readJournalPolicy(); const stateRoot = liveStateRoot(); const now = new Date();
  const sinceMs = j.parseSince(o.today ? 'today' : o.since, now, policy.tz);
  if (o.all || !target) {
    const sums = j.journalAgents(stateRoot).map(a => j.summarize(a, j.readJournal(agentHome(stateRoot, a), sinceMs, now.getTime(), policy), policy.top));
    const kpi = j.journalKpi(sums, now.getTime() - sinceMs, policy);
    const tot = { acted: sums.reduce((n, s) => n + s.acted, 0), failed: sums.reduce((n, s) => n + s.failed, 0), refused: sums.reduce((n, s) => n + s.refused, 0) };
    print({ since: new Date(sinceMs).toISOString(), until: now.toISOString(), total: tot, kpi, agents: sums }, o.json,
      [`감독 교정 일지 · ${new Date(sinceMs).toISOString().slice(0, 16)}Z~ · 행동 ${tot.acted} · 실패 ${tot.failed} · 거절 ${tot.refused} · ${kpi.line}`,
        'agent\t행동\t실패\t거절\ttop', ...sums.map(s => `${s.agent}\t${s.acted}\t${s.failed}\t${s.refused}\t${j.topLine(s) || '-'}`),
        ...(sums.length ? [] : ['(일지 없음 — 아직 교정한 감독이 없다)'])].join('\n'));
    return;
  }
  if (!CARD_ID_RE.test(target)) throw new Error(`bad loop agent id ${target}`);
  const rows = j.readJournal(agentHome(stateRoot, target), sinceMs, now.getTime(), policy);
  const sum = j.summarize(target, rows, policy.top);
  print({ agent: target, since: new Date(sinceMs).toISOString(), summary: sum, rows }, o.json,
    [`${target} 교정 일지 · ${new Date(sinceMs).toISOString().slice(0, 16)}Z~ · ${j.countsLine(sum)}${sum.top.length ? ` — ${j.topLine(sum)}` : ''}`,
      ...rows.map(r => `  ${r.at.slice(5, 16)} ${r.status}\t${r.action}:${r.target} — ${r.what.slice(0, 110)}${r.before || r.after ? ` · ${r.before ?? '?'} → ${r.after ?? '?'}` : ''}${r.undo ? ` · undo: ${r.undo.slice(0, 80)}` : ''}${r.evidence.length ? ` · ${r.evidence.slice(0, 3).join(' ')}` : ''}`),
      ...(rows.length ? [] : ['  (이 창에 교정 없음)'])].join('\n'));
}

export function registerAgentCommands(loop: Command): void {
  loop.command('agent <id> [verb] [args...]')
    .description('LOOP-AGENT v2 (generic): `list` · `lint [<id>]` (v3 agent.yaml) · `gen [<id>]` (goal.yaml ← agent.yaml) · `room` (voices ⊕ ws:supervisors) · `journal <id> [--since 2h|ISO|today] | journal --all --today` (교정 일지 · rollup ⊕ KPI) · `<id> card|status|tick|voice|retro [ls] [--since 6h]|memory [--grep q]|knowhow ls|show|add|lesson ls|approve|reject|add|level <l>|policy [key value]`')
    .option('--json').option('--all').option('--today').option('--since <when>').option('--by <seat>').option('--grep <q>').option('--reason <text>')
    .option('--title <t>').option('--situation <t>').option('--prescription <t>').option('--measure <cmd>').option('--kind <k>').option('--text <t>')
    .action(async (id: string, verb: string | undefined, args: string[], o: AgentOpts) => {
      try {
        if (id === 'room') {
          // SUPERVISOR-REVIVE 3/3: register every v2 voice (@loop:<id>) and let each introduce itself in ws:supervisors.
          const { openRoom, liveRoomDeps } = await import('./room.js');
          const r = await openRoom(liveRoomDeps());
          print(r, o.json, `ws:supervisors — voices ${r.registered.length} (${r.registered.join(', ')})${r.skipped.length ? ` · no body ${r.skipped.join(',')}` : ''} · intro ${r.spoken.length}${r.refused.length ? ` · refused ${r.refused.join(',')} (els server down?)` : ''} · open the room: els channel open ws:supervisors`);
          return;
        }
        if (id === 'lint') {
          // LOOP-AGENT-V3-YAML: `eln loop agent lint [<id>]` — agent.yaml schema · requires vs this install · portability · the
          // trigger shim (YAML-SUPERVISORS-RUNTIME: the wake lives only in agent.yaml) · goal.yaml = what agent.yaml generates.
          const { lintSupervisor } = await import('./v3/supervisor.js');
          const root = (await import('./card.js')).cardsRoot();
          const ids = verb ? [verb] : readdirSync(root).filter(n => existsSync(join(root, n, 'agent.yaml'))).sort();
          const rows = ids.map(a => { const r = lintSupervisor(a, root, { parity: true }); return { id: a, present: r.present, ok: r.ok, errors: r.errors, warnings: r.warnings }; });
          print(rows, o.json, rows.map(r => !r.present ? `${r.id}\t— no agent.yaml (v2 card only)` : [`${r.id}\t${r.ok ? 'ok' : 'REFUSED'}`, ...r.errors.map(e => `  ✘ ${e}`), ...r.warnings.map(w => `  ⚠ ${w}`)].join('\n')).join('\n') || 'no agent.yaml under graphs/loop-agents');
          if (rows.some(r => r.present && !r.ok) || (verb && !rows[0]?.present)) process.exitCode = 1;
          return;
        }
        if (id === 'gen') {
          // YAML-SUPERVISORS-RUNTIME: `eln loop agent gen [<id>]` — rewrite goal.yaml (the v2 fallback card) from agent.yaml.
          const { lintAgentDir } = await import('./v3/agent-yaml.js');
          const { genGoalYaml } = await import('./v3/card-gen.js');
          const { writeFileSync } = await import('node:fs');
          const root = (await import('./card.js')).cardsRoot();
          const ids = verb ? [verb] : readdirSync(root).filter(n => existsSync(join(root, n, 'agent.yaml'))).sort();
          const rows = ids.map(a => {
            const r = lintAgentDir(join(root, a), { triggersDir: join(root, '..', 'triggers') });
            if (!r.ok || !r.compiled) return { id: a, wrote: false, why: `agent.yaml refused: ${r.errors.slice(0, 2).join(' · ')}` };
            const text = genGoalYaml(r.compiled);
            if (text === null) return { id: a, wrote: false, why: 'no card: block (not a v2-shell supervisor)' };
            writeFileSync(join(root, a, 'goal.yaml'), text);
            return { id: a, wrote: true, why: 'goal.yaml generated' };
          });
          print(rows, o.json, rows.map(r => `${r.id}\t${r.wrote ? 'wrote' : 'skip'} — ${r.why}`).join('\n'));
          if (rows.some(r => !r.wrote && r.why.startsWith('agent.yaml refused'))) process.exitCode = 1;
          return;
        }
        if (id === 'journal') { await journalCmd(verb, o); return; }
        if (id === 'list') {
          const { cards, errors } = listCards();
          const rows = cards.map(c => { const m = fileAgentMemory(liveStateRoot(), c.id, c.supervisor); const s = m.readState(); return { id: c.id, name: c.name, address: c.address, supervisor: c.supervisor, kpi: kpiLine(c.kpi, s.lastKpi), level: levelOf(c, m).level, lastTickAt: s.lastTickAt, body: hasBody(c.id) }; });
          print({ agents: rows, bespoke: BESPOKE_AGENTS, errors }, o.json, ['id\tname\tL0\tlevel\tbody\tlast tick\tKPI', ...rows.map(r => `${r.id}\t${r.name}\t${r.supervisor}\t${r.level}\t${r.body ? 'yes' : 'none'}\t${r.lastTickAt ?? '—'}\t${r.kpi}`),
            ...Object.entries(BESPOKE_AGENTS).map(([k, v]) => `${k}\t(bespoke)\t-\t-\t${v}`), ...errors.map(e => `⚠️ ${e}`)].join('\n'));
          return;
        }
        await agentVerb(id, verb ?? 'status', args, o);
      } catch (e) { console.error(`loop agent: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
    });
}
