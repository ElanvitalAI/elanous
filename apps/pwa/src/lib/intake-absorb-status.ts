import type { AbsorbStatus } from './intake-front-door-api';

export const ABSORB_SETTLED_STATUSES = ['absorbed', 'discarded', 'routed', 'checked'] as const;

const LABELS: Record<string, string> = {
  new: '대기 중',
  queued: '대기 중',
  absorbed: '흡수됨',
  routed: '다른 갈래로 넘김',
  checked: '확인됨',
  discarded: '버림',
  deferred: '미룸',
};

export function summarizeAbsorbStatus(status: AbsorbStatus | null): { label: string; settled: boolean; noteRef: string | null } {
  if (status === null) return { label: '찾을 수 없음', settled: false, noteRef: null };
  return {
    label: Object.hasOwn(LABELS, status.status) ? LABELS[status.status]! : status.status,
    settled: (ABSORB_SETTLED_STATUSES as readonly string[]).includes(status.status),
    noteRef: status.outputs?.find((output) => output.kind === 'note')?.ref ?? null,
  };
}
