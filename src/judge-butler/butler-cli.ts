// `eln loop butler tick|status` · `eln loop demote|promote judge-butler` — the judge-butler's doors (registered under `eln loop`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { BUTLER_ID, BUTLER_LEVELS, butlerHome, fileMemory, type ButlerLevel } from './memory.js';
import { filterInWindow, HOUR_MS } from '../kit/kpi/index.js';
import { greensInWindow } from '../loop-agent/v3/kind-runners.js';

const out = (v: unknown, json: boolean, text: string) => console.log(json ? JSON.stringify(v) : text);
const stateRoot = () => (require('../instance/resolve.js') as typeof import('../instance/resolve.js')).effectiveInstanceRoot();
const byOf = (by?: string) => { const who = (by ?? process.env.ELANOUS_TRACK ?? '').trim(); if (!who) throw new Error('who? --by <JUD|OP|CLAUDE-OP|CEO>'); return who; };

/** Loop agents v2 with a level: judge-butler (L0 JUD) · guardian (L0 RES). */
function agentMemory(id: string) {
  const name = id.replace(/^loop:/u, '');
  if (name === BUTLER_ID) return { name, mem: fileMemory(stateRoot()) };
  if (name === 'guardian') {
    const g = require('../guardian-agent/body.js') as typeof import('../guardian-agent/body.js');
    return { name, mem: fileMemory(stateRoot(), { agent: g.GUARDIAN_ID, supervisor: g.GUARDIAN_SUPERVISOR, demoters: g.GUARDIAN_DEMOTERS }) };
  }
  throw new Error(`unknown loop agent ${id} — judge-butler | guardian`);
}

export function registerButlerCommands(loop: Command): void {
  const b = loop.command('butler').description('판정 집사 (judge-butler) — first loop agent v2: greens from evidence · HOLD ledger · judge ✋ · voice (mail to JUDGE-BUTLER / loop:judge-butler)');
  b.command('tick').description('One wake: observe → judge vs done-when → act → verify → report, then voice turns for waiting mail — alias of `eln loop agent judge-butler tick` (the shared v3 door · JUDGE-BUTLER-V3-LISTED)')
    .option('--json').action(async (o: { json?: boolean }) => {
      try {
        const { KIND_RUNNERS } = await import('../loop-agent/v3/kind-runners.js');
        const r = await KIND_RUNNERS['judge-butler.tick']!({ stateRoot: stateRoot() });
        out(r.summary, !!o.json, r.text);
      } catch (e) { console.error(`judge-butler tick: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
    });
  b.command('voice').description('els channel voice adapter (PR #40331): one JSON line {loop,from,channel,text,refs,messageId} on stdin → one JSON line {text,evidence[],actions[]} on stdout · register: els channel voice judge-butler -- eln loop butler voice')
    .action(async () => {
      let reply: { text: string; evidence: readonly string[]; actions: readonly string[] };
      try {
        const line = (await Bun.stdin.text()).split('\n').map(l => l.trim()).find(Boolean) ?? '';
        const { parseLoopVoiceInput, toVoiceMessage, toLoopVoiceReply } = await import('./voice-channel.js');
        const input = parseLoopVoiceInput(line);
        const { liveContext, configuredVoiceLlm } = await import('./live.js');
        const { voiceOnce } = await import('./agent.js');
        const { loadCards } = await import('./cards.js');
        const ctx = liveContext();
        try { reply = toLoopVoiceReply(await voiceOnce({ view: ctx.view, ports: ctx.ports, llm: configuredVoiceLlm(), cards: loadCards() }, toVoiceMessage(input, new Date()))); }
        finally { ctx.close(); }
      } catch (e) { reply = { text: `[판정 집사] 목소리 실패 — ${e instanceof Error ? e.message : String(e)} · JUD 에 직접`, evidence: [], actions: [] }; process.exitCode = 1; }
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
  b.command('status').description('Level · KPI (greens/h · frozen hands · voice turns/h) · last tick · recent cases').option('--json').action((o: { json?: boolean }) => {
    const mem = fileMemory(stateRoot());
    const s = mem.readState(); const lvl = mem.level(); const now = Date.now();
    const cases = mem.cases(1000);
    const hour = filterInWindow(cases, c => c.at, now, HOUR_MS); // kit/kpi: by event time · a future-dated case never counts
    const k = { level: lvl, lastTickAt: s.lastTickAt, greensLastHour: greensInWindow(cases, s.reversed, now, HOUR_MS), signEventsLastHour: hour.filter(c => c.kind === 'sign').length, frozenHands: Object.keys(s.frozenLast).length,
      voiceTurnsLastHour: s.voiceTurns.filter(t => now - t < 3_600_000).length, escalationsLastHour: hour.filter(c => /escalate/u.test(c.kind)).length, lessons: mem.lessons().length,
      e4LastHour: { tried: hour.filter(c => c.kind === 'e4-run').length, ok: hour.filter(c => c.kind === 'e4-run' && /rc 0\b/u.test(c.why)).length, fail: hour.filter(c => c.kind === 'e4-run' && !/rc 0\b/u.test(c.why)).length },
      e4LastTick: (() => { try { return (JSON.parse(readFileSync(join(butlerHome(stateRoot()), 'last-tick.json'), 'utf8')) as { e4?: unknown }).e4 ?? null; } catch { return null; } })() };
    out({ ...k, recent: cases.slice(-10) }, !!o.json, [`judge-butler · level ${lvl.level} (by ${lvl.by} ${lvl.at}) · last tick ${s.lastTickAt ?? '—'}`,
      `greens/h ${k.greensLastHour} (distinct cells still green · sign events ${k.signEventsLastHour}) · frozen hands ${k.frozenHands} · voice ${k.voiceTurnsLastHour}/h · → JUD ${k.escalationsLastHour}/h · lessons ${k.lessons}`,
      `e4-run last hour tried ${k.e4LastHour.tried} · ok ${k.e4LastHour.ok} · fail ${k.e4LastHour.fail}${k.e4LastTick ? ` · last tick ${JSON.stringify(k.e4LastTick)}` : ''}`,
      ...cases.slice(-10).map(c => `  ${c.at.slice(5, 16)} ${c.kind} ${c.subject} — ${c.why.slice(0, 110)}`)].join('\n'));
  });
  loop.command('demote <id>').description(`Demote a loop agent: L1 = rules only (no voice) · shadow = plan, write nothing · off = kill switch`)
    .requiredOption('--to <level>', 'L1 | shadow | off').option('--by <seat>', 'JUD | OP | CLAUDE-OP | CEO (default ELANOUS_TRACK)').option('--reason <text>', 'why', 'demoted')
    .action((id: string, o: { to: string; by?: string; reason: string }) => {
      try {
        const a = agentMemory(id);
        if (!(BUTLER_LEVELS as readonly string[]).includes(o.to) || o.to === 'live') throw new Error('--to L1 | shadow | off (promote for live)');
        a.mem.setLevel(o.to as ButlerLevel, byOf(o.by), o.reason);
        console.log(`${a.name} → ${o.to}`);
      } catch (e) { console.error(`loop demote: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
    });
  loop.command('promote <id>').description('Back to live (body + voice)').option('--by <seat>').option('--reason <text>', 'why', 'promoted')
    .action((id: string, o: { by?: string; reason: string }) => {
      try { const a = agentMemory(id); a.mem.setLevel('live', byOf(o.by), o.reason); console.log(`${a.name} → live`); }
      catch (e) { console.error(`loop promote: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
    });
}
