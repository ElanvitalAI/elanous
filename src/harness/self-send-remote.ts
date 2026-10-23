import { readTaskAgentState, shellQuote, taskAgentStatePath, type TaskCard } from '../task-agent/task-hand.js';
import { defaultSshRunner, remoteLedgerMirrorDir, type SshRunner } from '../task-agent/parent-host.js';
import { loadRunLedger } from '../self-implement/run-ledger.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { normalizeRunId } from './harness-space.js';
import { parsePodReadWait } from './pod-control-send.js';
import { SELF_SEND_LOCAL_ONLY_ENV } from './self-send-routing-guard.js';

export interface RemotePodRunCard extends Pick<TaskCard, 'id' | 'runId' | 'runChildId' | 'parentHost'>, Partial<Pick<TaskCard, 'status'>> {}

export class RemotePodOwnershipAmbiguousError extends Error {
  override name = 'RemotePodOwnershipAmbiguousError';
}

export function remotePodControlForOptions(opts: { stop?: boolean; memo?: string; readWait?: string }): { stop: true } | { memo: string; readWait: string } {
  if (Boolean(opts.stop) === (opts.memo !== undefined)) throw new Error('self send에는 --stop 또는 --memo 한 가지만 필요합니다');
  if (opts.stop) return { stop: true };
  if (!opts.memo || /[\r\n]/.test(opts.memo)) throw new Error('control inbox memo must be a non-empty single line');
  return { memo: opts.memo, readWait: String(parsePodReadWait(opts.readWait ?? '10')) };
}

/** Resolve only an exact card parent or a child recorded under that parent. */
export function remotePodCardForRun(runId: string, cards: readonly RemotePodRunCard[],
  children: (card: RemotePodRunCard) => readonly string[]): RemotePodRunCard | null {
  if (runId !== normalizeRunId(runId)) return null;
  const active = cards.filter((card) => card.parentHost?.host && card.runId
    && (card.status === undefined || card.status === 'launched'));
  const direct = active.filter((card) => card.parentHost?.host && card.runId
    && (card.runId === runId || card.runChildId === runId));
  const mirrored = active.filter((card) => children(card).includes(runId));
  const matches = [...new Map([...direct, ...mirrored].map((card) => [card.id, card])).values()];
  if (matches.length > 1) throw new RemotePodOwnershipAmbiguousError(`self send 원격 런 소유 카드가 여러 개입니다: ${runId} (${matches.map((card) => card.id).join(', ')})`);
  return matches[0] ?? null;
}

/** A missing child mirror is a possible explanation, never proof of ownership. */
export function remoteChildOwnershipUnconfirmed(card: RemotePodRunCard | null, cards: readonly RemotePodRunCard[]): boolean {
  return !card && cards.filter((candidate) => candidate.parentHost?.host && candidate.runId && !candidate.runChildId
    && (candidate.status === undefined || candidate.status === 'launched')).length === 1;
}

export function findRemotePodCardForRun(runId: string): { card: RemotePodRunCard | null; remoteChildUnconfirmed: boolean } {
  const cards = Object.values(readTaskAgentState<{ tasks?: Record<string, TaskCard> }>(taskAgentStatePath()).tasks ?? {});
  const card = remotePodCardForRun(runId, cards, (card) => {
    if (!card.runId || !card.parentHost?.host) return [];
    const ledger = loadRunLedger(card.runId, remoteLedgerMirrorDir(effectiveInstanceRoot(), card.parentHost.host)) ?? [];
    return ledger.filter((entry) => entry.event === 'pod-child-run')
      .map((entry) => entry.data.childRunId).filter((value): value is string => typeof value === 'string');
  });
  return { card, remoteChildUnconfirmed: remoteChildOwnershipUnconfirmed(card, cards) };
}

export function sendRemotePodRun(card: RemotePodRunCard, runId: string, control: { memo: string; readWait: string } | { stop: true },
  ssh: SshRunner = defaultSshRunner): { stdout: string; stderr: string } {
  const host = card.parentHost?.host;
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(host) || runId !== normalizeRunId(runId))
    throw new Error(`self send 원격 런 대상이 유효하지 않습니다: ${runId}`);
  const binary = '$HOME/.local/share/elanous/bin/elanous';
  const configDir = card.parentHost?.configDir ? shellQuote(card.parentHost.configDir) : '$HOME/.elanous';
  const args = control.stop ? '--stop' : `--memo ${shellQuote(control.memo)} --read-wait ${shellQuote(control.readWait)}`;
  const script = `${SELF_SEND_LOCAL_ONLY_ENV}=1 ${binary} --config-dir ${configDir} self send --run ${shellQuote(runId)} ${args}`;
  const wait = 'memo' in control ? Number(control.readWait) : 0;
  // The remote kubectl call has a 120s ceiling; SSH must outlive it and CLI startup.
  const result = ssh(host, script, Math.max(150_000, (Number.isFinite(wait) ? Math.max(0, wait) : 0) * 1_000 + 90_000));
  if (result.status !== 0) throw new Error(`self send 원격 Pod 전달 실패 (${host}, ${runId}, rc=${result.status ?? 'unknown'}): ${result.stderr.trim() || result.stdout.trim() || '원격 응답 없음'}`);
  const podReceipt = control.stop ? 'Pod 조각에 soft stop 기록:' : 'Pod 조각에 감독 메모 기록:';
  if (!result.stdout.includes(podReceipt)) throw new Error(`self send 원격 Pod 전달 미확인 (${host}, ${runId}): ${result.stdout.trim() || '원격 Pod 영수증 없음'}`);
  return { stdout: result.stdout, stderr: result.stderr };
}
