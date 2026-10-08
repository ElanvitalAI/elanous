#!/usr/bin/env bun
// ── ASK 마커 «발사 전» 검사 (2026-09-05) ─────────────────────────────────────
//
// 왜 있나: `## 불변식` / `## 경계` 는 **제목형**이라 골 저작기가 마커로 «안 읽는다».
//   저작기는 그것을 authoring «중»에 경고로 알려 주지만, 그때는 이미 발사한 뒤다.
//   ⇒ 이 자는 그 판정을 «발사 전»으로 당긴다. 판정 함수는 저작기 «자신의» 것을 부른다(재구현 금지).
//
// 쓰는 법:  bun scripts/ask-marker-check.ts <ask 파일…>
//   exit 0 = 세 마커와 불변식 경로 축이 통과 · exit 1 = 하나라도 «없거나» 추출/접지 실패
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import {
  DECISION_SIGNAL_MARKER_GUIDANCE,
  inspectAskInvariantMarker,
  inspectAskBoundaryMarker,
  inspectAskDecisionSignalMarker,
  leadingGoalMetadata,
  GOAL_TYPES,
} from '../src/self-implement/goal-author.js';
import { parseAskTargetPathHints } from '../src/self-dev/launch-preflight.js';
import { parseSafeDecisionSignalCommand } from '../src/self-implement/decision-signal-press.js';

/** 압박기가 「안전하게 못 읽는다」고 낸 사유.
 *  ⛔⭐ ***손으로 베끼지 않는다*** — 그 union 을 여기 다시 적어 두었던 탓에 `#18822` 가 사유를 넓혔을 때
 *    이 파일만 뒤처져 타입이 «게이트 바깥»에서 빨갰다. ⇒ 파서의 «반환 타입»에서 뽑는다(동기화가 공짜가 된다). */
type DecisionSignalRejectionReason =
  Extract<ReturnType<typeof parseSafeDecisionSignalCommand>, { reason: string }>['reason'];

type Axis = { label: string; marker: boolean; extracted: boolean };
type GoalTypeMetadataAxis = Axis & { readonly invalidValue?: string };
export type DecisionObservationKind = 'unit-test' | 'real' | 'unresolved';
type DecisionObservationAxis = Axis & {
  readonly signalCount: number;
  readonly unitTestObservationCount: number;
  readonly realObservationCount: number;
  readonly unresolvedObservationCount: number;
  readonly unresolvedObservationNames: readonly string[];
};
type InvariantPathAxis = Axis & {
  readonly inspectionRoot: string;
  readonly invariantLines: readonly string[];
  readonly ungroundedLines: readonly string[];
  /** 아직 없지만 이 골의 «대상 경로»로 선언돼 곧 만들어질 경로. 실재 경로와 «다른 값»으로 낸다. */
  readonly plannedPaths: readonly string[];
  readonly outsideTargetPaths: readonly string[];
};

type DecisionTestPathAxis = Axis & {
  readonly inspectionRoot: string;
  readonly observations: readonly DecisionTestPathObservation[];
  /** 뿌리를 못 훑었으면 그 이유 — 이때 관측은 «안 쟀다»이지 «0개 매치»가 아니다. */
  readonly unreadableRoot?: string;
};

type DecisionTestPathObservation = {
  readonly path: string;
  readonly matches: number;
  readonly alternatePaths: readonly string[];
};

/** 판정 신호가 «무엇을 관측하나» — 단위 시험뿐이면 「값이 실행 경로로 흘렀는지」를 아무것도 증명하지 못한다.
 *  ⛔ 이 축은 «막지 않는다». marker/extracted 를 항상 true 로 두어 종료 코드를 바꾸지 않고, 수만 낸다.
 *  🩸 계기(2026-09-07): 한 창이 판정 신호가 «전부» 단위 시험인 ask 를 넷 쐈고 넷 다 내부 리뷰에서
 *    반복 실패했다. 같은 날 다른 트랙의 아홉 골은 신호 4~6 중 단위 시험이 «항상 하나»였다. */
export type DecisionSignalKindAxis = Axis & {
  readonly total: number;
  readonly unitTestOnly: number;
  readonly realWorld: number;
};

export type DecisionSignalObservation = {
  readonly signal: string;
  readonly command?: string;
  /** Parser-owned observation classification consumed by the decision-signal presser. */
  readonly kind: DecisionObservationKind;
};

type UnpressedDecisionSignalAxis = Axis & {
  readonly total: number;
  readonly unreadable: readonly {
    readonly ordinal: number;
    readonly command: string;
    // ⛔ 이 union 은 `parseSafeDecisionSignalCommand` 의 «사유»를 그대로 받는다 — 그쪽이 넓어지면 여기도 넓힌다.
    //   📏 #18822 가 `ambiguous-rg-c-arguments` 를 넓혔는데 여기가 안 따라가 타입이 «게이트 바깥»에서 빨갰다.
    readonly rejectionReason?: DecisionSignalRejectionReason;
  }[];
  readonly uninspectable: readonly { readonly ordinal: number; readonly signal: string }[];
};

type UnpressedDecisionSignalRemedy = 'repeat-command' | 'specify-path' | 'unclassified';
type NotAllowlistedRemedy = 'global-elanous' | 'environment-prefix' | 'generic';

function classifyUnpressedDecisionSignal(command: string): UnpressedDecisionSignalRemedy {
  if (/^\s*(?:같은\s*(?:시험|명령)|위와\s*같다)\s*$/u.test(command)) return 'repeat-command';
  if (/<[^>\r\n]+>/u.test(command)) return 'specify-path';
  return 'unclassified';
}

function classifyNotAllowlistedRemedy(command: string): NotAllowlistedRemedy {
  const firstWord = command.trim().split(/\s+/, 1)[0] ?? '';
  if (firstWord === 'elanous') return 'global-elanous';
  if (/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(firstWord)) return 'environment-prefix';
  return 'generic';
}

function formatUnpressedDecisionSignalRemedy(
  ordinal: number,
  command: string,
  rejectionReason?: DecisionSignalRejectionReason,
): string {
  const remedy = classifyUnpressedDecisionSignal(command);
  if (remedy === 'repeat-command') {
    return `ℹ️ 안 눌릴 신호 — ${ordinal}번째 신호 처방: 축약하지 말고 명령을 통째로 반복하라`;
  }
  if (remedy === 'specify-path') {
    return `ℹ️ 안 눌릴 신호 — ${ordinal}번째 신호 처방: 자리표시자 대신 실제 경로를 명시하라`;
  }
  if (rejectionReason === 'not-allowlisted') {
    const notAllowlistedRemedy = classifyNotAllowlistedRemedy(command);
    if (notAllowlistedRemedy === 'global-elanous') {
      return `ℹ️ 안 눌릴 신호 — ${ordinal}번째 신호 거부 이유: not-allowlisted; 전역 elanous 대신 bun bin/elanous.mjs …로 바꿔라`;
    }
    if (notAllowlistedRemedy === 'environment-prefix') {
      return `ℹ️ 안 눌릴 신호 — ${ordinal}번째 신호 거부 이유: not-allowlisted; 환경 변수 접두를 떼거나 그 값이 꼭 필요하면 이 신호에서 실행할 수 없다고 적어라`;
    }
    return `ℹ️ 안 눌릴 신호 — ${ordinal}번째 신호 거부 이유: not-allowlisted; 통과 예: bun test <실제 시험 경로> 또는 rg -c '패턴' <실제 파일 경로>`;
  }
  if (rejectionReason !== undefined) {
    return `ℹ️ 안 눌릴 신호 — ${ordinal}번째 신호 거부 이유: ${rejectionReason}`;
  }
  return `ℹ️ 안 눌릴 신호 — ${ordinal}번째 신호는 분류 못 함; 처방을 지어내지 않는다`;
}

/** 검사 루트를 «명시»해 부른다 — 기판(외부 저장소) 골은 그 트리를 줘야 판정이 맞다.
 *  ⛔ `inspectAskMarkers` 의 서명은 «그대로» 둔다: 내보낸 함수의 매개변수를 늘리면 tsc 게이트가
 *     저장소 전체 검사로 승격하고, 그 전체 검사에는 PWA 프로젝트의 «기존» 오류 19건이 들어 있어
 *     이 축과 무관한 이유로 착지가 막힌다(실측 2026-09-17 · pilot 19건 · 워크트리 8,388건).
 *     ⇒ 계약을 넓히지 않고 «다른 이름»으로 내놓는다. 부르는 쪽이 뿌리를 아는 경우에만 이쪽을 쓴다. */
export function inspectAskMarkersInRoot(ask: string, inspectionRoot: string): Axis[] {
  return inspectAskMarkersAt(ask, inspectionRoot);
}

export function inspectAskMarkers(ask: string): Axis[] {
  return inspectAskMarkersAt(ask, REPOSITORY_ROOT);
}

function inspectAskMarkersAt(ask: string, inspectionRoot: string): Axis[] {
  return [
    { label: '불변식', ...pick(inspectAskInvariantMarker(ask)) },
    { label: '경계', ...pick(inspectAskBoundaryMarker(ask)) },
    { label: '판정 신호', ...pick(inspectAskDecisionSignalMarker(ask)) },
    inspectGoalTypeMetadata(ask),
    inspectInvariantFilePaths(ask, inspectionRoot),
    inspectDecisionTestPaths(ask, inspectionRoot),
    inspectDecisionObservations(ask),
    inspectDecisionSignalKinds(ask),
    inspectTargetPathLabel(ask),
  ];
}

const WRAPPED_MARKER = /^\s*(불변식|경계|판정 신호)\s*[:：]/u;
const EXISTING_MARKER = /^\s*(?:대상 경로|불변식|경계|판정 신호|한계)\s*[:：]/u;
const NON_CONTINUATION = /^\s*$|^\s*(?:#{1,6}(?:\s|$)|[-*+](?:\s|$)|\d+[.)](?:\s|$)|>(?:\s|$)|`{3,}.*$|~{3,}.*$|\|(?:\s|$))/u;

/** 줄 단위 추출기가 버릴 마커 바로 다음 본문을 비차단으로 이름 붙인다. */
export function inspectWrappedMarkerWarnings(ask: string): string[] {
  const lines = ask.split(/\r?\n/);
  return lines.flatMap((line, index) => {
    const marker = WRAPPED_MARKER.exec(line)?.[1];
    const continuation = lines[index + 1];
    if (!marker || continuation === undefined || EXISTING_MARKER.test(continuation) || NON_CONTINUATION.test(continuation)) return [];
    return [`⚠️ 감싼 마커 — ${marker} ${index + 1}번째 줄 다음 ${index + 2}번째 줄의 버려지는 문면: ${continuation.trim()}`];
  });
}

export function inspectDecisionSignalKinds(ask: string): DecisionSignalKindAxis {
  const observations = inspectDecisionSignalObservations(ask);
  const count = (kind: DecisionObservationKind) => observations.filter((observation) => observation.kind === kind).length;
  return {
    label: '판정 신호 종류',
    marker: true,
    extracted: true,
    total: observations.length,
    unitTestOnly: count('unit-test'),
    realWorld: count('real'),
  };
}

function pick(i: { marker: boolean; extracted: boolean }): { marker: boolean; extracted: boolean } {
  return { marker: i.marker, extracted: i.extracted };
}

const GOAL_TYPE_DECLARATION = /^- GoalType:[ \t]*(.*)$/m;
const TARGET_PATH_LABEL = /^대상 경로\s*[:：]/m;

function inspectTargetPathLabel(ask: string): Axis {
  const present = TARGET_PATH_LABEL.test(ask);
  return { label: '대상 경로', marker: present, extracted: present };
}

function inspectGoalTypeMetadata(ask: string): GoalTypeMetadataAxis {
  if (!GOAL_TYPE_DECLARATION.test(ask)) return { label: 'GoalType 머리 블록', marker: true, extracted: true };

  const metadataDeclaration = leadingGoalMetadata(ask)
    .map((line) => GOAL_TYPE_DECLARATION.exec(line)?.[1].trim())
    .find((value): value is string => value !== undefined);
  if (metadataDeclaration === undefined) return { label: 'GoalType 머리 블록', marker: false, extracted: false };
  if (!GOAL_TYPES.includes(metadataDeclaration as typeof GOAL_TYPES[number])) {
    return { label: 'GoalType 머리 블록', marker: false, extracted: false, invalidValue: metadataDeclaration };
  }
  return { label: 'GoalType 머리 블록', marker: true, extracted: true };
}

export function inspectDecisionSignalObservations(ask: string): DecisionSignalObservation[] {
  const lines = ask.split(/\r?\n/).map((line) => line.trim());
  const inline = lines
    .filter((line) => /^판정 신호\s*[:：]/.test(line))
    .map((signal) => decisionSignalObservation(signal, /관측\s*=\s*(?:`([^`]+)`|([^;]+))/.exec(signal)));
  const candidates = lines.flatMap((line, index) => {
    if (!/^[-*]?\s*Candidate decision signal\s*:/i.test(line)) return [];
    const observation = lines.slice(index + 1).find((next) => /^[-*]?\s*Observation\s*:/i.test(next));
    const command = observation ? /^[-*]?\s*Observation\s*:\s*(?:`([^`]+)`|(.+))$/i.exec(observation) : null;
    return [decisionSignalObservation(line, command)];
  });
  return [...inline, ...candidates];
}

function decisionSignalObservation(
  signal: string,
  match: RegExpExecArray | null,
): DecisionSignalObservation {
  const command = (match?.[1] ?? match?.[2])?.trim();
  return { signal, ...(command ? { command } : {}), kind: classifyDecisionObservation(command ? `관측 = ${command}` : signal) };
}

export function inspectUnpressedDecisionSignals(ask: string): UnpressedDecisionSignalAxis {
  const observations = inspectDecisionSignalObservations(ask);
  return {
    label: '안 눌릴 신호',
    marker: true,
    extracted: true,
    total: observations.length,
    unreadable: observations.flatMap(({ command }, index) => {
      if (command === undefined) return [];
      const parsed = parseSafeDecisionSignalCommand(command);
      if (parsed !== undefined && !('reason' in parsed)) return [];
      return [{
        ordinal: index + 1,
        command,
        ...(parsed !== undefined ? { rejectionReason: parsed.reason } : {}),
      }];
    }),
    uninspectable: observations.flatMap(({ command, signal }, index) =>
      command === undefined ? [{ ordinal: index + 1, signal }] : []),
  };
}

export function inspectDecisionObservations(ask: string): DecisionObservationAxis {
  const parsedSignals = inspectDecisionSignalObservations(ask);
  const signalLines = parsedSignals.map(({ signal }) => signal);
  const observationKinds = parsedSignals.map(({ kind }) => kind);
  const count = (kind: DecisionObservationKind) => observationKinds.filter((candidate) => candidate === kind).length;

  return {
    label: '판정 신호 관측',
    marker: true,
    extracted: true,
    signalCount: signalLines.length,
    unitTestObservationCount: count('unit-test'),
    realObservationCount: count('real'),
    unresolvedObservationCount: count('unresolved'),
    unresolvedObservationNames: parsedSignals
      .filter(({ kind }) => kind === 'unresolved')
      .map(({ command, signal }) => command ?? signal),
  };
}

const UNIT_TEST_OBSERVATION = /\bbun\s+(?:test|run\s+test)\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bnode\s+--test\b|같은 시험/u;
const LEGACY_REAL_OBSERVATION = /^(?:rg|ffmpeg|git|printf)\s+\S+|(?:^|[^\p{L}\p{N}])(?:호출|실행|돌려받|출력|종료 코드|통과 여부)(?=$|[^\p{L}\p{N}])/u;
const EXECUTABLE_REAL_OBSERVATION = /^(?:\.\/\S+|bun\s+(?:bin\/elanous\.mjs\s+\S+|run\s+\S+|-e\s+\S+|scripts\/\S+)|(?:python3|bash|sh|curl)\s+(?!(?:결과|개수)(?:\s|$))\S+)/u;

const ASK_MARKER_REPOSITORY_ROOT_FOR_KIND = resolve(import.meta.dir, '..');

function classifyDecisionObservation(signalLine: string): DecisionObservationKind {
  const match = /관측\s*=\s*(?:`([^`]+)`|([^;]+))/.exec(signalLine);
  const observation = match?.[1] ?? match?.[2];
  if (!observation) return 'unresolved';
  const command = observation.trim();
  if (UNIT_TEST_OBSERVATION.test(command)) {
    const paths = extractBunTestPaths(command);
    if (paths.some((path) => bunTestFileLaunchesRepositoryExecutable(path))) return 'real';
    return 'unit-test';
  }
  if (LEGACY_REAL_OBSERVATION.test(command) || EXECUTABLE_REAL_OBSERVATION.test(command)) return 'real';
  return 'unresolved';
}

/** spawn 호출의 인자 목록. 시험 파일은 실행하지 않고 소스만 읽는다.
 *  인자에 괄호가 있을 수 있어 첫 `)` 가 아니라 괄호가 닫히는 곳까지 읽는다. */
const REPOSITORY_SPAWN_HEAD = /\b(?:spawnSync|execFileSync|Bun\.spawn)\s*\(/gu;

function spawnCallArguments(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(REPOSITORY_SPAWN_HEAD)) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const character = source[index]!;
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      if (depth > 0) index += 1;
    }
    if (depth === 0) calls.push(source.slice(start, index));
  }
  return calls;
}
const REPOSITORY_EXECUTABLE_TARGET =
  /(?:^|[\s'"`])(?:\.\/)?(?:install\.sh|bin\/elanous\.mjs|scripts\/[^\s'"`]+|\/bin\/bash)(?=$|[\s'"`])/u;
/** 바인딩 리터럴은 그 네 타깃뿐이다. `fixture.ts` 같은 임의 `*.ts` 는 저장소 실행물이 아니다.
 *  `new URL('./….ts', import.meta.url)` 만 예외 — 그 형태가 이 저장소 스크립트를 가리킨다. */
const REPOSITORY_EXECUTABLE_BINDING =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:fileURLToPath\s*\(\s*)?(?:new\s+URL|resolve)\s*\(\s*(?:import\.meta\.(?:url|dir)\s*,\s*)?(['"`])((?:\.\/)?(?:install\.sh|bin\/elanous\.mjs|scripts\/[^\s'"`]+|\.\/[A-Za-z0-9_.-]+\.ts))(?:\2|\s*,)/gu;

/** 축 문면의 «둘째 줄» 들여쓰기 — CLI 가 축 줄 앞에 붙이는 세 칸과 맞춘다(첫 줄은 그대로 둔다: 줄 단위로 무는 시험·소비자가 있다). */
const VERDICT_FOLLOWUP_INDENT = '     ';

/** 「이 시험 파일이 있는 디렉토리」를 가리키는 식 — `import.meta.dir(name)` · `__dirname` ·
 *  `dirname(fileURLToPath(import.meta.url))`. 그리고 그 식에 묶인 변수(한 단계 간접).
 *  🩸 2026-09-23 🅕: `const ROOT = import.meta.dir; const SCRIPT = join(ROOT, 'ruler-stability.sh')` 가
 *    «실물 셸 스크립트를 spawn 하는» 시험인데 `new URL`·`resolve` 한 줄 형태만 보던 정규식이 못 봐서
 *    「실물 관측 0」 경고를 냈고, 그 경고가 저자를 «흔들리는 파일»로 밀어 착지를 막았다. */
const TEST_DIRECTORY_EXPRESSION = String.raw`(?:import\.meta\.dir(?:name)?|__dirname|dirname\s*\(\s*fileURLToPath\s*\(\s*import\.meta\.url\s*\)\s*\))`;
const TEST_DIRECTORY_ALIAS = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${TEST_DIRECTORY_EXPRESSION}\s*[;\n]`, 'gu');
/** `const S = join|resolve(<시험 디렉토리 식 또는 그 별칭>, '<조각>'[, '<조각>' …])` — 조각을 시험 파일
 *  디렉토리에서 풀어 «실제로 있는 파일»일 때만 묶는다. ⛔ `join(tmpDir, 'x.sh')` 같은 임시 픽스처는
 *  첫 인자가 시험 디렉토리가 아니라 안 묶인다(그건 저장소 실행물이 아니다). */
function testDirectoryJoinBindings(source: string, testPath: string): Set<string> {
  const aliases = new Set<string>();
  for (const match of source.matchAll(TEST_DIRECTORY_ALIAS)) if (match[1]) aliases.add(match[1]);
  const base = aliases.size === 0
    ? TEST_DIRECTORY_EXPRESSION
    : String.raw`(?:${TEST_DIRECTORY_EXPRESSION}|${[...aliases].map((name) => name.replace(/[$]/g, '\\$')).join('|')})`;
  const binding = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:join|resolve)\s*\(\s*${base}\s*((?:,\s*(['"])[^'"\n]+\3\s*)+)\)`, 'gu');
  const bound = new Set<string>();
  for (const match of source.matchAll(binding)) {
    const segments = [...match[2]!.matchAll(/(['"])([^'"\n]+)\1/gu)].map((segment) => segment[2]!);
    if (segments.length === 0) continue;
    if (existsSync(resolve(dirname(testPath), ...segments))) bound.add(match[1]!);
  }
  return bound;
}

/** bun test 파일이 «저장소 실행물»을 spawn 하면 실물 하니스다. 못 읽으면 false — real 로 올리지 않는다. */
export function bunTestFileLaunchesRepositoryExecutable(path: string): boolean {
  const resolved = isAbsolute(path) ? path : resolve(ASK_MARKER_REPOSITORY_ROOT_FOR_KIND, path);
  let source: string;
  try {
    source = readFileSync(resolved, 'utf8');
  } catch {
    return false;
  }
  const bound = new Set<string>();
  for (const match of source.matchAll(REPOSITORY_EXECUTABLE_BINDING)) {
    if (match[1]) bound.add(match[1]);
  }
  for (const name of testDirectoryJoinBindings(source, resolved)) bound.add(name);
  for (const args of spawnCallArguments(source)) {
    if (new RegExp(REPOSITORY_EXECUTABLE_TARGET.source, 'u').test(args)) return true;
    if ([...bound].some((name) => new RegExp(`\\b${name}\\b`, 'u').test(args))) return true;
  }
  return false;
}

const BUN_TEST_COMMAND = /\bbun\s+test\s+([^;`\n]+)/gu;
const BUN_TEST_OPTIONS_WITH_VALUE = new Set(['--preload', '--test-name-pattern', '--timeout', '--rerun-each', '--seed', '-t']);
const SHELL_COMMAND_BOUNDARIES = new Set(['&&', '||', '|']);
const GLOB_MAGIC = /[*?\[\]{}]/u;

function shellWords(command: string): string[] {
  return command.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g)?.map((word) => word.replace(/^(?:"|')|(?:"|')$/g, '')) ?? [];
}

function extractBunTestPaths(command: string): string[] {
  const paths: string[] = [];
  for (const match of command.matchAll(BUN_TEST_COMMAND)) {
    const words = shellWords(match[1]!);
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]!;
      if (SHELL_COMMAND_BOUNDARIES.has(word)) break;
      if (word.startsWith('-')) {
        if (!word.includes('=') && BUN_TEST_OPTIONS_WITH_VALUE.has(word)) index += 1;
        continue;
      }
      paths.push(word);
    }
  }
  return paths;
}

/** 경고 줄에 쓸 «짧은» 검사 루트 이름.
 *  ⛔ 절대 경로를 그대로 쓰면 워크트리 루트가 140자라 한 줄이 못 읽히는 글이 된다(실측 2026-09-17).
 *     읽히지 않는 경고는 «안 읽힌다» — 이 자가 오늘 그 이유로 한 번 오독을 낳았다. */
function shortInspectionRoot(root: string): string {
  const name = root.split(sep).filter(Boolean).pop() ?? root;
  return name.length > 32 ? `${name.slice(0, 31)}…` : name;
}

/** 뿌리의 파일 목록. ⛔ 못 훑으면 던지지 않고 이유를 값으로 낸다.
 *  🩸 2026-09-23: 없는 뿌리(시험의 `/repo`)에서 `Bun.Glob.scanSync` 가 ENOENT 를 던졌고, 그 예외가
 *    발사 전 예비 검사 전체를 죽였다 — `ask-launch-flow.test.ts` 48건이 `#19299`(09-21) 부터 이틀간 main 에서 빨강. */
function repositoryFiles(inspectionRoot: string): { files: string[]; unreadable?: string } {
  try {
    return { files: Array.from(new Bun.Glob('**/*').scanSync({ cwd: inspectionRoot, onlyFiles: true })) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { files: [], unreadable: message.split(/\r?\n/, 1)[0] ?? 'unknown' };
  }
}

function isInsideInspectionRoot(path: string, inspectionRoot: string): boolean {
  const fromRoot = relative(inspectionRoot, path);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function existsAsInspectionFile(path: string, inspectionRoot: string): boolean {
  try { return lstatSync(resolve(inspectionRoot, path)).isFile(); } catch { return false; }
}

function expandRepositoryPath(path: string, files: readonly string[], inspectionRoot: string): string[] {
  if (!isInsideInspectionRoot(resolve(inspectionRoot, path), inspectionRoot)) return [];
  if (!GLOB_MAGIC.test(path)) return existsAsInspectionFile(path, inspectionRoot) ? [path] : [];
  const matches = new Set(new Bun.Glob(path).scanSync({ cwd: inspectionRoot, onlyFiles: true }));
  return files.filter((file) => matches.has(file));
}

function inspectDecisionTestPaths(ask: string, inspectionRoot: string): DecisionTestPathAxis {
  const { files, unreadable } = repositoryFiles(inspectionRoot);
  if (unreadable !== undefined) {
    return { label: '판정 신호 시험 경로', marker: true, extracted: true, inspectionRoot, observations: [], unreadableRoot: unreadable };
  }
  const observations = inspectDecisionSignalObservations(ask).flatMap(({ command }) =>
    command ? extractBunTestPaths(command).map((path) => {
      const matches = expandRepositoryPath(path, files, inspectionRoot);
      const alternatePaths = matches.length > 0 ? [] : files.filter((file) => basename(file) === basename(path));
      return { path, matches: matches.length, alternatePaths };
    }) : []);
  return { label: '판정 신호 시험 경로', marker: true, extracted: true, inspectionRoot, observations };
}

function inspectInvariantFilePaths(ask: string, inspectionRoot: string): InvariantPathAxis {
  const invariantLines = ask.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^불변식\s*[:：]/.test(line));
  const targetPaths = new Set(parseAskTargetPathHints(ask).map(normalize));
  const groundedByLine = invariantLines.map((line) => extractRepositoryFilePaths(line, inspectionRoot));
  const groundedPaths = groundedByLine.flat();
  // ⭐ 실재하지 않아도 «이 골의 대상 경로»로 선언된 것은 「경로를 댔다」로 센다.
  //    ⛔ 대상 경로에 «없는» 미존재 토큰은 세지 않는다 — 그러면 오타가 통과한다.
  // ⛔⭐ 「이 골이 만들 경로」는 그 줄에 실재 경로가 «있든 없든» 따로 센다.
  //   🩸 실물 유래 픽스처가 잡은 결함(2026-09-07): 한 불변식 줄이 「만들 파일」과 「그것을 부를 기존 파일」을
  //   «둘 다» 대는 것이 실물의 흔한 모양인데, 실재가 하나라도 있으면 그 줄의 계획 경로가 통째로 빠져
  //   사람이 읽는 목록이 «적게» 나왔다. 판정(접지 여부)은 여전히 실재 ⊕ 계획의 합집합으로 본다.
  const plannedByLine = invariantLines.map((line) =>
    extractDeclaredPathTokens(line).filter((path) =>
      targetPaths.has(normalize(path)) && !existsAsInspectionFile(path, inspectionRoot)));
  const plannedPaths = [...new Set(plannedByLine.flat())];
  const ungroundedLines = invariantLines.filter((_, index) =>
    groundedByLine[index]!.length === 0 && plannedByLine[index]!.length === 0);
  const outsideTargetPaths = targetPaths.size === 0
    ? []
    : [...new Set(groundedPaths.filter((path) => !targetPaths.has(normalize(path))))];

  return {
    label: '불변식 경로',
    marker: true,
    // ⭐ 「경로를 댔나」는 실재 ⊕ «이 골이 만들» 것을 «둘 다» 센다(🅕 제보 — green-field 골은 실재로 못 센다).
    extracted: invariantLines.length === 0 || groundedPaths.length > 0 || plannedPaths.length > 0,
    inspectionRoot,
    invariantLines,
    ungroundedLines,
    plannedPaths,
    outsideTargetPaths,
  };
}

/** 기존 서명 래퍼가 검사하는 저장소 뿌리. 호출자는 실제 폴백 판정 위치를 드러낼 때만 쓴다. */
export const ASK_MARKER_REPOSITORY_ROOT = resolve(import.meta.dir, '..');
const REPOSITORY_ROOT = ASK_MARKER_REPOSITORY_ROOT;
const REPOSITORY_FILE_TOKEN = /(?:^|[\s`("'])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)(?=$|[\s`"'),;:.])/g;
const REPOSITORY_PATH_TOKEN = /(?:^|[\s`("'])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?)(?=$|[\s`"'),;:.])/g;
const TRAILING_PATH_PUNCTUATION = /[.,:;]+$/;
const AUTHOR_DECLARED_ABSENCE = /지금은\s*(?:0\s*건|없다)|아직\s*없다/u;
/** ⛔⭐ 「기대」 쪽도 «열거»로는 끝이 없었다 — 리뷰가 라운드를 거듭하며
 *    `0건이 아니다` · `종료 코드 0` · `2건이며 오류가 없다` · `오류 수는 0이다` ·
 *    `0 < 매치 수` · `부재가 아니라 2건이다` 를 차례로 찾아냈다.
 *    ***「부재처럼 «보이는» 조각을 찾는」 방식은 원리상 그 조각을 «뒤집는 말»을 못 센다.***
 *
 *  ✅ 그래서 관측 쪽(옵션 표)과 «같은 방향»으로 뒤집는다 — ***형태 허용 목록***:
 *     기대를 낱말로 쪼개 ⑴세는 주어·관형어 ⑵0/부재를 말하는 낱말 «하나» ⑶맺는 말
 *     ***그 셋만으로 이루어질 때만*** 부재 기대로 센다.
 *     ⛔ 모르는 낱말이 하나라도 있으면(`아니다` · `<` · `보다` · `2건이며`…) 판정을 포기한다.
 *  🔑 이 검사는 «막지 않는» 경고다 ⇒ 「놓침」과 「거짓 경고」 중 ***놓침을 고른다***. */
const COUNT_WORD = /^(?:매치|일치|결과|산출|출력|줄|라인|항목|해당|발생|검출|히트|개수|건수|수|패턴|문자열|토큰|심볼|참조|호출|사례|자리|곳|count|matches|hits|lines|occurrences)(?:들)?(?:이|가|은|는|도|를|을|의)?$/iu;
/** ⛔ 관형어를 «모양»으로 허용하던 와일드카드를 없앴다 — `[\p{L}]+(하는|된|…)` 은 «열린 집합»이라
 *    「누락된 항목이 0」처럼 ***매치가 아닌 다른 것의 부재***를 통과시켰다(리뷰 9라운드).
 *    옵션 축에서 표를 없앤 것과 «같은 이유»다: 모양으로 여는 칸은 감사해도 다시 샌다.
 *  ⇒ 이제 낱말은 «전부» 아래 닫힌 표 넷 중 하나여야 한다. 대가는 놓침이다
 *    (「일치하는 줄이 0」은 이제 판정하지 않는다 — 「매치가 0이다」로 쓰면 잡힌다). */
/** 「0」을 말하는 낱말 — 조사·맺음이 붙어도 하나로 본다 */
const ZERO_TERM = /^0\s*(?:개|건|회|줄|곳|번)?(?:이|가|은|는)?(?:다|이다|임|이어야|여야)?$/u;
/** 「없다」를 말하는 낱말 */
const ABSENCE_TERM = /^(?:없다|없음|없어야|없어진다|부재(?:가|는|이|다)?|사라진다|사라짐|사라져야)$/u;
/** 맺는 말 — 뜻을 «뒤집지 않는» 꼬리만 */
const CLOSING_WORD = /^(?:한다|함|된다|되어야|해야|이다|다|유지된다|나온다|이어야|여야)$/u;

/** ⛔ 「종료 코드 0」의 0 은 «매치 수»가 아니다 — 그 문면을 부재로 읽으면 «정상 신호»에 빨강이 난다. */
const EXIT_CODE_ZERO = /(?:종료\s*코드|exit\s*code|\brc)\s*(?:가|는|=|:)?\s*0/giu;

function expectsAbsenceCount(expectation: string): boolean {
  const tokens = expectation.replace(EXIT_CODE_ZERO, ' ').split(/\s+/u).filter(Boolean);
  let zeroTerms = 0;
  for (const token of tokens) {
    const word = token.replace(/[.,;:·]+$/u, '');
    if (word.length === 0) continue;
    if (ZERO_TERM.test(word) || ABSENCE_TERM.test(word)) {
      zeroTerms += 1;
      continue;
    }
    if (COUNT_WORD.test(word) || CLOSING_WORD.test(word)) continue;
    return false; // ⛔ 모르는 낱말 — 판정을 포기한다
  }
  return zeroTerms === 1;
}

/** 관측 문면을 셸 낱말로 쪼갠다 — 따옴표·역슬래시를 존중한다 */
function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote) {
      // ⛔ 큰따옴표 «안»에서도 역슬래시는 다음 글자를 감싼다 — `"file\\""` 의 `\\"` 를 «닫는 따옴표»로 읽으면
      //    그 뒤의 `|| true` 가 인용 «안»으로 삼켜져 셸 합성이 안 보인다(리뷰 12라운드).
      //    ⚠️ 작은따옴표 안에서는 역슬래시가 «글자 그대로»다 — 그래서 `"` 일 때만 감싼다.
      if (quote === '"' && character === '\\' && index + 1 < command.length) token += command[++index]!;
      else if (character === quote) quote = undefined;
      else token += character;
    } else if (character === '"' || character === "'") quote = character;
    else if (/\s/u.test(character)) {
      if (token) tokens.push(token);
      token = '';
    } else if (character === '\\' && index + 1 < command.length) token += command[++index]!;
    else token += character;
  }
  if (token) tokens.push(token);
  return tokens;
}

/** ⛔⭐⭐ 「이 «명령»의 종료 코드」를 말하려면 그것이 ***한 명령***이어야 하고,
 *    그 낱말들이 ***셸을 거치며 바뀌지 않아야*** 한다.
 *    📏 리뷰가 이 자리에서 «세 번» 잡았고 셋 다 「우리가 셸 규칙을 흉내 내다 틀린 것」이었다:
 *      12라운드 `rg -c p "file\\"" || true`      큰따옴표 «안»의 역슬래시를 못 봤다
 *      13라운드 `grep -c "$(printf %s -v)" p f`  큰따옴표 «안»의 치환은 여전히 «펼쳐진다»
 *      14라운드 `grep -c * p file`               ***글로브 확장이 «옵션»을 집어넣는다***
 *                                               (`-v` 라는 파일이 있으면 `grep -c -v … ` 가 된다)
 *
 *  ✅ 그래서 낱말을 «해석»하지 않고, ***셸이 손댈 수 있는 글자를 아예 안 받는다***:
 *     ⑴ 작은따옴표 «안»은 글자 그대로다(POSIX 에서 유일하게 아무것도 안 일어난다) — 무엇이든 허용
 *     ⑵ 그 «밖»은 ***안전한 글자만*** 허용한다: 영문자·숫자·공백 ⊕ `_ . / - = , : + @ %`
 *     ⛔ 그 밖의 글자가 하나라도 있으면 판정하지 않는다
 *        (`| & ; < > $ ( ) \` " \\ * ? [ ] { } ~ ^ !` ⊕ 줄바꿈이 전부 여기 걸린다)
 *  🔑 이 꼴은 ***열거가 아니라 «여집합»***이다 — 새 메타문자가 생각나도 표를 늘릴 필요가 없다.
 *  ⛔ 대가는 놓침이다: `rg -c "a b" file` · `rg -c ^export file` · `rg --glob=*.ts -c p f` 는
 *     판정하지 않는다(각각 `'a b'` · `'^export'` 처럼 작은따옴표로 쓰면 잡힌다).
 *     이 저장소의 규율(`#18799`)도 「반드시 인용하라」에서 «작은따옴표»를 쓴다. */
const SHELL_SAFE_OUTSIDE_QUOTES = /[A-Za-z0-9_.\/\-=,:+@% \t]/u;

function hasShellComposition(command: string): boolean {
  let inSingleQuote = false;
  for (const character of command) {
    if (inSingleQuote) {
      if (character === "'") inSingleQuote = false;
      continue; // 작은따옴표 «안»은 셸이 아무것도 하지 않는다
    }
    if (character === "'") { inSingleQuote = true; continue; }
    if (!SHELL_SAFE_OUTSIDE_QUOTES.test(character)) return true;
  }
  return inSingleQuote; // 짝이 안 맞는 따옴표도 판정하지 않는다
}

/** ⛔⭐⭐⭐ ***이 검사가 말하는 문장은 하나다*** — 「이 관측은 매치가 없으면 종료 코드 1이 된다」.
 *    그 문장을 지키려면 «명령의 모든 낱말»에 대해 답을 가지고 있어야 하는데,
 *    리뷰가 «여덟 라운드»에 걸쳐 그 답이 없는 자리를 차례로 찾아냈다:
 *      `-ie` · `--iglob` · `grep -Ec`        ⇒ 「인자를 먹나」를 몰랐다
 *      `-v` · `--files-without-match`         ⇒ 「부재를 성공으로 만드나」를 몰랐다
 *      `grep --color`                         ⇒ 「인자가 선택인가」를 몰랐다
 *      `grep --glob=*.ts`                     ⇒ 「그 프로그램의 «유효한» 옵션인가」를 몰랐다
 *      `rg -c p f || true`                    ⇒ 「한 명령인가」를 몰랐다
 *    ⇒ 표를 뒤집고(denylist→allowlist), 표를 없애고(`--이름=값`만 허용해 봤고), 그래도 «새 질문»이 열렸다.
 *      ⇒ 지금은 ***`-c` 말고 다른 옵션은 «무엇이든» 거절***한다 — `--이름=값` 꼴도 포함이다.
 *
 *  ✅ 그래서 ***질문이 생길 자리를 남기지 않는다***:
 *     ⑴ 인용 밖 셸 메타문자가 있으면 판정하지 않는다(= 한 명령이 아니다)
 *     ⑵ `rg`/`grep` 이 아니면 판정하지 않는다
 *     ⑶ ***`-c`/`--count` «말고 다른 옵션이 하나라도 있으면» 판정하지 않는다***
 *     ⑷ `-c` 가 정확히 하나이고 «패턴 ⊕ 경로»가 있어야 한다
 *  🔑 ⑶ 이 그동안의 모든 질문(인자 수 · 뒤집기 · 선택 인자 · 유효성)을 «한꺼번에» 없앤다 —
 *     옵션을 «읽지 않으므로» 옵션에 대해 알 필요가 없다.
 *  ⛔ 대가는 «놓침»이다: `rg --glob=*.ts -c p f` · `rg -uu -c p f` 는 판정하지 않는다.
 *     이 검사는 «막지 않는» 경고이므로 ***「놓침」과 「거짓 경고」 중 놓침을 고른다***. */
function isCountCommand(observation: string): boolean {
  if (hasShellComposition(observation)) return false;
  const [program, ...arguments_] = shellTokens(observation);
  if (program !== 'rg' && program !== 'grep') return false;

  let countFlags = 0;
  let operands = 0;
  for (const argument of arguments_) {
    if (!argument.startsWith('-') || argument === '-') {
      operands += 1;
      continue;
    }
    if (argument === '-c' || argument === '--count') {
      countFlags += 1;
      continue;
    }
    return false; // ⛔ 다른 옵션은 «무엇이든» 판정 포기 — 그래야 옵션에 대해 알 필요가 없다
  }

  return countFlags === 1 && operands >= 2;
}

type DecisionSignalField = '조건' | '관측' | '기대';

function isQuotedAt(text: string, index: number): boolean {
  let quote: '"' | "'" | undefined;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const character = text[cursor]!;
    if (quote === "'") {
      if (character === quote) quote = undefined;
    } else if (character === '\\') {
      cursor += 1;
    } else if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    }
  }
  return quote !== undefined;
}

function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** ⛔⭐ `bun test <파일> -t '<이름>'` 은 ***이름이 하나도 안 맞아도 `rc=0`*** 이다.
 *    📏 실측(2026-09-17 · bun 1.3.12):
 *      이름이 주석·문자열에만 있다   regex "…" matched 0 tests   rc=0
 *      이름이 test.skip 이다        1 skip · Ran 1 test        rc=0
 *      이름이 실재한다              1 pass · Ran 1 test        rc=0
 *    ⇒ 셋 다 rc=0 이라, 판정이 종료 코드로 내려지는 한 «빈 신호»를 원리상 못 가른다.
 *
 *  ✅ 그래서 이 검사는 ***세지 않는다 — 모양만 보고 말한다.***
 *    ⛔ 「그 이름이 그 파일에 있나」를 세려면 Bun 의 시험 이름 의미를 재현해야 하고
 *       (주석·문자열 제외 · `describe`+`it` 합성 · `test.each` 매개변수 이름 · `test.only`),
 *       그래도 `skip` 은 못 가른다 — 저작 시점 검사는 시험을 «돌릴 수 없다».
 *       실제로 그 길로 간 판이 리뷰에서 막혔다(`#18843` · `#18855`).
 *    🔑 판정하지 않고 ***판정할 수 없다는 사실 자체를 말하면*** 틀릴 수가 없다. */
/** ⚠️ 짧은 옵션은 «붙여» 쓸 수 있다 — `-tname` 도 `-t name` 과 같다(리뷰 지적).
 *    ⛔ 그래서 `-t` 는 «접두»로 본다. 한 글자 옵션을 붙여 쓰면 그 뒤는 전부 값이므로,
 *       `-timeout` 같은 것도 bun 에겐 `-t imeout` 이라 «좁힘»이 맞다 — 넓게 잡는 쪽이 옳다. */
function narrowsBunTestByName(observation: string): boolean {
  const tokens = shellTokens(observation);
  if (tokens[0] !== 'bun' || tokens[1] !== 'test') return false;
  return tokens.slice(2).some((token) =>
    token.startsWith('-t') && !token.startsWith('--')
    || token === '--test-name-pattern'
    || token.startsWith('--test-name-pattern='));
}

/** 좁힌 시험 신호를 «알아보고 말만» 한다 — 막지 않는다. */
export function inspectNarrowedTestSignalWarnings(ask: string): string[] {
  let ordinal = 0;
  return ask.split(/\r?\n/).map((line) => line.trim())
    .flatMap((signal) => {
      if (!/^판정 신호\s*[:：]/u.test(signal)) return [];
      ordinal += 1;
      const observation = extractDecisionSignalField(signal, '관측');
      if (!observation || !narrowsBunTestByName(observation)) return [];
      return [`⚠️ 좁힌 시험 신호 — ${ordinal}번째 신호는 이름이 하나도 안 맞아도 종료 코드가 0이다; 발사 전에 그 명령을 한 번 돌려 N pass의 N ≥ 1을 확인하라.`];
    });
}

/** `rg -c`/`grep -c`는 매치가 없으면 exit 1이므로 부재 기대 신호는 원하는 결과에서도 빨강이 된다. */
export function inspectAbsenceCountSignalWarnings(ask: string): string[] {
  let ordinal = 0;
  return ask.split(/\r?\n/).map((line) => line.trim())
    .flatMap((signal) => {
      if (!/^판정 신호\s*[:：]/u.test(signal)) return [];
      ordinal += 1;
      const observation = extractDecisionSignalField(signal, '관측');
      const expectation = extractDecisionSignalField(signal, '기대');
      if (!observation || !expectation || !isCountCommand(observation) || !expectsAbsenceCount(expectation)) return [];
      return [`⚠️ 부재 count 신호 — ${ordinal}번째 신호는 원하는 결과에서 종료 코드 1이 되어 빨강이 된다; 부재는 bun test로 단언하라(래칫).`];
    });
}

const TEXT_COUNTING_COMMANDS = new Set(['rg', 'grep', 'wc', 'cat', 'sed', 'head', 'tail']);
const EXECUTION_PROMISE = /돈다|실행|완주|동작/u;

function observationFirstWord(observation: string): string {
  return observation.trim().replace(/^`+|`+$/g, '').trim().split(/\s+/u, 1)[0] ?? '';
}

/** ⛔⭐ 「실행 «경로»에 있나」는 «정적» 질문이라 `rg -c` 가 «옳은 자»다 — 여기서 빼야 한다.
 *  📏 전수(2026-09-22 · docs/goals ASK⊕GOAL): 「조건에 실행류 낱말 ⊕ 관측이 문면 세기」 28건 중
 *    ***24건이 「실행 경로/실행 축」*** 이었다. 그 24건에 경고를 뿌리면 이 축은 ***소음***이 된다.
 *    진짜 양성은 ***4건***(「실물에서 돈다」 ×2 · 「소스에서 …를 찾는다」 ×2). */
const STATIC_WIRING_CONDITION = /실행[\s«»「」'"*`]*?(경로|축)/u;

function conditionPromisesLiveExecution(condition: string): boolean {
  // ⛔⭐ 「실행 «경로/축»」만 말하는 조건은 «정적»이라 문면 세기가 옳다.
  //   다만 그 조건이 «돈다·완주·동작»까지 말하면 그때는 «실행»을 약속한 것이므로 경고한다.
  //   📏 실측: 실재하는 28건은 ***전부 경로 낱말만***이고 「실행 경로에서 돈다」는 ***0건***이다.
  if (STATIC_WIRING_CONDITION.test(condition) && !/돈다|완주|동작/u.test(condition)) return false;
  return EXECUTION_PROMISE.test(condition);
}

/** 조건이 실행을 약속하는데 관측이 문면 세기면 «알아보고 말만» 한다 — 막지 않는다. */
export function inspectConditionObservationPairWarnings(ask: string): string[] {
  let ordinal = 0;
  return ask.split(/\r?\n/).map((line) => line.trim())
    .flatMap((signal) => {
      if (!/^판정 신호\s*[:：]/u.test(signal)) return [];
      ordinal += 1;
      const condition = extractDecisionSignalField(signal, '조건');
      const observation = extractDecisionSignalField(signal, '관측');
      if (!condition || !observation) return [];
      if (!conditionPromisesLiveExecution(condition)) return [];
      if (!TEXT_COUNTING_COMMANDS.has(observationFirstWord(observation))) return [];
      return [`⚠️ 조건↔관측 짝 — ${ordinal}번째 신호: 조건이 「돈다」인데 관측이 «문면 세기»다`];
    });
}

/** `--test nexus run` 의 기본 바인드는 loopback 이라 운영 포트를 가린다 — 막지 않고 말한다. */
export function inspectUnportedIsolatedDaemonWarnings(ask: string): string[] {
  let ordinal = 0;
  return ask.split(/\r?\n/).map((line) => line.trim())
    .flatMap((signal) => {
      if (!/^판정 신호\s*[:：]/u.test(signal)) return [];
      ordinal += 1;
      const observation = extractDecisionSignalField(signal, '관측');
      const condition = extractDecisionSignalField(signal, '조건');
      const fields = [observation, condition].filter((field): field is string => field !== undefined);
      if (!fields.some(launchesUnportedIsolatedNexus)) return [];
      return [`⚠️ 무포트 격리 데몬 — ${ordinal}번째 신호는 bun bin/elanous.mjs --test nexus run 을 포트 없이 띄워 운영 포트를 가린다; --http-port 로 포트를 명시하라.`];
    });
}

function launchesUnportedIsolatedNexus(observation: string): boolean {
  const tokens = shellTokens(observation);
  return commandCandidates(tokens).some((command) =>
    isIsolatedNexusRun(command) && !specifiesHttpPort(command));
}

/** 셸 경계로 나눈 명령에 더해, 한국어 산문 토큰 뒤에 나오는 `bun`/`elanous` 시작점도 후보로 본다. */
function commandCandidates(tokens: readonly string[]): readonly (readonly string[])[] {
  const commands = splitShellCommands(tokens);
  const candidates: (readonly string[])[] = [];
  for (const command of commands) {
    candidates.push(command);
    for (let index = 1; index < command.length; index += 1) {
      if (!isCommandExecutableToken(command[index]!)) continue;
      if (!command.slice(0, index).some(hasHangul)) continue;
      candidates.push(command.slice(index));
    }
  }
  return candidates;
}

function isCommandExecutableToken(token: string): boolean {
  const name = programBasename(token);
  return name === 'bun' || name === 'elanous';
}

function hasHangul(token: string): boolean {
  return /\p{Script=Hangul}/u.test(token);
}

function splitShellCommands(tokens: readonly string[]): readonly (readonly string[])[] {
  const commands: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (SHELL_COMMAND_BOUNDARIES.has(token)) {
      if (current.length > 0) commands.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

function isIsolatedNexusRun(tokens: readonly string[]): boolean {
  const parsed = parseElanousInvocation(tokens);
  return parsed !== undefined && parsed.isolated && parsed.subcommand[0] === 'nexus' && parsed.subcommand[1] === 'run';
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const ENV_OPTIONS_WITH_VALUE = new Set([
  '-u', '--unset',
  '-C', '--chdir',
  '-P',
  '--block-signal',
  '--default-signal',
  '--ignore-signal',
]);
const ENV_SPLIT_STRING_LONG = '--split-string';
const ELANOUS_OPTIONS_WITH_VALUE = new Set([
  '--tool-cwd',
  '--http-port',
  '--http-host',
  '--port',
  '--tools',
  '--history-dir',
  '--config-dir',
  '--test-state-dir',
]);

function skipEnvAssignments(tokens: readonly string[], start: number): number {
  let index = start;
  while (index < tokens.length && ENV_ASSIGNMENT.test(tokens[index]!)) index += 1;
  return index;
}

function programBasename(token: string): string {
  const slash = token.lastIndexOf('/');
  return slash === -1 ? token : token.slice(slash + 1);
}

/** 현재 저장소의 `bin/elanous.mjs`만 CLI로 인정한다. 절대 경로도 같은 파일이면 허용한다. */
function isElanousCliScript(token: string): boolean {
  if (token.startsWith('/')) return normalize(token) === resolve(import.meta.dir, '..', 'bin', 'elanous.mjs');
  const parts = token.split('/').filter((part) => part !== '' && part !== '.');
  return parts.length === 2 && parts[0] === 'bin' && parts[1] === 'elanous.mjs';
}

/** `-S`/`--split-string` 값은 버릴 옵션이 아니라 다시 해석해 실행하는 명령이다. */
function envSplitString(token: string, next: string | undefined): { value: string; consumed: number } | undefined {
  if (token === '-S' || token === ENV_SPLIT_STRING_LONG) {
    return next === undefined ? undefined : { value: next, consumed: 2 };
  }
  if (token.startsWith(`${ENV_SPLIT_STRING_LONG}=`)) {
    return { value: token.slice(ENV_SPLIT_STRING_LONG.length + 1), consumed: 1 };
  }
  if (token.startsWith('-S') && token.length > 2 && !token.startsWith('--')) {
    return { value: token.slice(2), consumed: 1 };
  }
  return undefined;
}

/** `env` 한 겹의 옵션·NAME=VALUE 를 걷고, `-S` 값은 명령 토큰으로 펼친다. */
function unwrapEnvUtility(tokens: readonly string[], envIndex: number): readonly string[] | undefined {
  let index = envIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (ENV_ASSIGNMENT.test(token) || token === '-') {
      index += 1;
      continue;
    }
    if (!token.startsWith('-')) break;
    if (token === '--') {
      index += 1;
      break;
    }
    const split = envSplitString(token, tokens[index + 1]);
    if (split) {
      const expanded = [...shellTokens(split.value), ...tokens.slice(index + split.consumed)];
      return unwrapEnvUtility(expanded, -1);
    }
    if (token.includes('=')) {
      index += 1;
      continue;
    }
    index += 1;
    if (ENV_OPTIONS_WITH_VALUE.has(token) && index < tokens.length) index += 1;
  }
  const rest = skipEnvAssignments(tokens, index);
  return rest === envIndex ? undefined : tokens.slice(rest);
}

/** 실행 위치 = argv0. `FOO=1 bun …` 의 대입과 `env` 래퍼는 프로그램이 아니다. 인자 속의 `bun` 은 기동이 아니다. */
function unwrapEnvWrappers(tokens: readonly string[]): readonly string[] {
  let current = tokens;
  for (;;) {
    const start = skipEnvAssignments(current, 0);
    if (programBasename(current[start] ?? '') !== 'env') return current.slice(start);
    const unwrapped = unwrapEnvUtility(current, start);
    if (unwrapped === undefined) return current.slice(start);
    current = unwrapped;
  }
}

type ElanousInvocation = {
  readonly isolated: boolean;
  readonly specifiesHttpPort: boolean;
  readonly subcommand: readonly string[];
};

/** `--http-port`/`--port` 는 비어 있지 않은 값이 있을 때만 명시다. 다음 옵션은 값이 아니다. */
function httpPortOptionValue(token: string, next: string | undefined): { value: string | undefined; consumed: number } | undefined {
  const takeSeparate = (flag: '--http-port' | '--port'): { value: string | undefined; consumed: number } | undefined => {
    if (token !== flag) return undefined;
    if (next === undefined || next.trim() === '' || next.startsWith('-')) return { value: undefined, consumed: 1 };
    return { value: next, consumed: 2 };
  };
  const takeEquals = (flag: '--http-port' | '--port'): { value: string | undefined; consumed: number } | undefined => {
    const prefix = `${flag}=`;
    if (!token.startsWith(prefix)) return undefined;
    const value = token.slice(prefix.length);
    return { value: value.trim() === '' ? undefined : value, consumed: 1 };
  };
  return takeSeparate('--http-port') ?? takeSeparate('--port') ?? takeEquals('--http-port') ?? takeEquals('--port');
}

/** `elanous` 또는 `bun [run] bin/elanous.mjs` 의 옵션 값을 소비한 뒤 남은 자리만 서브커맨드로 본다. */
function parseElanousInvocation(tokens: readonly string[]): ElanousInvocation | undefined {
  const command = unwrapEnvWrappers(tokens);
  const executable = programBasename(command[0] ?? '');
  const argumentIndex = executable === 'elanous'
    ? 1
    : executable === 'bun'
      ? (command[1] === 'run' ? 3 : 2)
      : undefined;
  if (argumentIndex === undefined) return undefined;
  if (executable === 'bun' && !isElanousCliScript(command[argumentIndex - 1] ?? '')) return undefined;
  let isolated = false;
  let specifiesHttpPort = false;
  const subcommand: string[] = [];
  for (let index = argumentIndex; index < command.length; index += 1) {
    const token = command[index]!;
    if (token === '--') {
      subcommand.push(...command.slice(index + 1));
      break;
    }
    if (token === '--test' || token.startsWith('--test=')) {
      isolated = true;
      continue;
    }
    const port = httpPortOptionValue(token, command[index + 1]);
    if (port) {
      if (port.value !== undefined) specifiesHttpPort = true;
      index += port.consumed - 1;
      continue;
    }
    if (token.startsWith('--') && token.includes('=')) continue;
    if (token.startsWith('-')) {
      if (ELANOUS_OPTIONS_WITH_VALUE.has(token) && index + 1 < command.length) index += 1;
      continue;
    }
    subcommand.push(token);
  }
  return { isolated, specifiesHttpPort, subcommand };
}

function specifiesHttpPort(tokens: readonly string[]): boolean {
  return parseElanousInvocation(tokens)?.specifiesHttpPort === true;
}

function extractDecisionSignalField(line: string, field: DecisionSignalField): string | undefined {
  const marker = /^판정 신호\s*[:：]\s*/u.exec(line);
  if (!marker) return undefined;
  const fields = new Map<DecisionSignalField, string>();
  const fieldPattern = /(?:^|;)\s*(조건|관측|기대)\s*=\s*/gu;
  const body = line.slice(marker[0].length);
  const matches = [...body.matchAll(fieldPattern)]
    .filter((match) => match.index !== undefined && !isQuotedAt(body, match.index) && !isEscapedAt(body, match.index + match[0].indexOf(';')));
  for (const [index, match] of matches.entries()) {
    const name = match[1] as DecisionSignalField;
    const valueStart = match.index! + match[0].length;
    const valueEnd = matches[index + 1]?.index ?? line.slice(marker[0].length).length;
    fields.set(name, line.slice(marker[0].length).slice(valueStart, valueEnd).trim());
  }
  return fields.get(field);
}

/** 검사 루트를 «명시»해 새 값 소비자 경로 경고를 낸다. */
export function inspectConsumerPathWarningInRoot(ask: string, inspectionRoot: string): string | undefined {
  const signals = ask.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^판정 신호\s*[:：]/.test(line));
  const declaresAbsence = signals.some((line) => AUTHOR_DECLARED_ABSENCE.test(extractDecisionSignalField(line, '기대') ?? ''));
  if (!declaresAbsence) return undefined;

  const boundaryPaths = new Set(
    ask.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^경계\s*[:：]/.test(line))
      .flatMap((line) => extractExistingRepositoryPaths(line, inspectionRoot)),
  );
  if (boundaryPaths.size === 0) return undefined;

  const observedPaths = signals.flatMap((line) => {
    const observation = extractDecisionSignalField(line, '관측');
    return observation ? extractExistingRepositoryPaths(observation, inspectionRoot) : [];
  });
  const unobserved = [...boundaryPaths].filter((boundaryPath) =>
    !observedPaths.some((observationPath) => pathsOverlap(boundaryPath, observationPath, inspectionRoot)));
  return unobserved.length > 0
    ? `⚠️ 어디까지 사나 — ${unobserved.join(', ')}: 판정 신호가 이 경계를 관측하지 않아 한 단계까지만 산다`
    : undefined;
}

/** 기존 호출자는 저장소 뿌리 판정을 계속 쓴다. */
export function inspectConsumerPathWarning(ask: string): string | undefined {
  return inspectConsumerPathWarningInRoot(ask, REPOSITORY_ROOT);
}

function extractExistingRepositoryPaths(text: string, inspectionRoot: string): string[] {
  const paths = new Set<string>();
  for (const candidate of text.matchAll(REPOSITORY_PATH_TOKEN)) {
    const rawPath = candidate[1]!;
    const path = rawPath === '.' || rawPath === './' ? rawPath : rawPath.replace(TRAILING_PATH_PUNCTUATION, '');
    if (path === '' || !isInsideInspectionRoot(resolve(inspectionRoot, path), inspectionRoot)) continue;
    try {
      lstatSync(resolve(inspectionRoot, path));
      paths.add(path);
    } catch {
      // 실재하지 않는 경계에는 아직 소비자가 있을 수 없다.
    }
  }
  return [...paths];
}

function pathsOverlap(left: string, right: string, inspectionRoot: string): boolean {
  const resolvedLeft = resolve(inspectionRoot, left);
  const resolvedRight = resolve(inspectionRoot, right);
  const leftContainsRight = relative(resolvedLeft, resolvedRight);
  const rightContainsLeft = relative(resolvedRight, resolvedLeft);
  return isSameOrDescendant(leftContainsRight) || isSameOrDescendant(rightContainsLeft);
}

function isSameOrDescendant(path: string): boolean {
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function isInsideRepository(path: string): boolean {
  const fromRoot = relative(REPOSITORY_ROOT, path);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function extractRepositoryFilePaths(line: string, inspectionRoot: string): string[] {
  const paths = new Set<string>();
  for (const candidate of line.matchAll(REPOSITORY_FILE_TOKEN)) {
    const path = candidate[1]!.replace(TRAILING_PATH_PUNCTUATION, '');
    if (path === '') continue;
    const resolvedPath = resolve(inspectionRoot, path);
    if (!isInsideInspectionRoot(resolvedPath, inspectionRoot)) continue;
    try {
      if (lstatSync(resolvedPath).isFile()) paths.add(path);
    } catch {
      // 존재하지 않는 경로와 디렉터리는 불변식 접지로 세지 않는다.
    }
  }
  return [...paths];
}

/** 존재 검사 «없이» 저장소 안을 가리키는 경로 토큰만 뽑는다.
 *  ⛔ `extractRepositoryFilePaths` 와 갈라 둔 이유: ***새 파일을 만드는 골***은 그 파일이 아직 «없어서»
 *  실재 검사로는 원리상 접지될 수 없다(🅕 제보 2026-09-07). 「경로를 댔나」와 「그 파일이 지금 있나」는
 *  다른 값이므로 다른 함수로 답한다. */
function existsAsFile(path: string): boolean {
  try { return lstatSync(resolve(REPOSITORY_ROOT, path)).isFile(); } catch { return false; }
}

function extractDeclaredPathTokens(line: string): string[] {
  const paths = new Set<string>();
  for (const candidate of line.matchAll(REPOSITORY_FILE_TOKEN)) {
    const path = candidate[1]!.replace(TRAILING_PATH_PUNCTUATION, '');
    if (path === '' || !path.includes('/')) continue;
    if (!isInsideRepository(resolve(REPOSITORY_ROOT, path))) continue;
    paths.add(path);
  }
  return [...paths];
}

function formatInvariantPathSummary(pathAxis: InvariantPathAxis): string {
  return `✅ 불변식 경로 — ${pathAxis.invariantLines.length - pathAxis.ungroundedLines.length}/${pathAxis.invariantLines.length}개 불변식 줄이 저장소 파일 경로를 댄다`;
}

/** 「없다」와 「있는데 못 읽었다」를 다른 값으로 낸다 — 처방이 다르기 때문이다. */
export function formatAxis(a: Axis): string {
  if (a.label === 'GoalType 머리 블록') {
    if (a.marker) return '✅ GoalType 머리 블록';
    const goalTypeAxis = a as GoalTypeMetadataAxis;
    if (goalTypeAxis.invalidValue !== undefined) {
      return `❌ GoalType 머리 블록 — \`${goalTypeAxis.invalidValue}\`는 알 수 없는 GoalType이다; 유효값: ${GOAL_TYPES.join(', ')}; 선언을 빼는 편이 낫다 — 생략하면 정식 기본값 \`implement\`를 쓴다`;
    }
    return '❌ GoalType 머리 블록 — ask에는 `- GoalType:` 선언이 있지만 저작기의 머리 블록 밖에 있다';
  }
  if (a.label === '판정 신호 시험 경로') {
    const testPathAxis = a as DecisionTestPathAxis;
    if (testPathAxis.unreadableRoot !== undefined) {
      return `ℹ️ 판정 신호 시험 경로 — «${shortInspectionRoot(testPathAxis.inspectionRoot)}»를 못 훑었다(${testPathAxis.unreadableRoot}) — 안 쟀다(«0개»가 아니다)`;
    }
    if (testPathAxis.observations.length === 0) return 'ℹ️ 판정 신호 시험 경로 — bun test 경로가 없다';
    const matched = testPathAxis.observations.filter(({ matches }) => matches > 0).length;
    const unmatched = testPathAxis.observations.length - matched;
    const fileMatches = testPathAxis.observations.reduce((total, { matches }) => total + matches, 0);
    if (unmatched > 0) {
      return `⚠️ 판정 신호 시험 경로 — ${unmatched}개 경로가 «${shortInspectionRoot(testPathAxis.inspectionRoot)}»의 파일을 못 문다 (${matched}/${testPathAxis.observations.length}개 경로가 파일 ${fileMatches}개를 문다)`;
    }
    return `✅ 판정 신호 시험 경로 — ${matched}/${testPathAxis.observations.length}개 경로가 «${shortInspectionRoot(testPathAxis.inspectionRoot)}»의 파일 ${fileMatches}개를 문다`;
  }
  if (a.label === '안 눌릴 신호') {
    const unpressed = a as UnpressedDecisionSignalAxis;
    if (unpressed.total === 0) return 'ℹ️ 안 눌릴 신호 — 판정 신호가 없어 수를 낼 수 없다';
    const summary = `안 눌릴 신호 ${unpressed.unreadable.length}개 / 전체 ${unpressed.total}개`;
    if (unpressed.uninspectable.length > 0) {
      return `⚠️ 안 눌릴 신호 — ${summary}; 미계산 ${unpressed.uninspectable.length}개`;
    }
    return `${unpressed.unreadable.length === 0 ? '✅' : '⚠️'} 안 눌릴 신호 — ${summary}`;
  }
  if (a.label === '판정 신호 관측') {
    const observationAxis = a as DecisionObservationAxis;
    if (observationAxis.signalCount === 0) return 'ℹ️ 판정 신호 관측 — 판정 신호가 없다 (기존 판정 신호 축이 담당)';
    if (observationAxis.unresolvedObservationCount > 0) {
      return `⚠️ 판정 신호 관측 — 판정 신호 ${observationAxis.signalCount}개: 단위 시험 실행 ${observationAxis.unitTestObservationCount}개, 실물 관측 ${observationAxis.realObservationCount}개, 미결 관측 ${observationAxis.unresolvedObservationCount}개: ${observationAxis.unresolvedObservationNames.join(', ')}`;
    }
    return `ℹ️ 판정 신호 관측 — 판정 신호 ${observationAxis.signalCount}개: 단위 시험 실행 ${observationAxis.unitTestObservationCount}개, 실물 관측 ${observationAxis.realObservationCount}개`;
  }
  if (a.label === '판정 신호 종류') {
    const kind = a as DecisionSignalKindAxis;
    if (kind.total === 0) return 'ℹ️ 판정 신호 종류 — 판정 신호가 없다 (위 마커 판정이 담당)';
    const unresolved = kind.total - kind.unitTestOnly - kind.realWorld;
    if (kind.realWorld === 0) {
      const summary = unresolved === 0
        ? `${kind.total}개가 «전부» 단위 시험이다`
        : `${kind.total}개 중 단위 시험 ${kind.unitTestOnly} · 미결 ${unresolved}`;
      return `⚠️ 판정 신호 종류 — ${summary} (실물 관측 0)`
        + ' — 값이 «실행 경로»로 흘렀다는 것을 무엇이 증명하나'
        + `\n${VERDICT_FOLLOWUP_INDENT}↳ ⛔ 실물을 무는 «기존» 시험 파일로 옮기기 전에 그 파일이 결정적인지 본다 — 빨강 조합이 흔들리는 파일로 옮기면 착지가 막힌다. ✅ 결정적이면서 실물을 무는 시험을 «만든다»`;
    }
    return `✅ 판정 신호 종류 — ${kind.total}개 중 단위 시험 ${kind.unitTestOnly} · 실물 ${kind.realWorld}`;
  }
  if (a.label === '불변식 경로') {
    const pathAxis = a as InvariantPathAxis;
    if (pathAxis.invariantLines.length === 0) return '✅ 불변식 경로 — 불변식 줄이 없다 (기존 불변식 마커 판정이 담당)';
    if (!a.extracted) return `❌ 불변식 경로 — ${pathAxis.invariantLines.length}개 불변식 줄이 «실재하지도, 대상 경로로 선언되지도» 않은 경로만 댄다 («${shortInspectionRoot(pathAxis.inspectionRoot)}»)`;
    if (pathAxis.plannedPaths.length > 0) {
      return `⚠️ 불변식 경로 — 그중 «이 골이 만들» 경로: ${pathAxis.plannedPaths.join(', ')}; 같은 이름의 기존 모듈이 있는지 확인하라 — 자식이 새로 만들면 그 모듈이 비워질 수 있다`;
    }
    return formatInvariantPathSummary(pathAxis);
  }
  if (!a.marker) return `❌ ${a.label} — 마커가 «없다» (제목형 "## ${a.label}" 은 마커가 아니다 ⇒ "${a.label}: <문장>" 줄로 쓴다)`;
  if (!a.extracted) {
    const guidance = a.label === '판정 신호' ? ` — 맞는 형식: ${DECISION_SIGNAL_MARKER_GUIDANCE.correctedExample}` : '';
    return `⚠️ ${a.label} — 마커는 있는데 «형식이 안 맞아» 못 읽었다${guidance}`;
  }
  return `✅ ${a.label}`;
}

export function formatAxisObservations(a: Axis): readonly string[] {
  if (a.label === '안 눌릴 신호') {
    const unpressed = a as UnpressedDecisionSignalAxis;
    return [
      ...unpressed.unreadable.flatMap(({ ordinal, command, rejectionReason }) => [
        `⚠️ 안 눌릴 신호 — ${ordinal}번째 신호는 안전하게 읽을 수 없다: ${command}`,
        formatUnpressedDecisionSignalRemedy(ordinal, command, rejectionReason),
      ]),
      ...unpressed.uninspectable.map(({ ordinal, signal }) => `⚠️ 안 눌릴 신호 — ${ordinal}번째 신호는 관측 명령이 없어 미계산이다: ${signal}`),
    ];
  }
  if (a.label === '판정 신호 시험 경로') {
    const testPathAxis = a as DecisionTestPathAxis;
    return testPathAxis.observations.flatMap(({ path, matches, alternatePaths }) => {
      if (matches > 0) return [`ℹ️ 판정 신호 시험 경로 — «${shortInspectionRoot(testPathAxis.inspectionRoot)}»에서 ${path}: ${matches}개 파일 매치`];
      if (alternatePaths.length > 0) return [`⚠️ 판정 신호 시험 경로 — «${shortInspectionRoot(testPathAxis.inspectionRoot)}»에서 0개 매치: ${path}; 같은 파일 이름의 실제 경로: ${alternatePaths.join(', ')}`];
      return [`ℹ️ 판정 신호 시험 경로 — «${shortInspectionRoot(testPathAxis.inspectionRoot)}»에서 0개 매치: ${path}; 이 골이 만들 파일로 읽는다`];
    });
  }
  if (a.label !== '불변식 경로') return [];
  const pathAxis = a as InvariantPathAxis;
  return [
    ...(pathAxis.plannedPaths.length > 0 ? [formatInvariantPathSummary(pathAxis)] : []),
    ...pathAxis.ungroundedLines.map((line) => `⚠️ 불변식 경로 — 실재하지도 대상 경로로 선언되지도 않은 줄 («${shortInspectionRoot(pathAxis.inspectionRoot)}»): ${line}`),
    ...pathAxis.outsideTargetPaths.map((path) => `ℹ️ 불변식 경로 — 대상 경로 밖의 실재 파일 («${shortInspectionRoot(pathAxis.inspectionRoot)}»): ${path}`),
  ];
}

/** CLI 본체. ⭐ 시험 심으로 export 한다(GATE-SPEED ③ · 2026-10-08) — 시험이 같은 출력 계약을
 *  프로세스 하나 안에서 잴 수 있게. 실물 진입점(`import.meta.main`)은 아래 한 줄 그대로다. */
export function main(files: string[]): number {
  if (files.length === 0) {
    console.error('쓰는 법: bun scripts/ask-marker-check.ts <ask 파일…>');
    return 2;
  }
  let bad = 0;
  let unreadable = 0;
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch (error) {
      unreadable += 1;
      console.error(`⛔ ${file} — 읽지 못했다: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const axes = inspectAskMarkers(source);
    const unpressedDecisionSignals = inspectUnpressedDecisionSignals(source);
    const absenceCountSignalWarnings = inspectAbsenceCountSignalWarnings(source);
    const narrowedTestSignalWarnings = inspectNarrowedTestSignalWarnings(source);
    const unportedIsolatedDaemonWarnings = inspectUnportedIsolatedDaemonWarnings(source);
    const conditionObservationPairWarnings = inspectConditionObservationPairWarnings(source);
    const wrappedMarkerWarnings = inspectWrappedMarkerWarnings(source);
    const consumerPathWarning = inspectConsumerPathWarning(source);
    const ok = axes.every((a) => a.marker && a.extracted);
    if (!ok) bad += 1;
    console.log(`${ok ? '✅' : '⛔'} ${file}`);
    for (const a of axes) {
      console.log(`   ${formatAxis(a)}`);
      for (const observation of formatAxisObservations(a)) console.log(`   ${observation}`);
    }
    console.log(`   ${formatAxis(unpressedDecisionSignals)}`);
    for (const warning of formatAxisObservations(unpressedDecisionSignals)) console.log(`   ${warning}`);
    for (const warning of absenceCountSignalWarnings) console.log(`   ${warning}`);
    for (const warning of narrowedTestSignalWarnings) console.log(`   ${warning}`);
    for (const warning of unportedIsolatedDaemonWarnings) console.log(`   ${warning}`);
    for (const warning of conditionObservationPairWarnings) console.log(`   ${warning}`);
    for (const warning of wrappedMarkerWarnings) console.log(`   ${warning}`);
    if (consumerPathWarning) console.log(`   ${consumerPathWarning}`);
  }
  if (unreadable > 0) console.error(`\n⛔ ${unreadable}개 파일을 «읽지 못했다» — 경로를 확인하라.`);
  if (bad > 0) console.error(`${unreadable > 0 ? '' : '\n'}⛔ ${bad}개 파일이 마커를 온전히 갖고 있지 않다 — 발사 전에 고쳐라.`);
  if (bad + unreadable === 0) console.log(`\n✅ ${files.length}개 파일이 마커를 온전히 갖고 있다 — 발사해도 된다.`);
  return bad + unreadable > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
