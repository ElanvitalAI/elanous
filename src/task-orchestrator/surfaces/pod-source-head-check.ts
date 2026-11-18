// TA-PREFLIGHT 조건① — 요청한 정확 소스(commit pin)와 자식이 «실제로 받은» HEAD 를 부모가 대조한다.
// 자식 Job 스크립트는 `ELANOUS_POD_SOURCE commit <HEAD>` 를 낸다(pod-source-receive.ts). 그 줄이 없거나 다르면 불일치다.
import type { PodSource } from './pod-source-receive.js';

export type PodSourceHeadVerdict =
  | { verdict: 'not-applicable'; pinned: null; received: null }
  | { verdict: 'match'; pinned: string; received: string }
  | { verdict: 'mismatch'; pinned: string; received: string }
  | { verdict: 'missing'; pinned: string; received: null };

/** commit 핀이 아닌 소스(default/pr/worktree/files)는 대조 대상이 아니다 — 조용히 통과로 읽지 않고 not-applicable 로 적는다. */
export function verifyPodSourceHead(logs: string | null, source: PodSource | undefined): PodSourceHeadVerdict {
  if (!source || source.kind !== 'commit') return { verdict: 'not-applicable', pinned: null, received: null };
  const pinned = source.sha.toLowerCase();
  const received = logs ? /^ELANOUS_POD_SOURCE commit ([0-9a-f]{40,64})\r?$/m.exec(logs)?.[1]?.toLowerCase() ?? null : null;
  if (received === null) return { verdict: 'missing', pinned, received: null };
  return received === pinned ? { verdict: 'match', pinned, received } : { verdict: 'mismatch', pinned, received };
}

/** 불일치·결손이면 발사 실패 사유(없으면 null). */
export function podSourceHeadFailure(check: PodSourceHeadVerdict): string | null {
  if (check.verdict === 'mismatch') return `정확 소스 불일치 — 요청 ${check.pinned.slice(0, 12)} ≠ 자식 수신 HEAD ${check.received.slice(0, 12)}`;
  if (check.verdict === 'missing') return `정확 소스 영수증 없음 — 요청 ${check.pinned.slice(0, 12)} · 자식이 ELANOUS_POD_SOURCE commit 줄을 내지 않았다`;
  return null;
}

/** 발사 실패 판정은 정상 종료(complete)일 때만 — 자식이 소스 영수증 전에 죽은 경우(clone 중 OOM·로그인 실패 등)와 중단은
 *  기존 처리(abort·재시도·OOM 재시도·사용량 재기록)가 우선이라 여기서 mismatch 로 덮지 않는다. */
export function podSourceHeadGate(check: PodSourceHeadVerdict, run: { state: 'complete' | 'failed' | 'aborted'; aborted: boolean }): string | null {
  if (run.state !== 'complete' || run.aborted) return null;
  return podSourceHeadFailure(check);
}
