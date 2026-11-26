// fed-state reader — the four federation KPIs (one definition for pulse · board · CLI).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Fact, readFacts } from './ledger.js';

export interface FedKpi {
  windowStart: string; windowEnd: string; hours: number;
  idleWithWorkHands: number; idleWithWorkSeats: string[];
  landedPerHour: number; landed: number;
  opInboundPerHour: number; opInbound: number;
  opTurnsByMailPct: number | null; opTurns: number; opTurnsByMail: number;
  aux: { workNext: number; claims: number; stewardWakes: number; reclaims: number; blocks: number; greens: number };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Pure KPI over a fact list (window = [start, end)). */
export function computeFedKpi(facts: readonly Fact[], start: Date, end: Date, opSeat = 'OP'): FedKpi {
  const hours = Math.max((end.getTime() - start.getTime()) / 3_600_000, 1e-9);
  const inWin = facts.filter(f => { const t = Date.parse(f.ts); return t >= start.getTime() && t < end.getTime(); });
  // idle-with-work: a hand's LATEST hand fact up to `end` (state carries across the window edge).
  const lastHand = new Map<string, Fact>();
  for (const f of facts) {
    if (f.type !== 'hand' || !f.seat || Date.parse(f.ts) >= end.getTime()) continue;
    const prev = lastHand.get(f.seat);
    if (!prev || Date.parse(prev.ts) <= Date.parse(f.ts)) lastHand.set(f.seat, f);
  }
  // A hand idle since T has work unless it said so: workReady:false, or `eln work next` returned empty after T.
  const emptyAfter = (seat: string, t: number) => facts.some(f => f.type === 'work' && f.state === 'empty' && f.seat === seat && Date.parse(f.ts) >= t && Date.parse(f.ts) < end.getTime());
  const idleWithWorkSeats = [...lastHand.values()].filter(f => f.state === 'idle' && f.workReady !== false && !emptyAfter(f.seat!, Date.parse(f.ts))).map(f => f.seat!).sort();
  // one PR = one land even when coach-land and pr land both record it (dedupe by ref).
  const landFacts = inWin.filter(f => f.type === 'land');
  const landed = new Set(landFacts.filter(f => f.ref).map(f => f.ref)).size + landFacts.filter(f => !f.ref).length;
  const opInbound = inWin.filter(f => f.type === 'mail' && f.state === 'post' && f.to === opSeat).length;
  const opTurnFacts = inWin.filter(f => f.type === 'turn' && f.seat === opSeat);
  const opTurnsByMail = opTurnFacts.filter(f => f.state === 'mail').length;
  const n = (p: (f: Fact) => boolean) => inWin.filter(p).length;
  return {
    windowStart: start.toISOString(), windowEnd: end.toISOString(), hours: round1(hours),
    idleWithWorkHands: idleWithWorkSeats.length, idleWithWorkSeats,
    landed, landedPerHour: round1(landed / hours),
    opInbound, opInboundPerHour: round1(opInbound / hours),
    opTurns: opTurnFacts.length, opTurnsByMail,
    opTurnsByMailPct: opTurnFacts.length === 0 ? null : Math.round((opTurnsByMail / opTurnFacts.length) * 100),
    aux: {
      workNext: n(f => f.type === 'work' && (f.state === 'claimed' || f.state === 'empty')),
      claims: n(f => (f.type === 'work' && f.state === 'claimed') || (f.type === 'cell' && f.state === 'claim')),
      stewardWakes: n(f => f.type === 'steward' && f.state === 'wake'),
      reclaims: n(f => f.type === 'steward' && f.state === 'reclaim'),
      blocks: n(f => (f.type === 'work' && f.state === 'block') || (f.type === 'cell' && f.state === 'block')),
      greens: n(f => f.type === 'green' || (f.type === 'cell' && f.state === 'green')),
    },
  };
}

export function parseWindow(w: string): number {
  const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(w.trim());
  if (!m) throw new Error(`bad window: ${w} (use 30m · 1h · 1d)`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
}

/** Ledger-backed KPI — the TS entry pulse and the status board call. */
export function fedKpi(opts: { window?: string; now?: Date; path?: string } = {}): FedKpi {
  const end = opts.now ?? new Date();
  const start = new Date(end.getTime() - parseWindow(opts.window ?? '1h'));
  // hand state carries over: read everything up to end (hand facts are few; window filter applied inside).
  const { facts } = readFacts({ until: end, path: opts.path });
  // Lands mostly happen outside `pr land` (judge poller · direct merges) and never write a land fact — the
  // KPI read landed 0/h while main took 13 merges/h (OP 11-26 08:0x). main's first-parent «(#N)» commits are
  // the land truth; fold them in (deduped by ref in computeFedKpi). Explicit-path callers (tests) stay pure.
  const lands = opts.path ? [] : gitLandFacts(start, end);
  return computeFedKpi(lands.length ? [...facts, ...lands] : facts, start, end);
}

/** First-parent main merge commits in [start, end) as land facts. Fail-open (no repo → []), cached 60 s per window. */
const gitLandCache = new Map<string, { at: number; facts: Fact[] }>();
export function gitLandFacts(start: Date, end: Date, gitDir: string = process.env.ELANOUS_FED_GIT_DIR || join(homedir(), 'elanous-hq', 'repo.git')): Fact[] {
  const key = `${gitDir}|${Math.floor(start.getTime() / 60_000)}|${Math.floor(end.getTime() / 60_000)}`;
  const hit = gitLandCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.facts;
  let facts: Fact[] = [];
  try {
    if (!existsSync(gitDir)) return [];
    const r = spawnSync('git', ['--git-dir', gitDir, 'log', 'origin/main', '--first-parent', `--since=${start.toISOString()}`, `--until=${end.toISOString()}`, '--format=%cI%x09%s'], { encoding: 'utf8', timeout: 5_000 });
    if (r.status === 0) facts = parseGitLandLog(r.stdout, start, end);
  } catch { facts = []; }
  if (gitLandCache.size > 64) gitLandCache.clear();
  gitLandCache.set(key, { at: Date.now(), facts });
  return facts;
}

/** Pure: `%cI\t%s` lines → land facts for commits whose subject ends «(#N)» and whose time is in [start, end). */
export function parseGitLandLog(stdout: string, start: Date, end: Date): Fact[] {
  const out: Fact[] = [];
  for (const line of stdout.split('\n')) {
    const [ts, subj] = line.split('\t');
    const m = subj ? /\(#(\d+)\)\s*$/.exec(subj) : null;
    const t = ts ? Date.parse(ts) : NaN;
    if (m && Number.isFinite(t) && t >= start.getTime() && t < end.getTime()) out.push({ ts: new Date(t).toISOString(), type: 'land', ref: m[1], source: 'git:main' });
  }
  return out;
}

export function formatFedKpi(k: FedKpi): string {
  return [
    `fed kpi ${k.windowStart} → ${k.windowEnd} (${k.hours}h)`,
    `idle-with-work hands: ${k.idleWithWorkHands}${k.idleWithWorkSeats.length ? ` (${k.idleWithWorkSeats.join(',')})` : ''}`,
    `landed/h: ${k.landedPerHour} (${k.landed})`,
    `OP inbound/h: ${k.opInboundPerHour} (${k.opInbound})`,
    `OP turns opened by mail: ${k.opTurnsByMailPct === null ? 'n/a' : `${k.opTurnsByMailPct}%`} (${k.opTurnsByMail}/${k.opTurns})`,
    `aux: work-next ${k.aux.workNext} · claims ${k.aux.claims} · steward wakes ${k.aux.stewardWakes} · reclaims ${k.aux.reclaims} · blocks ${k.aux.blocks} · greens ${k.aux.greens}`,
  ].join('\n');
}

/** `eln fed show <cell|seat>` — latest facts touching that id (state answer without mail). */
export function showFed(id: string, opts: { limit?: number; path?: string } = {}): Fact[] {
  const { facts } = readFacts({ path: opts.path });
  return facts.filter(f => f.cell === id || f.seat === id || f.from === id || f.to === id).slice(-(opts.limit ?? 20));
}

/** HQ digest: cells blocked in the last 30 min (fed-state `work:block` facts) — replaces per-event steward-exception mails to HQ. */
export function hqBlockLines(nowMs: number, path?: string): string[] {
  try {
    const { facts } = readFacts({ since: new Date(nowMs - 30 * 60_000), until: new Date(nowMs + 1), ...(path ? { path } : {}) });
    return facts.filter((f) => f.type === 'work' && f.state === 'block').slice(-12).map((f) => `${f.cell ?? '?'} → ${f.to ?? '?'} (${f.seat ?? '?'})${f.kind ? ` · ${f.kind}` : ''}`);
  } catch { return []; }
}
