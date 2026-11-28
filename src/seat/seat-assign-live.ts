// OP-HANDLES-L2b — the live wiring for seatAssign (CLI `eln seat assign` and the SeatAssign tool share it).
// Ledgers: release checklist (owner) · seat mail (assignment) · wakeRecipient (idle-only typing) · gh/git (writers).

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readBoardPointer, readRawConfig, resolveCurrentVersion } from '../ops-dashboard/current-version.js';
import { debug } from '../debug/log.js';
import { assignItem, listChecklist, swapOwnerIf } from '../release-loop/checklist.js';
import { declaredFederationSeats } from '../msg/seat-mail-trust.js';
import { loadFederationLadder } from '../msg/hand-raise-ladder.js';
import { openMsgStore } from '../msg/msg-store.js';
import { resolveSeatStateRoot, wakeRecipient } from '../loops/msg-wake.js';
import { resolveScope } from '../steward/space/config.js';
import { getUserConfig } from '../user-config/reader.js';
import { preapprovedPool } from './resource-preapproval.js';
import { claimSeatWake, defaultWakeLedgerPath } from './wake-ledger.js';
import { lastTurnAt } from '../msg/diverted-mail.js';
import { pathTouches, SEAT_ASSIGN_MAIL_KIND, type AssignRatePolicy, type SeatAssignDeps, type WriterRow } from './seat-assign.js';
import { seatVeto, type SeatVetoDeps } from './seat-veto.js';
import { loadSeatAssignPolicy } from './seat-assign-wip1.js';
import { boardVersion } from '../release-loop/board-version.js';

const WRITER_TIMEOUT_MS = 20_000;

/** MODEL-BY-DIFFICULTY: earlier assignment mails for this cell in 48 h (each = an attempt that did not finish it). */
export function priorAttempts(cellId: string, nowMs = Date.now()): number {
  try {
    const store = openMsgStore();
    try {
      return store.listCreatedBetween(new Date(nowMs - 48 * 3_600_000).toISOString(), new Date(nowMs + 60_000).toISOString())
        .filter(m => m.kind === SEAT_ASSIGN_MAIL_KIND && (m.refs ?? []).includes(`cell:${cellId}`)).length;
    } finally { store.close(); }
  } catch { return 0; }
}

/** STEWARD-RX-CURRENT-PLAN — default = the current release (PLAN `status: current` → schedule → package), not the
 *  package dev version: after a roster move (0.3.36 → 0.3.37) before the bump PR lands, the package still says 0.3.36. */
function currentChecklistVersion(version?: string): string {
  if (version) return version;
  try { return resolveCurrentVersion({ hqRoot: join(homedir(), 'elanous-hq') }).version; } catch { return boardVersion(); }
}

function liveFindCell(cellId: string, version?: string) {
  const v = currentChecklistVersion(version);
  const item = listChecklist(v).items.find(row => row.id === cellId);
  return item ? { version: v, item } : undefined;
}

function liveStewardScope(seat: string): string | null {
  const ladder = loadFederationLadder();
  const scope = ladder.parentOf(seat.toUpperCase()).toUpperCase();
  return resolveScope(scope, ladder.hq, getUserConfig().loops?.stewardSpace).mode === 'live' ? scope : null;
}

/** Open PRs (gh) ⊕ main commits of the last 6 h (git) that touch the paths. A failure throws: «check unavailable». */
export function liveWriters(paths: readonly string[], cwd: string = process.cwd()): WriterRow[] {
  const gh = spawnSync('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName,updatedAt,files'],
    { cwd, encoding: 'utf8', timeout: WRITER_TIMEOUT_MS });
  if (gh.status !== 0) throw new Error(`gh pr list failed: ${(gh.stderr || gh.error?.message || '').trim().slice(0, 120)}`);
  const prs = JSON.parse(gh.stdout) as { number: number; title: string; headRefName: string; updatedAt: string; files?: { path: string }[] }[];
  const rows: WriterRow[] = [];
  for (const pr of prs) {
    const touched = (pr.files ?? []).map(f => f.path).filter(file => paths.some(p => pathTouches(file, p)));
    if (touched.length) rows.push({ kind: 'pr', ref: `#${pr.number}`, title: pr.title, updatedAt: pr.updatedAt, branch: pr.headRefName, paths: touched });
  }
  const git = spawnSync('git', ['log', 'origin/main', '--since=6.hours', '--format=%h%x09%cI%x09%s', '--', ...paths], { cwd, encoding: 'utf8', timeout: WRITER_TIMEOUT_MS });
  if (git.status === 0) {
    for (const line of git.stdout.split('\n').filter(Boolean)) {
      const [sha, at, subject] = line.split('\t');
      rows.push({ kind: 'commit', ref: sha ?? '?', title: subject ?? '', updatedAt: at ?? '', paths: [] });
    }
  }
  return rows;
}

/** ASSIGN-CAP-POLICY — `seat.assign.*` of a raw config object (numbers only; anything else = the default). */
export function readAssignRatePolicy(raw: unknown): AssignRatePolicy | null {
  const a = (raw as { seat?: { assign?: Record<string, unknown> } } | null)?.seat?.assign;
  if (!a || typeof a !== 'object') return null;
  const pick = (k: string) => (typeof a[k] === 'number' ? { [k]: a[k] as number } : {});
  return { ...pick('rateMax'), ...pick('rateWindowMs'), ...pick('handRateMax') };
}

/**
 * WIP1-ASSIGN-GUARD-ACTIVE — the latest outside activity on a hand's cell since `sinceMs` (epoch ms ⊕ what it was):
 * push = an open PR whose branch/title names the cell or the seat · commit = a commit on any ref naming the cell or the seat ·
 * edit/test = the newest mtime of a dirty file in the seat's worktree. Each source fails soft; all failing throws (= unknown).
 */
export function liveCellActivity(seat: string, cellId: string, sinceMs: number, repo: string = join(homedir(), 'elanous-hq', 'repo.git')): { atMs: number; signal: string } | null {
  const s = seat.toLowerCase();
  const c = cellId.toLowerCase();
  const names = (text: string) => { const t = text.toLowerCase(); return t.includes(c) || t.includes(s); };
  let best: { atMs: number; signal: string } | null = null;
  const seen = (atMs: number, signal: string) => { if (Number.isFinite(atMs) && atMs >= sinceMs && (!best || atMs > best.atMs)) best = { atMs, signal }; };
  let failures = 0;
  try {
    const gh = spawnSync('gh', ['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName,updatedAt'], { cwd: repo, encoding: 'utf8', timeout: WRITER_TIMEOUT_MS });
    if (gh.status !== 0) throw new Error('gh');
    for (const pr of JSON.parse(gh.stdout) as { number: number; title: string; headRefName: string; updatedAt: string }[]) {
      if (names(`${pr.headRefName} ${pr.title}`)) seen(Date.parse(pr.updatedAt), `push PR #${pr.number}`);
    }
  } catch { failures += 1; }
  try {
    const since = Math.max(1, Math.ceil((Date.now() - sinceMs) / 60_000));
    const git = spawnSync('git', ['log', '--all', `--since=${since} minutes ago`, '--format=%ct%x09%S%x09%s'], { cwd: repo, encoding: 'utf8', timeout: WRITER_TIMEOUT_MS });
    if (git.status !== 0) throw new Error('git');
    for (const line of git.stdout.split('\n').filter(Boolean)) {
      const [ct, ref, subject] = line.split('\t');
      if (names(`${ref ?? ''} ${subject ?? ''}`)) seen(Number(ct) * 1000, `commit ${(ref ?? '').replace(/^refs\/(heads|remotes)\//, '').slice(0, 40)}`);
    }
  } catch { failures += 1; }
  try {
    const { liveWriterCheckPorts } = require('../steward/space/writer-resolver-live.js') as typeof import('../steward/space/writer-resolver-live.js');
    const ports = liveWriterCheckPorts([seat.toUpperCase()], repo);
    const wt = ports.worktreeOf(seat, undefined);
    if (wt) for (const file of ports.uncommitted(wt)) { try { seen(statSync(join(wt, file)).mtimeMs, `worktree edit ${file.slice(0, 60)}`); } catch { /* deleted file */ } }
  } catch { failures += 1; }
  if (failures === 3) throw new Error('cell activity: gh · git · worktree all unavailable');
  return best;
}

export function liveSeatAssignDeps(): SeatAssignDeps {
  return {
    now: () => new Date(),
    coordinators: () => {
      const ladder = loadFederationLadder();
      // depth 1 = HQ · 2 = space coordinator (hand-raise ladder: journal ⊕ federation.yaml).
      return { hq: ladder.hq, spaces: [], isCoordinator: seat => { const depth = ladder.depthOf(seat); return depth === 1 || depth === 2; } };
    },
    federationSeats: () => declaredFederationSeats({ stateRoot: resolveSeatStateRoot() }),
    findCell: liveFindCell,
    writers: paths => liveWriters(paths),
    assign: (version, cellId, seat, options) => { const done = assignItem(version, cellId, seat, options); return { from: done.from, outcome: done.outcome }; },
    post: mail => {
      const store = openMsgStore();
      try { return { id: store.post(mail).id }; } finally { store.close(); }
    },
    wake: (seat, mailId, from) => wakeRecipient(seat, mailId, { from, kind: 'assign' }),
    pool: () => preapprovedPool(resolveSeatStateRoot()),
    // FEDERATION HAND POOL — POOL picks from it; a hand from another scope is logged as pool.lend.
    handPool: async () => (require('./hand-pool-live.js') as typeof import('./hand-pool-live.js')).liveHandPool(),
    hq: loadFederationLadder().hq,
    log: (event, data) => debug.log('seat', event, data),
    liveStewardScope,
    // OP-DIRECT-ASSIGN: the board's ready count = open (yellow) cells nobody owns in the current release.
    readyCells: () => listChecklist(currentChecklistVersion()).items.filter(row => row.status === 'yellow' && !row.owner).length,
    recentAssign: (seat, cellId, sinceMs) => {
      const store = openMsgStore();
      try {
        const ref = `cell:${cellId}`;
        const hit = store.listCreatedBetween(new Date(sinceMs).toISOString(), new Date(Date.now() + 60_000).toISOString())
          .filter(m => m.to.toUpperCase() === seat.toUpperCase() && m.kind === SEAT_ASSIGN_MAIL_KIND && (m.refs ?? []).includes(ref))
          .sort((a, b) => b.id - a.id)[0];
        if (!hit) return null;
        return { id: hit.id, atMs: Date.parse(hit.createdAt), answered: store.listReplies(hit.id, 1).length > 0 };
      } finally { store.close(); }
    },
    // SEAT-ASSIGN-GUARD — the sender's assignment mails of the window · the target release · the pull-hint fold.
    // ASSIGN-CAP-POLICY — every assignment mail of the window; a `steward:<scope>` ref is the steward's own rate key.
    assignLedger: sinceMs => {
      const store = openMsgStore();
      try {
        return store.listCreatedBetween(new Date(sinceMs).toISOString(), new Date(Date.now() + 60_000).toISOString())
          .filter(m => m.kind === SEAT_ASSIGN_MAIL_KIND)
          .map(m => {
            const refs = m.refs ?? [];
            const steward = refs.find(r => r.startsWith('steward:'));
            return { from: m.from.toUpperCase(), to: m.to.toUpperCase(), cell: (refs.find(r => r.startsWith('cell:')) ?? '').slice(5), by: steward ?? m.from.toUpperCase() };
          });
      } finally { store.close(); }
    },
    // ASSIGN-CAP-POLICY — `seat.assign.{rateMax,rateWindowMs,handRateMax}` straight from config.json on every call.
    ratePolicy: () => readAssignRatePolicy(readRawConfig()),
    // GRAPH-VERSION-FRESH: from config.json on every call — the typed/scoped getUserConfig() has no `release` section.
    targetVersion: () => readBoardPointer(),
    hint: (cellId, seat, by) => {
      const { addPullHints } = require('../steward/space/work-next-cli.js') as typeof import('../steward/space/work-next-cli.js');
      const { effectiveInstanceRoot } = require('../instance/resolve.js') as typeof import('../instance/resolve.js');
      addPullHints(effectiveInstanceRoot(), [{ cell: cellId, seat }], by, Date.now());
    },
    // MODEL-BY-DIFFICULTY: score the cell from facts, write the seat's model directive (applied at the hand's next turn).
    modelFor: (seat, item, paths) => {
      const m = require('./model-by-difficulty.js') as typeof import('./model-by-difficulty.js');
      const { effectiveInstanceRoot } = require('../instance/resolve.js') as typeof import('../instance/resolve.js');
      const d = m.directiveFor({ seat, cell: item.id, facts: { cellId: item.id, paths, priorAttempts: priorAttempts(item.id) }, usedShare: m.liveUsedShare, by: 'seat-assign', now: new Date() });
      if (!d) { m.noModelFallback({ root: effectiveInstanceRoot(), seat, cell: item.id, note: 'no acceptable model under the budget', by: 'seat-assign', now: new Date() }); return { line: 'model: no acceptable model under the budget — your tab returns to its default model (no paid bypass)', tier: m.cellDifficulty({ cellId: item.id, paths }).tier }; }
      m.writeSeatModelDirective(effectiveInstanceRoot(), d);
      debug.log('seat', 'seat.model-directive', { seat: d.seat, cell: d.cell, tier: d.tier, model: `${d.provider}/${d.model}`, score: d.score, reasons: d.reasons, ...(d.note ? { note: d.note } : {}), via: 'assign' });
      return { line: m.directiveLine(d), tier: d.tier };
    },
    // WIP1-ASSIGN-GUARD — the current release's cells (owner ⊕ status ⊕ priority ⊕ updatedAt) · YAML policy · the veto path
    // (HQ override: CAS on the owner ⊕ checklist history claim row ⊕ one mail to the scope steward / previous owner).
    heldCells: () => listChecklist(currentChecklistVersion()).items,
    wip1Policy: () => loadSeatAssignPolicy().wip1,
    cellActivity: (seat, cellId, sinceMs) => liveCellActivity(seat, cellId, sinceMs),
    // ELN-OP-CROWN-MEMORY — active CEO directive cards (kit/crown-directive · policy graphs/policies/crown-directives.yaml).
    directiveRefusal: (q) => {
      const { liveDirectiveRefusal } = require('../kit/crown-directive/index.js') as typeof import('../kit/crown-directive/index.js');
      const { elanousStateRoot } = require('../autopilot/state-paths.js') as typeof import('../autopilot/state-paths.js');
      return liveDirectiveRefusal(q, { stateRoot: elanousStateRoot(), seatState: resolveSeatStateRoot() });
    },
    returnToBoard: (cellId, reason) => {
      const r = seatVeto({ cellId, actor: loadFederationLadder().hq || 'OP', reason }, liveSeatVetoDeps());
      return { ok: r.ok, line: r.ok ? r.lines.join(' · ') : r.reason };
    },
    // SEAT-AREA-GUARD — graphs/policies/seat-roles.yaml through the one reader (kit/seat-area).
    seatFit: (seat, item) => (require('../kit/seat-area/index.js') as typeof import('../kit/seat-area/index.js')).liveSeatFit()(seat, item),
    // RAIL30 ⑤ — the seat's last turn stamp (eln TUI seats) lets the ledger stop a 3rd wake nobody answered; no stamp = unknown.
    claimWake: (seat, cellId, by) => {
      let last: number | null = null;
      try { last = lastTurnAt(seat); } catch { last = null; }
      return claimSeatWake(defaultWakeLedgerPath(), { seat, cell: cellId, by, atMs: Date.now(), ...(last === null ? {} : { lastActivityMs: last }) });
    },
  };
}

/** OP-DIRECT-ASSIGN — the steward veto's live wiring (same ledgers as assign: checklist ⊕ seat mail ⊕ debug log). */
export function liveSeatVetoDeps(): SeatVetoDeps {
  return {
    findCell: liveFindCell,
    liveStewardScope,
    federationSeats: () => declaredFederationSeats({ stateRoot: resolveSeatStateRoot() }),
    swapOwner: (version, cellId, input) => swapOwnerIf(version, cellId, input),
    post: mail => {
      const store = openMsgStore();
      try { return { id: store.post({ ...mail, intent: 'info' }).id }; } finally { store.close(); }
    },
    hq: loadFederationLadder().hq || 'OP',
    log: (event, data) => debug.log('seat', event, data),
  };
}
