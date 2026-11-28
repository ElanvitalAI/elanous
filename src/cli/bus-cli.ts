// `eln bus` — the OP context bus (src/op-context-bus/bus.ts · 내부 문서 `CLAUDE-OP-PROXY` §A4).
// post · ack write; tail · since · digest · watch read. A writer's `--as` is an identity claim checked here:
// CLAUDE-OP must verify its process-bound proxy grant; any other seat must be the caller's own seat; the proxy session
// writes only as CLAUDE-OP; CEO lines come from CEO surfaces (captureCeoLine), never from this CLI.
import type { Command } from 'commander';
import {
  BUS_DEFAULT_SPACE, BUS_TYPES, busAck, busDigest, busPost, busSince, readBus, watchBus, type BusItem, type BusType,
} from '../op-context-bus/bus.js';
import { busSearch, recordCeoRequestMemory } from '../op-context-bus/seat-turn.js';
import { BUS_HQ_SPACE, busKnownSpace, busOwnSpace, busSpacesForSeat } from '../op-context-bus/spaces.js';
import type { OrgMap } from '../org/org-map.js';

export interface BusCliDeps {
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  readonly setExitCode?: (code: number) => void;
  readonly stateRoot?: () => string;
  /** The caller's own seat (ELANOUS_TRACK, then this directory's seat) — null when it names none. */
  readonly callerSeat?: () => string | null;
  /** Does this process run inside the granted CLAUDE-OP session? (verifyProxyCaller) */
  readonly verifyProxy?: () => { ok: true } | { ok: false; line: string };
  readonly now?: () => number;
  /** Persist a posted ceo-request into surface_events (default recordCeoRequestMemory). */
  readonly remember?: (entry: import('../op-context-bus/bus.js').BusEntry) => void;
  /** CONTEXT-BUS-FEDERATION — the federation org map (default: loadOrgMap · the workspace declaration over DEFAULT_ORG). */
  readonly org?: () => OrgMap;
}

const PROXY = 'CLAUDE-OP';

export type ClaimVerdict = { ok: true; seat: string } | { ok: false; line: string };

/** Check a writer's `--as` claim against the caller's verified identity. Pure over the injected probes. */
export function checkBusClaim(claim: string, probes: { callerSeat: string | null; proxy: { ok: true } | { ok: false; line: string } }): ClaimVerdict {
  const seat = claim.trim().toUpperCase();
  if (!seat) return { ok: false, line: 'bus: --as <seat> is required' };
  if (seat === 'CEO') return { ok: false, line: 'bus: CEO lines are captured from CEO surfaces (Telegram · TUI · web) — relay them as --as CLAUDE-OP --type ceo-request --source <surface>' };
  if (seat === PROXY) return probes.proxy.ok ? { ok: true, seat } : { ok: false, line: probes.proxy.line };
  if (probes.proxy.ok) return { ok: false, line: `bus: this process is the ${PROXY} session — it writes as ${PROXY} only` };
  const own = (probes.callerSeat ?? '').trim().toUpperCase();
  if (!own) return { ok: false, line: `bus: --as ${seat} refused — this process names no seat (ELANOUS_TRACK or a seats/<SEAT> directory)` };
  if (own !== seat) return { ok: false, line: `bus: --as ${seat} refused — this process is seat ${own}` };
  return { ok: true, seat };
}

function itemLine(i: BusItem): string {
  const where = i.source ? `@${i.source}${i.alsoFrom.length ? `+${i.alsoFrom.join('+')}` : ''}` : '';
  return `${i.id} ${i.at} ${i.type} ${i.from}${where}${i.conflictsWith ? ` ⚠ conflicts ${i.conflictsWith}` : ''}${i.refs.length ? ` [${i.refs.join(' ')}]` : ''}: ${i.body.replace(/\s+/gu, ' ')}`;
}

export function registerBusCommands(program: Command, deps: BusCliDeps = {}): void {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const exit = deps.setExitCode ?? ((c: number) => { process.exitCode = c; });
  const stateRoot = () => deps.stateRoot?.() ?? (require('../autopilot/state-paths.js') as typeof import('../autopilot/state-paths.js')).elanousStateRoot();
  const callerSeat = () => deps.callerSeat?.() ?? (() => {
    const track = (process.env.ELANOUS_TRACK ?? '').trim();
    if (track) return track.toUpperCase();
    const { resolveSeatId } = require('../tui/seat-mail-boot.js') as typeof import('../tui/seat-mail-boot.js');
    return resolveSeatId(process.cwd());
  })();
  const verifyProxy = () => deps.verifyProxy?.() ?? (() => {
    const { verifyProxyCaller, proxyStateRoot } = require('../proxy/proxy-identity.js') as typeof import('../proxy/proxy-identity.js');
    const v = verifyProxyCaller({ stateRoot: proxyStateRoot() });
    return v.ok ? { ok: true as const } : { ok: false as const, line: v.line };
  })();
  const claim = (as: string): ClaimVerdict => checkBusClaim(as, { callerSeat: callerSeat(), proxy: verifyProxy() });
  const fail = (line: string, code = 2) => { err(line); exit(code); };
  const org = (): OrgMap => deps.org?.() ?? (require('../org/org-map.js') as typeof import('../org/org-map.js')).loadOrgMap().org;
  // CONTEXT-BUS-FEDERATION — `--space` defaults to the seat's own space (OP for eln OP and Claude OP, as before).
  const spaceOf = (given: string | undefined, seat: string | null): string => (given?.trim() ? given.trim().toUpperCase() : seat ? busOwnSpace(seat) : BUS_DEFAULT_SPACE);
  const readerSpace = (given: string | undefined): string => { try { return spaceOf(given, callerSeat()); } catch { return spaceOf(given, null); } };

  const bus = program.command('bus').description('OP context bus — one typed append-only stream Claude OP and eln OP both read and write (ceo-request · decision · commitment · status · handoff · opinion · consult)');
  bus.command('post <body...>').description('Append one item (--as is checked: CLAUDE-OP needs its proxy grant; other seats must be the caller)')
    .requiredOption('--as <seat>', 'writer seat')
    .requiredOption('--type <type>', BUS_TYPES.join('|'))
    .option('--ref <ref>', 'a ref, repeatable (cell:<id> · pr:<n> · msg:<id> · rail:<name>)', (v: string, prev: string[] = []) => [...prev, v])
    .option('--source <surface>', 'ceo-request: the surface the words came from (telegram · tui · web · …)')
    .option('--owner <seat>', 'commitment: who owns it')
    .option('--due <when>', 'commitment: due')
    .option('--done-when <line>', 'commitment: done when')
    .option('--space <space>', `bus space (default: the writer's own space · ${BUS_HQ_SPACE} = every coordinator · <SEAT> = a handoff to that seat)`)
    .option('--json', 'print the result as JSON')
    .action((body: string[], o: { as: string; type: string; ref?: string[]; source?: string; owner?: string; due?: string; doneWhen?: string; space?: string; json?: boolean }) => {
      const c = claim(o.as);
      if (!c.ok) { fail(c.line); return; }
      const space = spaceOf(o.space, c.seat);
      // A typo space would be a black hole (nobody reads it) — refuse it and name the readable ones.
      let known = true;
      try { known = busKnownSpace(space, org(), c.seat); } catch { known = true; }
      if (!known) { fail(`bus post: no seat reads space ${space} — use ${BUS_HQ_SPACE} (every coordinator), your own space, or a seat id (\`eln bus spaces --for <seat>\`)`); return; }
      try {
        const r = busPost(stateRoot(), { type: o.type as BusType, from: c.seat, body: body.join(' '), ...(o.ref?.length ? { refs: o.ref } : {}),
          ...(o.source ? { source: o.source } : {}), ...(o.owner ? { owner: o.owner } : {}), ...(o.due ? { due: o.due } : {}), ...(o.doneWhen ? { doneWhen: o.doneWhen } : {}) },
          { space, ...(deps.now ? { now: deps.now() } : {}) });
        // BUS-SEAT-TURN ③ — the CEO's words stay recallable (`eln self recall` · `eln self utterances`) · text-deduped.
        if (r.kind === 'posted' && r.entry.type === 'ceo-request') { try { (deps.remember ?? ((e) => { recordCeoRequestMemory(e); }))(r.entry); } catch { /* fail-open */ } }
        if (o.json) { out(JSON.stringify(r)); return; }
        if (r.kind === 'posted') out(`bus: ${r.entry.id} ${r.entry.type}${space !== BUS_DEFAULT_SPACE ? ` @${space}` : ''}${r.conflict ? ` ⚠ conflicts ${r.conflict}` : ''}`);
        else if (r.kind === 'also') out(`bus: same CEO words as ${r.id} — added surface ${r.source}`);
        else out(`bus: already on the bus as ${r.id}`);
      } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });
  bus.command('ack <id>').description('Mark everything up to <id> as seen by --as (the catch-up cursor)')
    .requiredOption('--as <seat>', 'reader seat')
    .option('--space <space>', 'bus space (default: the reader\'s own space)')
    .action((id: string, o: { as: string; space?: string }) => {
      const c = claim(o.as);
      if (!c.ok) { fail(c.line); return; }
      try { busAck(stateRoot(), id, c.seat, { space: spaceOf(o.space, c.seat), ...(deps.now ? { now: deps.now() } : {}) }); out(`bus: ${c.seat} acked through ${id}`); }
      catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });
  bus.command('tail').description('Last items').option('-n, --limit <n>', 'how many', '20').option('--space <space>', 'bus space (default: this seat\'s own space, else OP)').option('--json')
    .action((o: { limit: string; space?: string; json?: boolean }) => {
      const n = Math.max(1, Math.min(500, Number(o.limit) || 20));
      const items = readBus(stateRoot(), readerSpace(o.space)).slice(-n);
      for (const i of items) out(o.json ? JSON.stringify(i) : itemLine(i));
    });
  bus.command('since <id>').description('Items after <id> (use - for everything)').option('--space <space>', 'bus space (default: this seat\'s own space, else OP)').option('--json')
    .action((id: string, o: { space?: string; json?: boolean }) => {
      for (const i of busSince(readBus(stateRoot(), readerSpace(o.space)), id === '-' ? null : id)) out(o.json ? JSON.stringify(i) : itemLine(i));
    });
  bus.command('digest').description('The compact digest a turn carries: items after --for\'s ack cursor, CEO words pinned, newest first, bounded')
    .requiredOption('--for <seat>', 'reader seat')
    .option('--max-chars <n>', 'bound', '2000')
    .option('--space <space>', 'bus space (default: this seat\'s own space, else OP)')
    .action((o: { for: string; maxChars: string; space?: string }) => {
      const text = busDigest(stateRoot(), { forSeat: o.for, maxChars: Math.max(200, Number(o.maxChars) || 2000) }, spaceOf(o.space, o.for));
      out(text || `bus: nothing new for ${o.for.toUpperCase()}`);
    });
  bus.command('search <query...>').description('Find exact words on the bus (every word must appear · newest first) — the CEO\'s original lines too; for all surfaces see also `eln self utterances --from <ISO> --to <ISO>`')
    .option('--type <type>', BUS_TYPES.join('|'))
    .option('--since <ISO>', 'only items at or after this time')
    .option('-n, --limit <n>', 'how many', '50')
    .option('--space <space>', 'bus space (default: this seat\'s own space, else OP)')
    .option('--json')
    .action((query: string[], o: { type?: string; since?: string; limit: string; space?: string; json?: boolean }) => {
      if (o.type && !(BUS_TYPES as readonly string[]).includes(o.type)) { fail(`bus search: unknown --type ${JSON.stringify(o.type)} (${BUS_TYPES.join('|')})`); return; }
      if (o.since && !Number.isFinite(Date.parse(o.since))) { fail(`bus search: --since ${JSON.stringify(o.since)} is not an ISO time`); return; }
      const hits = busSearch(readBus(stateRoot(), readerSpace(o.space)), { query: query.join(' '), ...(o.type ? { type: o.type } : {}), ...(o.since ? { sinceIso: o.since } : {}),
        limit: Math.max(1, Math.min(500, Number(o.limit) || 50)) });
      if (hits.length === 0) { out(`bus: no item matches ${JSON.stringify(query.join(' '))}`); return; }
      for (const i of hits) out(o.json ? JSON.stringify(i) : itemLine(i));
    });
  bus.command('spaces').description('The spaces a seat\'s turn digest carries (own · HQ for coordinators · OP addressed-only) — from the federation org map')
    .option('--for <seat>', 'seat (default: this seat)')
    .option('--json')
    .action((o: { for?: string; json?: boolean }) => {
      const seat = (o.for ?? (() => { try { return callerSeat(); } catch { return null; } })() ?? '').trim().toUpperCase();
      if (!seat) { fail('bus spaces: --for <seat> is required (this process names no seat)'); return; }
      const spaces = busSpacesForSeat(seat, org());
      if (o.json) { out(JSON.stringify({ seat, spaces })); return; }
      out(`${seat}: ${spaces.map((s) => `${s.space}(${s.view})`).join(' · ')}`);
    });
  bus.command('watch').description('Print new items as they are appended (file events · no polling) until interrupted')
    .option('--space <space>', 'bus space (default: this seat\'s own space, else OP)')
    .action((o: { space?: string }) => new Promise<void>((resolve) => {
      const stop = watchBus(stateRoot(), (items) => { for (const i of items) out(itemLine(i)); }, { space: readerSpace(o.space) });
      process.once('SIGINT', () => { stop(); resolve(); });
    }));
}
