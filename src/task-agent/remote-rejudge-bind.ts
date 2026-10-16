/** Bind remote TA parents from the HQ ledger mirror before `rejudge --all` selects PR cards. */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { loadRunLedger } from '../self-implement/run-ledger.js';
import { bindCardEvidence, podChildRunIds, podTerminalPr, readCardRunSnapshot, refreshCardRunBinding } from './card-evidence.js';
import { mirrorRemoteRunLedgers, remoteLedgerMirrorDir } from './parent-host.js';
import { cardPrNumber, type TaskCard } from './task-hand.js';

const RECENT_LAUNCH_MS = 24 * 60 * 60 * 1000;
/**
 * TA-BIND-PULL-ONCE — an older launch whose parent ledger was never mirrored at HQ gets one pull («묶기만»).
 * Bounded per tick so the first tick after deploy does not run hundreds of sequential ssh reads (backlog ≈690
 * cards on 10-15 drains over ticks); a pulled mirror is then read locally and never pulled again by this rule.
 */
export const UNMIRRORED_PULL_CAP_PER_TICK = 20;

type BindDeps = {
  now?: () => number;
  mirror?: typeof mirrorRemoteRunLedgers;
  unmirroredPullCap?: number;
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
 * Only an existing, launched parent (TA-owned or not — TA-BIND-WIDEN) with a parent→child edge in its own host
 * mirror is bound; rejudge/land selection keeps its own taLand gate. The
 * launch registry (including foreign/test universes) and child-only ledgers are never scanned or adopted here.
 */
export async function bindMirroredRemoteRejudgeCards(
  tasks: Readonly<Record<string, TaskCard>>, statePath: string,
  deps: BindDeps = {},
): Promise<{ scanned: number; bound: number; skipped: number; pulledUnmirrored: number }> {
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
  let pulledUnmirrored = 0;
  const unmirroredCap = deps.unmirroredPullCap ?? UNMIRRORED_PULL_CAP_PER_TICK;
  for (const card of Object.values(tasks)) {
    // TA-BIND-WIDEN — «묶기»는 taLand 와 무관하게 launched ⊕ runId 카드 전부. 묶여도 재판정(rejudge)·land 후보는
    // `rejudgeCandidates`/`remoteBoundRunTerminal` 의 taLand 관문이 그대로 거른다 — 여기서 넓히는 것은 카드↔PR 연결뿐이다.
    if (card.status !== 'launched' || !card.parentHost || !card.runId
      || cardPrNumber(card) !== undefined || card.refSource === 'manual') continue;
    scanned++;
    const dir = remoteLedgerMirrorDir(root, card.parentHost.host);
    try {
      // This prepass runs before PR-based candidate selection. Pulling here breaks the otherwise circular
      // dependency: cards with a remote PR cannot be selected while their parent/child ledgers are absent locally.
      // Limit fresh remote pulls to recent launches, but keep binding older ledgers already mirrored at HQ.
      if (recentlyLaunched(card, now)) mirror(card.parentHost, card.runId, root);
      else if (!existsSync(join(dir, `${card.runId}.jsonl`)) && pulledUnmirrored < unmirroredCap) {
        pulledUnmirrored++;
        mirror(card.parentHost, card.runId, root);
      }
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
      // TA-BIND-PR-TERMINAL — a blocked-draft child has no `pr-opened`; the parent's `pr-terminal` for that exact child,
      // number and URL is the same PR evidence.
      const terminal = parent ? podTerminalPr(parent, [childRunId ?? '']) : undefined;
      if (!parent || !childRunId || !pr?.url || !child
        || !podChildRunIds(parent, card.runId).includes(childRunId)
        || !(child.some((entry) => entry.event === 'pr-opened' && entry.data?.number === pr.number
          && entry.data?.url === pr.url) || (terminal?.number === pr.number && terminal.url === pr.url))
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
  return { scanned, bound, skipped, pulledUnmirrored };
}
