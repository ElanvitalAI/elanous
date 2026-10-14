import { defaultMsgStorePath, openMsgStore } from '../msg/msg-store.js';
import type { RunLedgerEntry } from '../self-implement/run-ledger.js';
import type { CardRunSnapshot, CardRunEvidence } from './card-evidence.js';
import { remoteParentAlive, type SshRunner } from './parent-host.js';
import type { TaskCard } from './task-hand.js';

const STOP_LINE = /\[supervisor\] 정지\((needs-human|no-progress)\)\s*[—-]\s*(.*)/u;

/** A remote parent's terminal stop is usable only after every referenced child ledger was read. */
export function remoteFailureReason(card: TaskCard, snapshot: CardRunSnapshot, evidence: CardRunEvidence, ssh?: SshRunner): string | undefined {
  if (!card.parentHost || !card.runId || !snapshot.host || snapshot.readErrors?.length || card.pr || evidence.pr) return undefined;
  const launchRows = snapshot.host.filter((row) => row.event === 'pod-child-run');
  const childRefs = launchRows.map((row) => row.data?.childRunId);
  // An unreadable or malformed child reference is unknown evidence, never "no children".
  if (childRefs.some((id) => typeof id !== 'string' || !/^run-[A-Za-z0-9_-]{4,64}$/.test(id) || id === card.runId)) return undefined;
  const children = childRefs as string[];
  if (children.some((id) => !snapshot.children[id])) return undefined;
  // The parent can stop while a child still runs. That child may publish a PR or salvage
  // branch later, so every launched child must have a terminal last status first.
  if (children.some((id) => {
    const lastStatus = [...(snapshot.children[id] ?? [])].reverse().find((row) => row.event === 'run-status');
    return !lastStatus || !['completed', 'failed', 'cancelled'].includes(String(lastStatus.data?.runStatus));
  })) return undefined;
  const rows: RunLedgerEntry[] = [...snapshot.host, ...children.flatMap((id) => snapshot.children[id] ?? [])];
  if (rows.some((row) => row.event === 'pr-opened' || row.event === 'salvaged'
    || (typeof row.data.harvestBranch === 'string' && row.data.harvestBranch.trim())
    || (typeof row.data.salvageBranch === 'string' && row.data.salvageBranch.trim()))) return undefined;
  const parentRows = snapshot.host.filter((row) => row.runId === card.runId);
  const stopIndex = parentRows.map((row) => row.event).lastIndexOf('stop');
  const stop = parentRows[stopIndex];
  if (!stop) return undefined;
  // A running status before stop is superseded by the supervisor's terminal stop.
  // A fresh execution event after stop makes that stop stale for the current parent.
  if (parentRows.slice(stopIndex + 1).some((row) => row.event === 'start' || row.event === 'pod-child-run'
    || (row.event === 'run-status' && !['completed', 'failed', 'cancelled'].includes(String(row.data?.runStatus))))) return undefined;
  const tail = Array.isArray(stop?.data.tail) ? stop.data.tail : [];
  const lines = tail.filter((line): line is string => typeof line === 'string');
  // A parent or terminal child stop can carry a PR or salvage branch only in raw text.
  // Any nonempty branch token is harvest evidence, regardless of its naming prefix.
  const stopText = rows.filter((row) => row.event === 'stop')
    .flatMap((row) => [row.data.cause, ...(Array.isArray(row.data.tail) ? row.data.tail : [])])
    .filter((value): value is string => typeof value === 'string').join('\n');
  if (/https:\/\/github\.com\/[^\s]+\/pull\/\d+|ELANOUS_POD_SALVAGE(?:\s*=\s*|\s+)\S+|수확할 브랜치:\s*\S+/.test(stopText)) return undefined;
  const matched = [...lines].reverse().map((line) => STOP_LINE.exec(line.replace(/\x1b\[[0-9;]*m/g, ''))).find((match) => match !== null);
  if (!matched || remoteParentAlive({ ...card.parentHost, runId: card.runId }, ssh) !== 'dead') return undefined;
  const raw = matched[2]?.replace(/[\r\n]+/g, ' ').trim();
  if (!raw) return undefined;
  return `${matched[1]} — ${raw}`;
}

/** SQLite provenance makes repeated refreshes insert precisely one message for this card/run/seat. */
export function notifyRemoteFailure(card: TaskCard, reason: string, messageStorePath = defaultMsgStorePath()): void {
  if (!card.seat || !card.runId || !card.parentHost) return;
  const log = card.parentHost.log ?? `${card.parentHost.configDir ?? '$HOME/.elanous'}/remote-parents/${card.runId}.log`;
  const store = openMsgStore(messageStorePath);
  try {
    store.appendWithProvenance({ from: 'TC', to: card.seat, kind: 'incident',
      body: `TA 카드 ${card.id} · 원격 부모 ${card.parentHost.host} 종결 · 사유: ${reason}\n원격 로그: ${log}` },
    `ta-failure:${card.id}-${card.runId}:${card.seat}`);
  } finally { store.close(); }
}
