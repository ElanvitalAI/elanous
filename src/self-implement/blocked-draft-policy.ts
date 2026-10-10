import type { AbandonedClassification } from './abandoned-classification.js';
import type { DraftOnStopMode } from './draft-on-stop-mode.js';
export { DRAFT_ON_STOP_MODES, DEFAULT_DRAFT_ON_STOP, parseDraftOnStopMode } from './draft-on-stop-mode.js';
export type { DraftOnStopMode } from './draft-on-stop-mode.js';

/** Environment interruptions have a resumable branch, not a human draft decision. */
export function blockedDraftDisposition(classification: string | undefined): 'open-draft' | 'preserve-branch' {
  return classification === 'provider-error' || classification === 'quota-exhausted' || classification === 'credential-failure'
    ? 'preserve-branch'
    : 'open-draft';
}

/** landable = 승인된 산출(merge-approved-abandoned) — 다음 수가 `pr land` 이므로 수확 가지로 숨기지 않고 PR 로 남긴다(⛔ needs-owner 라벨은 안 단다). */
export type StopClass = 'needs-owner' | 'harvestable' | 'landable';

const LANDABLE: ReadonlySet<string> = new Set<AbandonedClassification>(['merge-approved-abandoned']);

/** 사람(주인 자리)이 골·계약·처분을 정해야 풀리는 멈춤. 모르는 분류는 «needs-owner» 쪽으로 기운다(⛔ 산출을 PR 밖으로 숨기지 않는다). */
const NEEDS_OWNER: ReadonlySet<string> = new Set<AbandonedClassification>([
  'contract-conflict',
  'goal-unconvergeable-candidate',
  'pr-declined',
]);

const HARVESTABLE: ReadonlySet<string> = new Set<AbandonedClassification>([
  'implementation-deficit',
  'report-deficit',
  'artifact-deficit',
  'run-deadline-exceeded',
  'already-satisfied',
  'quota-exhausted',
  'provider-error',
  'credential-failure',
]);

export function stopClassFor(classification: string | undefined): StopClass {
  if (classification && NEEDS_OWNER.has(classification)) return 'needs-owner';
  if (classification && LANDABLE.has(classification)) return 'landable';
  if (classification && HARVESTABLE.has(classification)) return 'harvestable';
  return 'needs-owner';
}

const NEXT_MOVE: Record<string, string> = {
  'implementation-deficit': '수확 가지에서 같은 골을 이어 돌린다(resume 1회) — 그래도 멈추면 needs-owner',
  'report-deficit': '수확 가지에서 완료 증거·보고를 보강해 다시 게이트에 올린다',
  'artifact-deficit': '수확 가지에서 요구 산출물을 채워 다시 돌린다',
  'run-deadline-exceeded': '수확 가지에서 이어 돌리거나, 산출이 작으면 골을 쪼개 재발사한다',
  'merge-approved-abandoned': '승인된 산출이다 — 이 PR 을 착지 경로(pr land)로 올린다',
  'already-satisfied': '고칠 것이 없다 — 재발사하지 말고 카드를 닫는다',
  'quota-exhausted': '용량 회복 뒤 수확 가지에서 이어 돌린다',
  'provider-error': 'provider 복구 뒤 수확 가지에서 이어 돌린다',
  'credential-failure': '인증 복구 뒤 수확 가지에서 이어 돌린다',
  'contract-conflict': '주인 자리가 골의 상충 기준을 정정한다',
  'goal-unconvergeable-candidate': '주인 자리가 되풀이된 must-fix 와 골 계약을 대조해 골을 다시 쓰거나 쪼갠다',
  'pr-declined': '주인 자리가 거절 사유를 반영할지 골을 다시 정할지 정한다',
};

export function nextMoveFor(classification: string | undefined): string {
  return (classification && NEXT_MOVE[classification]) ?? '주인 자리가 중단 사유를 읽고 처분을 정한다(분류 못 함)';
}

export type DraftOnStopDecision =
  | { action: 'open-draft'; stopClass: StopClass; mode: DraftOnStopMode; ownerLabel?: string }
  | { action: 'salvage-branch'; stopClass: 'harvestable'; mode: 'needs-owner-only' };

/** 'always' 는 종전 그대로(라벨도 그대로). 'needs-owner-only' 는 harvestable → 수확 가지 · needs-owner·landable → draft ⊕ 주인 자리 라벨.
 *  ⛔ 자리를 모르면 자리 라벨을 «안 단다»(OP 로 추측해 달면 «안다»고 말하는 셈이다) — `elanous:needs-owner` 만 남는다. */
export function decideDraftOnStop(input: { mode: DraftOnStopMode; classification: string | undefined; seat?: string }): DraftOnStopDecision {
  const stopClass = stopClassFor(input.classification);
  if (input.mode !== 'needs-owner-only') return { action: 'open-draft', stopClass, mode: 'always' };
  if (stopClass === 'harvestable') return { action: 'salvage-branch', stopClass, mode: 'needs-owner-only' };
  const ownerLabel = ownerSeatLabel(input.seat);
  return { action: 'open-draft', stopClass, mode: 'needs-owner-only', ...(ownerLabel ? { ownerLabel } : {}) };
}

const SEATS = ['OP', 'TC', 'MK', 'UX'] as const;

/** 주인 자리 라벨 — `helper-repair` 가 읽는 `elanous:seat-<자리>` 꼴. 아는 자리일 때만 낸다(모르면 undefined). */
export function ownerSeatLabel(seat: string | undefined): string | undefined {
  const trimmed = seat?.trim().toUpperCase();
  return trimmed && (SEATS as readonly string[]).includes(trimmed) ? `elanous:seat-${trimmed}` : undefined;
}

/** 런 하나의 수확 가지 — `salvage/run-<6hex>/<가지 잎>`. 잎이 `-r<6hex>` 로 끝나면 `selectRunSalvageRefs` 가 그대로 찾는다. */
export function salvageBranchForRun(runId: string, branch: string): string {
  // `salvage-branches.ts` `runSuffixKey` 와 같은 규칙 — 그 모듈은 실행 러너를 끌고 와 user-config 가 부를 수 없다.
  const key = /^(?:run-)?([0-9a-f]{6})/i.exec(runId.trim())?.[1]?.toLowerCase();
  const runShort = key ? `run-${key}` : (runId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'run-unknown');
  const leaf = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/\.\.+/g, '.').replace(/\.lock$/i, '-lock') || 'branch';
  return `salvage/${runShort}/${leaf}`;
}
