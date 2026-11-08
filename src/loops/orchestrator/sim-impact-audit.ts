import { join } from 'node:path';
import { openMsgStore } from '../../msg/msg-store.js';
import { hasCodeTarget } from '../../self-dev/sim-impact-wording.js';
import { collectWork, type WorkItem } from './overlap.js';
export type AuditWindow = '08' | '12' | '18';

export interface SimImpactGap {
  kind: WorkItem['kind'];
  ref: string;
  seat: string | null;
  files: string[];
  cells: string[];
  reason: 'missing-proof-scenario' | 'unknown-proof-scenario' | 'unreadable-goal' | 'unknown-target' | 'missing-target';
}

export function simImpactGaps(work: readonly WorkItem[]): SimImpactGap[] {
  return work.flatMap((item) => {
    if (item.unreadable) return [{ kind: item.kind, ref: item.ref, seat: item.seat, files: [], cells: item.cells, reason: 'unreadable-goal' as const }];
    const gaps: SimImpactGap[] = [];
    if (item.unresolvedTargets?.length) gaps.push({ kind: item.kind, ref: item.ref, seat: item.seat, files: item.unresolvedTargets, cells: item.cells, reason: 'unknown-target' });
    if (item.kind === 'goal' && item.files.length === 0 && !item.unresolvedTargets?.length) {
      gaps.push({ kind: item.kind, ref: item.ref, seat: item.seat, files: [], cells: item.cells, reason: 'missing-target' });
    }
    const codeTargets = [...new Set([...item.files, ...(item.unresolvedTargets ?? [])])].filter((file) => hasCodeTarget([file]));
    if (codeTargets.length > 0 && (!item.proofScenario || item.proofScenarioFound !== true)) {
      gaps.push({ kind: item.kind, ref: item.ref, seat: item.seat, files: codeTargets, cells: item.cells,
        reason: item.proofScenario ? 'unknown-proof-scenario' : 'missing-proof-scenario' });
    }
    return gaps;
  }).sort((a, b) => a.ref.localeCompare(b.ref) || a.kind.localeCompare(b.kind));
}

export function formatSimImpactGaps(gaps: readonly SimImpactGap[]): string {
  const lines = gaps.map((gap) => {
    const where = [gap.seat ?? '자리 미상', ...(gap.cells.length ? [`칸 ${gap.cells.join(',')}`] : [])].join(' · ');
    const detail = gap.reason === 'unreadable-goal'
      ? '골 문면 판독 불가'
      : gap.reason === 'unknown-target'
        ? `골 대상 경로를 추적 파일에서 확인 못함 · ${gap.files.join(', ')}`
        : gap.reason === 'missing-target'
          ? '읽을 수 있는 골에서 추적 대상 경로를 추출하지 못함'
        : gap.reason === 'unknown-proof-scenario'
        ? `증명 시나리오 이름을 저장소에서 확인 못함 · ${gap.files.join(', ')}`
        : `코드 경로 변경에 증명 시나리오 줄 없음 · ${gap.files.join(', ')}`;
    return `- ${gap.kind} ${gap.ref} · ${where} · ${detail}`;
  });
  return `시뮬 월드 미고려 (관측 후보 ${gaps.length})\n${lines.join('\n')}`;
}

export interface SimImpactAuditDeps {
  work?: () => ReturnType<typeof collectWork>['work'];
  post?: (body: string) => void;
}

/** Reuse the coordinator's existing report tick; 12:00 runs other orchestration work, not this twice-daily audit. */
export function runSimImpactAudit(window: AuditWindow, root: string, deps: SimImpactAuditDeps = {}): SimImpactGap[] {
  if (window !== '08' && window !== '18') return [];
  const gaps = simImpactGaps((deps.work ?? (() => collectWork({ includeNonReady: true }).work))());
  const body = formatSimImpactGaps(gaps);
  if (deps.post) deps.post(body);
  else {
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try { store.post({ from: 'ORCHESTRATOR', to: 'OP', kind: 'report', body }); }
    finally { store.close(); }
  }
  return gaps;
}
