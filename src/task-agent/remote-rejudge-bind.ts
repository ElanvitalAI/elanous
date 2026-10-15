/** Bind remote TA parents from the HQ ledger mirror before `rejudge --all` selects PR cards. */
import { dirname } from 'node:path';
import { debug } from '../debug/log.js';
import { loadRunLedger } from '../self-implement/run-ledger.js';
import { bindCardEvidence, podChildRunIds, readCardRunSnapshot, refreshCardRunBinding } from './card-evidence.js';
import { mirrorRemoteRunLedgers, remoteLedgerMirrorDir } from './parent-host.js';
import { cardPrNumber, type TaskCard } from './task-hand.js';

const RECENT_LAUNCH_MS = 24 * 60 * 60 * 1000;

type BindDeps = {
  now?: () => number;
  mirror?: typeof mirrorRemoteRunLedgers;
  onFailure?: (failure: { card: string; runId: string; host: string; reason: string }) => void;
};

function recentlyLaunched(card: TaskCard, now: number): boolean {
  const launch = [...card.history].reverse().find(event => event.event === 'launch');
  const at = Date.parse(launch?.at ?? card.createdAt);
  return Number.isFinite(at) && at <= now && now - at < RECENT_LAUNCH_MS;
}

/**
 * A remote child PR can appear after the last HQ card refresh. A card without a PR is otherwise absent from
 * `rejudgeCandidates`, so the normal rejudge tick never reaches `mirrorRemoteCardLedger` or the binding replay.
 * Only an existing, launched TA-owned parent with a parent→child edge in its own host mirror is admitted. The
 * launch registry (including foreign/test universes) and child-only ledgers are never scanned or adopted here.
 */
export async function bindMirroredRemoteRejudgeCards(
  tasks: Readonly<Record<string, TaskCard>>, statePath: string,
  deps: BindDeps = {},
): Promise<{ scanned: number; bound: number; skipped: number }> {
  const root = dirname(statePath);
  const now = (deps.now ?? Date.now)();
  const mirror = deps.mirror ?? mirrorRemoteRunLedgers;
  const reportFailure = (card: TaskCard, reason: string): void => {
    const failure = { card: card.id, runId: card.runId!, host: card.parentHost!.host, reason: reason.slice(0, 300) };
    try { (deps.onFailure ?? ((data) => debug.log('task-agent', 'remote-rejudge-bind-failed', data)))(failure); }
    catch { /* observation must not stop the other cards */ }
  };
  let scanned = 0;
  let bound = 0;
  let skipped = 0;
  for (const card of Object.values(tasks)) {
    if (card.status !== 'launched' || card.taLand !== true || !card.parentHost || !card.runId
      || cardPrNumber(card) !== undefined || card.refSource === 'manual') continue;
    scanned++;
    const dir = remoteLedgerMirrorDir(root, card.parentHost.host);
    try {
      // This prepass runs before PR-based candidate selection. Pulling here breaks the otherwise circular
      // dependency: cards with a remote PR cannot be selected while their parent/child ledgers are absent locally.
      // Limit fresh remote pulls to recent launches, but keep binding older ledgers already mirrored at HQ.
      if (recentlyLaunched(card, now)) mirror(card.parentHost, card.runId, root);
      const snapshot = await readCardRunSnapshot(card, {
        loadLedger: (id) => loadRunLedger(id, dir),
        podFinishes: () => [],
      });
      const parent = snapshot.host;
      const evidence = bindCardEvidence(card, snapshot);
      const childRunId = evidence.childRunId;
      const pr = evidence.pr;
      const child = childRunId ? snapshot.children[childRunId] : null;
      if (snapshot.readErrors?.length) {
        reportFailure(card, snapshot.readErrors.join('; '));
        skipped++;
        continue;
      }
      // A PR event alone is not a completed remote run. The rejudge candidate must have the same exact
      // child PR and terminal status that remoteBoundRunTerminal will later require.
      if (!parent || !childRunId || !pr?.url || !child
        || !podChildRunIds(parent, card.runId).includes(childRunId)
        || !child.some((entry) => entry.event === 'pr-opened' && entry.data?.number === pr.number
          && entry.data?.url === pr.url)
        || !child.some((entry) => entry.event === 'run-status'
          && ['completed', 'failed', 'cancelled'].includes(String(entry.data?.runStatus)))) { skipped++; continue; }
      const result = await refreshCardRunBinding(card.id, statePath, {
        // Reuse the verified snapshot so a second mirror read cannot silently change the selected PR.
        loadLedger: (id) => id === card.runId ? [...parent] : snapshot.children[id] ? [...snapshot.children[id]!] : null,
        // The remote mirror is the sole evidence for this prepass. Host logs can contain unrelated child receipts.
        podFinishes: () => [],
      });
      if (result.card?.runId === card.runId && cardPrNumber(result.card) !== undefined
        && result.card.runChildId && podChildRunIds(parent, card.runId).includes(result.card.runChildId)) bound++;
      else skipped++;
    } catch (error) {
      skipped++;
      reportFailure(card, error instanceof Error ? error.message : String(error));
    }
  }
  return { scanned, bound, skipped };
}
