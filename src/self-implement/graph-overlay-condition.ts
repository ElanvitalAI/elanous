/** ⭐ RFC §5 «4단계» — `applies_when` 을 «코드»가 판정한다.
 *
 *  ⛔⭐ **표현식 엔진을 만들지 않는다.** 문법이 넓어지면 오버레이가 «작은 프로그램»이 되고,
 *    그러면 「왜 이 걸음인가」를 답하려면 그 프로그램을 읽어야 한다 — 그래프를 데이터로 둔 이유가 사라진다.
 *  ⇒ 문법은 «둘»뿐이다. 못 읽는 조건은 ⛔ **거절**한다(조용히 참으로 만들지 않는다).
 *
 *  📌 RFC §4.3 ⑵: 라우터·조건의 «값»은 코드가 낸다. LLM 이 못 고른다. */
export type OverlayConditionOperator = '>=' | '>' | '<=' | '<' | '==' | '!=';

export interface OverlayCondition {
  readonly key: string;
  readonly operator: OverlayConditionOperator;
  readonly literal: string | number;
}

export type OverlayConditionParse =
  | { readonly ok: true; readonly condition: OverlayCondition }
  | { readonly ok: false; readonly reason: 'unparseable'; readonly source: string };

/** ⛔⭐ 리터럴을 «좁힌다» — 수 또는 «낱말»만.
 *  🩸 2026-09-08 실측: 옛 정규식(`\S+`)이 `a >= 1;` 을 통과시켰다. `1;` 이 «문자열 리터럴»이 되어
 *    수 비교가 조용히 낱말 비교로 바뀌었다 ⇒ 뜻이 달라지는데 아무도 안 말한다. */
const CONDITION = /^\s*([a-z_][a-z0-9_]*)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?|[a-z_][a-z0-9_-]*)\s*$/i;

export function parseOverlayCondition(source: string): OverlayConditionParse {
  const match = CONDITION.exec(source);
  if (!match) return { ok: false, reason: 'unparseable', source };
  const [, key, operator, rawLiteral] = match;
  const numeric = Number(rawLiteral);
  const literal = rawLiteral!.length > 0 && Number.isFinite(numeric) ? numeric : rawLiteral!;
  return { ok: true, condition: { key: key!, operator: operator as OverlayConditionOperator, literal } };
}

export type OverlayConditionVerdict =
  /** 조건이 참이다 — 얹는다. */
  | { readonly kind: 'applies' }
  /** 조건이 거짓이다 — 안 얹는다. ⛔ 「못 읽었다」와 «다른 값»이다. */
  | { readonly kind: 'does-not-apply' }
  /** ⛔ 조건을 못 읽었다 — 얹지 «않는다». 조용히 참으로 만들지 않는다. */
  | { readonly kind: 'unparseable'; readonly source: string }
  /** ⛔ 그 키가 상태에 «없다» — 「값이 0」과 «다른 값»이다. 얹지 않는다. */
  | { readonly kind: 'key-absent'; readonly key: string };

/** 조건을 «상태»에 대 본다. ⛔ 상태에 없는 키를 0·빈값으로 «가정하지 않는다». */
export function evaluateOverlayCondition(
  source: string | undefined,
  state: Readonly<Record<string, unknown>>,
): OverlayConditionVerdict {
  // 조건이 «없는» 오버레이는 항상 후보다(파서가 조건 필수를 따로 강제한다).
  if (source === undefined) return { kind: 'applies' };
  const parsed = parseOverlayCondition(source);
  if (!parsed.ok) return { kind: 'unparseable', source };
  const { key, operator, literal } = parsed.condition;
  if (!(key in state)) return { kind: 'key-absent', key };
  const actual = state[key];
  if (actual === undefined || actual === null) return { kind: 'key-absent', key };
  // Measured boolean branch keys accept only a real boolean observation — any textual lookalike
  // ('true', 'TRUE', 'yes', 1) is unknown, whatever the literal spelling in the condition.
  if ((key === 'sibling_overlap' || key === 'main_sync_conflict') && typeof actual !== 'boolean') return { kind: 'key-absent', key };

  if (typeof literal === 'number') {
    // ⛔ 수 비교인데 값이 수가 아니면 「비교 불가」다 — 거짓으로 접지 않는다.
    if (typeof actual !== 'number' || !Number.isFinite(actual)) return { kind: 'key-absent', key };
    const holds = operator === '>=' ? actual >= literal
      : operator === '>' ? actual > literal
      : operator === '<=' ? actual <= literal
      : operator === '<' ? actual < literal
      : operator === '==' ? actual === literal
      : actual !== literal;
    return holds ? { kind: 'applies' } : { kind: 'does-not-apply' };
  }

  const actualText = typeof actual === 'string' ? actual : String(actual);
  const holds = operator === '==' ? actualText === literal
    : operator === '!=' ? actualText !== literal
    : undefined;
  // ⛔ 문자열에 대소 비교를 쓰면 「못 읽었다」다 — 사전순으로 «몰래» 답하지 않는다.
  if (holds === undefined) return { kind: 'unparseable', source };
  return holds ? { kind: 'applies' } : { kind: 'does-not-apply' };
}
