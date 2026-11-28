// `eln land steward tick|status|ask|voice|demote|promote` — 착지 집사's doors (registered under `eln land`).
// The land-graph trigger (graphs/triggers/land-graph.yaml → recipe land-steward-tick) runs `tick`; els channel
// `loop:land-steward` runs `voice` (register: els channel voice land-steward -- eln land steward voice).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { LandDeps } from '../land-graph/land-graph.js';
import { checkBusClaim } from '../cli/bus-cli.js';
import { appendAudit } from '../kit/audit-ledger/index.js';
import { fileMemory, loadCards, STEWARD_DEMOTERS, STEWARD_ID, STEWARD_LEVELS, STEWARD_SEAT, STEWARD_SUPERVISOR, stewardHome, type StewardLevel } from './memory.js';

const out = (v: unknown, json: boolean, text: string) => console.log(json ? JSON.stringify(v) : text);
const withRefs = (text: string, refs: readonly string[]) => (refs.length ? `${text}\n근거: ${refs.join(' ')}` : text);

export interface CallerProbes { callerSeat: string | null; proxy: { ok: true } | { ok: false; line: string } }
/** The caller's verified identity — the same probes as `eln bus post --as`: ELANOUS_TRACK / the seats/<SEAT> directory,
 *  and the process-bound CLAUDE-OP proxy grant. CEO never changes a level from this CLI (CEO surfaces relay through OP). */
export function defaultCallerProbes(): CallerProbes {
  const track = (process.env.ELANOUS_TRACK ?? '').trim();
  const { resolveSeatId } = require('../tui/seat-mail-boot.js') as typeof import('../tui/seat-mail-boot.js');
  const { verifyProxyCaller, proxyStateRoot } = require('../proxy/proxy-identity.js') as typeof import('../proxy/proxy-identity.js');
  const v = verifyProxyCaller({ stateRoot: proxyStateRoot() });
  return { callerSeat: track ? track.toUpperCase() : resolveSeatId(process.cwd()), proxy: v.ok ? { ok: true } : { ok: false, line: v.line } };
}
/** `--by` is a claim: it must be the verified caller AND a seat allowed to change the level (TC · OP · CLAUDE-OP). */
export function verifyLevelCaller(by: string | undefined, probes: CallerProbes): { ok: true; seat: string } | { ok: false; line: string } {
  const claim = (by ?? probes.callerSeat ?? '').trim();
  if (!claim) return { ok: false, line: 'land steward level: who? --by <TC|OP|CLAUDE-OP> (must be your own seat)' };
  const c = checkBusClaim(claim, probes);
  if (!c.ok) return { ok: false, line: c.line.replace(/^bus:/u, 'land steward level:') };
  if (!STEWARD_DEMOTERS.has(c.seat)) return { ok: false, line: `land steward level: ${c.seat} may not change the level (TC · OP · CLAUDE-OP)` };
  return c;
}

/** Its own channel: a local line file (always) ⊕ els `loop:land-steward` when els is installed (10 s · fail-open). */
export function channelPort(stateRoot: string): (line: string) => void {
  return line => {
    appendAudit(join(stewardHome(stateRoot), 'channel.jsonl'), 'land-steward.channel/1', { at: new Date().toISOString(), line });
    try { spawnSync(process.env.ELS_BIN ?? 'els', ['channel', 'post', `loop:${STEWARD_ID}`, line], { timeout: 10_000, stdio: 'ignore' }); } catch { /* fail-open */ }
  };
}

export function registerStewardCommands(land: Command, deps: () => LandDeps): void {
  const s = land.command('steward').description('착지 집사 (land-steward) — loop agent v2 over the land graph: train manager · finisher · cell link · KPI · voice (loop:land-steward)');
  s.command('tick').description('One wake: body tick (train order · terminal owner) → KPI → one channel line per breach (the land-graph trigger runs this · alias of the shared v3 door: the land-graph.tick kind runner)')
    .option('--json').action(async (o: { json?: boolean }) => {
      try {
        // CODE-BODY-TO-KIND: the shared v3 door's runner for the land-graph.tick kind — this command is its alias
        const { KIND_RUNNERS } = await import('../loop-agent/v3/kind-runners.js');
        const r = await KIND_RUNNERS['land-graph.tick']!({ stateRoot: deps().stateRoot });
        out(r.summary, !!o.json, r.text);
        // GH-BUDGET-GOVERNOR ④: a skipped tick (GitHub read failed · cooldown) exits 0 — the trigger must not record an exception.
        const sum = r.summary as { error?: string; skipped?: string };
        if (sum.error && !sum.skipped) process.exitCode = 1;
      } catch (e) { console.error(`land steward tick: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
    });
  s.command('cell-link').description('LAND-CELL-LINK-ALWAYS: link merges to main → their release cell (evidence #PR · 판정 집사 signs green) · unmatched → one OP digest line. The tick runs it every wake; --since = backfill')
    .option('--since <iso>', 'backfill window start (ISO, e.g. 2026-11-27T00:00:00Z) — overrides the cursor, never re-posts')
    .option('--dry', 'plan only: no evidence, no mail, no cursor move').option('--json')
    .action(async (o: { since?: string; dry?: boolean; json?: boolean }) => {
      try {
        if (o.since !== undefined && !Number.isFinite(Date.parse(o.since))) throw new Error(`--since: not an ISO time: ${o.since}`);
        const { sweepMainCellLinks, formatSweep } = await import('../land-graph/main-cell-link.js');
        const { liveSweepDeps } = await import('./cell-link-live.js');
        const r = await sweepMainCellLinks(liveSweepDeps(deps().stateRoot, { ...(o.dry ? { dry: true } : {}), ...(o.since ? { since: new Date(o.since).toISOString() } : {}) }));
        out(r, !!o.json, formatSweep(r));
        if (r.error) process.exitCode = 1;
      } catch (e) { console.error(`land steward cell-link: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
    });
  s.command('status').description('Level · KPI of the last tick · hot-file lanes · slot advice · open blocked PRs with their next owner · recent cases')
    .option('--json').action((o: { json?: boolean }) => {
      try {
        const d = deps(); const mem = fileMemory(d.stateRoot); const lvl = mem.level();
        const last = (() => { try { return JSON.parse(readFileSync(join(stewardHome(d.stateRoot), 'last-tick.json'), 'utf8')) as import('../loop-agent/v3/land-graph-kind.js').LandTickReport; } catch { return null; } })();
        const blocked = (last?.decisions ?? []).filter(x => x.action !== 'land');
        const v = { level: lvl, last, recent: mem.cases(10) };
        const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
        const min = (x: number | null) => (x === null ? '—' : `${Math.round(x)}m`);
        out(v, !!o.json, [`land-steward · L0 ${STEWARD_SUPERVISOR} · level ${lvl.level} (by ${lvl.by} ${lvl.at}) · snapshot = last tick ${last?.at ?? '—'} (closed PRs since then: eln land graph status)`,
          ...(last?.kpi ? [`lands/h ${last.kpi.landsLastHour} (today ${last.kpi.landsToday}) · landable ${pct(last.kpi.landableRatio)} · finisher p50 ${min(last.kpi.needsFinisherWaitP50Min)} · no-next ${last.kpi.refusalsWithoutNext.length}`] : []),
          ...(last?.breaches ?? []).map(b => `⚠ ${b}`),
          ...(last?.slots ? [`slots: ${last.slots.why}`] : []),
          ...(last?.lanes ?? []).map(l => `lane ${l.file}: ${l.prs.map(n => `#${n}`).join(' ')}`),
          ...blocked.map(x => `#${x.pr} ${x.action}${x.cls ? ` ${x.cls}` : ''} · ${x.why.slice(0, 100)}${x.next ? ` → ${x.next.owner} (${x.next.action})` : ''}`),
          ...v.recent.map(c => `  ${c.at.slice(5, 16)} ${c.kind} ${c.subject} — ${c.why.slice(0, 100)}`)].join('\n'));
      } catch (e) { console.error(`land steward status: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
    });
  s.command('ask <question...>').description('«왜 #N 안 들어가?» · «지금 막힌 것?» · «다음 1시간 몇 건?» — answered from the records (dry plan)')
    .option('--json').action(async (q: string[], o: { json?: boolean }) => {
      try {
        const { answer } = await import('../land-graph/voice.js');
        const { landVoiceView } = await import('../loop-agent/v3/land-graph-kind.js');
        const d = deps(); const c = loadCards(); const a = answer(q.join(' '), await landVoiceView(d, STEWARD_SEAT), { id: STEWARD_ID, l0: STEWARD_SUPERVISOR, soulText: c.soulText, knowhowText: c.knowhowText });
        fileMemory(d.stateRoot).appendCase({ at: new Date().toISOString(), kind: 'voice', subject: a.kind, why: q.join(' ').slice(0, 120), refs: a.evidence });
        out(a, !!o.json, withRefs(a.text, a.evidence));
      } catch (e) { console.error(`land steward ask: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
    });
  s.command('voice').description('els channel voice adapter: one JSON line {loop,from,channel,text,refs,messageId} on stdin → {text,evidence[],actions[]}')
    .action(async () => {
      let reply: { text: string; evidence: string[]; actions: string[] };
      try {
        const line = (await Bun.stdin.text()).split('\n').map(l => l.trim()).find(Boolean) ?? '';
        const j = JSON.parse(line) as { text?: unknown; loop?: unknown };
        if (typeof j.text !== 'string') throw new Error('loop voice input needs {text}');
        if (j.loop && j.loop !== STEWARD_ID) throw new Error(`this adapter is loop:${STEWARD_ID}, not loop:${String(j.loop)}`);
        const { answer } = await import('../land-graph/voice.js');
        const { landVoiceView } = await import('../loop-agent/v3/land-graph-kind.js');
        const d = deps(); const c = loadCards(); const a = answer(j.text, await landVoiceView(d, STEWARD_SEAT), { id: STEWARD_ID, l0: STEWARD_SUPERVISOR, soulText: c.soulText, knowhowText: c.knowhowText });
        fileMemory(d.stateRoot).appendCase({ at: new Date().toISOString(), kind: 'voice', subject: a.kind, why: j.text.slice(0, 120), refs: a.evidence });
        reply = { text: a.text, evidence: a.evidence.slice(0, 12), actions: [] };
      } catch (e) { reply = { text: `[착지 집사] 목소리 실패 — ${e instanceof Error ? e.message : String(e)} · eln land steward status`, evidence: [], actions: [] }; process.exitCode = 1; }
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
  s.command('level <level>').description('live | shadow (plain body · steward records only, no channel line) | off (plain body · steward silent) — the verified caller seat TC · OP · CLAUDE-OP')
    .option('--by <seat>', 'your own seat (checked against ELANOUS_TRACK / seat directory / the CLAUDE-OP proxy grant)').option('--reason <text>', 'why', 'level change').action((level: string, o: { by?: string; reason: string }) => {
      try {
        if (!(STEWARD_LEVELS as readonly string[]).includes(level)) throw new Error(`level must be ${STEWARD_LEVELS.join(' | ')}`);
        const who = verifyLevelCaller(o.by, defaultCallerProbes());
        if (!who.ok) throw new Error(who.line);
        fileMemory(deps().stateRoot).setLevel(level as StewardLevel, who.seat, o.reason);
        console.log(`land-steward → ${level}`);
      } catch (e) { console.error(`land steward level: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; }
    });
}

/** Deduped mail to the L0 from the steward's own address (agent.yaml refusal · LOOP-AGENT-V3-YAML) — fail-open. */
export function l0MailPort(): (key: string, to: string, body: string) => void {
  return (key, to, body) => {
    try {
      const m = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
      const { appendOnce } = require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js');
      const store = m.openMsgStore(m.defaultMsgStorePath());
      try { appendOnce(store, key, () => ({ from: 'LAND-STEWARD', to, body, kind: 'request', intent: 'decision', refs: [key.slice(0, 200)] })); } finally { store.close(); }
    } catch { /* fail-open: the tick report carries `refused` */ }
  };
}
