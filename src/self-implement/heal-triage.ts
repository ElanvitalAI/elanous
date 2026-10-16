/** 결정론 트리아지 — 실패 서명과 이미 거친 역할만으로 다음 갈래를 고른다. */

import { defaultOverlaysDir, loadGraphOverlays, selectOverlays, type GraphOverlaySpec } from './graph-overlay-yaml.js';
import { GRAPH_SPECS } from './graph-templates.js';

export type HealTriageOutcome =
  | 'environment-claimed'
  | 'untestable'
  | 'harness-fixable'
  | 'child-fixable'
  | 'needs-deeper-observation'
  | 'needs-grounding'
  | 'rework-with-citations'
  | 'exhausted';

export interface HealCitation {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface HealFailureSignature {
  readonly errorText?: string;
  readonly citations?: readonly HealCitation[];
  readonly failedTests?: number;
  readonly introduced?: number;
  readonly unknown?: number;
  readonly timedOut?: number;
  readonly unverified?: readonly string[];
  readonly importerUnrunTests?: number;
  readonly environmentClaim?: string;
  readonly namedSource?: string;
}

/** 게이트 사실로 채울 수 있는 칸. 없는 칸만 채운다. */
export const HEAL_GATE_FACT_FIELDS = ['introduced', 'unknown', 'timedOut', 'failedTests', 'unverified', 'errorText'] as const;
export type HealGateFactField = (typeof HEAL_GATE_FACT_FIELDS)[number];

export type PathExists = boolean | 'unknown';

export interface HealFactFill {
  readonly signature: HealFailureSignature;
  readonly added: readonly HealGateFactField[];
}

export interface HealSignatureMerge {
  readonly signature: HealFailureSignature;
  readonly evidence: readonly string[];
}

const NUMBER_GATE_FIELDS = ['introduced', 'unknown', 'timedOut', 'failedTests'] as const;

function isMarkedDeleted(path: string): boolean {
  return path.startsWith('-') || path.includes('(deleted)');
}

/** 없는 경로만 `-<path>` 로 표시한다. 이미 표시된 것은 그대로 두고, `unknown` 은 표시하지 않는다. */
export function markDeletedUnverified(paths: readonly string[], exists: (path: string) => PathExists): string[] {
  return paths.map((path) => {
    if (isMarkedDeleted(path)) return path;
    const present = exists(path);
    if (present === false) return `-${path}`;
    return path;
  });
}

function numberField(record: Record<string, unknown>, field: (typeof NUMBER_GATE_FIELDS)[number]): number | undefined {
  const value = record[field];
  return typeof value === 'number' ? value : undefined;
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length ? items : undefined;
}

/** 원장 항목들에서 마지막 게이트 사실을 고른다. 칸마다 가장 뒤의 값만 남긴다. */
export function lastGateFacts(entries: readonly { readonly data?: unknown }[]): Partial<HealFailureSignature> {
  const facts: {
    introduced?: number;
    unknown?: number;
    timedOut?: number;
    failedTests?: number;
    unverified?: readonly string[];
    errorText?: string;
  } = {};
  for (const entry of entries) {
    const data = entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
      ? entry.data as Record<string, unknown>
      : undefined;
    if (!data) continue;
    for (const field of NUMBER_GATE_FIELDS) {
      const value = numberField(data, field);
      if (value !== undefined) facts[field] = value;
    }
    const unverified = stringList(data.unverified);
    if (unverified) facts.unverified = unverified;
    if (typeof data.errorText === 'string') facts.errorText = data.errorText;
  }
  return facts;
}

/** 서명에 없는 칸만 마지막 게이트 사실에서 복사한다. 더한 칸이 없으면 added 가 빈다. */
export function fillMissingGateFacts(signature: HealFailureSignature, ledgerEntries: readonly { readonly data?: unknown }[]): HealFactFill {
  const facts = lastGateFacts(ledgerEntries);
  const added: HealGateFactField[] = [];
  const next: {
    introduced?: number;
    unknown?: number;
    timedOut?: number;
    failedTests?: number;
    unverified?: readonly string[];
    errorText?: string;
  } = {};
  for (const field of NUMBER_GATE_FIELDS) {
    if (signature[field] === undefined && facts[field] !== undefined) {
      next[field] = facts[field];
      added.push(field);
    }
  }
  if (signature.unverified === undefined && facts.unverified !== undefined) {
    next.unverified = facts.unverified;
    added.push('unverified');
  }
  if (signature.errorText === undefined && facts.errorText !== undefined) {
    next.errorText = facts.errorText;
    added.push('errorText');
  }
  return { signature: { ...signature, ...next }, added };
}

const MERGE_FACT_FIELDS = [...HEAL_GATE_FACT_FIELDS, 'importerUnrunTests', 'environmentClaim', 'namedSource', 'citations'] as const;

function definedFields(signature: HealFailureSignature): string[] {
  return MERGE_FACT_FIELDS.filter((field) => signature[field] !== undefined);
}

/** 나중 오버레이가 이긴다. 기여한 칸마다 evidence 한 줄. */
export function mergeHealSignatures(base: HealFailureSignature, overlays: readonly { readonly source: string; readonly signature: HealFailureSignature }[]): HealSignatureMerge {
  let signature: HealFailureSignature = { ...base };
  const evidence: string[] = [];
  for (const overlay of overlays) {
    const contributed = definedFields(overlay.signature);
    if (contributed.length === 0) continue;
    signature = { ...signature, ...overlay.signature };
    for (const field of contributed) evidence.push(`${field} ← ${overlay.source}`);
  }
  return { signature, evidence };
}

export interface HealTriageHistory {
  /** 이 판에서 이미 방문한 노드 id. */
  readonly visited?: readonly string[];
}

export interface HealTriageResult {
  readonly outcome: HealTriageOutcome;
  readonly evidence: readonly string[];
}

/** 수리 한도를 다 쓴 런의 결함 셋. 힐 루프가 이 셋 중 하나만 고른다. */
export type ReworkCapDefectClass = 'test-defect' | 'goal-defect' | 'code-defect';

/** 분류 뒤 힐 루프가 고르는 다음 행동. */
export type ReworkCapNextAction = 'harvest' | 'relaunch' | 'card';

export interface ReworkCapHealInput {
  /** 게이트가 이번 diff 가 들여온 실패 수. 없으면 0. */
  readonly introduced?: readonly string[];
  /** 마지막 리뷰 must-fix. 없으면 빈 목록. */
  readonly mustFix?: readonly string[];
  readonly summary?: string;
}

export interface ReworkCapHealDecision {
  readonly defectClass: ReworkCapDefectClass;
  readonly nextAction: ReworkCapNextAction;
  readonly evidence: readonly string[];
}

const GOAL_DEFECT = /골|goal|acceptance|수용 기준|요구가 모순|스펙|경계:/i;

/**
 * 수리 한도 소진 런을 «시험 결함 · 골 결함 · 코드 결함» 중 하나로 가르고
 * 수확·재발사·카드 중 하나를 고른다. 근거는 게이트 introduced 목록과 마지막 리뷰 지적이다.
 * 도입 실패가 있으면 코드 결함(재발사). 리뷰가 골·수용 기준을 짚으면 골 결함(카드).
 * 그 밖(리뷰만 있거나 근거가 비면)은 시험 결함(수확)이다.
 */
export function classifyReworkCapExhaustion(input: ReworkCapHealInput): ReworkCapHealDecision {
  const introduced = (input.introduced ?? []).map((item) => item.trim()).filter(Boolean);
  const mustFix = (input.mustFix ?? []).map((item) => item.trim()).filter(Boolean);
  const evidence = [
    ...introduced.map((item) => `gate introduced: ${item}`),
    ...mustFix.map((item) => `review must-fix: ${item}`),
  ];
  if (introduced.length > 0) {
    return { defectClass: 'code-defect', nextAction: 'relaunch', evidence };
  }
  if (mustFix.some((item) => GOAL_DEFECT.test(item)) || (input.summary ? GOAL_DEFECT.test(input.summary) : false)) {
    return { defectClass: 'goal-defect', nextAction: 'card', evidence };
  }
  return { defectClass: 'test-defect', nextAction: 'harvest', evidence };
}

const UNTESTABLE_EXT = new Set(['.md', '.json', '.yaml', '.yml', '.txt']);
const ENVIRONMENT_CLAIM = /할당량|자격|기판|quota|credential|substrate/i;

function extOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function deletedOrUntestable(path: string): boolean {
  return path.startsWith('-') || path.includes('(deleted)') || UNTESTABLE_EXT.has(extOf(path.replace(/^\-/, '')));
}

function visited(history: HealTriageHistory | undefined, nodeId: string): boolean {
  return (history?.visited ?? []).includes(nodeId);
}

export function triageFailure(signature: HealFailureSignature, history?: HealTriageHistory): HealTriageResult {
  const failed = signature.failedTests ?? 0;
  const introduced = signature.introduced ?? 0;
  const unverified = signature.unverified ?? [];
  const importer = signature.importerUnrunTests ?? 0;
  const claim = signature.environmentClaim?.trim() ?? '';

  if (claim && ENVIRONMENT_CLAIM.test(claim) && !visited(history, 'verify-evidence')) {
    return {
      outcome: 'environment-claimed',
      evidence: [`환경 분류를 주장한다: ${claim}`, 'verify-evidence 를 아직 거치지 않았다'],
    };
  }
  if (failed === 0 && unverified.length > 0 && unverified.every(deletedOrUntestable)) {
    return {
      outcome: 'untestable',
      evidence: [`실패 시험 0`, `미검증이 전부 지운 파일 또는 시험 불가 확장자다: ${unverified.join(', ')}`],
    };
  }
  if (failed === 0 && importer > 0) {
    return {
      outcome: 'harness-fixable',
      evidence: [`실패 시험 0`, `importer 미실행 시험 ${importer}`],
    };
  }
  if (introduced > 0 || (signature.namedSource?.trim() ?? '') !== '') {
    const why = introduced > 0
      ? `도입 실패 introduced=${introduced}`
      : `이름이 짚이는 미검증 소스: ${signature.namedSource}`;
    return { outcome: 'child-fixable', evidence: [why] };
  }
  if (!visited(history, 'observe-deeper')) {
    return {
      outcome: 'needs-deeper-observation',
      evidence: ['결정론 갈래에 안 맞는다', 'observe-deeper 를 아직 거치지 않았다'],
    };
  }
  if (!visited(history, 'ground-external')) {
    return {
      outcome: 'needs-grounding',
      evidence: ['observe-deeper 를 거쳤다', 'ground-external 을 아직 거치지 않았다'],
    };
  }
  if (signature.citations?.length) {
    return {
      outcome: 'rework-with-citations',
      evidence: ['ground-external 인용으로 재작업한다', ...signature.citations.map((citation) => citation.url)],
    };
  }
  return {
    outcome: 'exhausted',
    evidence: ['observe-deeper 와 ground-external 을 둘 다 거쳤다', '더 올릴 해상도가 없다'],
  };
}

/** ═══ 슈퍼바이저 고르기(0.2.32 칸 GRAPH-SUPERVISOR-PICK) — «선언된» 오버레이 중에서 고른다 ═══
 *
 * 능력표 ③b: 고르기만 한다. ⛔ 새 그래프 노드를 «짓지 않는다» — 후보를 읽고 선언된 조건을
 * 판정해 overlayId 하나를 고를 뿐, 템플릿을 만들거나 노드를 더하지 않는다.
 *
 * 후보의 실체: `graphs/overlays/`(loadGraphOverlays) 선언 중 `stage: heal` 인 것만.
 * 조건의 값은 코드가 낸다 — 선언의 appliesWhen 을 selectOverlays(선언 조건 판정 기계)로 판정한다.
 * 결정론: 같은 입력·같은 선언이면 언제나 같은 답 — 조건이 맞는 후보 중 «선언 순서가 가장 앞»인 것.
 */

/** 선언된 heal 오버레이 후보를 읽는 자리 — 시험이 갈아 끼운다. */
export type DeclaredHealOverlayLoader = () => readonly GraphOverlaySpec[];

export type SupervisorOverlayPickOutcome =
  | 'picked'
  | 'no-declared-candidate'
  | 'no-applicable-candidate';

export interface SupervisorOverlayPickInput {
  /** 선언 조건(appliesWhen) 판정에 쓸 상태 — 예: `{ stop_class: 'pod-died' }`. */
  readonly state: Readonly<Record<string, unknown>>;
  /** 후보를 좁힐 그래프 id — 기본은 활성 self-implement 그래프. */
  readonly graphId?: string;
}

/** 고르기 결과 — outcome+evidence 계약(triageFailure·classifyReworkCapExhaustion 과 같은 양식). */
export interface SupervisorOverlayPick {
  readonly outcome: SupervisorOverlayPickOutcome;
  /** outcome='picked' 일 때 고른 선언 오버레이. */
  readonly overlayId?: string;
  readonly evidence: readonly string[];
}

/** `graphs/overlays/` 선언에서 `stage: heal` 인 것만 읽는다 — 고르기 후보의 실체. */
export function loadDeclaredHealOverlays(): readonly GraphOverlaySpec[] {
  return loadGraphOverlays(defaultOverlaysDir()).overlays.filter((spec) => spec.stage === 'heal');
}

/**
 * 선언된 heal 오버레이 후보 중 하나를 고른다. 조건이 맞는 후보가 여럿이면 선언 순서가
 * 가장 앞인 것을 고른다(결정론). 던지지 않는다 — 못 고르는 이유는 evidence 가 말한다.
 */
export function pickSupervisorHealOverlay(
  input: SupervisorOverlayPickInput,
  load: DeclaredHealOverlayLoader = loadDeclaredHealOverlays,
): SupervisorOverlayPick {
  let declared: readonly GraphOverlaySpec[];
  try {
    declared = load();
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { outcome: 'no-declared-candidate', evidence: [`선언을 읽지 못했다: ${why}`] };
  }
  const healOnly = declared.filter((spec) => spec.stage === 'heal');
  if (healOnly.length === 0) {
    return { outcome: 'no-declared-candidate', evidence: ['선언된 heal 오버레이 후보가 없다'] };
  }
  const graphId = input.graphId ?? GRAPH_SPECS['self-implement']?.graphId;
  if (!graphId) {
    return { outcome: 'no-declared-candidate', evidence: ['활성 self-implement 그래프 선언이 없다'] };
  }
  let applied: readonly GraphOverlaySpec[];
  try {
    applied = selectOverlays(healOnly, { graphId, stage: 'heal', state: { ...input.state } }).applied;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { outcome: 'no-applicable-candidate', evidence: [`선언 조건 판정이 실패했다: ${why}`] };
  }
  const applicable = new Set(applied.map((spec) => spec.overlayId));
  const first = healOnly.find((spec) => applicable.has(spec.overlayId));
  if (!first) {
    return { outcome: 'no-applicable-candidate', evidence: [`선언된 heal 후보 ${healOnly.length}개 중 조건이 맞는 것이 없다`] };
  }
  return { outcome: 'picked', overlayId: first.overlayId, evidence: [`선언된 heal 후보 ${healOnly.length}개 중 조건이 맞는 첫 선언: ${first.overlayId}`] };
}
