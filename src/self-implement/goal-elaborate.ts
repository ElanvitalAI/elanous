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
  /** ELABORATION-PROTECTED-PATH-INVERSION — 골이 «고치라고» 준 경로(대상 경로·신설·증거 명령의 파일).
   *  이 경로는 불변식 문면에 같이 나와도 보호 구역이 되지 않는다(대상을 수정 금지로 뒤집지 않는다). */
  targetPaths: string[];
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
  | { status: 'needs-human'; reason: ElaborationFailureReason; attempts: number; violations: string[]; cardSha: string }
  | { status: 'skipped'; reason: 'no-provider' | 'provider-failed' | 'card-unparseable'; attempts: number; error?: string };

const MAX_LINES = 20;
const MAX_LINE_CHARS = 300;
const MAX_CARD_FILES = 30;
export type ElaborationFailureReason = 'goal-elaboration-ungrounded-path' | 'goal-elaboration-protected-path'
  | 'goal-elaboration-scope-conflict' | 'goal-elaboration-fixed-layer-conflict';

function failureReason(violations: readonly string[]): ElaborationFailureReason {
  if (violations.some((violation) => violation.startsWith('ungrounded path:'))) return 'goal-elaboration-ungrounded-path';
  if (violations.some((violation) => violation.startsWith('protected path:'))) return 'goal-elaboration-protected-path';
  // 판정기 자유 문면의 "KPI 범위 약화"는 확장 수복 대상이 아니다. 구조화된 kind=scope만 인정한다.
  if (violations.some((violation) => violation.startsWith('scope expansion:'))) return 'goal-elaboration-scope-conflict';
  return 'goal-elaboration-fixed-layer-conflict';
}

function repairInstruction(reason: ElaborationFailureReason, fixed: GoalFixedLayer): string {
  switch (reason) {
    case 'goal-elaboration-ungrounded-path':
      return `없는 경로를 다시 접지한다. 저장소에 있는 파일이나 골에 명시된 대상 경로만 고르고, 새 파일은 골이 신설을 요구할 때만 newFiles에 적는다. 대상 경로: ${fixed.targetPaths.join(', ') || '(명시 없음)'}`;
    case 'goal-elaboration-protected-path':
      return `보호 경로를 카드에서 빼고 골의 대상 경로 안에서만 구현한다.${fixed.protectedPaths.length ? ` 보호 경로: ${fixed.protectedPaths.join(', ')}` : ' 위반 목록의 보호 경로 지적을 확인한다.'}`;
    case 'goal-elaboration-scope-conflict':
      return '범위 확장을 좁힌다. 골의 대상과 완료 경계를 유지하고 새 기능이나 새 판정 조건을 더하지 않는다.';
    case 'goal-elaboration-fixed-layer-conflict':
      return '고정 층의 방향·KPI·불변식을 보존한다. 지적된 문장만 고치고 완료 조건을 약화하지 않는다.';
  }
}
const KPI_LINE = /판정 신호|수용선|완료 경계|증거 명령|KPI|acceptance|verify:|반증/i;
const INVARIANT_LINE = /불변|경계:|⛔|바꾸지 않는다|하지 않는다|금지|보호|invariant|must not|do not/i;
const DIRECTION_LINE = /^(?:[-*]\s*)?(?:바꿀 것|목표|무엇|왜|현재 계약|Goal|Why|What)\s*[:：]/i;
const PROHIBITION = /바꾸지 않는다|건드리지 않는다|하지 않는다|금지|보호|⛔|must not|do not (?:touch|modify|change)/i;
const PATH_TOKEN = /[\w@.-]+(?:\/[\w@.-]+)*\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|md|sh)\b/g;
/** 골이 바꾸라고 준 경로가 실리는 줄 — 대상 경로 · 신설 · 증거 명령(bun test <파일>). */
//   ⛔ «줄 처음 ⊕ 콜론» 고정 — 경계 줄 안의 «…판정 신호 불변…» 을 대상 줄로 읽으면 보호 경로가 빠진다.
//   ① 대상·신설 줄 = 그 줄의 모든 경로 ② 증거 명령·판정 신호·현재 계약 줄 = `bun test` 바로 뒤 시험 파일만
//      (그 줄의 «goal-author.ts 는 바꾸지 않는다» 같은 보호 경로를 대상으로 빼지 않게 · r1 must-fix).
const TARGET_LINE = /^(?:[-*]\s*)?(?:대상 경로|대상|신설|새 파일|target paths?|files?)\s*[:：]/i;
const COMMAND_LINE = /^(?:[-*]\s*)?(?:완료 경계 증거 명령|증거 명령|판정 신호|현재 계약)\s*[:：]/i;
const BUN_TEST_HEAD = /bun test\s+/g;
/** `bun test` 인자 — 경로 꼴 토큰이 끊기는 곳(`·`·문장·`→`)에서 멈추고 시험 파일만 낸다(r2 must-fix). */
export function bunTestPathArgs(line: string): string[] {
  const out: string[] = [];
  for (const head of line.matchAll(BUN_TEST_HEAD)) {
    const rest = line.slice(head.index! + head[0].length).split(/\s+/);
    for (const raw of rest) {
      // 따옴표·백틱으로 감싼 인자도 시험 파일이다(r3 must-fix) — 짝이 맞는 감싸기만 벗긴다.
      const tok = /^(["'`])(.*)\1$/.exec(raw)?.[2] ?? raw;
      if (tok.startsWith('-')) continue;
      if (!/^[\w@./-]+$/.test(tok)) break;
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(tok)) out.push(tok);
    }
  }
  return out;
}
/** 경로 바로 뒤가 «의 …»·«안의 …»·«'s …» 면 그 금지는 파일 «안의 내용»(기존 단언·동작·계약)에 대한 것이다. */
const CONTENT_SCOPED = /^\s*(?:의|안의|에 있는|속)\s|^'s\s|^\s+(?:existing|assertions?|behaviou?r|contract)\b/i;
/** 형식이 안 맞아 «검증 불가»로 처리된 경계 줄 — 금지 불변식으로 격상하지 않는다(10-22 실물). */
const UNVERIFIABLE_LINE = /UNVERIFIABLE|검증 불가|형식 불일치/i;
/** 사람이 쓴 경계 줄 — 대상 경로를 보호로 이길 수 있는 유일한 자리. */
const BOUNDARY_LINE = /^(?:[-*]\s*)?경계\s*[:：]/;
/** 경로 «바로 뒤»가 «는/를 바꾸지 않는다» 꼴일 때만 경로 자체 금지다 — «X 를 수정하되 기존 단언은 바꾸지 않는다» 는 아니다(r1 must-fix). */
const BARE_PATH_PROHIBITION = /^\s*(?:파일)?\s*(?:은|는|을|를|도)?\s*(?:(?:바꾸|건드리|수정하|고치|변경하)지\s*않는다|(?:수정|변경)\s*금지)/;

function samePathOrSuffix(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function clip(lines: string[]): string[] {
  return lines.slice(0, MAX_LINES).map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line));
}

/** 골 원문에서 고정 층을 «그대로» 뽑는다(요약·재서술하지 않는다 — 판정기가 원문 줄을 본다). */
export function extractGoalFixedLayer(goal: string): GoalFixedLayer {
  const lines = goal.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const kpi = lines.filter((line) => KPI_LINE.test(line));
  const invariants = lines.filter((line) => INVARIANT_LINE.test(line) && !UNVERIFIABLE_LINE.test(line));
  const targetPaths = new Set<string>();
  for (const line of lines.filter((l) => TARGET_LINE.test(l))) {
    // 대상 줄 안의 금지 절(«· X 는 바꾸지 않는다»)은 대상이 아니다 — 보호로 남긴다(r4 must-fix). 쪼개기는 보호 구역과 같은 규칙.
    for (const clause of line.split(/[·;,]|\s-\s/)) {
      if (PROHIBITION.test(clause)) continue;
      for (const match of clause.matchAll(PATH_TOKEN)) targetPaths.add(match[0]);
    }
  }
  /** 증거·판정 명령이 «돌리라고» 준 시험 파일 — 어떤 금지 줄로도 보호 구역이 되지 않는다(TA-REMOTE-MIRROR-BIND 10-22). */
  const evidencePaths = new Set<string>();
  for (const line of lines.filter((l) => COMMAND_LINE.test(l))) {
    for (const path of bunTestPathArgs(line)) { targetPaths.add(path); evidencePaths.add(path); }
  }
  let direction = lines.filter((line) => DIRECTION_LINE.test(line));
  // UNVERIFIABLE 경계 줄은 방향 대체값으로도 고정 층에 들이지 않는다(r6 — 판정기 프롬프트에 «X 수정 금지»가 되살아났다).
  if (!direction.length) direction = lines.filter((line) => !kpi.includes(line) && !invariants.includes(line) && !UNVERIFIABLE_LINE.test(line)).slice(0, 3);
  const protectedPaths = new Set<string>();
  const explicitlyProtected = new Set<string>();
  for (const line of invariants) {
    for (const clause of line.split(/[·;,]|\s-\s/)) {
      if (!PROHIBITION.test(clause)) continue;
      for (const match of clause.matchAll(PATH_TOKEN)) {
        const isTarget = [...targetPaths].some((target) => samePathOrSuffix(match[0], target));
        if (isTarget) {
          // 골이 고치거나 돌리라고 준 파일(대상·신설·증거 시험)은 «추론»으로 보호되지 않는다 —
          //   저작기가 덧붙인 분해 인용·«단정하지 않는다» 같은 동작 금지 문장이 같은 절의 대상까지 보호로 뒤집었다(TA-REMOTE-MIRROR-BIND 10-22).
          //   ⛔ 이기는 것은 사람이 쓴 «경계:» 줄의 맨 «X 는 바꾸지 않는다»(경로 자체 금지)뿐이고, 증거 명령의 시험 파일은 그것으로도 안 막는다(r5 ⊕ 이번 변종).
          //   «X 의 기존 단언·동작은 바꾸지 않는다» 는 «내용» 금지다 — 파일은 고친다(10-22 밤샘 parked 다수의 뒤집힘).
          const pathLevel = BOUNDARY_LINE.test(line) && BARE_PATH_PROHIBITION.test(clause.slice(match.index! + match[0].length));
          const isEvidence = [...evidencePaths].some((path) => samePathOrSuffix(match[0], path));
          if (!pathLevel || isEvidence) continue;
          explicitlyProtected.add(match[0]);
        }
        protectedPaths.add(match[0]);
      }
    }
  }
  const targets = [...targetPaths].filter((target) => ![...explicitlyProtected].some((p) => samePathOrSuffix(p, target)));
  return { direction: clip(direction), kpi: clip(kpi), invariants: clip(invariants), protectedPaths: [...protectedPaths], targetPaths: targets };
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
    if (hit) violations.push(protectedPathViolation(path, hit));
    else if (!card.newFiles.includes(path) && !fileExists(path)) violations.push(`ungrounded path: ${path} does not exist and is not listed in newFiles`);
  }
  return violations;
}

const CARD_SYSTEM = 'You elaborate a software goal into a concrete implementation card before coding starts. Reply with one JSON object only.';
const JUDGE_SYSTEM = 'You check only whether an implementation card stays inside a goal\'s fixed layer (direction, KPI/acceptance signals, invariants, protected areas). Reply with one JSON object only.';

function section(title: string, lines: string[]): string {
  return [`### ${title}`, ...(lines.length ? lines.map((line) => `- ${line}`) : ['- (없음)'])].join('\n');
}

function buildCardPrompt(goal: string, context: string, fixed: GoalFixedLayer, previousViolations: string[] = [], repair?: string): string {
  return [
    '## 할 일 — 착수 구체화 카드(E1)',
    '아래 골을 구현하기 전에, 저장소 맥락을 근거로 «구체화 카드»를 쓴다. 고정 층(방향·KPI·불변식·보호 구역)은 바꾸지 않는다 — 카드는 «어디서부터 어떻게» 만 정한다.',
    'JSON 형식: {"files": [실제 건드릴 경로], "newFiles": [그중 새로 만들 경로], "requirements": [세부 요구], "firstTest": {"path": 시험 파일, "name": 시험 이름, "redReason": 지금 왜 실패하는가}, "stage": "unit|integration|live", "level": "L0|L1|L2|L3|L4"(주입 사다리 층)}',
    ...(previousViolations.length ? ['', '## 앞 카드가 고정 층과 어긋났다 — 이 사유로 딱 한 번 고쳐 다시 쓴다', ...(repair ? [repair] : []), ...previousViolations.map((v) => `- ${v}`)] : []),
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
    'JSON 형식: {"consistent": true|false, "violations": [{"kind": "path"|"content"|"scope", "path": "<경로 · path 일 때>", "text": "<어긋난 점>"}]}',
    'kind=path = 그 경로를 «건드리는 것 자체»가 금지라는 지적 · kind=content = 기존 단언·동작·계약·KPI 를 바꾸거나 약화했다는 지적 · kind=scope = 골 밖의 새 기능으로 범위를 확장했다는 지적.',
    ...(fixed.targetPaths.length ? [`대상 경로(골이 고치라고 준 파일 · 건드리는 것 자체는 위반 아님 · 그 안의 기존 계약을 바꾸면 content 위반): ${fixed.targetPaths.join(', ')}`] : []),
    '',
    section('방향', fixed.direction),
    section('KPI·판정 신호', fixed.kpi),
    section('불변식·보호 구역', fixed.invariants),
    '',
    '### 카드',
    JSON.stringify(card, null, 2),
  ].join('\n');
}

type JudgeViolation = { kind: 'path' | 'content' | 'scope' | 'unknown'; path?: string; text: string };

const PROTECTED_PATH_PREFIX = 'protected path:';
function protectedPathViolation(path: string, protectedPath: string): string {
  return `${PROTECTED_PATH_PREFIX} ${path} (goal invariant forbids changing ${protectedPath})`;
}

function legacyProtectedPath(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith(PROTECTED_PATH_PREFIX)) return undefined;
  const match = /^(\S+?)(?:\s+\(goal invariant forbids changing\s+(\S+)\))?\.?$/i.exec(trimmed.slice(PROTECTED_PATH_PREFIX.length).trim());
  return match && (!match[2] || match[1] === match[2]) ? match[1] : undefined;
}

/** 판정기 지적이 «대상 경로를 건드리는 것 자체»(kind=path)인가 — 문구가 아니라 판정기가 낸 «종류»로 가른다(r2 must-fix).
 *  ⛔ content·종류 없음(옛 문자열 꼴)은 버리지 않는다 — 기존 단언·동작·계약 위반은 문구와 무관하게 남는다. */
function isTargetInversion(violation: JudgeViolation, targetPaths: readonly string[]): boolean {
  // 이전 판정기는 kind 없이 결정론 검사와 똑같은 보호 경로 문장을 돌려주기도 했다
  // (FIRST10-GATE: 신설 scripts/first10-gate.test.ts). 정확한 경로 수준 문법만 복구한다.
  // 명시적 content 지적은 문구가 비슷해도 기존 계약 위반일 수 있으므로 버리지 않는다.
  const legacy = violation.kind === 'unknown' ? legacyProtectedPath(violation.text) : undefined;
  const path = violation.kind === 'path' ? violation.path
    : legacy;
  if (!path) return false;
  return targetPaths.some((target) => samePathOrSuffix(path, target));
}

function judgeViolations(value: unknown): JudgeViolation[] {
  if (!Array.isArray(value)) return [];
  const out: JudgeViolation[] = [];
  for (const item of value) {
    if (typeof item === 'string') { if (item.trim()) out.push({ kind: 'unknown', text: item }); continue; }
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const text = typeof rec.text === 'string' && rec.text.trim() ? rec.text : JSON.stringify(rec);
    const kind = rec.kind === 'path' || rec.kind === 'content' || rec.kind === 'scope' ? rec.kind : 'unknown';
    out.push({ kind, text, ...(typeof rec.path === 'string' && rec.path.trim() ? { path: rec.path.trim() } : {}) });
  }
  return out;
}

function parseJudge(text: string): { consistent: boolean; violations: JudgeViolation[] } | undefined {
  const raw = lastJsonObject(text) as Record<string, unknown> | undefined;
  if (!raw || typeof raw.consistent !== 'boolean') return undefined;
  const violations = judgeViolations(raw.violations ?? []);
  return {
    consistent: raw.consistent && violations.length === 0,
    violations: raw.consistent ? violations : violations.length ? violations : [{ kind: 'unknown', text: 'judge reported inconsistency' }],
  };
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
  deps: { callLLM?: ElaborationCallLLM; maxRewrites?: number; observe?: (event: string, data: Record<string, unknown>) => void },
): Promise<ElaborationOutcome> {
  if (!deps.callLLM) return { status: 'skipped', reason: 'no-provider', attempts: 0 };
  const fixed = extractGoalFixedLayer(input.goal);
  // 같은 결함으로 LLM을 계속 부르지 않는다. 과도한 호출자 설정을 조용히 무시하지 않는다.
  if (deps.maxRewrites !== undefined && deps.maxRewrites !== 0 && deps.maxRewrites !== 1) {
    throw new RangeError('goal elaboration maxRewrites must be 0 or 1');
  }
  const maxAttempts = 1 + (deps.maxRewrites ?? 1);
  const fixedLayerEmpty = !fixed.kpi.length && !fixed.invariants.length;
  /** 다시 쓰기 프롬프트에 실을 앞 회차의 문제(판독 실패 포함). */
  let feedback: string[] = [];
  let repair: string | undefined;
  /** 고정 층 위반은 «판독된 카드»에만 귀속한다 — 해시와 위반이 같은 카드를 가리킨다. */
  let lastRejected: { sha: string; violations: string[]; reason: ElaborationFailureReason } | undefined;
  const judgeErrors: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let text: string;
    try {
      text = await deps.callLLM({ prompt: buildCardPrompt(input.goal, input.context ?? '', fixed, feedback, repair), systemPrompt: CARD_SYSTEM });
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
          if (!verdict.consistent) {
            // 판정기가 «대상 경로를 건드렸다 = 보호 구역 위반»이라고 하면 그 지적은 뒤집힘이다 — 버리고 관측에 남긴다.
            const inverted = verdict.violations.filter((v) => isTargetInversion(v, fixed.targetPaths));
            if (inverted.length) judgeErrors.push(`judge-target-inversion-dropped: ${inverted.length}`);
            violations = verdict.violations.filter((v) => !isTargetInversion(v, fixed.targetPaths))
              .map((v) => v.kind === 'scope' ? `scope expansion: ${v.text}`
                : v.kind === 'content' ? `content violation: ${v.text}` : v.text);
          }
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
    const reason = failureReason(violations);
    lastRejected = { sha, violations, reason };
    feedback = violations;
    if (attempt < maxAttempts) {
      repair = [...new Set(violations.map((violation) => failureReason([violation])))].map((kind) => repairInstruction(kind, fixed)).join('\n');
      deps.observe?.('goal-elaboration-self-heal', { reason, attempt, cardSha: sha, violations });
    }
  }
  if (!lastRejected) return { status: 'skipped', reason: 'card-unparseable', attempts: maxAttempts, error: feedback[0] };
  return { status: 'needs-human', reason: lastRejected.reason, attempts: maxAttempts, violations: lastRejected.violations, cardSha: lastRejected.sha };
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
    outcome = await elaborateGoalOnArrival({ goal: input.goal, context: input.prompt, fileExists }, { callLLM: input.callLLM,
      observe: (event, data) => input.observe(event, data, { level: 'warn' }) });
  } catch (error) {
    if (error instanceof RangeError && error.message === 'goal elaboration maxRewrites must be 0 or 1') throw error;
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
    input.observe('goal-elaboration-needs-human', { outcome: 'needs-human', reason: outcome.reason, attempts: outcome.attempts, violations: outcome.violations, cardSha: outcome.cardSha }, { level: 'warn' });
    return { prompt: input.prompt, parked: true, detail: `goal-elaboration needs-human: ${outcome.reason} (attempts: ${outcome.attempts}) · ${outcome.violations.join(' | ').slice(0, 500)}` };
  }
  input.observe('goal-elaboration-skipped', { outcome: 'skipped', reason: outcome.reason, attempts: outcome.attempts, ...(outcome.error ? { error: outcome.error } : {}) }, outcome.reason === 'no-provider' ? undefined : { level: 'warn' });
  return { prompt: input.prompt, parked: false };
}
