import { cpus, loadavg } from 'node:os';
import { classifyRouting, type RoutingOutcome } from './nl-routing-measurement.js';

interface ScreeningItem {
  id: string;
  tier: string;
  prompt: string;
  accept: readonly string[];
  /** 부정 기대(대조군) — 이 툴이 돌면 실패다. 없으면 종전 의미론 그대로. */
  reject?: readonly string[];
  context_dependent?: boolean;
  context?: string;
}

interface ScreeningEvaluation {
  toolBreakdown?: Record<string, unknown>;
  turnCount: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  firstTokenMs?: number | null;
  /** 자식이 낸 답문. ⭐ 러너는 이미 이것을 쥐고 있었고 **버리고 있었다**(`I-16`). */
  text?: string;
}

export interface MachineLoad {
  loadAverage: [number, number, number];
  coreCount: number;
}

/**
 * ⛔⭐⭐ 부하 필드가 **셋**인 이유 — 하나로 뭉치면 다시 `MEAS-T15` 가 난다.
 *
 * | 필드 | 언제 잰 값 | 무엇에 쓰나 |
 * |---|---|---|
 * | `machineLoad` | ⚠️ **호출부가 넘긴 값**(코퍼스 러너는 **런 시작**에 한 번 잡는다) | 런 사이 조건 비교 |
 * | `loadAtStart` | ⭐ **이 레코드의 실행 직전** | ⭐ 부하 축 **조작 검사**(저·고 칸이 실제로 갈렸나) |
 * | `loadAtEnd`   | ⭐ 이 레코드의 실행 **직후** | 실행 중 부하가 **오르고 있었는지** |
 *
 * ⛔ **`machineLoad` 를 레코드의 부하로 읽지 마라** — 이름이 그렇게 읽히지만 아니다(형태 `F7`).
 *    종전엔 이것 하나뿐이었고, 그래서 **런 내부 변동이 어느 레코드에도 안 적혔다**(`MEAS-T15`).
 *    이름을 안 바꾸는 이유는 기존 원자료(`b4-grid.json` 등)가 그 뜻으로 이미 쓰였기 때문이다.
 */

export interface ScreeningRecord {
  id: string;
  tier: string;
  budget: number;
  rep: number;
  fired: string[];
  outcome: RoutingOutcome;
  turns: number;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  firstTokenMs?: number | null;
  tokensPerTurn?: number;
  /**
   * ⭐ **미발사(`no-fire`) 런의 답문 원문** — `I-16`.
   *
   * ⛔ **이름이 `noFireText` 인 것은 의도다.** `text` 로 두면 *"모든 레코드에 있다"* 로 읽히고
   * 그러면 형태 `F7`(한 이름 아래 둘)이다. **미발사일 때만 있다.**
   *
   * ⛔⭐⭐ **해석·채점하지 않는다.** 이 필드는 *"정당한 생략 / 되묻기 / 진짜 실패 / 잡음"* 을
   * 가르기 위한 **원자료**이고, 그 판정은 **사람이 읽어서** 한다. 러너가 분류하는 순간
   * 그 분류가 곧 자가 되고 아무도 그 자를 검증하지 않는다(Goodhart).
   *
   * ⚠️ **왜 미발사만인가**: 물음이 *"왜 안 쐈나"* 라서다(`MEAS-T17` — 세는 방식으로는
   * 안 닫히므로 **읽어야** 한다). 발사한 런의 답문은 이 물음에 답하지 않는다.
   */
  noFireText?: string;
  /** ⛔ **조용한 절단 금지** — 잘랐으면 원래 길이를 남긴다(`piped-stdin` 규율 계승). */
  noFireTextTruncatedFrom?: number;
  machineLoad: MachineLoad;
  loadAtStart: MachineLoad;
  loadAtEnd: MachineLoad;
}

type ScreeningEvaluationRunner = (item: ScreeningItem, budget: number) => Promise<ScreeningEvaluation>;

/** 미발사 답문 보존 상한(문자). ⛔ **자르되 조용히 자르지 않는다** — 넘으면 원래 길이를 함께 남긴다.
 *  ⚠️ 넉넉히 잡는다: 23차 `I-9` 가 *"꼬리 2000자"* 때문에 증거를 잃은 사건이라 같은 실수를
 *  반복하지 않으려면 **읽을 수 있는 만큼**은 남겨야 한다.
 *  ⛔ export 하지 않는다 — 밖에 소비자가 없다(죽은 공개 표면). */
const NO_FIRE_TEXT_LIMIT = 8000;

export function machineLoad(): MachineLoad {
  const [one = 0, five = 0, fifteen = 0] = loadavg();
  return { loadAverage: [one, five, fifteen], coreCount: cpus().length || 1 };
}

/** Execution failures are null, never a synthetic no-fire record. */
export async function measureScreeningRun(
  item: ScreeningItem,
  budget: number,
  rep: number,
  evaluate: ScreeningEvaluationRunner,
  load: MachineLoad = machineLoad(),
  // ⭐ 주입 가능한 샘플러 — 테스트가 결정론으로 쓰고, 운영은 기본값(진짜 `loadavg`)이 돈다.
  sampleLoad: () => MachineLoad = machineLoad,
): Promise<ScreeningRecord | null> {
  // ⛔⭐ **`load` 를 재사용하지 않는다** — 그것은 호출부가 넘긴 값이고 코퍼스 러너는 **런 시작**에
  //    한 번 잡는다(`MEAS-T15`). 이 레코드가 **실제로 어떤 부하에서 돌았는지**는 여기서만 알 수 있다.
  const loadAtStart = sampleLoad();
  try {
    const result = await evaluate(item, budget);
    // ⛔ **`await` 직후에** 잰다 — 뒤처리(`Object.keys` 등) 뒤로 밀면 *"실행 직후"* 라는 계약이
    //    문면과 어긋난다(리뷰 must-fix 수용). 실측 차이는 작지만 **계약은 정확해야 자다.**
    const loadAtEnd = sampleLoad();
    const fired = Object.keys(result.toolBreakdown ?? {});
    const outcome = classifyRouting(fired, item.accept, item.reject);
    // ⭐ `I-16` — 미발사면 답문을 **그대로** 싣는다. ⛔ 읽지도 채점하지도 않는다.
    //    ⚠️ 판정(`outcome`)은 이미 위에서 났고 이 필드는 그 판정에 **아무 영향도 주지 않는다** —
    //    원자료를 늘릴 뿐이다. 그것이 이 항목의 전부다.
    const rawText = outcome === 'no-fire' ? (result.text ?? '') : '';
    // ⛔⭐ **코드포인트로 자른다**(리뷰 1R) — `slice` 는 UTF-16 코드 단위라 경계의 이모지·보조 평면
    //    문자를 **반으로 쪼개** 원자료를 손상시킨다. 자르는 목적은 크기 상한이지 **손상이 아니다.**
    //    ⚠️ 길이도 코드포인트로 센다 — 상한과 보고 길이가 다른 단위면 그 수가 거짓이 된다.
    const points = Array.from(rawText);
    const noFire = points.length > NO_FIRE_TEXT_LIMIT
      ? { noFireText: points.slice(0, NO_FIRE_TEXT_LIMIT).join(''), noFireTextTruncatedFrom: points.length }
      : points.length > 0 ? { noFireText: rawText } : {};
    return {
      id: item.id,
      tier: item.tier,
      budget,
      rep,
      fired,
      outcome,
      ...noFire,
      turns: result.turnCount,
      ms: result.durationMs,
      ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
      ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
      ...(result.firstTokenMs !== undefined ? { firstTokenMs: result.firstTokenMs } : {}),
      ...(result.inputTokens !== undefined && result.outputTokens !== undefined && result.turnCount > 0
        ? { tokensPerTurn: (result.inputTokens + result.outputTokens) / result.turnCount }
        : {}),
      machineLoad: load,
      loadAtStart,
      loadAtEnd,
    };
  } catch (error) {
    // ⛔⭐ **왜 실패했는지를 버리지 않는다**(2026-07-30 실측) — 종전 `catch { return null }` 은
    //    30/30 이 실패해도 호출부가 *"측정 불가"* 밖에 못 적었다. 자를 재는 자가 침묵하면
    //    사람이 원인을 **다시 처음부터** 찾아야 한다(실제로 그랬다: 워크트리 `node_modules` 누락).
    //    ⇒ 이유를 문자열로 올려 보낸다. 판정(=측정 불가)은 그대로다.
    screeningFailureReasons.set(failureKey(item.id, budget, rep), errorText(error));
    return null;
  }
}

/** 실패 사유 보관소 — `measureScreeningRun` 이 `null` 을 돌려준 실행의 **이유**를 남긴다.
 *  ⚠️ 반환 타입을 바꾸면 기존 호출부·회귀가 전부 흔들리므로, 판정은 그대로 두고 **곁에** 남긴다. */
const screeningFailureReasons = new Map<string, string>();

function failureKey(id: string, budget: number, rep: number): string {
  return `${id}|b${budget}|rep${rep}`;
}

/** 그 실행이 왜 실패했는지. **기록이 없으면 `undefined`** — 즉 그 실행은 실패한 적이 없다.
 *  ⛔ 조회해도 지우지 않는다(같은 실행을 두 번 물어도 같은 답이 나온다). */
export function screeningFailureReason(id: string, budget: number, rep: number): string | undefined {
  return screeningFailureReasons.get(failureKey(id, budget, rep));
}

/** 예외 → 한 줄 사유. ⛔ 스택은 싣지 않는다(측정 로그가 스택으로 덮이면 그것도 관측 손실이다). */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0]!.slice(0, 200);
  return String(error).split('\n')[0]!.slice(0, 200);
}
