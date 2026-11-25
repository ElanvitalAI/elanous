/**
 * Condition triggers — a graph runs when a ledger/state predicate becomes true, not when a clock says so.
 *
 * Predicates are STRUCTURED (no regex on prose). Each evaluation returns { met, key, evidence }:
 *   met      — the predicate holds now
 *   key      — what the truth is about (the PR, the idle seats, the state digest, the hour …). The registry fires a
 *              condition trigger at most once per key (edge-triggered dedupe): a predicate that stays true with the
 *              same key never re-fires; a flapping predicate is held off by cooldown.
 *   evidence — the ledger line the run and its card cite.
 *
 * Kinds reuse the COND-WATCH outcomes from #40074 (`watch: 'pr-merged:N' | 'pregate-receipt:N' | 'cell-status:…' |
 * 'seat-idle:S' | 'file-exists:P' | 'mail-from:S'`) and add the minimum the migrated graphs and the release graph need.
 * Probes are injected (sims use fakes); defaults read gh · checklist · els · the filesystem · npm.
 */
import { createHash } from 'node:crypto';
import { liveFacts, parseTimeExpr, resolveTime, type Facts } from './trigger-facts.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { BURST_HOSTS as RES_BURST_HOSTS, READY_MAX_AGE_DAYS as RES_READY_MAX_AGE_DAYS, dueKey, dueLeases, releasePhase, staleHosts } from '../res-graphs/burst.js';

export type Predicate =
  | { kind: 'all' | 'any'; of: Predicate[] }
  | { kind: 'not'; of: Predicate }
  /** COND-WATCH outcome (#40074) in its own grammar, e.g. `pr-merged:40111`. */
  | { kind: 'watch'; watch: string }
  /** Wall-clock minute within the hour ≥ minute (retro «by :15»). */
  | { kind: 'minute-at-least'; minute: number }
  /** Absolute time reached (release cutAt). */
  | { kind: 'time-reached'; at: string }
  /** The file has not been modified since the start of the current hour/day (or does not exist). */
  | { kind: 'not-updated-since'; path: string; since: 'hour-start' | 'day-start' }
  /** A JSON file's field equals a value (rehearsal receipt verdict PASS for a sha). */
  | { kind: 'json-field'; path: string; field: string; equals: string | number | boolean }
  /** Checklist cells with this status number exactly `equals` (release: red = 0). */
  | { kind: 'cell-count'; status: 'green' | 'yellow' | 'red' | 'done'; equals: number }
  /** A hand seat idle for ≥ idle_min with at least one open cell of `status` it owns (idle triage). */
  | { kind: 'idle-with-open-cell'; status: 'yellow' | 'red'; idleMin: number }
  /** Material change of structured state since the last fire: always met; the key is the digest. */
  | { kind: 'state-changed'; parts: Array<'landed-count' | 'idle-seats' | 'hands-up-count' | { file: string }> }
  /** The registry publishes this version (npm dist-tag / GitHub release). */
  | { kind: 'version-published'; version: string }
  /** The installed runtime is at this version. */
  | { kind: 'installed-version'; equals: string }
  /**
   * Rocket-launch GO/NO-GO poll (RELEASE-ROCKET L-2/L-3): every voter's LATEST answer in the poll ledger (jsonl rows
   * {poll, voter, answer: GO|NO-GO, sha, evidence}) is GO, bound to the cut sha, with non-empty evidence.
   * No answer / no evidence / another sha ≠ GO. Any NO-GO → `blocked` (recovery edge + card, never an advance).
   */
  | { kind: 'poll-go'; ledger: string; poll: string; voters: string[]; sha: ShaRef }
  /**
   * OP-PULSE: a pulse is due — the phase changed (fire at once), the phase cadence elapsed since the last pulse, or a CEO
   * crown line carries urgency urgent/all-in. `rhythm` = the rhythm yaml (graphs/triggers/op-pulse.rhythm.yaml).
   */
  | { kind: 'pulse-due'; rhythm: string }
  /**
   * RES burst pool (src/res-graphs/burst.ts · RES-READY-POOL-RESERVATION): `ready-stale` = a burst host never verified or
   * verified > maxAgeDays ago (key = the stale set + day) · `lease-due` = a lease to activate or drain · `release-phase` =
   * always met, key = the reservation class (reserved@version | idle) so each phase transition fires once.
   */
  | { kind: 'res'; check: 'ready-stale' | 'lease-due' | 'release-phase'; root: string; stateRoot: string; hosts: string[]; maxAgeDays: number }
  /**
   * Compound-trigger atoms (SCHEDULER-TO-GRAPH-RUNNER · src/loops/trigger-facts.ts). Times are fact expressions
   * («release.cutAt - 2h»), so the key is the RESOLVED instant: one fire per release, never per tick.
   */
  | { kind: 'time'; after?: string; before?: string }
  /** A named fact (release.* · res.*) equals a value / is one of a set. Release facts key on the release version. */
  | { kind: 'fact'; fact: string; equals?: Scalar; in?: Scalar[] }
  /** A row in a jsonl event ledger whose fields match, at/after `since` (a time expression). Key = the first such row. */
  | { kind: 'event'; ledger: string; match: Record<string, Scalar>; since?: string }
  /** Deadline branch: met once `after` passes; key carries `then` so the graph routes to its timeout path once. */
  | { kind: 'timeout'; after: string; then: string };
export type Scalar = string | number | boolean;

/** A sha given literally, or read from a receipt JSON field (e.g. the cut receipt's `cutSha`). */
export type ShaRef = string | { path: string; field: string };

export interface ConditionProbes {
  now(): Date;
  /** COND-WATCH evidence line, or null while not met (reuses the #40074 probe semantics). */
  watch(watch: string, sinceIso: string): Promise<string | null>;
  mtimeMs(path: string): number | null;
  readJson(path: string): unknown;
  /** Lines of a ledger file ([] when missing). */
  readLines(path: string): string[];
  cells(): Promise<Array<{ id: string; status: string; owner?: string | null }>>;
  /** Seats whose every pane is idle, with the idle-since time when the journal knows it. */
  idleSeats(): Promise<Array<{ seat: string; sinceMs: number | null }>>;
  landedCount(): Promise<number>;
  handsUpCount(): Promise<number>;
  publishedVersions(): Promise<string[]>;
  installedVersion(): Promise<string | null>;
  /** OP-PULSE due check (default: op-pulse-run.pulseDueNow over the live probes). */
  pulseDue?(rhythmPath: string): Promise<{ met: boolean; key: string; evidence: string }>;
  /** Named facts for time/fact atoms (default: trigger-facts.liveFacts over {stateRoot}/{seatState}). */
  facts?(): Facts;
}

export interface PredicateResult {
  met: boolean; key: string; evidence: string;
  /** A positive NO-GO (not merely «not yet»): the registry cards the owner once per key and never fires. */
  blocked?: string;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

function hourStart(now: Date): Date { const d = new Date(now); d.setMinutes(0, 0, 0); return d; }
function dayStart(now: Date): Date { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; }

function field(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((at, part) => at && typeof at === 'object' ? (at as Record<string, unknown>)[part] : undefined, value);
}

/** Validate a predicate from YAML; throws with the offending path so a bad declaration is refused at register time. */
export function parsePredicate(raw: unknown, at = 'condition'): Predicate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${at}: predicate must be an object`);
  const p = raw as Record<string, unknown>;
  const str = (k: string) => { if (typeof p[k] !== 'string' || !(p[k] as string)) throw new Error(`${at}.${k} must be a non-empty string`); return p[k] as string; };
  const int = (k: string) => { if (typeof p[k] !== 'number' || !Number.isInteger(p[k]) || (p[k] as number) < 0) throw new Error(`${at}.${k} must be a non-negative integer`); return p[k] as number; };
  switch (p.kind) {
    case 'all': case 'any': {
      if (!Array.isArray(p.of) || !p.of.length) throw new Error(`${at}.of must be a non-empty list`);
      return { kind: p.kind, of: p.of.map((x, i) => parsePredicate(x, `${at}.of[${i}]`)) };
    }
    case 'not': return { kind: 'not', of: parsePredicate(p.of, `${at}.of`) };
    case 'watch': return { kind: 'watch', watch: str('watch') };
    case 'minute-at-least': { const minute = int('minute'); if (minute > 59) throw new Error(`${at}.minute must be 0–59`); return { kind: 'minute-at-least', minute }; }
    case 'time-reached': { const value = str('at'); if (Number.isNaN(Date.parse(value))) throw new Error(`${at}.at must be an ISO time`); return { kind: 'time-reached', at: value }; }
    case 'not-updated-since': {
      if (p.since !== 'hour-start' && p.since !== 'day-start') throw new Error(`${at}.since must be hour-start|day-start`);
      return { kind: 'not-updated-since', path: str('path'), since: p.since };
    }
    case 'json-field': {
      if (!['string', 'number', 'boolean'].includes(typeof p.equals)) throw new Error(`${at}.equals must be a scalar`);
      return { kind: 'json-field', path: str('path'), field: str('field'), equals: p.equals as string | number | boolean };
    }
    case 'cell-count': {
      if (!['green', 'yellow', 'red', 'done'].includes(String(p.status))) throw new Error(`${at}.status must be green|yellow|red|done`);
      return { kind: 'cell-count', status: p.status as 'red', equals: int('equals') };
    }
    case 'idle-with-open-cell': {
      if (p.status !== 'yellow' && p.status !== 'red') throw new Error(`${at}.status must be yellow|red`);
      return { kind: 'idle-with-open-cell', status: p.status, idleMin: p.idle_min === undefined ? 0 : int('idle_min') };
    }
    case 'state-changed': {
      if (!Array.isArray(p.parts) || !p.parts.length) throw new Error(`${at}.parts must be a non-empty list`);
      const parts = p.parts.map((part, i) => {
        if (part === 'landed-count' || part === 'idle-seats' || part === 'hands-up-count') return part;
        if (part && typeof part === 'object' && typeof (part as { file?: unknown }).file === 'string') return { file: (part as { file: string }).file };
        throw new Error(`${at}.parts[${i}] must be landed-count|idle-seats|hands-up-count|{file}`);
      });
      return { kind: 'state-changed', parts };
    }
    case 'version-published': return { kind: 'version-published', version: str('version') };
    case 'installed-version': return { kind: 'installed-version', equals: str('equals') };
    case 'poll-go': {
      if (!Array.isArray(p.voters) || !p.voters.length || !p.voters.every(v => typeof v === 'string' && v)) throw new Error(`${at}.voters must be a non-empty list of seats`);
      const sha = p.sha;
      const shaRef: ShaRef = typeof sha === 'string' && sha ? sha
        : sha && typeof sha === 'object' && typeof (sha as { path?: unknown }).path === 'string' && typeof (sha as { field?: unknown }).field === 'string'
          ? { path: (sha as { path: string }).path, field: (sha as { field: string }).field }
          : (() => { throw new Error(`${at}.sha must be a sha or {path, field}`); })();
      return { kind: 'poll-go', ledger: str('ledger'), poll: str('poll'), voters: (p.voters as string[]).map(v => v.toUpperCase()), sha: shaRef };
    }
    case 'pulse-due': return { kind: 'pulse-due', rhythm: str('rhythm') };
    case 'res': {
      const check = str('check');
      if (!['ready-stale', 'lease-due', 'release-phase'].includes(check)) throw new Error(`${at}.check must be ready-stale|lease-due|release-phase`);
      const hosts = p.hosts === undefined ? [...RES_BURST_HOSTS] : Array.isArray(p.hosts) && p.hosts.every(h => typeof h === 'string') ? p.hosts as string[]
        : (() => { throw new Error(`${at}.hosts must be a list of hosts`); })();
      return { kind: 'res', check: check as 'ready-stale', root: typeof p.root === 'string' ? p.root : '{seatState}/RES/graph-state',
        stateRoot: typeof p.state_root === 'string' ? p.state_root : '{stateRoot}', hosts, maxAgeDays: p.max_age_days === undefined ? RES_READY_MAX_AGE_DAYS : int('max_age_days') };
    }
    case 'time': {
      if (p.after === undefined && p.before === undefined) throw new Error(`${at}: time needs after and/or before`);
      for (const k of ['after', 'before'] as const) if (p[k] !== undefined) parseTimeExpr(str(k));
      return { kind: 'time', ...(p.after !== undefined ? { after: p.after as string } : {}), ...(p.before !== undefined ? { before: p.before as string } : {}) };
    }
    case 'fact': {
      const scalar = (v: unknown) => ['string', 'number', 'boolean'].includes(typeof v);
      if (p.equals === undefined && p.in === undefined) throw new Error(`${at}: fact needs equals or in`);
      if (p.equals !== undefined && !scalar(p.equals)) throw new Error(`${at}.equals must be a scalar`);
      if (p.in !== undefined && !(Array.isArray(p.in) && p.in.length && p.in.every(scalar))) throw new Error(`${at}.in must be a non-empty scalar list`);
      return { kind: 'fact', fact: str('fact'), ...(p.equals !== undefined ? { equals: p.equals as Scalar } : {}), ...(p.in !== undefined ? { in: p.in as Scalar[] } : {}) };
    }
    case 'event': {
      if (!p.match || typeof p.match !== 'object' || Array.isArray(p.match)) throw new Error(`${at}.match must be an object`);
      if (p.since !== undefined) parseTimeExpr(str('since'));
      return { kind: 'event', ledger: str('ledger'), match: p.match as Record<string, Scalar>, ...(p.since !== undefined ? { since: p.since as string } : {}) };
    }
    case 'timeout': parseTimeExpr(str('after')); return { kind: 'timeout', after: str('after'), then: str('then') };
    default: throw new Error(`${at}.kind ${String(p.kind)} is not a known predicate`);
  }
}

/**
 * The compound `when:` form (CEO 11-25 23:5x):
 *   when: { all: [ {time: {after: "release.cutAt - 2h"}}, {fact: release.rehearsal, in: [...]}, {event: {...}} ],
 *           any: [ ... ], timeout: { after: "release.publishAt + 2h", then: abort-restore } }
 * = (all ∧ any) ∨ timeout. Items: {time:{after,before}} · {fact, equals|in} · {event: "<fact name>", equals} (a named
 * state event is a fact) · {event: {ledger, match, since?}} · nested {all|any} · or any `kind:` predicate.
 */
export function parseWhen(raw: unknown, at = 'when'): Predicate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${at} must be an object`);
  const w = raw as Record<string, unknown>;
  if ('kind' in w) return parsePredicate(w, at);
  if ('time' in w) return parsePredicate({ kind: 'time', ...(w.time as object) }, at);
  if ('fact' in w) return parsePredicate({ ...w, kind: 'fact' }, at);
  if ('event' in w) {
    if (typeof w.event === 'string') return parsePredicate({ kind: 'fact', fact: w.event, equals: w.equals, in: w.in }, at);
    return parsePredicate({ kind: 'event', ...(w.event as object) }, at);
  }
  const parts: Predicate[] = [];
  for (const k of ['all', 'any'] as const) {
    if (w[k] === undefined) continue;
    if (!Array.isArray(w[k]) || !(w[k] as unknown[]).length) throw new Error(`${at}.${k} must be a non-empty list`);
    parts.push({ kind: k, of: (w[k] as unknown[]).map((x, i) => parseWhen(x, `${at}.${k}[${i}]`)) });
  }
  if (!parts.length) throw new Error(`${at} needs all | any | time | fact | event`);
  const main: Predicate = parts.length === 1 ? parts[0]! : { kind: 'all', of: parts };
  if (w.timeout === undefined) return main;
  const t = w.timeout as Record<string, unknown>;
  return { kind: 'any', of: [main, parsePredicate({ kind: 'timeout', after: t?.after, then: t?.then }, `${at}.timeout`)] };
}

/** Evaluate one predicate. `expand` resolves path templates ({seatState} …); `sinceIso` bounds watch outcomes. */
export async function evaluatePredicate(pred: Predicate, probes: ConditionProbes, opts: { expand: (s: string) => string; sinceIso: string; facts?: Facts }): Promise<PredicateResult> {
  const now = probes.now();
  const facts = (): Facts => (opts.facts ??= probes.facts ? probes.facts() : liveFacts(opts.expand('{stateRoot}'), opts.expand('{seatState}'), now));
  switch (pred.kind) {
    case 'time': {
      const f = facts(); const bits: string[] = []; const keys: string[] = []; let met = true;
      for (const [k, cmp] of [['after', (t: number) => now.getTime() >= t], ['before', (t: number) => now.getTime() < t]] as const) {
        const expr = pred[k]; if (expr === undefined) continue;
        const at = resolveTime(expr, f);
        if (at === null) { met = false; keys.push(`${k}:unresolved`); bits.push(`${k} ${expr} unresolved (fact missing)`); continue; }
        const iso = new Date(at).toISOString(); const ok = cmp(at); met &&= ok;
        keys.push(`${k}@${iso}`); bits.push(`${k} ${expr} = ${iso} ${ok ? 'reached' : 'not yet'}`);
      }
      return { met, key: `time:${keys.join(',')}`, evidence: `time ${bits.join(' · ')} (now ${now.toISOString()})` };
    }
    case 'fact': {
      const f = facts(); const v = f[pred.fact];
      const met = v !== undefined && v !== null && (pred.equals !== undefined ? v === pred.equals : pred.in!.includes(v as Scalar));
      const scope = pred.fact.startsWith('release.') ? `@${String(f['release.version'] ?? 'none')}` : '';
      const want = pred.equals !== undefined ? `=${String(pred.equals)}` : `∈{${pred.in!.join(',')}}`;
      return { met, key: `fact:${pred.fact}${want}${scope}`, evidence: `${pred.fact}=${JSON.stringify(v) ?? 'undefined'} (want ${want.slice(1)})` };
    }
    case 'event': {
      const ledger = opts.expand(pred.ledger);
      const since = pred.since === undefined ? null : resolveTime(pred.since, facts());
      if (pred.since !== undefined && since === null) return { met: false, key: `event:${ledger}@unresolved`, evidence: `event since ${pred.since} unresolved` };
      for (const line of probes.readLines(ledger)) {
        let row: Record<string, unknown>; try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (!Object.entries(pred.match).every(([k, v]) => field(row, k) === v)) continue;
        const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
        if (since !== null && !(at >= since)) continue;
        return { met: true, key: `event:${ledger}#${String(row.id ?? row.at ?? sha(line))}`, evidence: `event ${JSON.stringify(pred.match)} at ${String(row.at ?? '?')}` };
      }
      return { met: false, key: `event:${ledger}@none`, evidence: `event ${JSON.stringify(pred.match)} not in ${ledger}` };
    }
    case 'timeout': {
      const at = resolveTime(pred.after, facts());
      if (at === null) return { met: false, key: `timeout:${pred.then}@unresolved`, evidence: `timeout ${pred.after} unresolved` };
      const iso = new Date(at).toISOString(); const met = now.getTime() >= at;
      return { met, key: `timeout:${pred.then}@${iso}`, evidence: `timeout ${pred.after} = ${iso} ${met ? `passed → ${pred.then}` : 'not yet'}` };
    }
    case 'all': case 'any': {
      const parts = [];
      for (const p of pred.of) parts.push(await evaluatePredicate(p, probes, opts));
      const met = pred.kind === 'all' ? parts.every(x => x.met) : parts.some(x => x.met);
      const relevant = pred.kind === 'all' ? parts : parts.filter(x => x.met);
      const blocked = parts.map(x => x.blocked).filter((b): b is string => !!b);
      return { met: met && !blocked.length, key: relevant.map(x => x.key).join('&'), evidence: parts.map(x => `${x.met ? '✓' : '✗'} ${x.evidence}`).join(' · '),
        ...(blocked.length ? { blocked: blocked.join(' · ') } : {}) };
    }
    case 'not': {
      const inner = await evaluatePredicate(pred.of, probes, opts);
      return { met: !inner.met, key: `not(${inner.key})`, evidence: `not: ${inner.evidence}` };
    }
    case 'watch': {
      const line = await probes.watch(pred.watch, opts.sinceIso);
      return { met: line !== null, key: pred.watch, evidence: line ?? `${pred.watch} not yet` };
    }
    case 'minute-at-least':
      return { met: now.getMinutes() >= pred.minute, key: `minute≥${pred.minute}@${hourStart(now).toISOString()}`, evidence: `minute ${now.getMinutes()} vs ${pred.minute}` };
    case 'time-reached':
      return { met: now.getTime() >= Date.parse(pred.at), key: `time@${pred.at}`, evidence: `now ${now.toISOString()} vs ${pred.at}` };
    case 'not-updated-since': {
      const path = opts.expand(pred.path);
      const since = (pred.since === 'hour-start' ? hourStart(now) : dayStart(now));
      const mtime = probes.mtimeMs(path);
      const met = mtime === null || mtime < since.getTime();
      return { met, key: `stale:${path}@${since.toISOString()}`, evidence: mtime === null ? `${path} missing` : `${path} updated ${new Date(mtime).toISOString()} (since ${since.toISOString()})` };
    }
    case 'json-field': {
      const path = opts.expand(pred.path);
      const value = field(probes.readJson(path), pred.field);
      return { met: value === pred.equals, key: `${path}#${pred.field}=${String(pred.equals)}`, evidence: `${path} ${pred.field}=${JSON.stringify(value) ?? 'undefined'}` };
    }
    case 'cell-count': {
      const count = (await probes.cells()).filter(c => c.status === pred.status).length;
      return { met: count === pred.equals, key: `cells:${pred.status}=${pred.equals}`, evidence: `${count} ${pred.status} cells (want ${pred.equals})` };
    }
    case 'idle-with-open-cell': {
      const nowMs = now.getTime();
      // Idle-since unknown is not «idle long enough» — only a measured idle span counts.
      const idle = new Set((await probes.idleSeats())
        .filter(s => pred.idleMin === 0 || (s.sinceMs !== null && nowMs - s.sinceMs >= pred.idleMin * 60_000))
        .map(s => s.seat.toUpperCase()));
      const cells = (await probes.cells()).filter(c => c.status === pred.status && c.owner);
      const seats = [...new Set(cells.map(c => String(c.owner).toUpperCase().split('/')[0]!).filter(s => idle.has(s)))].sort();
      return { met: seats.length > 0, key: `idle-open:${seats.join(',')}`, evidence: seats.length ? `idle with ${pred.status} cells: ${seats.join(', ')}` : `no idle seat owns a ${pred.status} cell` };
    }
    case 'state-changed': {
      const values: string[] = [];
      for (const part of pred.parts) {
        if (part === 'landed-count') values.push(`landed=${await probes.landedCount()}`);
        else if (part === 'idle-seats') values.push(`idle=${(await probes.idleSeats()).map(s => s.seat.toUpperCase()).sort().join(',')}`);
        else if (part === 'hands-up-count') values.push(`hands=${await probes.handsUpCount()}`);
        else { const path = opts.expand(part.file); values.push(`file=${path}@${probes.mtimeMs(path) ?? 'missing'}`); }
      }
      return { met: true, key: `state:${sha(values.join('|'))}`, evidence: values.join(' · ') };
    }
    case 'version-published': {
      const published = await probes.publishedVersions();
      return { met: published.includes(pred.version), key: `published:${pred.version}`, evidence: `published ${published.slice(-3).join(', ') || 'none'} (want ${pred.version})` };
    }
    case 'installed-version': {
      const installed = await probes.installedVersion();
      return { met: installed === pred.equals, key: `installed:${pred.equals}`, evidence: `installed ${installed ?? 'unknown'} (want ${pred.equals})` };
    }
    case 'pulse-due': {
      if (!probes.pulseDue) throw new Error('pulse-due needs the pulseDue probe');
      const rhythm = opts.expand(pred.rhythm);
      return probes.pulseDue(rhythm.startsWith('/') ? rhythm : `${import.meta.dir}/../../graphs/triggers/${rhythm}`);
    }
    case 'poll-go': {
      const sha = typeof pred.sha === 'string' ? pred.sha : field(probes.readJson(opts.expand(pred.sha.path)), pred.sha.field);
      if (typeof sha !== 'string' || !sha) return { met: false, key: `poll:${pred.poll}@none`, evidence: `poll ${pred.poll}: no cut sha yet` };
      const ledger = opts.expand(pred.ledger);
      const latest = new Map<string, { answer?: unknown; sha?: unknown; evidence?: unknown }>();
      for (const line of probes.readLines(ledger)) {
        let row: Record<string, unknown>;
        try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (row.poll !== pred.poll || typeof row.voter !== 'string') continue;
        latest.set(row.voter.toUpperCase(), row);
      }
      const go: string[] = []; const missing: string[] = []; const noGo: string[] = [];
      for (const voter of pred.voters) {
        const row = latest.get(voter);
        const bound = row && row.sha === sha && typeof row.evidence === 'string' && row.evidence.trim() !== '';
        if (row?.answer === 'NO-GO' && row.sha === sha) noGo.push(voter);
        else if (row?.answer === 'GO' && bound) go.push(voter);
        else missing.push(voter);
      }
      const evidence = `poll ${pred.poll} @${sha.slice(0, 12)}: GO ${go.join(',') || '—'} · NO-GO ${noGo.join(',') || '—'} · missing/unbound ${missing.join(',') || '—'}`;
      return { met: go.length === pred.voters.length, key: `poll:${pred.poll}@${sha}`, evidence,
        ...(noGo.length ? { blocked: `NO-GO from ${noGo.join(',')} on ${pred.poll} @${sha.slice(0, 12)}` } : {}) };
    }
    case 'res': {
      const root = opts.expand(pred.root);
      if (pred.check === 'ready-stale') {
        const stale = staleHosts(root, pred.hosts, pred.maxAgeDays, now);
        return { met: stale.length > 0, key: `res-stale:${stale.map(s => s.host).join(',')}@${dayStart(now).toISOString()}`,
          evidence: stale.length ? stale.map(s => `${s.host} ${s.why}`).join(' · ') : `all of ${pred.hosts.join(',')} ready ≤ ${pred.maxAgeDays}d (or leased)` };
      }
      if (pred.check === 'lease-due') {
        const due = dueLeases(root, now);
        return { met: due.length > 0, key: `res-lease:${dueKey(due, now)}`,
          evidence: due.length ? due.map(d => `${d.action} ${d.lease.id}${d.action === 'drain' ? ` (${d.why})` : ''}`).join(' · ') : 'no lease due' };
      }
      const ph = releasePhase(opts.expand(pred.stateRoot), now);
      const cls = ph.phase === 'idle' ? 'idle' : `reserved@${ph.version}`;
      return { met: true, key: `res-phase:${cls}`, evidence: `release phase ${ph.phase}${ph.version ? ` ${ph.version} until ${ph.until}` : ''}` };
    }
  }
}

/** Default probes: the COND-WATCH probes (#40074) plus small ledger reads. Every external call is lazy. */
export function defaultConditionProbes(): ConditionProbes {
  return {
    now: () => new Date(),
    async watch(watch, sinceIso) {
      const { parseWaitCondition, defaultWaitProbes } = await import('../msg/self-timer-watch.js');
      const c = parseWaitCondition(watch);
      const p = defaultWaitProbes();
      switch (c.kind) {
        case 'pr-merged': return await p.prMerged(c.pr) ? `PR #${c.pr} merged` : null;
        case 'file': return await p.fileExists(c.path) ? `file exists ${c.path}` : null;
        case 'pregate-receipt': return p.pregateReceipt ? p.pregateReceipt(c.pr, c.head) : null;
        case 'seat-idle': return p.seatIdle && await p.seatIdle(c.seat) ? `seat ${c.seat} idle` : null;
        case 'cell-status': {
          const cell = p.cellStatus ? await p.cellStatus(c.cell) : null;
          if (!cell) return null;
          const met = c.owner !== undefined ? (cell.owner ?? '').toUpperCase().split('/')[0] === c.owner : cell.status === c.status;
          return met ? `cell ${c.cell} status=${cell.status}` : null;
        }
        case 'mail-from': {
          const id = p.mailFrom ? await p.mailFrom(c.seat, 'OP', sinceIso) : null;
          return id === null ? null : `mail #${id} from ${c.seat}`;
        }
        default: throw new Error(`watch ${watch}: not an outcome condition`);
      }
    },
    mtimeMs: path => existsSync(path) ? statSync(path).mtimeMs : null,
    readJson: path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } },
    readLines: path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [],
    async cells() {
      const { checklistDevVersion, listChecklist } = await import('../release-loop/checklist.js');
      return listChecklist(checklistDevVersion()).items.map(i => ({ id: i.id, status: i.status, owner: i.owner ?? null }));
    },
    async idleSeats() {
      const { spawnSync } = await import('node:child_process');
      const out = spawnSync('els', ['ls', '--json'], { encoding: 'utf8', timeout: 15_000 }); // Source: els socket call bound, one per tick.
      if (out.status !== 0) throw new Error(`els ls exit ${out.status}`);
      const panes = (JSON.parse(out.stdout) as { panes?: Array<{ workspace?: string; status?: { state?: string; since?: number } | null }> }).panes ?? [];
      const bySeat = new Map<string, { idle: boolean; sinceMs: number | null }>();
      for (const pane of panes) {
        const seat = (pane.workspace ?? '').toUpperCase();
        if (!seat) continue;
        const prev = bySeat.get(seat) ?? { idle: true, sinceMs: 0 };
        const idle = (pane.status?.state ?? '').toUpperCase() === 'IDLE';
        const since = typeof pane.status?.since === 'number' ? pane.status.since : null;
        // A seat is idle since its most recently idled pane.
        bySeat.set(seat, { idle: prev.idle && idle, sinceMs: prev.sinceMs === null || since === null ? null : Math.max(prev.sinceMs, since) });
      }
      return [...bySeat].filter(([, v]) => v.idle).map(([seat, v]) => ({ seat, sinceMs: v.sinceMs }));
    },
    async landedCount() {
      const { spawnSync } = await import('node:child_process');
      const { repoRoot } = await import('../domains/schedule-registry.js');
      const out = spawnSync('git', ['-C', repoRoot(), 'rev-list', '--count', 'origin/main'], { encoding: 'utf8' });
      return Number(out.stdout.trim()) || 0;
    },
    async handsUpCount() {
      // ✋ proxy: OP's unread mail count (hands raised to the coordinator land there first).
      const { readUnreadCount } = await import('../msg/msg-store.js');
      return readUnreadCount('OP') ?? 0;
    },
    async publishedVersions() {
      const { spawnSync } = await import('node:child_process');
      const out = spawnSync('npm', ['view', 'elanous', 'versions', '--json'], { encoding: 'utf8', timeout: 30_000 }); // Source: one registry read per tick.
      if (out.status !== 0) return [];
      const parsed = JSON.parse(out.stdout) as string[] | string;
      return Array.isArray(parsed) ? parsed : [parsed];
    },
    async pulseDue(rhythmPath) {
      const [{ pulseDueNow }, { livePulseProbes }] = await Promise.all([import('./op-pulse-run.js'), import('./op-pulse-live.js')]);
      const { join } = await import('node:path');
      const { effectiveInstanceRoot } = await import('../instance/resolve.js');
      return pulseDueNow(livePulseProbes(), { rhythmPath, seatState: process.env.ELANOUS_SEAT_STATE ?? join(process.env.HOME ?? '', 'elanous-hq', 'seat-state'), stateRoot: effectiveInstanceRoot() });
    },
    async installedVersion() {
      const { installedCronRoot } = await import('../domains/schedule-registry.js');
      const root = installedCronRoot();
      if (!root) return null;
      try { return (JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as { version?: string }).version ?? null; } catch { return null; }
    },
  };
}
