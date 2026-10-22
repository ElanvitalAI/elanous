/**
 * GOAL-REFINE-FROM-FIRST-IMPL — E3 첫 구현 → 골 저작 역피드백(골 v2).
 *
 * 설계 = 내부 문서 `RFC-progressive-goal-elaboration-2026-10-21` §7 간선 ②③④ — ta-journey 의 author-dialogue 단위에서
 * judge «findings» → author → «deliver vN+1» → implement 되돌이를 «한 번»(max_visits) 실행한다.
 * 첫 라운드(구현 → gate → 리뷰) 뒤 «재그라운딩 노트»(지나간 생산 경로 · 건드린 파일 · 운영이 골 가정과 다른 점 ·
 * 불가능/모호한 수용선과 바꿀 문면 · 남은 일)를 받아 골 v2 를 만든다.
 *
 * ⛔ 방향·KPI 줄은 바뀌지 않는다(사람 몫) — 바꾸려 들면 v2 를 «버리고» v1 을 유지한다 ⊕ 사유를 남긴다.
 * ⭐ 바뀌어도 되는 칸은 셋뿐: 예상 구역(`대상 경로:`·`신설:`) · 수용선 문구(`완료 경계 코드:`·`완료 경계 실물:`·`수용선:`·`- Checkable requested criterion:`) ·
 *    검증 무대(`검증 무대:`·`무대:`). 줄 머리 꼴은 저작 문법(goal-author.ts GOAL_DONE_BOUNDARY_LABELS ⊕ 칸 문면)을 따른다.
 *    `완료 경계 증거 명령`은 «재는 명령»이라 KPI 로 본다(E1 extractGoalFixedLayer 의 KPI 줄에서 수용선 문구만 뺀 것).
 * ⭐ 순수 함수 ⊕ 주입한 LLM — 시험은 대본 응답(fake-llm)으로 돈다(주입 사다리 L2).
 */
import { createHash } from 'node:crypto';

export type RefineCallLLM = (args: { prompt: string; systemPrompt?: string }) => Promise<string>;

/** 골 한 줄의 칸. fixed = 방향·KPI(불변) · zone/acceptance/stage = 바뀌어도 되는 칸 · other = 이 칸이 안 건드린다. */
export type GoalLineZone = 'direction' | 'kpi' | 'zone' | 'acceptance' | 'stage' | 'other';
const EDITABLE: ReadonlySet<GoalLineZone> = new Set(['zone', 'acceptance', 'stage']);

/**
 * 편집 가능 칸의 줄 머리 — 분류기(classifyGoalLine)와 노트 프롬프트(buildRegroundingPrompt)가 «이 상수 하나»에서 만든다.
 * `Checkable requested criterion` = 저작기가 쓰는 «요구된 수용 기준» 줄(REFUTE 인용 자격 줄 — reflect-mustfix.ts) · preservation 은 고정(other).
 */
export const EDITABLE_GOAL_LABELS = {
  zone: ['대상 경로', '신설', '예상 구역'],
  acceptance: ['완료 경계 코드', '완료 경계 실물', '수용선', 'acceptance', 'Checkable requested criterion'],
  stage: ['검증 무대', '무대', 'stage'],
} as const satisfies Record<'zone' | 'acceptance' | 'stage', readonly string[]>;
const EDITABLE_ZONE_NAMES: Record<keyof typeof EDITABLE_GOAL_LABELS, string> = { zone: '예상 구역', acceptance: '수용선 문구', stage: '검증 무대' };

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LABEL = (labels: string) => new RegExp(`^\\s*(?:[-*]\\s*)?(?:${labels})\\s*[:：]`, 'i');
const LABELS = (labels: readonly string[]) => LABEL(labels.map(escapeRegExp).join('|'));
const KPI_LABEL = LABEL('완료 경계 증거 명령|증거 명령|판정 신호(?:\\([^)]*\\))?|KPI|verify|반증');
const ACCEPTANCE_LABEL = LABELS(EDITABLE_GOAL_LABELS.acceptance);
const ZONE_LABEL = LABELS(EDITABLE_GOAL_LABELS.zone);
const STAGE_LABEL = LABELS(EDITABLE_GOAL_LABELS.stage);
const DIRECTION_LABEL = LABEL('바꿀 것|목표|무엇|왜|현재 계약|Goal|Why|What');
/** 라벨 없는 줄도 KPI 낱말을 품으면 고정으로 본다(보수 쪽). */
const KPI_WORD = /판정 신호|KPI/i;

export function classifyGoalLine(line: string): GoalLineZone {
  if (KPI_LABEL.test(line)) return 'kpi';
  if (ACCEPTANCE_LABEL.test(line)) return 'acceptance';
  if (ZONE_LABEL.test(line)) return 'zone';
  if (STAGE_LABEL.test(line)) return 'stage';
  if (DIRECTION_LABEL.test(line)) return 'direction';
  if (KPI_WORD.test(line)) return 'kpi';
  return 'other';
}

function labelOf(line: string): string {
  return /^\s*(?:[-*]\s*)?([^:：]+)[:：]/.exec(line)?.[1]?.trim() ?? '';
}

/** 방향·KPI 줄(원문 그대로 · 순서 보존) — v1·v2 대조의 정본. */
export function fixedGoalLines(goal: string): string[] {
  return goal.split(/\r?\n/).filter((line) => {
    const zone = classifyGoalLine(line);
    return zone === 'direction' || zone === 'kpi';
  });
}

export interface RegroundEdit { from: string; to: string; reason: string }
export interface RegroundingNote {
  productionPath: string[];
  touchedFiles: string[];
  divergences: string[];
  edits: RegroundEdit[];
  remaining: string[];
}

export interface GoalChangedLine { index: number; zone: GoalLineZone; before: string; after: string; reason: string }
export type GoalKeptReason = 'no-provider' | 'provider-failed' | 'note-unparseable' | 'empty-note' | 'no-applicable-edits' | 'fixed-layer-edit' | 'max-visits';
export type GoalRefinement =
  | { outcome: 'refined'; v1Hash: string; v2Hash: string; v2: string; changedLines: GoalChangedLine[]; reasons: string[]; rejectedEdits: string[]; note: RegroundingNote }
  | { outcome: 'kept'; v1Hash: string; v2Hash: string; kept: GoalKeptReason; detail?: string; rejectedEdits: string[] };

export function goalHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function strings(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, max).map((item) => item.slice(0, 400));
}

function lastJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]!);
  for (const candidate of [...fenced.reverse(), text]) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* next */ }
  }
  return undefined;
}

export function parseRegroundingNote(text: string): { ok: true; note: RegroundingNote } | { ok: false; error: string } {
  const raw = lastJsonObject(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'no JSON object' };
  const record = raw as Record<string, unknown>;
  const edits: RegroundEdit[] = Array.isArray(record.edits)
    ? record.edits.flatMap((edit) => {
      const e = edit as Record<string, unknown> | null;
      return e && typeof e.from === 'string' && typeof e.to === 'string'
        ? [{ from: e.from, to: e.to, reason: typeof e.reason === 'string' && e.reason.trim() ? e.reason.trim().slice(0, 400) : '(이유 없음)' }]
        : [];
    }).slice(0, 20)
    : [];
  return { ok: true, note: { productionPath: strings(record.productionPath), touchedFiles: strings(record.touchedFiles, 40), divergences: strings(record.divergences), edits, remaining: strings(record.remaining) } };
}

function noteIsEmpty(note: RegroundingNote): boolean {
  return !note.edits.length && !note.productionPath.length && !note.touchedFiles.length && !note.divergences.length && !note.remaining.length;
}

const REGROUND_NOTE_HEADER = '## 재그라운딩 노트 (골 v2 · 첫 라운드 실전 — 참고, 고정 층 아님)';

/**
 * (v1 골 문면, 재그라운딩 노트) → v2 ⊕ 바뀐 줄·이유 ⊕ 해시.
 * ⛔ 방향·KPI 줄을 겨눈 편집이 «하나라도» 있으면 v2 전체를 버린다(kept: fixed-layer-edit).
 * 바뀌어도 되는 칸 밖(other)·없는 줄·칸 머리를 바꾼 편집은 그 편집만 버리고 이유를 rejectedEdits 에 남긴다.
 */
export function applyRegroundingNote(v1: string, note: RegroundingNote): GoalRefinement {
  const v1Hash = goalHash(v1);
  const kept = (reason: GoalKeptReason, rejectedEdits: string[] = [], detail?: string): GoalRefinement =>
    ({ outcome: 'kept', v1Hash, v2Hash: v1Hash, kept: reason, rejectedEdits, ...(detail ? { detail } : {}) });
  if (noteIsEmpty(note)) return kept('empty-note');
  const lines = v1.split('\n');
  const rejected: string[] = [];
  const changed: GoalChangedLine[] = [];
  for (const edit of note.edits) {
    const from = edit.from.trim();
    const index = lines.findIndex((line, i) => line.trim() === from && !changed.some((c) => c.index === i));
    if (index === -1) { rejected.push(`not-in-goal: ${from.slice(0, 120)}`); continue; }
    const before = lines[index]!;
    const zone = classifyGoalLine(before);
    if (zone === 'direction' || zone === 'kpi') {
      return kept('fixed-layer-edit', [...rejected, `${zone}: ${before.trim().slice(0, 160)}`], edit.reason);
    }
    const after = edit.to.replace(/\r?\n/g, ' ').trim();
    if (!EDITABLE.has(zone)) { rejected.push(`out-of-zone(${zone}): ${before.trim().slice(0, 120)}`); continue; }
    if (classifyGoalLine(after) !== zone || labelOf(after) !== labelOf(before.trim())) { rejected.push(`label-changed: ${before.trim().slice(0, 120)}`); continue; }
    if (after === before.trim()) { rejected.push(`no-op: ${before.trim().slice(0, 120)}`); continue; }
    const indent = /^\s*/.exec(before)![0];
    lines[index] = `${indent}${after}`;
    changed.push({ index, zone, before: before.trim(), after, reason: edit.reason });
  }
  if (!changed.length) return kept('no-applicable-edits', rejected);
  const body = lines.join('\n');
  // 방어 이중화 — 적용 뒤에도 방향·KPI 줄이 원문 그대로인가(줄 분류가 편집으로 바뀌는 경우까지 막는다).
  if (JSON.stringify(fixedGoalLines(body)) !== JSON.stringify(fixedGoalLines(v1))) return kept('fixed-layer-edit', rejected, 'fixed lines differ after applying edits');
  const section = (title: string, items: string[]) => (items.length ? [`### ${title}`, ...items.map((item) => `- ${item.replace(/\r?\n/g, ' ')}`)] : []);
  const v2 = [
    body.trimEnd(),
    '',
    REGROUND_NOTE_HEADER,
    ...section('지나간 생산 경로', note.productionPath),
    ...section('건드린 파일', note.touchedFiles),
    ...section('운영이 골 가정과 다른 점', note.divergences),
    ...section('바뀐 문면(v1 → v2)', changed.map((c) => `${c.before} → ${c.after} — ${c.reason}`)),
    ...section('남은 일', note.remaining),
  ].join('\n');
  return { outcome: 'refined', v1Hash, v2Hash: goalHash(v2), v2, changedLines: changed, reasons: changed.map((c) => c.reason), rejectedEdits: rejected, note };
}

const NOTE_SYSTEM = 'You re-ground a software goal after its first implementation round. Reply with one JSON object only.';

export interface FirstRoundEvidence {
  /** 첫 라운드 자식 요약(무엇을 해 봤나). */
  implSummary?: string;
  /** 첫 라운드 gate·리뷰가 돌려준 지적(must-fix 등). */
  findings?: string;
  /** 첫 라운드가 실제로 건드린 파일. */
  changedFiles?: readonly string[];
}

/** 내부 — 시험은 refineGoalFromFirstRound 가 LLM 에 넘긴 프롬프트로 본다. */
function buildRegroundingPrompt(v1: string, evidence: FirstRoundEvidence): string {
  const fixed = fixedGoalLines(v1);
  return [
    '## 할 일 — 재그라운딩 노트(E3 · 첫 라운드 → 골 v2)',
    '첫 라운드(구현 → gate → 리뷰) 실전에서 알게 된 것으로 골을 다시 접지한다. 방향·KPI 줄은 바꾸지 않는다(사람 몫).',
    `바꿀 수 있는 줄은 셋뿐이다: ${(Object.keys(EDITABLE_GOAL_LABELS) as Array<keyof typeof EDITABLE_GOAL_LABELS>)
      .map((zone) => `${EDITABLE_ZONE_NAMES[zone]}(${EDITABLE_GOAL_LABELS[zone].map((label) => `\`${label}:\``).join('·')})`).join(' · ')}. 줄 머리(라벨)는 그대로 두고 값만 고친다.`,
    'JSON 형식: {"productionPath": [실제로 지나간 생산 경로], "touchedFiles": [건드린 파일], "divergences": [운영이 골 가정과 다른 점], "edits": [{"from": "골 원문 한 줄 그대로", "to": "고친 한 줄", "reason": "왜(불가능·모호·경로 틀림)"}], "remaining": [남은 일]}',
    '',
    '## 고정 층(바꾸지 않는다 — 방향·KPI)',
    ...(fixed.length ? fixed.map((line) => `- ${line.trim()}`) : ['- (없음)']),
    '',
    '## 첫 라운드 실전',
    `- 자식 요약: ${(evidence.implSummary ?? '').replace(/\s+/g, ' ').trim().slice(0, 600) || '(없음)'}`,
    `- 건드린 파일: ${evidence.changedFiles?.length ? evidence.changedFiles.slice(0, 40).join(', ') : '(관측 없음)'}`,
    '### gate·리뷰 지적',
    (evidence.findings ?? '').trim().slice(0, 4000) || '(없음)',
    '',
    '## 골 v1 원문',
    v1,
  ].join('\n');
}

/** 노트 생성(LLM) → v2. 실패·빈 노트·상한 초과는 v1 유지(보수 쪽) ⊕ 사유 — 조용한 폴백은 없다(호출부가 사건으로 남긴다). */
export async function refineGoalFromFirstRound(
  input: { v1: string; evidence: FirstRoundEvidence; visit: number; maxVisits?: number },
  deps: { callLLM?: RefineCallLLM },
): Promise<GoalRefinement> {
  const v1Hash = goalHash(input.v1);
  const kept = (reason: GoalKeptReason, detail?: string): GoalRefinement => ({ outcome: 'kept', v1Hash, v2Hash: v1Hash, kept: reason, rejectedEdits: [], ...(detail ? { detail } : {}) });
  if (input.visit > (input.maxVisits ?? GOAL_REFINE_MAX_VISITS)) return kept('max-visits', `visit ${input.visit} > ${input.maxVisits ?? GOAL_REFINE_MAX_VISITS}`);
  if (!deps.callLLM) return kept('no-provider');
  let text: string;
  try {
    text = await deps.callLLM({ prompt: buildRegroundingPrompt(input.v1, input.evidence), systemPrompt: NOTE_SYSTEM });
  } catch (error) {
    return kept('provider-failed', (error instanceof Error ? error.message : String(error)).slice(0, 200));
  }
  const parsed = parseRegroundingNote(text);
  if (!parsed.ok) return kept('note-unparseable', parsed.error);
  return applyRegroundingNote(input.v1, parsed.note);
}

/** 되돌이 상한 — ta-journey author-dialogue 의 refine 왕복은 런당 한 번(첫 라운드 뒤). */
export const GOAL_REFINE_MAX_VISITS = 1;

/** 원장 `goal-refined` 사건 값 — v1·v2 해시 ⊕ 바뀐 줄 ⊕ 이유 ⊕ (유지면) kept 사유. */
export function goalRefinedEvent(refinement: GoalRefinement, round: number): Record<string, unknown> {
  const base = { outcome: refinement.outcome, round, v1Hash: refinement.v1Hash, v2Hash: refinement.v2Hash,
    ...(refinement.rejectedEdits.length ? { rejectedEdits: refinement.rejectedEdits } : {}) };
  if (refinement.outcome === 'kept') return { ...base, changedLines: [], reasons: [], kept: refinement.kept, ...(refinement.detail ? { detail: refinement.detail } : {}) };
  return { ...base, changedLines: refinement.changedLines, reasons: refinement.reasons };
}

/** PR 본문 «골 변경» 절 — v1→v2 바뀐 줄과 이유(유지면 그 사유). */
export function renderGoalChangeSection(refinement: GoalRefinement): string {
  const head = ['## 골 변경', `- v1 ${refinement.v1Hash.slice(0, 12)} → v2 ${refinement.v2Hash.slice(0, 12)} (방향·KPI 줄 불변)`];
  if (refinement.outcome === 'kept') return [...head, `- 시도 · v1 유지 · 사유 ${refinement.kept}${refinement.detail ? ` (${refinement.detail})` : ''}`,
    ...refinement.rejectedEdits.map((edit) => `- 버린 편집: ${edit}`)].join('\n');
  return [...head,
    ...refinement.changedLines.flatMap((c) => [`- [${c.zone}] \`${c.before}\``, `  → \`${c.after}\``, `  이유: ${c.reason}`]),
    ...refinement.rejectedEdits.map((edit) => `- 버린 편집: ${edit}`)].join('\n');
}

/**
 * orchestrator 호출점 한 곳 — 첫 라운드 뒤 · 둘째 라운드 프롬프트 직전.
 * 관측 = 원장 `goal-refined`(observe → 런 원장 ⊕ debug.log 범주 `self-implement.goal-refine`).
 * 돌려준 goal 이 다음 라운드 프롬프트의 골이다(유지면 v1).
 */
export async function runFirstRoundRefine(input: {
  goal: string;
  evidence: FirstRoundEvidence;
  round: number;
  visit: number;
  callLLM?: RefineCallLLM;
  observe: (event: string, data: Record<string, unknown>, opt?: { category?: string; level?: 'warn' }) => void;
}): Promise<{ goal: string; refinement: GoalRefinement }> {
  let refinement: GoalRefinement;
  try {
    refinement = await refineGoalFromFirstRound({ v1: input.goal, evidence: input.evidence, visit: input.visit }, { callLLM: input.callLLM });
  } catch (error) {
    const v1Hash = goalHash(input.goal);
    refinement = { outcome: 'kept', v1Hash, v2Hash: v1Hash, kept: 'provider-failed', rejectedEdits: [], detail: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
  }
  // ⚠️ 유지(kept)는 전부 warn — seam(callLLM) 부재로 늘 no-provider 인 런도 «조용히 꺼지지» 않는다(리뷰 r1 should-fix 4).
  input.observe('goal-refined', goalRefinedEvent(refinement, input.round), { category: 'self-implement.goal-refine', ...(refinement.outcome === 'refined' ? {} : { level: 'warn' as const }) });
  return { goal: refinement.outcome === 'refined' ? refinement.v2 : input.goal, refinement };
}
