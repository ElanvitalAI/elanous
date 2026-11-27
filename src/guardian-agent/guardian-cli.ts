// `eln loop guardian tick|status|voice` · `eln res reap [--apply] [--host h]` · `eln res reap register` · `eln res host pick`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { butlerHome, fileMemory } from '../judge-butler/memory.js';
import { GUARDIAN_DEMOTERS, GUARDIAN_ID, GUARDIAN_SUPERVISOR, runGuardian } from './body.js';

const stateRoot = () => (require('../instance/resolve.js') as typeof import('../instance/resolve.js')).effectiveInstanceRoot();
const guardianMemory = () => fileMemory(stateRoot(), { agent: GUARDIAN_ID, supervisor: GUARDIAN_SUPERVISOR, demoters: GUARDIAN_DEMOTERS });

function cards(): { soulText: string; goalText: string; perHour: number } {
  const { resolve } = require('node:path') as typeof import('node:path');
  const dir = resolve(import.meta.dir, '../../graphs/loop-agents/guardian');
  const read = (f: string) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return ''; } };
  const goalText = read('goal.yaml');
  const per = Number(/per_hour_max:\s*(\d+)/u.exec(goalText)?.[1] ?? 12);
  return { soulText: read('soul.md') || '수호자 (guardian) — 자원국 서브 조율자 · L0 = RES', goalText, perHour: per };
}

export function registerGuardianCommands(loop: Command): void {
  const g = loop.command('guardian').description('수호자 (guardian) — loop agent v2: sanitize test universes · route to the least-loaded local host · hand capacity vs ready supply · voice (loop:guardian)');
  g.command('tick').description('One wake: sanitize → route → hand-scale proposals → report, then voice turns for waiting mail').option('--json').action(async (o: { json?: boolean }) => {
    try {
      const { guardianLive } = await import('./live.js');
      const live = guardianLive();
      try {
        const report = runGuardian(live.view, live.ports);
        const voice = await guardianVoiceInbox(live);
        const summary = { ...report, voice };
        mkdirSync(butlerHome(live.stateRoot, GUARDIAN_ID), { recursive: true });
        writeFileSync(join(butlerHome(live.stateRoot, GUARDIAN_ID), 'last-tick.json'), JSON.stringify(summary));
        await (await import('../loop-agent/live.js')).liveJournalRollup(GUARDIAN_ID); // SUPERVISOR-CORRECTION-JOURNAL
        console.log(o.json ? JSON.stringify(summary) : `guardian ${report.level} · reaped ${JSON.stringify(report.reaped)} · route ${report.route ?? '-'} · max load/ncpu ${report.kpi.maxRatio?.toFixed(2) ?? '?'} (over: ${report.kpi.overloaded.join(',') || 'none'})${report.kpi.unnormalized !== undefined ? ` · 미정상화 사건 ${report.kpi.unnormalized ?? '?'} (target 0)` : ''} · proposals ${report.proposals.length} · → OP ${report.escalations.length} · voice ${voice.length}`);
      } finally { live.close(); }
    } catch (e) { console.error(`guardian tick: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
  });
  g.command('pulse').description('The thin body (LLM 0 · every trigger tick): aggregate hosts · supervisors → KPI table → spawn due sub-agents (맥박 · 임대관 · 연료관 · 대식세포 …) → final route')
    .option('--json').action(async (o: { json?: boolean }) => {
      try {
        const { livePulseDeps, runResidentPulse } = await import('./pulse.js');
        const d = livePulseDeps();
        try {
          const r = runResidentPulse(d);
          console.log(o.json ? JSON.stringify(r) : `guardian pulse ${r.level} · changes ${r.changes.length} · spawned ${r.spawned.join(', ') || '-'} · reaped lines ${r.reaped.length} · route ${r.route ?? '-'}`);
        } finally { d.close(); }
      } catch (e) { console.error(`guardian pulse: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
    });
  g.command('world').description('World health in one screen — hosts (load/ncpu) · supervisors · fuel · the 7 sub-agents\' KPI').option('--json')
    .action(async (o: { json?: boolean }) => {
      const { readPulseSnapshot, renderWorld } = await import('./world.js');
      const { renderKpiTable } = await import('./subagents.js');
      const snap = readPulseSnapshot(stateRoot());
      if (o.json) { console.log(JSON.stringify(snap)); return; }
      console.log(snap ? `${renderWorld(snap.world)}\n— 서브 루프 에이전트 (pulse ${snap.at.slice(11, 16)}Z)\n${renderKpiTable(snap.kpi)}` : 'no pulse yet — eln loop guardian pulse');
    });
  g.command('status').description('Level · KPI · last tick · recent cases').option('--json').action((o: { json?: boolean }) => {
    const mem = guardianMemory(); const lvl = mem.level(); const s = mem.readState();
    let last: unknown = null; try { last = JSON.parse(readFileSync(join(butlerHome(stateRoot(), GUARDIAN_ID), 'last-tick.json'), 'utf8')); } catch { /* none */ }
    const cases = mem.cases(20);
    if (o.json) { console.log(JSON.stringify({ level: lvl, lastTickAt: s.lastTickAt, last, recent: cases })); return; }
    console.log([`guardian · level ${lvl.level} (by ${lvl.by} ${lvl.at}) · last tick ${s.lastTickAt ?? '—'}`, `last: ${JSON.stringify(last)?.slice(0, 300) ?? '—'}`,
      ...cases.slice(-10).map(c => `  ${c.at.slice(5, 16)} ${c.kind} ${c.subject} — ${c.why.slice(0, 110)}`)].join('\n'));
  });
  g.command('voice').description('els channel voice adapter: one JSON line {loop,from,channel,text,refs,messageId} on stdin → {text,evidence[],actions[]} · els channel voice guardian -- eln loop guardian voice')
    .action(async () => {
      let out: { text: string; evidence: string[]; actions: string[] };
      try {
        const line = (await Bun.stdin.text()).split('\n').map(l => l.trim()).find(Boolean) ?? '';
        const j = JSON.parse(line) as { loop?: string; from?: { seat?: string; pane?: string; role?: string }; channel?: string; text?: string; messageId?: string };
        if (j.loop && j.loop !== GUARDIAN_ID) throw new Error(`this adapter is loop:${GUARDIAN_ID}, not loop:${j.loop}`);
        if (typeof j.text !== 'string' || typeof j.messageId !== 'string') throw new Error('loop voice input needs {loop, from, channel, text, refs, messageId}');
        const { guardianLive } = await import('./live.js');
        const live = guardianLive();
        try {
          const from = (j.from?.seat?.replace(/^loop:/u, '') || j.from?.pane || j.from?.role || 'UNKNOWN').toUpperCase();
          const res = await voiceOnce(live, { id: j.messageId, from, body: j.text, at: new Date().toISOString(), channel: `els:${j.channel ?? 'channel'}` });
          out = { text: res.reply, evidence: res.refs.filter(r => /^[A-Za-z0-9._:/#@+-]{1,200}$/u.test(r)), actions: res.actions };
        } finally { live.close(); }
      } catch (e) { out = { text: `[수호자] 목소리 실패 — ${e instanceof Error ? e.message : String(e)} · RES 에 직접`, evidence: [], actions: [] }; process.exitCode = 1; }
      process.stdout.write(`${JSON.stringify(out)}\n`);
    });
}

type Live = import('./live.js').GuardianLive;
async function voiceOnce(live: Live, msg: import('../judge-butler/voice.js').VoiceMessage) {
  const { guardianVoiceTurn } = await import('./voice.js');
  const { configuredVoiceLlm } = await import('../judge-butler/live.js');
  const { planGuardian } = await import('./body.js');
  const { killExact } = await import('./reaper.js');
  const c = cards(); const mem = live.ports.memory;
  const s = mem.readState(); const nowMs = live.view.now.getTime();
  s.voiceTurns = s.voiceTurns.filter(t => nowMs - t < 3_600_000);
  const budgetOk = s.voiceTurns.length < c.perHour; if (budgetOk) { s.voiceTurns.push(nowMs); mem.writeState(s); }
  const plan = planGuardian(live.view);
  const { readPulseSnapshot, renderWorld } = await import('./world.js');
  const { renderKpiTable } = await import('./subagents.js');
  const snap = readPulseSnapshot(live.stateRoot);
  return guardianVoiceTurn(msg, live.view, { memory: mem, llm: configuredVoiceLlm(900, 'loop-agent:guardian'), soulText: c.soulText, goalText: c.goalText, budgetOk, ...(snap ? { worldText: `${renderWorld(snap.world)}\n${renderKpiTable(snap.kpi)}` } : {}), cmds: {
    reap: (host, apply) => {
      const entries = [...plan.reap].filter(([h]) => !host || h === host);
      if (!apply) return `정리 대상 ${entries.map(([h, x]) => `${h} ${x.length}`).join(' · ') || '없음'}`;
      return entries.map(([h, x]) => { const r = killExact(h, x); for (const k of r.killed) live.ports.audit({ at: new Date().toISOString(), host: h, pid: k, by: 'GUARDIAN', via: `voice ${msg.channel}#${msg.id}` }); return `${h} 정리 ${r.killed.length}`; }).join(' · ') || '정리할 것 없음';
    },
    route: () => `경로 ${plan.route.host ?? '없음'} — ${plan.route.why}`,
    proposeHands: () => plan.scaleUp ? `손 늘리기 후보 ${plan.scaleUp.hosts.join(',')} (${plan.scaleUp.why}) — tick 이 RES 에 제안` : plan.paidEscalation ?? '지금은 손을 늘릴 근거가 없다',
    escalate: (to, why) => { const id = live.ports.post(`guardian-voice-esc:${msg.channel}:${msg.id}:${to}`, to, `[수호자 → ${to}] ${msg.from} #${msg.id}: ${why}`, 'request'); return `→ ${to}${id ? ` #${id}` : ''}`; },
    demote: (to, by) => { if (!GUARDIAN_DEMOTERS.has(by.toUpperCase())) return `수준 변경 거절 — ${by}`; try { mem.setLevel(to as never, by, `voice ${msg.channel}#${msg.id}`); return `수준 → ${to}`; } catch (e) { return `수준 변경 실패 — ${e instanceof Error ? e.message : String(e)}`; } },
  } });
}

async function guardianVoiceInbox(live: Live): Promise<Array<{ msg: number; from: string; folded: boolean }>> {
  const rows = live.store.db.query(`SELECT id, sender, body, created_at, refs_json FROM msg_messages m WHERE recipient = 'GUARDIAN' AND sender != 'GUARDIAN' AND created_at >= ?
    AND NOT EXISTS (SELECT 1 FROM msg_messages r WHERE r.sender = 'GUARDIAN' AND r.reply_to = m.id) ORDER BY id ASC LIMIT 10`)
    .all(new Date(Date.now() - 24 * 3_600_000).toISOString()) as Array<{ id: number; sender: string; body: string; created_at: string; refs_json: string | null }>;
  const done: Array<{ msg: number; from: string; folded: boolean }> = [];
  if (['off', 'shadow'].includes(live.ports.memory.level().level)) return done;
  for (const r of rows.filter(x => !/"block:/u.test(x.refs_json ?? ''))) {
    const res = await voiceOnce(live, { id: r.id, from: r.sender, body: r.body, at: r.created_at, channel: 'mail' });
    live.store.post({ from: 'GUARDIAN', to: r.sender, body: res.reply, kind: 'reply', replyTo: r.id, refs: res.refs.slice(0, 12) });
    done.push({ msg: r.id, from: r.sender, folded: res.folded });
  }
  return done;
}

export function registerReapCommands(res: Command): void {
  const reap = res.command('reap').description('TEST-UNIVERSE-REAPER — kill expired / orphaned (>2h) test universes by exact PID (the guardian runs this each tick)')
    .option('--apply', 'kill (default: dry run — list only)').option('--dry-run', 'list only (default)').option('--host <h>', 'one host (default: all sanitized hosts)').option('--json')
    .action(async (o: { apply?: boolean; host?: string; json?: boolean }) => {
      const { SANITIZE_HOSTS } = await import('./live.js');
      const r = await import('./reaper.js');
      const { hostname } = await import('node:os');
      const me = hostname().split('.')[0]!.toLowerCase();
      const out: Array<{ host: string; candidates: number; killed: number[]; skipped: number[]; error?: string }> = [];
      for (const host of o.host ? [o.host] : SANITIZE_HOSTS) {
        const procs = r.listProcs(host);
        if (!procs) { out.push({ host, candidates: 0, killed: [], skipped: [], error: 'could not list processes' }); continue; }
        const cands = r.planReap(procs, host === me ? r.readLocalRegistry(stateRoot()) : r.remoteRegistry(host), Date.now(), { self: host === me ? new Set([process.pid, process.ppid]) : new Set() });
        if (!o.apply) { out.push({ host, candidates: cands.length, killed: [], skipped: [] }); if (!o.json) for (const c of cands.slice(0, 30)) console.log(`${host}\t${c.pid}\t${Math.round(c.ageMs / 3_600_000)}h\t${c.cpu}%\t${c.why}\t${c.command.slice(0, 90)}`); continue; }
        const k = r.killExact(host, cands);
        for (const c of cands) if (k.killed.includes(c.pid)) r.auditReap(stateRoot(), { at: new Date().toISOString(), host, pid: c.pid, pgid: c.pgid, why: c.why, command: c.command.slice(0, 120), by: process.env.ELANOUS_TRACK || 'cli' });
        out.push({ host, candidates: cands.length, killed: k.killed, skipped: k.skipped });
      }
      if (o.json) console.log(JSON.stringify(out));
      else for (const x of out) console.log(`${x.host}: ${x.error ?? `${x.candidates} candidate(s)${o.apply ? ` · killed ${x.killed.length} · skipped ${x.skipped.length}` : ' (dry run — --apply to kill)'}`}`);
    });
  reap.command('register').description('A test-universe launcher registers its process group with a TTL (default 2h)')
    .requiredOption('--by <launcher>').option('--pid <n>', 'leader pid (default: parent of this command)').option('--pgid <n>').option('--ttl <dur>', '30m · 2h', '2h').option('--cmd <text>', 'command prefix of the leader', '')
    .action(async (o: { by: string; pid?: string; pgid?: string; ttl: string; cmd: string }) => {
      const r = await import('./reaper.js');
      const { parseTtl } = await import('../hold-ledger/hold-ledger.js');
      const pid = o.pid ? Number(o.pid) : process.ppid;
      const ok = r.registerTestUniverse(stateRoot(), { pid, ...(o.pgid ? { pgid: Number(o.pgid) } : {}), cmd: o.cmd, ttlMs: parseTtl(o.ttl), by: o.by });
      console.log(ok ? `registered pid ${pid} ttl ${o.ttl} (${o.by})` : 'register failed (fail-open)');
    });
  res.command('host').description('Host placement (guardian · PREGATE-HOST-BALANCE)').command('pick').description('Least-loaded reachable local host (load/ncpu) — local before paid VMs; prints the host')
    .option('--json').option('--allow-paid', 'consider paid VMs when no local host is usable').option('--reserved <csv>', 'hosts to skip')
    .action(async (o: { json?: boolean; allowPaid?: boolean; reserved?: string }) => {
      const { pickLiveHost } = await import('./hosts.js');
      // RESOURCE-FACTS-FROM-LEDGER: candidates from the world registry (a host marked unhealthy/reserved/off is not probed).
      const f = await import('../kit/resource-facts/index.js');
      const cands = [...f.hostsFor('test-run'), ...(o.allowPaid ? f.paidHostsFor('burst') : [])];
      const r = pickLiveHost(cands, { reserved: new Set((o.reserved ?? '').split(',').map(s => s.trim()).filter(Boolean)), ...(o.allowPaid ? { allowPaid: true } : {}) });
      if (o.json) console.log(JSON.stringify(r)); else { console.log(r.host ?? ''); console.error(r.why); }
      if (!r.host) process.exitCode = 1;
    });
}
