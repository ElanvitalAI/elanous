// HARNESS-FAILURE-ORACLE-GEN (0.3.28 · 정본 seat-state/ELN-DOGFOOD/ASK-RIFLE-NOT-TANK-HARNESS-1117.md 칸 3)
//
// S: 같은 하니스에서 budget 모델은 문자열·UI 일은 1라운드에 끝내고, 영속·동시성 일은 3~4라운드를 돈다(ASK §근거).
// C: 약한 모델의 약점은 코드 쓰기가 아니라 «무엇이 잘못될 수 있나»를 상상하는 것 — 실패 상황 시험을 스스로 못 깐다.
// Q: 바뀔 파일이 위험 범주(영속·잠금·프로세스 간)일 때, 구현 «전»에 실패 상황 시험 틀을 어떻게 깔아 주나?
// A: #38175 의 work-risk-router 범주만 입력으로 받아(새 분류기·정규식 없음 · R-SIG) 범주 → 시나리오 표를 순수 함수로
//    펼친다. 하니스는 첫 구현 라운드의 자식 프롬프트에만 짧은 절로 싣는다(`harness.failureOracle` · 기본 shadow =
//    개수 이벤트만 · 주입 0). 생성은 동기·순수이고, 어떤 예외든 이벤트 하나 남기고 라운드는 그대로 간다.

import { classifyWorkRisk, WORK_RISK_CATEGORIES, type WorkRiskCategory } from '../model-tier/work-risk-router.js';

export type FailureScenarioId =
  | 'read-failure'
  | 'write-failure'
  | 'death-mid-write'
  | 'session-roundtrip'
  | 'restart-recover'
  | 'concurrent-append'
  | 'holder-dies';

export interface FailureSkeleton {
  readonly scenario: FailureScenarioId;
  readonly title: string;
  readonly given: string;
  readonly when: string;
  readonly then: string;
  /** 대상 파일(저장소 상대) — 경로가 없는 «선언된» 범주면 `FAILURE_ORACLE_GOAL_TARGET`. */
  readonly target: string;
  /** 이 틀을 낸 범주(경로·선언 중 처음 낸 쪽). */
  readonly category: WorkRiskCategory;
}

/** 시나리오 하나 = 한 꼴. 문면은 시나리오에만 묶인다(범주와 무관) — 두 범주가 같은 시나리오를 내도 중복 없이 하나. */
export const FAILURE_SCENARIOS: Readonly<Record<FailureScenarioId, Omit<FailureSkeleton, 'scenario' | 'target' | 'category'>>> = {
  'read-failure': { title: '읽기 실패',
    given: '대상이 읽는 파일·행이 없거나 깨졌거나 권한이 없다', when: '읽기 경로를 부른다',
    then: '빈 값으로 조용히 넘어가지 않고 이유가 담긴 실패(이벤트·오류)를 낸다' },
  'write-failure': { title: '쓰기 실패',
    given: '디스크·권한 오류로 쓰기가 던진다', when: '쓰기 경로를 부른다',
    then: '호출자가 실패를 알고, 이전에 커밋된 내용은 그대로 남는다' },
  'death-mid-write': { title: '죽음',
    given: '임시 파일 쓰기와 rename(커밋) 사이에서 프로세스가 죽는다', when: '다음 프로세스가 같은 대상을 읽는다',
    then: '반쯤 쓴 내용이 아니라 마지막 커밋본을 읽고, 남은 임시 파일을 치운다' },
  'session-roundtrip': { title: '세션 왕복',
    given: '모든 칸이 채워진 레코드를 저장한다', when: '새 인스턴스로 다시 읽는다',
    then: '모든 칸이 같다(빠진 칸·바뀐 형 없음)' },
  'restart-recover': { title: '재기동',
    given: '작업 도중 상태가 디스크·다른 프로세스에 남은 채 재기동한다', when: '시작 경로가 상태를 다시 읽는다',
    then: '중복 실행·유실 없이 이어 가거나, 이어 갈 수 없음을 이벤트로 남긴다' },
  'concurrent-append': { title: '동시 추가',
    given: '두 쓰기 주체(프로세스·비동기 작업)가 같은 대상에 동시에 추가한다', when: '둘 다 끝난 뒤 읽는다',
    then: '두 항목이 모두 있고 어느 것도 덮이거나 깨지지 않는다' },
  'holder-dies': { title: '잠금 보유자 죽음',
    given: '잠금을 쥔 프로세스가 풀지 못하고 죽는다', when: '다른 프로세스가 같은 잠금을 얻으려 한다',
    then: '영원히 기다리지 않고 낡은 잠금을 판정해 회수하거나, 막힘을 이벤트로 남긴다' },
};

/** 칸 서명 — 칸 HARNESS-FAILURE-ORACLE-GEN(정본 seat-state/ELN-DOGFOOD/ASK-RIFLE-NOT-TANK-HARNESS-1117.md 칸 3) 제목 «영속·잠금·프로세스 간이면 … 생성(죽음·동시 추가·세션 왕복·재기동)» 의
 *  네 꼴을 칸 문면 순서 그대로. 세 범주는 이 넷을 «모두» 맨 앞에 낸다(JUD-B 20261118-AM-REST-HOLD «서명에 없음» 절).
 *  시나리오 title 은 칸 문면과 같은 낱말이다(죽음·동시 추가·세션 왕복·재기동). */
export const FAILURE_ORACLE_CELL_SIGNATURE: readonly FailureScenarioId[] = ['death-mid-write', 'concurrent-append', 'session-roundtrip', 'restart-recover'];
/** 칸 서명을 받아야 하는 범주(칸 제목 «영속·잠금·프로세스 간»). 보안은 칸 밖. */
export const FAILURE_ORACLE_SIGNATURE_CATEGORIES: readonly WorkRiskCategory[] = ['persistence', 'locking', 'cross-process'];

/** 범주 → 시나리오(순서 = 표시 순서 · 서명 넷이 먼저라 글자 상한에 잘려도 서명이 남는다). 출처: ASK 칸 3
 *  «쓰기↔rename 사이 죽음·동시 추가·세션 왕복·재기동 복원» ⊕ PR 본문 «실패 경로 표»(읽기·쓰기 실패·잠금 보유자 죽음·동시·재기동) 상시 규칙. */
export const FAILURE_SCENARIOS_BY_CATEGORY: Readonly<Record<WorkRiskCategory, readonly FailureScenarioId[]>> = {
  persistence: [...FAILURE_ORACLE_CELL_SIGNATURE, 'read-failure', 'write-failure'],
  locking: [...FAILURE_ORACLE_CELL_SIGNATURE, 'holder-dies'],
  'cross-process': [...FAILURE_ORACLE_CELL_SIGNATURE],
  // 비밀이 안 읽히면 «다른 자격으로 조용히 새지 않는다» — 읽기 실패 한 꼴만(동시성·영속 꼴은 범주 밖).
  security: ['read-failure'],
};

/** 경로에 묶이지 않은 «선언된» 범주(`위험 범주:` 줄)의 대상 표시. */
export const FAILURE_ORACLE_GOAL_TARGET = '(goal)';

// ── 숫자 상수(NUMGUARD — 출처) ────────────────────────────────────────────────
/** 절 하나에 싣는 틀 수 상한. 출처: ASK 칸 3 의 네 꼴(죽음·동시 추가·세션 왕복·재기동) × 칸 «대상 경로» 관례 3파일 = 12. */
export const FAILURE_ORACLE_MAX_SKELETONS = 12;
/** 주입 절 글자 상한. 출처: ASK «강중약 섞기 정책 v0» — 하니스가 싣는 짧은 조언 ≤400 토큰 ≈ 1600자(한글 ~4자/토큰). */
export const FAILURE_ORACLE_MAX_SECTION_CHARS = 1600;
/** 살피는 경로 수 상한 — 경로 수백 개 골이 라운드를 늦추지 않게. 출처: #38175 `WORK_ROUTE_MAX_REASONS`(20) 의 10배 여유. */
export const FAILURE_ORACLE_MAX_PATHS = 200;

export interface FailureOracleInput {
  /** 계획·변경 파일 목록(저장소 상대 · glob 허용). */
  readonly paths: readonly string[];
  /** 골에 «선언된» 범주(`위험 범주:` 줄 · work-risk-router 입력 `declaredCategories`)만. 경로 범주는 생성기가 경로에서 얻는다.
   *  ⛔ 전체 경로로 계산한 범주를 여기 넘기지 않는다 — 경로 상한 밖 범주가 `(goal)` 로 잘못 붙는다(OP REVIEW-1 #38286). 모르는 이름은 버리고 센다. */
  readonly declaredCategories?: readonly string[];
}

export interface FailureOracleResult {
  /** 상한 안의 틀(순서 고정). */
  readonly skeletons: readonly FailureSkeleton[];
  /** 상한 전 전체 틀 수. */
  readonly total: number;
  /** 상한 때문에 뺀 틀 수. */
  readonly omitted: number;
  /** 버린 모르는 범주 수. */
  readonly unknownCategories: number;
  /** 경로 상한 때문에 살피지 않은 경로 수. */
  readonly pathsOmitted: number;
  /** 상한 밖 경로에서만 나온 범주 — 틀을 만들지 않고 이름만 센다(`(goal)` 로 바꿔 붙이지 않는다). */
  readonly omittedCategories: readonly WorkRiskCategory[];
}

function isWorkRiskCategory(value: string): value is WorkRiskCategory {
  return (WORK_RISK_CATEGORIES as readonly string[]).includes(value);
}

/** 순수 — 같은 입력이면 같은 출력. 경로별 범주는 기존 `classifyWorkRisk` 를 경로 하나씩 불러 얻는다(새 분류기 없음). */
export function generateFailureSkeletons(input: FailureOracleInput, cap: number = FAILURE_ORACLE_MAX_SKELETONS): FailureOracleResult {
  const uniquePaths = [...new Set(input.paths.map((path) => path.trim()).filter(Boolean))];
  const scanned = uniquePaths.slice(0, FAILURE_ORACLE_MAX_PATHS);
  const all: FailureSkeleton[] = [];
  const seen = new Set<string>();
  const push = (scenario: FailureScenarioId, target: string, category: WorkRiskCategory): void => {
    const key = `${scenario}\u0000${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    all.push({ scenario, target, category, ...FAILURE_SCENARIOS[scenario] });
  };
  const covered = new Set<WorkRiskCategory>();
  for (const path of scanned) {
    for (const category of classifyWorkRisk({ paths: [path] }).riskCategories) {
      covered.add(category);
      for (const scenario of FAILURE_SCENARIOS_BY_CATEGORY[category]) push(scenario, path, category);
    }
  }
  const beyondCap = uniquePaths.slice(FAILURE_ORACLE_MAX_PATHS);
  const omittedCategories = beyondCap.length
    ? classifyWorkRisk({ paths: beyondCap }).riskCategories.filter((category) => !covered.has(category))
    : [];
  let unknownCategories = 0;
  for (const raw of input.declaredCategories ?? []) {
    const name = raw.trim().toLowerCase();
    if (!isWorkRiskCategory(name)) { unknownCategories += 1; continue; }
    if (covered.has(name)) continue;
    covered.add(name);
    for (const scenario of FAILURE_SCENARIOS_BY_CATEGORY[name]) push(scenario, FAILURE_ORACLE_GOAL_TARGET, name);
  }
  const limit = Number.isSafeInteger(cap) && cap >= 0 ? cap : FAILURE_ORACLE_MAX_SKELETONS;
  const skeletons = all.slice(0, limit);
  return {
    skeletons,
    total: all.length,
    omitted: all.length - skeletons.length,
    unknownCategories,
    pathsOmitted: uniquePaths.length - scanned.length,
    omittedCategories,
  };
}

export const FAILURE_ORACLE_SECTION_HEADER = '## 실패 경로 시험 틀(하니스 · 코드 전에)';

/** 안내문의 범주 이름(표시용). */
export const FAILURE_CATEGORY_LABELS: Readonly<Record<WorkRiskCategory, string>> = {
  persistence: '영속', locking: '잠금', 'cross-process': '프로세스 간', security: '보안',
};

/** 안내문 첫 문장 — 경로 근거가 있는 범주만 «바뀔 파일이 X 경로다», 선언만 있는 범주(`(goal)`)는 «골에 선언된 위험 범주: Y»(OP REVIEW-1 #38286). */
export function failureOracleLead(skeletons: readonly FailureSkeleton[]): string {
  const labels = (fromGoal: boolean) => WORK_RISK_CATEGORIES
    .filter((c) => skeletons.some((s) => s.category === c && (s.target === FAILURE_ORACLE_GOAL_TARGET) === fromGoal))
    .map((c) => FAILURE_CATEGORY_LABELS[c]).join('·');
  const fromPaths = labels(false);
  const declared = labels(true);
  return [
    ...(fromPaths ? [`바뀔 파일이 ${fromPaths} 경로다.`] : []),
    ...(declared ? [`골에 선언된 위험 범주: ${declared}.`] : []),
  ].join(' ');
}

/** 틀 → 자식 프롬프트의 짧은 절. 글자 상한을 넘기는 줄부터는 싣지 않고 «+N개 생략» 한 줄로 센다. */
export function renderFailureOracleSection(skeletons: readonly FailureSkeleton[], maxChars: number = FAILURE_ORACLE_MAX_SECTION_CHARS): { text: string; shown: number } {
  if (!skeletons.length) return { text: '', shown: 0 };
  const head = [
    FAILURE_ORACLE_SECTION_HEADER,
    `${failureOracleLead(skeletons)} 구현 코드를 쓰기 전에 아래 틀마다 실패하는(빨강) 시험을 먼저 쓰고, 그다음 초록으로 만들어라.`,
  ];
  const lines: string[] = [];
  let length = head.join('\n').length;
  let shown = 0;
  // 생략 줄 자리를 남겨 둔다(«(+NN개 생략)» ≈ 12자).
  const budget = maxChars - 16;
  for (const s of skeletons) {
    const line = `- [${s.scenario}] \`${s.target}\` ${s.title} — Given ${s.given} / When ${s.when} / Then ${s.then}`;
    if (length + 1 + line.length > budget) break;
    lines.push(line);
    length += 1 + line.length;
    shown += 1;
  }
  if (shown === 0) return { text: '', shown: 0 };
  if (shown < skeletons.length) lines.push(`(+${skeletons.length - shown}개 생략)`);
  return { text: [...head, ...lines].join('\n'), shown };
}

// ── 하니스 배선(첫 구현 라운드) ───────────────────────────────────────────────

export type FailureOracleMode = 'shadow' | 'on';
export const FAILURE_ORACLE_EVENT = 'harness.failure-oracle';

/** SMART-ROUTER-TIER-FULL-WIRE(칸 43) — 등급 원천 기본값: 실제 원천 스토어 → env 폴백 → free(fail-closed). */
import { authorizeRouterFeatureAtEntry } from '../plugins/smart-router/full-wire.js';
import { createMemberTierStore, memberTierResolver } from '../members/tier-store.js';
import type { MembershipResolver } from '../plugins/smart-router/consumer.js';

/** 생략·무효값 = shadow. `on` 만 주입한다. 등급 게이트(router.failure_oracle_gen · advanced 전용) 미달이면
 *  주입 없음(shadow)으로 강등 — 프롬프트를 못 바꾼다(fail-closed). 원천 미주입 시 실제 회원 등급 원천으로 판정. */
export function resolveFailureOracleMode(
  config: { harness?: { failureOracle?: unknown } } | undefined,
  membership: MembershipResolver = memberTierResolver(createMemberTierStore()),
): FailureOracleMode {
  const grant = authorizeRouterFeatureAtEntry('router.failure_oracle_gen', membership);
  if (!grant.allowed) return 'shadow';
  return config?.harness?.failureOracle === 'on' ? 'on' : 'shadow';
}

export interface FailureOracleImplementInput {
  /** 첫 구현 라운드인가(rework·재시도 라운드는 이미 코드가 있어 «코드 전»이 아니다). */
  readonly firstRound: boolean;
  readonly readMode: () => FailureOracleMode;
  /** 계획 파일 ⊕ work-risk-router 범주 — 호출측이 골 문서에서 만든다(던져도 된다). */
  readonly readInput: () => FailureOracleInput;
  readonly runId?: string;
  readonly log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

/** 서명 누락(Terra 리뷰 mustFix #38368) — `generated` = 상한 전 전체 틀(생성 순서), `injected` = 프롬프트에 실제 실린 앞쪽 줄 수
 *  (틀 수 상한 ⊕ 글자 상한 뒤 · 두 상한 모두 앞에서 자르므로 실린 줄 = generated 의 앞 `injected` 개).
 *  서명 범주(영속·잠금·프로세스 간) 틀이 «생성»됐으면 서명이 걸린다 → 생성됐지만 실리지 못한 서명 꼴을 대상마다 하나씩(생성 순서) 낸다.
 *  한 줄도 못 실려도 빈 배열·생략이 아니라 잘린 꼴이 모두 나온다. 서명 범주 틀이 하나도 생성되지 않았을 때만 undefined(필드 생략).
 *  대상 경로는 싣지 않는다(사건은 개수·꼴 이름만). */
export function missingCellSignature(generated: readonly FailureSkeleton[], injected: number): FailureScenarioId[] | undefined {
  if (!generated.some((s) => FAILURE_ORACLE_SIGNATURE_CATEGORIES.includes(s.category))) return undefined;
  const shown = Number.isSafeInteger(injected) && injected > 0 ? injected : 0;
  return generated
    .slice(shown)
    .filter((s) => FAILURE_ORACLE_SIGNATURE_CATEGORIES.includes(s.category) && FAILURE_ORACLE_CELL_SIGNATURE.includes(s.scenario))
    .map((s) => s.scenario);
}

function scenarioCounts(skeletons: readonly FailureSkeleton[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of skeletons) counts[s.scenario] = (counts[s.scenario] ?? 0) + 1;
  return counts;
}

/** 구현 직전 한 번 — 주입할 절(없으면 undefined). 동기·순수 계산 · 모든 분기가 개수만 담은 이벤트를 남긴다(문면 없음).
 *  ⛔ 어떤 예외도 밖으로 던지지 않는다 — 라운드를 막거나 늦추지 않는다. */
export function failureOracleSectionForImplement(input: FailureOracleImplementInput): string | undefined {
  const emit = (event: string, data: Record<string, unknown>): void => {
    try { input.log?.(FAILURE_ORACLE_EVENT, event, { ...(input.runId ? { runId: input.runId } : {}), ...data }); } catch { /* observation is fail-soft */ }
  };
  let stage = 'mode';
  try {
    if (!input.firstRound) { emit('skipped', { reason: 'not-first-round' }); return undefined; }
    const mode = input.readMode();
    stage = 'input';
    const oracleInput = input.readInput();
    stage = 'generate';
    const result = generateFailureSkeletons(oracleInput);
    // 서명 누락 판정용 — 틀 수 상한 전 전체(같은 순서). 상한에 잘린 서명 줄도 «누락»으로 센다.
    const generated = generateFailureSkeletons(oracleInput, Number.MAX_SAFE_INTEGER).skeletons;
    stage = 'render';
    // shadow 도 같은 상한으로 그려 «실렸을» 줄을 잰다 — 문면은 on 일 때만 쓴다.
    const rendered = renderFailureOracleSection(result.skeletons);
    const inject = mode === 'on' && rendered.text.length > 0;
    // 서명 누락 — on = 실제 실린 줄 · shadow = 같은 상한에서 실렸을 줄. 빈 배열 = 잘린 서명 줄 없음.
    const signatureMissing = missingCellSignature(generated, rendered.shown);
    emit(inject ? 'injected' : 'computed', {
      mode,
      paths: oracleInput.paths.length,
      skeletons: result.skeletons.length,
      total: result.total,
      omitted: result.omitted,
      // shown = 실제 실린 줄(shadow 는 0 · 종전 뜻 유지). shadow 가 «실렸을» 줄은 signatureMissing 에만 반영한다.
      shown: mode === 'on' ? rendered.shown : 0,
      unknownCategories: result.unknownCategories,
      pathsOmitted: result.pathsOmitted,
      omittedCategories: [...result.omittedCategories],
      scenarios: scenarioCounts(result.skeletons),
      ...(signatureMissing ? { signatureMissing } : {}),
      ...(inject ? { sectionChars: rendered.text.length } : {}),
      ...(!inject ? { reason: mode !== 'on' ? 'shadow' : result.skeletons.length === 0 ? 'no-risk' : 'over-char-cap' } : {}),
    });
    return inject ? rendered.text : undefined;
  } catch (error) {
    emit('error', { stage, error: error instanceof Error ? error.name : typeof error });
    return undefined;
  }
}
