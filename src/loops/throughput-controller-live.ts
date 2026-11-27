// THROUGHPUT-CONTROLLER live probes and actuators (see throughput-controller.ts for the SCQA and the three faces).
// Every probe reads an existing ledger once and fails open to null («?» — never zero):
//   lands/h          git log origin/main --since 1h (squash subjects «(#N)») — every landing path, not only the graph
//   cells · greens   checklist listChecklist(version in play) — green/h = cells turned green in the last hour
//   judge-ready      green-triage bucket (a) — merged PR ⊕ same-head PREGATE-GREEN lane (the `green-triage` command)
//   land             {stateRoot}/land-graph/last-tick.json ⊕ ledger.jsonl (landed/h · refusals · waits · tick spacing)
//   slots · authors  config land.graph.{slots, authors} (the land graph's own config)
//   open PRs         one `gh pr list --json number,headRefOid,author,files,isDraft`
//   receipts         seat-state/RES/evidence/PREGATE-GREEN/*/receipt.json written in the last 2 h (tsc step exit)
//   hands · frozen   hand pool (free = idle without a cell) · hand-raise ladder open ✋ ≥ FROZEN_MIN
// Actuators: one msg-store card per action (from OP, kind info) · dedupe ledger {stateRoot}/loops/throughput-controller.jsonl
// · the board line seat-state/OP/pulse/THROUGHPUT-NOW.md.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readHolds } from '../hold-ledger/hold-ledger.js';
import { namedByHold } from '../judge-butler/body.js';
import { ageMin, HOUR_MS, inWindow } from '../kit/kpi/index.js';
import { boardLine, decideThroughput, executeThroughput, FROZEN_MIN, renderThroughputBlock, TARGET_GREENS_PER_H, TARGET_LANDS_PER_H,
  type ThroughputActuators, type ThroughputSnapshot, type TpOpenPr, type TpReceipt, type TpRefusal } from './throughput-controller.js';
import { hostsFor } from '../kit/resource-facts/index.js';

const HOUR = HOUR_MS;
const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/gu, ' ').slice(0, 80);
// 출처: OPS-RULES §착지 가속 · memory local-hosts-before-paid-vm — local first, paid VMs only on overflow.
// RESOURCE-FACTS-FROM-LEDGER: the pregate hosts come from the world registry (an unhealthy/reserved host drops out).
export const pregateHosts = (): string[] => hostsFor('pregate');
const SENT_WINDOW_MS = 6 * HOUR;

export interface TpRoots { stateRoot: string; seatState: string }

export const throughputLedgerPath = (stateRoot: string) => join(stateRoot, 'loops', 'throughput-controller.jsonl');

/** Earliest timestamp of each key's successful card-send ledger row, without an age window. */
export function throughputFirstSentAt(stateRoot: string): Map<string, number> {
  const first = new Map<string, number>();
  for (const row of readJsonl<{ at?: string; key?: string; mail?: unknown }>(throughputLedgerPath(stateRoot))) {
    if (typeof row.key !== 'string' || !Array.isArray(row.mail)) continue;
    const at = Date.parse(row.at ?? '');
    if (!Number.isFinite(at)) continue;
    const previous = first.get(row.key);
    if (previous === undefined || at < previous) first.set(row.key, at);
  }
  return first;
}

export const throughputNowPath = (seatState: string) => join(seatState, 'OP', 'pulse', 'THROUGHPUT-NOW.md');

type LandRow = { at?: string; pr?: number; head?: string; event?: string; action?: string; cls?: string; synthetic?: boolean };

function readJsonl<T>(path: string): T[] {
  try { return readFileSync(path, 'utf8').split('\n').flatMap(l => { if (!l.trim()) return []; try { return [JSON.parse(l) as T]; } catch { return []; } }); } catch { return []; }
}

function landConfig(): { slots: number | null; authors: Record<string, string> } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getElanousConfigDirOverride } = require('../elanous-config-dir.js') as typeof import('../elanous-config-dir.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { userConfigPath } = require('../user-config.js') as typeof import('../user-config.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { effectiveInstanceRoot } = require('../instance/resolve.js') as typeof import('../instance/resolve.js');
    const path = getElanousConfigDirOverride() ? join(effectiveInstanceRoot(), 'config.json') : userConfigPath();
    const g = (JSON.parse(readFileSync(path, 'utf8')) as { land?: { graph?: { slots?: unknown; authors?: unknown } } }).land?.graph ?? {};
    // Same default as defaultLandDeps: single-flight when unset.
    return { slots: typeof g.slots === 'number' && g.slots > 0 ? g.slots : 1, authors: g.authors && typeof g.authors === 'object' ? g.authors as Record<string, string> : {} };
  } catch { return { slots: null, authors: {} }; }
}

/** Land-graph readings from its ledger: graph lands/h · churn refusals (2 h) · PRs waiting for a receipt · tick spacing. */
export function readLandLedger(stateRoot: string, nowMs: number, openHeads: ReadonlyMap<number, string> | null): {
  graphLands: number; churn: Array<{ pr: number; cls: string; at: string }>; awaiting: Array<{ pr: number; sinceMin: number }> | null; avgTickMin: number | null;
} {
  const rows = readJsonl<LandRow>(join(stateRoot, 'land-graph', 'ledger.jsonl')).filter(r => !r.synthetic && typeof r.pr === 'number' && typeof r.at === 'string');
  const t = (r: LandRow) => Date.parse(r.at!);
  const graphLands = rows.filter(r => r.event === 'landed' && inWindow(r.at, nowMs, HOUR)).length;
  const churn = rows.filter(r => r.event === 'refused' && r.cls && inWindow(r.at, nowMs, 2 * HOUR)).map(r => ({ pr: r.pr!, cls: r.cls!, at: r.at! }));
  let awaiting: Array<{ pr: number; sinceMin: number }> | null = null;
  if (openHeads) {
    awaiting = [];
    for (const [pr, head] of openHeads) {
      const mine = rows.filter(r => r.pr === pr && r.head === head && r.event === 'decision');
      const last = mine[mine.length - 1];
      if (!last || !(last.cls === 'no-receipt' || last.cls === 'stale-head')) continue;
      const first = mine.find(r => r.cls === 'no-receipt' || r.cls === 'stale-head')!;
      awaiting.push({ pr, sinceMin: ageMin(first.at, nowMs) ?? 0 });
    }
  }
  // Tick spacing: rows of one tick share its start time — the median gap between distinct tick times in 2 h.
  const ticks = [...new Set(rows.filter(r => inWindow(r.at, nowMs, 2 * HOUR)).map(t))].sort((a, b) => a - b);
  const gaps = ticks.slice(1).map((x, i) => (x - ticks[i]!) / 60_000).sort((a, b) => a - b);
  const avgTickMin = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]! * 10) / 10 : null;
  return { graphLands, churn, awaiting, avgTickMin };
}

function gitLines(cwd: string, args: string[]): string[] | null {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }); // Source: one log read per probe.
  return r.status === 0 ? r.stdout.split('\n') : null;
}

/** Files per merged PR from the squash commits of the last 3 h (refused PRs that have since landed). */
function mergedFiles(cwd: string, nowMs: number): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const lines = gitLines(cwd, ['log', 'origin/main', `--since=${new Date(nowMs - 3 * HOUR).toISOString()}`, '--name-only', '--format=@@%s']) ?? [];
  let pr: number | null = null;
  for (const l of lines) {
    if (l.startsWith('@@')) { const m = /\(#(\d+)\)\s*$/u.exec(l); pr = m ? Number(m[1]) : null; if (pr) out.set(pr, []); continue; }
    if (pr && l.trim()) out.get(pr)!.push(l.trim());
  }
  return out;
}

// THROUGHPUT-REPO (11-27 P0): `repoRoot()` resolves from the running code, so on an install it is the package dir — not a
// git repo — and the installed controller could count neither lands/h nor open PRs. The dev repo is resolved instead:
// ELANOUS_REPO → config `repo.path` → the running code's root (a tree run) → ~/elanous-hq/repo.git. Each candidate must
// be a git work tree that knows origin/main; none → null and the readings that need it are «unmeasured», never 0.
function configRepoPath(): unknown {
  const { getUserConfig } = require('../user-config/reader.js') as typeof import('../user-config/reader.js');
  return (getUserConfig() as { repo?: { path?: unknown } }).repo?.path;
}

export function resolveDevRepoRoot(deps: { env?: NodeJS.ProcessEnv; configPath?: () => unknown; codeRoot?: () => string; home?: string; isRepo?: (p: string) => boolean } = {}): string | null {
  const env = deps.env ?? process.env;
  const isRepo = deps.isRepo ?? ((p: string) => spawnSync('git', ['-C', p, 'rev-parse', '--verify', '--quiet', 'origin/main'], { encoding: 'utf8', timeout: 10_000 }).status === 0);
  const tries: Array<() => unknown> = [
    () => env.ELANOUS_REPO,
    () => (deps.configPath ?? configRepoPath)(),
    () => (deps.codeRoot ?? (() => (require('../domains/schedule-registry.js') as typeof import('../domains/schedule-registry.js')).repoRoot()))(),
    () => join(deps.home ?? homedir(), 'elanous-hq', 'repo.git'),
  ];
  for (const t of tries) {
    let p: unknown;
    try { p = t(); } catch { continue; }
    if (typeof p !== 'string' || !p.trim()) continue;
    const path = p.trim().replace(/^~(?=\/|$)/u, deps.home ?? homedir());
    try { if (isRepo(path)) return path; } catch { /* next */ }
  }
  return null;
}

/** The controller snapshot from live state. */
export async function liveThroughputSnapshot(roots: TpRoots, now: Date): Promise<ThroughputSnapshot> {
  const nowMs = now.getTime(); const unmeasured: string[] = [];
  const repo = resolveDevRepoRoot();
  if (!repo) unmeasured.push('repo(no git repo with origin/main: ELANOUS_REPO · repo.path · ~/elanous-hq/repo.git)');
  const cwd = repo ?? '';
  const landedLines = repo ? gitLines(cwd, ['log', 'origin/main', `--since=${new Date(nowMs - HOUR).toISOString()}`, '--format=%s']) : null;
  const landed = landedLines ? new Set(landedLines.flatMap(l => { const m = /\(#(\d+)\)\s*$/u.exec(l); return m ? [Number(m[1])] : []; })) : null;
  if (!landed) unmeasured.push('lands(git log)');

  let version: string | null = null;
  let items: import('../release-loop/checklist.js').ChecklistItem[] | null = null;
  try {
    const { listChecklist } = await import('../release-loop/checklist.js');
    const { releaseLedgerRoot } = await import('../instance/resolve.js');
    const { versionInPlay } = await import('./op-next-action-live.js');
    version = await versionInPlay(join(roots.seatState, '..'), releaseLedgerRoot());
    items = listChecklist(version, releaseLedgerRoot()).items;
  } catch (e) { unmeasured.push(`checklist(${short(e)})`); }
  const greensLastHour = items ? items.filter(i => i.status === 'green' && inWindow(i.updatedAt, nowMs, HOUR)).length : null;
  let landsWithoutCell: number | null = null;
  if (items && landed) {
    const cited = new Set<number>();
    for (const i of items) for (const m of `${i.evidence ?? ''} ${i.source ?? ''} ${i.body ?? ''}`.matchAll(/#(\d{3,6})\b/gu)) cited.add(Number(m[1]));
    landsWithoutCell = [...landed].filter(pr => !cited.has(pr)).length;
  }
  let judgeReady: ThroughputSnapshot['judgeReady'] = null;
  try {
    if (version && items) {
      const { PREGATE_GREEN_DIR, readGreenTriageSources, triageGreen } = await import('../release-loop/green-triage.js');
      const lanes = existsSync(PREGATE_GREEN_DIR) ? readdirSync(PREGATE_GREEN_DIR) : [];
      const candidates = triageGreen(version, items, readGreenTriageSources({ greenLanes: () => lanes })).rows.judge.map(r => ({ cell: r.id, prs: r.mergedPrs }));
      try {
        const holds = readHolds(roots.stateRoot, now);
        judgeReady = candidates.filter(candidate => !namedByHold(holds, candidate.cell, now));
      } catch {
        judgeReady = candidates;
        unmeasured.push('holds');
      }
    }
  } catch (e) { unmeasured.push(`green-triage(${short(e)})`); }

  const cfg = landConfig();
  if (cfg.slots === null) unmeasured.push('land.graph.slots');
  let openPrs: TpOpenPr[] | null = null;
  try {
    if (!repo) throw new Error('no repo');
    const r = spawnSync('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,headRefOid,author,files,isDraft'], { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }); // Source: one list per controller run.
    if (r.status !== 0) throw new Error(`gh exit ${r.status}: ${String(r.stderr).trim().slice(0, 80)}`);
    openPrs = (JSON.parse(r.stdout) as Array<{ number: number; headRefOid: string; author?: { login?: string }; files?: Array<{ path: string }>; isDraft: boolean }>)
      .map(p => ({ pr: p.number, head: p.headRefOid, author: cfg.authors[p.author?.login ?? ''] ?? p.author?.login ?? '', files: (p.files ?? []).map(f => f.path), draft: p.isDraft }));
  } catch (e) { unmeasured.push(`open-prs(${short(e)})`); }
  const openHeads = openPrs ? new Map(openPrs.filter(p => !p.draft).map(p => [p.pr, p.head] as const)) : null;
  const ledger = readLandLedger(roots.stateRoot, nowMs, openHeads);
  type LastTick = { at?: string; mode?: string; readyNotLanded?: number };
  const tick: LastTick | null = (() => { try { return JSON.parse(readFileSync(join(roots.stateRoot, 'land-graph', 'last-tick.json'), 'utf8')) as LastTick; } catch { unmeasured.push('land last-tick'); return null; } })();
  const filesOf = new Map<number, readonly string[]>((openPrs ?? []).map(p => [p.pr, p.files] as const));
  const merged = repo ? mergedFiles(cwd, nowMs) : new Map<number, string[]>();
  const churn: TpRefusal[] = ledger.churn.map(r => ({ ...r, files: filesOf.get(r.pr) ?? merged.get(r.pr) ?? [] }));

  let receipts: TpReceipt[] | null = null;
  try {
    const root = join(roots.seatState, 'RES', 'evidence', 'PREGATE-GREEN');
    const authorOf = new Map((openPrs ?? []).map(p => [p.pr, p.author] as const));
    receipts = [];
    for (const name of existsSync(root) ? readdirSync(root) : []) {
      const f = join(root, name, 'receipt.json');
      let mtime: number; try { mtime = statSync(f).mtimeMs; } catch { continue; }
      if (nowMs - mtime > 2 * HOUR) continue;
      try {
        const r = JSON.parse(readFileSync(f, 'utf8')) as { pr?: number; head?: string; host?: string; steps?: Array<{ name?: string; exit?: number | null }> };
        const tsc = (r.steps ?? []).find(s => /tsc/u.test(s.name ?? ''));
        if (typeof r.pr !== 'number' || !tsc) continue; // no tsc step = nothing to judge here
        const author = authorOf.get(r.pr);
        receipts.push({ pr: r.pr, head: r.head ?? '', host: r.host ?? '?', at: new Date(mtime).toISOString(), tscExit: typeof tsc.exit === 'number' ? tsc.exit : null, ...(author ? { author } : {}) });
      } catch { /* unreadable receipt — skip */ }
    }
  } catch (e) { unmeasured.push(`receipts(${short(e)})`); }

  let hands: ThroughputSnapshot['hands'] = null;
  try {
    const { liveHandPool } = await import('../seat/hand-pool-live.js');
    const { isJudgeHand } = await import('../seat/hand-pool.js');
    const pool = await liveHandPool({ now: nowMs });
    hands = { free: pool.filter(h => h.state === 'idle' && !h.cell && !isJudgeHand(h.seat)).map(h => h.seat),
      holdingIdle: pool.filter(h => h.state === 'idle' && !!h.cell).map(h => h.seat), working: pool.filter(h => h.state === 'working').length };
  } catch (e) { unmeasured.push(`hands(${short(e)})`); }
  let frozen: ThroughputSnapshot['frozen'] = null;
  try {
    const { openMsgStoreReadOnly } = await import('../msg/msg-store.js');
    const ladder = await import('../msg/hand-raise-ladder.js');
    const store = openMsgStoreReadOnly();
    try {
      const seen = new Set<string>();
      frozen = ladder.openHands(store, { now: nowMs }).filter(h => h.waitedMs >= FROZEN_MIN * 60_000)
        .sort((a, b) => b.waitedMs - a.waitedMs)
        .filter(h => { const k = h.blockedSeat.toUpperCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .map(h => ({ seat: h.blockedSeat, to: h.receiver, ageMin: Math.round(h.waitedMs / 60_000), msgId: h.id }));
    } finally { store.close(); }
  } catch (e) { unmeasured.push(`frozen(${short(e)})`); }
  let readyCells: number | null = null;
  if (items) {
    const { readyCells: ready } = await import('./op-next-action.js');
    readyCells = ready(items.map(i => ({ id: i.id, title: i.title, status: i.status, ...(i.owner ? { owner: i.owner } : {}), ...(i.priority ? { priority: i.priority } : {}),
      ...(i.predecessors ? { predecessors: i.predecessors } : {}), ...(i.dispatchKind ? { dispatchKind: i.dispatchKind } : {}), updatedAt: i.updatedAt })))
      .filter(c => !!items!.find(i => i.id === c.id)?.doneCriterion).length;
  }
  return {
    now: now.toISOString(), version, targets: { landsPerH: TARGET_LANDS_PER_H, greensPerH: TARGET_GREENS_PER_H },
    landsLastHour: landed ? landed.size : null, graphLandsLastHour: ledger.graphLands, greensLastHour, judgeReady, landsWithoutCell,
    land: { readyToLand: typeof tick?.readyNotLanded === 'number' ? tick.readyNotLanded : null, slots: cfg.slots, mode: tick?.mode ?? null,
      lastTickAgeMin: tick?.at ? Math.max(0, Math.round((nowMs - Date.parse(tick.at)) / 60_000)) : null, avgTickMin: ledger.avgTickMin },
    churn, openPrs, awaitingPregate: ledger.awaiting, receipts, pregateHosts: pregateHosts(), hands, frozen, readyCells, unmeasured,
  };
}

/** Live actuators: one msg-store card per recipient (from OP · kind info) · the dedupe ledger. */
export function liveThroughputActuators(roots: TpRoots, nowMs = Date.now()): ThroughputActuators {
  const ledger = throughputLedgerPath(roots.stateRoot);
  return {
    async card(to, body) {
      const { openMsgStore } = await import('../msg/msg-store.js');
      const store = openMsgStore();
      try { return String(store.post({ from: 'OP', to, kind: 'info', body } as Parameters<typeof store.post>[0]).id); } finally { store.close(); }
    },
    sentKeys() {
      return new Set(readJsonl<{ at?: string; key?: string; mail?: unknown }>(ledger).filter(r => typeof r.key === 'string' && Array.isArray(r.mail) && nowMs - Date.parse(r.at ?? '') <= SENT_WINDOW_MS).map(r => r.key!));
    },
    staleKeys() {
      const firstSentAt = throughputFirstSentAt(roots.stateRoot);
      const recent = this.sentKeys();
      return new Set([...firstSentAt.keys()].filter(key => !recent.has(key)));
    },
    record(row) { mkdirSync(dirname(ledger), { recursive: true }); appendFileSync(ledger, `${JSON.stringify(row)}\n`); },
  };
}

/**
 * One controller run: snapshot → verdict → (live: machine levers + safety cards) → board line → block.
 * `stage` = live (the pulse) | manual (`eln pulse next` / `eln pulse throughput` without --execute: read only).
 */
export async function runThroughputLive(roots: TpRoots, now: Date, stage: string): Promise<{ block: string; line: string }> {
  const snap = await liveThroughputSnapshot(roots, now);
  const verdict = decideThroughput(snap);
  const actuators = stage === 'live' ? liveThroughputActuators(roots, now.getTime()) : null;
  const did = await executeThroughput(verdict, actuators, stage);
  const line = boardLine(verdict);
  if (stage === 'live') {
    const p = throughputNowPath(roots.seatState); mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${line}\n\n${renderThroughputBlock(verdict, did)}\n`);
    mkdirSync(dirname(throughputLedgerPath(roots.stateRoot)), { recursive: true });
    appendFileSync(throughputLedgerPath(roots.stateRoot), `${JSON.stringify({ at: verdict.at, verdict: verdict.binding.kind, lever: verdict.lever.id, lands: verdict.measured.lands, greens: verdict.measured.greens, active: verdict.active.map(a => a.kind) })}\n`);
  }
  return { block: renderThroughputBlock(verdict, did), line };
}
