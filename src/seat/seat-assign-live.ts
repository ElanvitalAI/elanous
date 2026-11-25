// OP-HANDLES-L2b — the live wiring for seatAssign (CLI `eln seat assign` and the SeatAssign tool share it).
// Ledgers: release checklist (owner) · seat mail (assignment) · wakeRecipient (idle-only typing) · gh/git (writers).

import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { assignItem, checklistDevVersion, listChecklist } from '../release-loop/checklist.js';
import { declaredFederationSeats } from '../msg/seat-mail-trust.js';
import { loadFederationLadder } from '../msg/hand-raise-ladder.js';
import { openMsgStore } from '../msg/msg-store.js';
import { resolveSeatStateRoot, wakeRecipient } from '../loops/msg-wake.js';
import { resolveScope } from '../steward/space/config.js';
import { getUserConfig } from '../user-config/reader.js';
import { preapprovedPool } from './resource-preapproval.js';
import { claimSeatWake, defaultWakeLedgerPath } from './wake-ledger.js';
import { lastTurnAt } from '../msg/diverted-mail.js';
import { pathTouches, SEAT_ASSIGN_MAIL_KIND, type SeatAssignDeps, type WriterRow } from './seat-assign.js';

const WRITER_TIMEOUT_MS = 20_000;

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

export function liveSeatAssignDeps(): SeatAssignDeps {
  return {
    now: () => new Date(),
    coordinators: () => {
      const ladder = loadFederationLadder();
      // depth 1 = HQ · 2 = space coordinator (hand-raise ladder: journal ⊕ federation.yaml).
      return { hq: ladder.hq, spaces: [], isCoordinator: seat => { const depth = ladder.depthOf(seat); return depth === 1 || depth === 2; } };
    },
    federationSeats: () => declaredFederationSeats({ stateRoot: resolveSeatStateRoot() }),
    findCell: (cellId, version) => {
      const v = version ?? checklistDevVersion();
      const item = listChecklist(v).items.find(row => row.id === cellId);
      return item ? { version: v, item } : undefined;
    },
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
    liveStewardScope: seat => {
      const ladder = loadFederationLadder();
      const scope = ladder.parentOf(seat.toUpperCase()).toUpperCase();
      return resolveScope(scope, ladder.hq, getUserConfig().loops?.stewardSpace).mode === 'live' ? scope : null;
    },
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
    // RAIL30 ⑤ — the seat's last turn stamp (eln TUI seats) lets the ledger stop a 3rd wake nobody answered; no stamp = unknown.
    claimWake: (seat, cellId, by) => {
      let last: number | null = null;
      try { last = lastTurnAt(seat); } catch { last = null; }
      return claimSeatWake(defaultWakeLedgerPath(), { seat, cell: cellId, by, atMs: Date.now(), ...(last === null ? {} : { lastActivityMs: last }) });
    },
  };
}
