/** Bind remote TA parents from the HQ ledger mirror before `rejudge --all` selects PR cards. */
import { dirname } from 'node:path';
import { debug } from '../debug/log.js';
import { loadRunLedger } from '../self-implement/run-ledger.js';
import { bindCardEvidence, podChildRunIds, readCardRunSnapshot, refreshCardRunBinding } from './card-evidence.js';
import { remoteLedgerMirrorDir } from './parent-host.js';
import { cardPrNumber, type TaskCard } from './task-hand.js';

/**
 * A remote child PR can appear after the last HQ card refresh. A card without a PR is otherwise absent from
 * `rejudgeCandidates`, so the normal rejudge tick never reaches `mirrorRemoteCardLedger` or the binding replay.
 * Only an existing, launched TA-owned parent with a parent→child edge in its own host mirror is admitted. The
 * launch registry (including foreign/test universes) and child-only ledgers are never scanned or adopted here.
 */
export async function bindMirroredRemoteRejudgeCards(
  tasks: Readonly<Record<string, TaskCard>>, statePath: string,
): Promise<{ scanned: number; bound: number; skipped: number }> {
  const root = dirname(statePath);
  let scanned = 0;
  let bound = 0;
  let skipped = 0;
  for (const card of Object.values(tasks)) {
    if (card.status !== 'launched' || card.taLand !== true || !card.parentHost || !card.runId
      || cardPrNumber(card) !== undefined || card.refSource === 'manual') continue;
    scanned++;
    const dir = remoteLedgerMirrorDir(root, card.parentHost.host);
    try {
      const snapshot = await readCardRunSnapshot(card, {
        loadLedger: (id) => loadRunLedger(id, dir),
        podFinishes: () => [],
      });
      const parent = snapshot.host;
      const evidence = bindCardEvidence(card, snapshot);
      const childRunId = evidence.childRunId;
      const pr = evidence.pr;
      const child = childRunId ? snapshot.children[childRunId] : null;
      // A PR event alone is not a completed remote run. The rejudge candidate must have the same exact
      // child PR and terminal status that remoteBoundRunTerminal will later require.
      if (snapshot.readErrors?.length || !parent || !childRunId || !pr?.url || !child
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
      try { debug.log('task-agent', 'remote-rejudge-bind-failed', {
        card: card.id, runId: card.runId, host: card.parentHost.host, reason: error instanceof Error ? error.message : String(error),
      }); } catch { /* observation must not stop the other cards */ }
    }
  }
  return { scanned, bound, skipped };
}
