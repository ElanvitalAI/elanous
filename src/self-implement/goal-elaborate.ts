/**
 * GOAL-ELABORATE-ON-ARRIVAL — E1 착수 구체화(spec-on-arrival).
 *
 * 설계 = 내부 문서 `RFC-progressive-goal-elaboration-2026-10-21` §2 E1 · §7 간선 ①(author → implement «구체화 층 v1»).
 * 골은 두 층이다: 고정 층(방향·KPI·불변식·보호 구역 — 런이 못 바꾼다) ⊕ 구체화 층(건드릴 파일·세부 요구·
 * 먼저 쓸 시험 — 런이 채운다). 이 모듈은 구현 첫 단계 전에 구체화 카드를 쓰게 하고, 카드가 고정 층과
 * 맞는지만 판정한다(안 맞으면 다시 쓰기 1회 → 그래도면 사람).
 *
 * ⛔ 골의 KPI·판정 신호는 바꾸지 않는다 — 카드는 골 원문 «뒤에» 덧붙을 뿐이고 고정 층을 다시 쓰지 않는다.
 * ⭐ 순수 함수 ⊕ 주입한 LLM 호출 — 시험은 대본 응답으로 돈다(주입 사다리 L2).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ElaborationCallLLM = (args: { prompt: string; systemPrompt?: string }) => Promise<string>;

const INJECTION_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export type InjectionLevel = typeof INJECTION_LEVELS[number];

export interface GoalFixedLayer {
  direction: string[];
  kpi: string[];
  invariants: string[];
  /** 불변식 문면에서 «바꾸지 않는다/금지» 절에 실린 경로 — 카드가 건드리면 위반이다. */
  protectedPaths: string[];
}

export interface ElaborationCard {
  files: string[];
  newFiles: string[];
  requirements: string[];
  firstTest: { path: string; name: string; redReason: string };
  stage: string;
  level: InjectionLevel;
}

export type ElaborationOutcome =
  | { status: 'elaborated'; card: ElaborationCard; cardSha: string; fileCount: number; level: InjectionLevel; attempts: number; judge: 'llm' | 'deterministic-only'; judgeErrors?: string[]; fixedLayerEmpty?: boolean }
  | { status: 'needs-human'; attempts: number; violations: string[]; cardSha: string }
  | { status: 'skipped'; reason: 'no-provider' | 'provider-failed' | 'card-unparseable'; attempts: number; error?: string };

const MAX_LINES = 20;
const MAX_LINE_CHARS = 300;
const MAX_CARD_FILES = 30;
const KPI_LINE = /판정 신호|수용선|완료 경계|증거 명령|KPI|acceptance|verify:|반증/i;
const INVARIANT_LINE = /불변|경계:|⛔|바꾸지 않는다|하지 않는다|금지|보호|invariant|must not|do not/i;
const DIRECTION_LINE = /^(?:[-*]\s*)?(?:바꿀 것|목표|무엇|왜|현재 계약|Goal|Why|What)\s*[:：]/i;
const PROHIBITION = /바꾸지 않는다|건드리지 않는다|하지 않는다|금지|보호|⛔|must not|do not (?:touch|modify|change)/i;
const PATH_TOKEN = /[\w@.-]+(?:\/[\w@.-]+)*\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|md|sh)\b/g;

function clip(lines: string[]): string[] {
  return lines.slice(0, MAX_LINES).map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line));
}

/** 골 원문에서 고정 층을 «그대로» 뽑는다(요약·재서술하지 않는다 — 판정기가 원문 줄을 본다). */
export function extractGoalFixedLayer(goal: string): GoalFixedLayer {
  const lines = goal.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const kpi = lines.filter((line) => KPI_LINE.test(line));
  const invariants = lines.filter((line) => INVARIANT_LINE.test(line));
  let direction = lines.filter((line) => DIRECTION_LINE.test(line));
  if (!direction.length) direction = lines.filter((line) => !kpi.includes(line) && !invariants.includes(line)).slice(0, 3);
  const protectedPaths = new Set<string>();
  for (const line of invariants) {
    for (const clause of line.split(/[·;,]|\s-\s/)) {
      if (!PROHIBITION.test(clause)) continue;
      for (const match of clause.matchAll(PATH_TOKEN)) protectedPaths.add(match[0]);
    }
  }
  return { direction: clip(direction), kpi: clip(kpi), invariants: clip(invariants), protectedPaths: [...protectedPaths] };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  return out.length === value.length ? out : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 마지막 JSON 객체를 읽는다(펜스 · 앞뒤 산문 허용). */
function lastJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1]!);
  const candidates = [...fenced.reverse(), text];
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* next */ }
  }
  return undefined;
}

export function parseElaborationCard(text: string): { ok: true; card: ElaborationCard } | { ok: false; error: string } {
  const raw = lastJsonObject(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'no JSON object' };
  const record = raw as Record<string, unknown>;
  const files = stringList(record.files);
  if (!files?.length || files.length > MAX_CARD_FILES) return { ok: false, error: `files must be 1..${MAX_CARD_FILES} strings` };
  const newFiles = record.newFiles === undefined ? [] : stringList(record.newFiles);
  if (!newFiles) return { ok: false, error: 'newFiles must be strings' };
  const requirements = stringList(record.requirements);
  if (!requirements?.length) return { ok: false, error: 'requirements must be a non-empty string list' };
  const test = record.firstTest as Record<string, unknown> | undefined;
  if (!test || !nonEmpty(test.path) || !nonEmpty(test.name) || !nonEmpty(test.redReason)) {
    return { ok: false, error: 'firstTest needs path, name and redReason' };
  }
  if (!nonEmpty(record.stage)) return { ok: false, error: 'stage is required' };
  if (!INJECTION_LEVELS.includes(record.level as InjectionLevel)) return { ok: false, error: 'level must be L0..L4' };
  return {
    ok: true,
    card: {
      files: [...new Set(files)],
      newFiles: [...new Set(newFiles)],
      requirements,
      firstTest: { path: test.path.trim(), name: test.name.trim(), redReason: test.redReason.trim() },
      stage: record.stage.trim(),
      level: record.level as InjectionLevel,
    },
  };
}

function touchesProtected(path: string, protectedPath: string): boolean {
  return path === protectedPath || path.endsWith(`/${protectedPath}`);
}

/** 결정론 대조 — 보호 경로를 건드리나 · 저장소에 없는 경로를 «기존»으로 적었나(접지). */
export function checkCardAgainstFixedLayer(card: ElaborationCard, fixed: GoalFixedLayer, fileExists: (path: string) => boolean): string[] {
  const violations: string[] = [];
  const paths = [...new Set([...card.files, ...card.newFiles, card.firstTest.path])];
  for (const path of paths) {
    const hit = fixed.protectedPaths.find((protectedPath) => touchesProtected(path, protectedPath));
    if (hit) violations.push(`protected path: ${path} (goal invariant forbids changing ${hit})`);
    else if (!card.newFiles.includes(path) && !fileExists(path)) violations.push(`ungrounded path: ${path} does not exist and is not listed in newFiles`);
  }
  return violations;
}

const CARD_SYSTEM = 'You elaborate a software goal into a concrete implementation card before coding starts. Reply with one JSON object only.';
const JUDGE_SYSTEM = 'You check only whether an implementation card stays inside a goal\'s fixed layer (direction, KPI/acceptance signals, invariants, protected areas). Reply with one JSON object only.';

function section(title: string, lines: string[]): string {
  return [`### ${title}`, ...(lines.length ? lines.map((line) => `- ${line}`) : ['- (없음)'])].join('\n');
}

function buildCardPrompt(goal: string, context: string, fixed: GoalFixedLayer, previousViolations: string[] = []): string {
  return [
    '## 할 일 — 착수 구체화 카드(E1)',
    '아래 골을 구현하기 전에, 저장소 맥락을 근거로 «구체화 카드»를 쓴다. 고정 층(방향·KPI·불변식·보호 구역)은 바꾸지 않는다 — 카드는 «어디서부터 어떻게» 만 정한다.',
    'JSON 형식: {"files": [실제 건드릴 경로], "newFiles": [그중 새로 만들 경로], "requirements": [세부 요구], "firstTest": {"path": 시험 파일, "name": 시험 이름, "redReason": 지금 왜 실패하는가}, "stage": "unit|integration|live", "level": "L0|L1|L2|L3|L4"(주입 사다리 층)}',
    ...(previousViolations.length ? ['', '## 앞 카드가 고정 층과 어긋났다 — 고쳐 다시 쓴다', ...previousViolations.map((v) => `- ${v}`)] : []),
    '',
    '## 고정 층(바꾸지 않는다)',
    section('방향', fixed.direction),
    section('KPI·판정 신호', fixed.kpi),
    section('불변식·보호 구역', fixed.invariants),
    '',
    '## 골 원문',
    goal,
    ...(context && context !== goal ? ['', '## 저장소 맥락', context.slice(0, 12_000)] : []),
  ].join('\n');
}

function buildJudgePrompt(fixed: GoalFixedLayer, card: ElaborationCard): string {
  return [
    '카드가 고정 층과 «맞는지만» 본다. 카드가 KPI·판정 신호를 약화·삭제·대체하거나, 방향을 바꾸거나, 불변식·보호 구역을 어기면 불일치다. 구현 방법의 좋고 나쁨은 판정하지 않는다.',
    'JSON 형식: {"consistent": true|false, "violations": [어긋난 점]}',
    '',
    section('방향', fixed.direction),
    section('KPI·판정 신호', fixed.kpi),
    section('불변식·보호 구역', fixed.invariants),
    '',
    '### 카드',
    JSON.stringify(card, null, 2),
  ].join('\n');
}

function parseJudge(text: string): { consistent: boolean; violations: string[] } | undefined {
  const raw = lastJsonObject(text) as Record<string, unknown> | undefined;
  if (!raw || typeof raw.consistent !== 'boolean') return undefined;
  const violations = stringList(raw.violations ?? []) ?? [];
  return { consistent: raw.consistent && violations.length === 0, violations: raw.consistent ? violations : violations.length ? violations : ['judge reported inconsistency'] };
}

function cardSha(card: ElaborationCard): string {
  return createHash('sha256').update(JSON.stringify(card)).digest('hex');
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/**
 * 카드 쓰기 → 판정(결정론 ⊕ LLM) → 어긋나면 다시 쓰기 1회 → 그래도면 needs-human.
 * 공급자 실패·카드 판독 실패는 skipped(런을 막지 않는다 — 카드 없이 오늘처럼 구현한다).
 */
export async function elaborateGoalOnArrival(
  input: { goal: string; context?: string; fileExists: (path: string) => boolean },
  deps: { callLLM?: ElaborationCallLLM; maxRewrites?: number },
): Promise<ElaborationOutcome> {
  if (!deps.callLLM) return { status: 'skipped', reason: 'no-provider', attempts: 0 };
  const fixed = extractGoalFixedLayer(input.goal);
  const maxAttempts = 1 + Math.max(0, deps.maxRewrites ?? 1);
  const fixedLayerEmpty = !fixed.kpi.length && !fixed.invariants.length;
  /** 다시 쓰기 프롬프트에 실을 앞 회차의 문제(판독 실패 포함). */
  let feedback: string[] = [];
  /** 고정 층 위반은 «판독된 카드»에만 귀속한다 — 해시와 위반이 같은 카드를 가리킨다. */
  let lastRejected: { sha: string; violations: string[] } | undefined;
  const judgeErrors: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let text: string;
    try {
      text = await deps.callLLM({ prompt: buildCardPrompt(input.goal, input.context ?? '', fixed, feedback), systemPrompt: CARD_SYSTEM });
    } catch (error) {
      return { status: 'skipped', reason: 'provider-failed', attempts: attempt, error: errorText(error) };
    }
    const parsed = parseElaborationCard(text);
    if (!parsed.ok) {
      feedback = [`card-unparseable: ${parsed.error}`];
      continue;
    }
    const card = parsed.card;
    const sha = cardSha(card);
    let violations = checkCardAgainstFixedLayer(card, fixed, input.fileExists);
    let judge: 'llm' | 'deterministic-only' = 'deterministic-only';
    if (!violations.length) {
      try {
        const verdict = parseJudge(await deps.callLLM({ prompt: buildJudgePrompt(fixed, card), systemPrompt: JUDGE_SYSTEM }));
        if (verdict) {
          judge = 'llm';
          if (!verdict.consistent) violations = verdict.violations;
        } else judgeErrors.push('judge-unparseable');
      } catch (error) {
        // 판정기 실패는 결정론 대조만으로 — 카드는 고정 층을 다시 쓰지 않는다. 실패 사실은 관측에 남긴다.
        judgeErrors.push(`judge-failed: ${errorText(error)}`);
      }
    }
    if (!violations.length) {
      return { status: 'elaborated', card, cardSha: sha, fileCount: card.files.length, level: card.level, attempts: attempt, judge,
        ...(judgeErrors.length ? { judgeErrors } : {}), ...(fixedLayerEmpty ? { fixedLayerEmpty } : {}) };
    }
    lastRejected = { sha, violations };
    feedback = violations;
  }
  if (!lastRejected) return { status: 'skipped', reason: 'card-unparseable', attempts: maxAttempts, error: feedback[0] };
  return { status: 'needs-human', attempts: maxAttempts, violations: lastRejected.violations, cardSha: lastRejected.sha };
}

export function renderElaborationCard(card: ElaborationCard, sha: string): string {
  return [
    `## 착수 구체화 카드 (E1 · 구체화 층 v1 · ${sha.slice(0, 12)})`,
    '> 고정 층(방향·KPI·판정 신호·불변식)은 위 골 원문이 정본이다 — 이 카드는 그것을 바꾸지 않고 «어디서부터 어떻게» 만 정한다. 구현 중 카드가 틀렸으면 고치고 이유를 남긴다.',
    `- 무대: ${card.stage} · 주입 층: ${card.level}`,
    '### 건드릴 파일',
    ...card.files.map((path) => `- ${path}${card.newFiles.includes(path) ? ' (신설)' : ''}`),
    '### 세부 요구',
    ...card.requirements.map((line) => `- ${line}`),
    '### 먼저 쓸 시험 (RED)',
    `- ${card.firstTest.path} — ${card.firstTest.name}`,
    `- 지금 실패하는 이유: ${card.firstTest.redReason}`,
  ].join('\n');
}

/** orchestrator 호출점 한 곳 — 관측(`observe` → 로그 ⊕ 런 원장)까지 여기서 낸다. */
export async function runArrivalElaboration(input: {
  goal: string;
  prompt: string;
  cwd?: string;
  fileExists?: (path: string) => boolean;
  callLLM?: ElaborationCallLLM;
  observe: (event: string, data: Record<string, unknown>, opt?: { level?: 'warn' }) => void;
}): Promise<{ prompt: string; parked: boolean; detail?: string }> {
  const fileExists = input.fileExists ?? ((path: string) => existsSync(join(input.cwd ?? process.cwd(), path)));
  let outcome: ElaborationOutcome;
  try {
    outcome = await elaborateGoalOnArrival({ goal: input.goal, context: input.prompt, fileExists }, { callLLM: input.callLLM });
  } catch (error) {
    outcome = { status: 'skipped', reason: 'provider-failed', attempts: 0, error: errorText(error) };
  }
  if (outcome.status === 'elaborated') {
    // `outcome` 은 여정 그래프 관측기(graphs/journey/units/author-dialogue/observe.ts)가 읽는 값이다.
    input.observe('goal-elaborated', { outcome: 'elaborated', cardSha: outcome.cardSha, fileCount: outcome.fileCount, level: outcome.level, stage: outcome.card.stage, attempts: outcome.attempts, judge: outcome.judge,
      ...(outcome.judgeErrors ? { judgeErrors: outcome.judgeErrors } : {}), ...(outcome.fixedLayerEmpty ? { fixedLayerEmpty: true } : {}) },
      outcome.judgeErrors || outcome.fixedLayerEmpty ? { level: 'warn' } : undefined);
    return { prompt: `${input.prompt}\n\n${renderElaborationCard(outcome.card, outcome.cardSha)}`, parked: false };
  }
  if (outcome.status === 'needs-human') {
    input.observe('goal-elaboration-needs-human', { outcome: 'needs-human', attempts: outcome.attempts, violations: outcome.violations, cardSha: outcome.cardSha }, { level: 'warn' });
    return { prompt: input.prompt, parked: true, detail: `goal-elaboration needs-human: ${outcome.violations.join(' | ').slice(0, 500)}` };
  }
  input.observe('goal-elaboration-skipped', { outcome: 'skipped', reason: outcome.reason, attempts: outcome.attempts, ...(outcome.error ? { error: outcome.error } : {}) }, outcome.reason === 'no-provider' ? undefined : { level: 'warn' });
  return { prompt: input.prompt, parked: false };
}
