/**
 * Jev(System One) 결정 호출 — ⛔ 텍스트를 «생성하지 않는다». 확률이 붙은 판정만 받는다.
 *
 * 📚 매뉴얼 = 내부 문서 `MANUAL-typesafe-jev-system-one-2026-09-20` (§0c 가 유일한 실측 절)
 *
 * ⛔ 이 파일이 지키는 함정 셋 (전부 실측으로 데인 것):
 *   ⓐ 질문 타입은 `noul`·`choice`·`score` 다 — `boolean` 을 보내면 HTTP 400 이고
 *      그 오류는 «어느 칸이 틀렸는지 말해 주지 않는다»(`{"message":"Invalid request."}` 한 줄).
 *   ⓑ 세 타입이 옵션/레벨을 «criteria» 한 칸으로 받는다 — `options`·`levels` 는 «없는 칸»이다.
 *   ⓒ score 는 `[0, N-1]` 이다. ***0.85 를 「85%」로 읽으면 뜻이 뒤집힌다*** — 그래서 이 모듈은
 *      점수를 언제나 `x / (N-1)` 로 «분모와 함께» 내고, 가장 가까운 레벨 문면을 같이 붙인다.
 */

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface JevRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
  model?: string;
}

export interface JevAnswer {
  type: 'noul' | 'choice' | 'score';
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** 요청을 보낼 곳과 자격 — 로컬 Jev 호환 서버(Laya `laya-serve` 등 `/v1/systemone`)로 바꿀 수 있다. */
export interface JevAccess {
  endpoint: string;
  endpointSource: 'config' | 'env' | 'default';
  /** Typesafe 는 필수 · 다른 서버는 선택(bearer 를 요구할 때만). */
  key?: string;
  model?: string;
}

const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * 순서: 설정 `decide.endpoint` > 환경 `ELANOUS_JEV_ENDPOINT` > Typesafe.
 * 기본(Typesafe)이면 키가 반드시 있어야 한다(환경 `TYPESAFE_API_KEY` > 캐시 파일).
 * 다른 서버면 키는 설정 `decide.keyFile` 파일 > 환경 `ELANOUS_JEV_KEY` 이고 없어도 된다.
 */
export function resolveJevAccess(input: {
  config?: { endpoint?: unknown; keyFile?: unknown; model?: unknown };
  env: NodeJS.ProcessEnv;
  readFile: (path: string) => string | undefined;
  typesafeCachePath: string;
}): { ok: true; access: JevAccess } | { ok: false; message: string } {
  const configEndpoint = nonEmpty(input.config?.endpoint);
  const envEndpoint = nonEmpty(input.env.ELANOUS_JEV_ENDPOINT);
  const endpoint = configEndpoint ?? envEndpoint ?? JEV_ENDPOINT;
  const endpointSource = configEndpoint ? 'config' : envEndpoint ? 'env' : 'default';
  const model = nonEmpty(input.config?.model);
  if (endpointSource === 'default') {
    const key = nonEmpty(input.env.TYPESAFE_API_KEY) ?? nonEmpty(input.readFile(input.typesafeCachePath));
    if (!key) {
      return { ok: false, message: `TYPESAFE_API_KEY 가 없습니다.  export TYPESAFE_API_KEY=<키>  또는  ${input.typesafeCachePath} (0600) — 로컬 Jev 호환 서버를 쓰려면 설정 decide.endpoint 를 준다` };
    }
    return { ok: true, access: { endpoint, endpointSource, key, ...(model ? { model } : {}) } };
  }
  const keyFile = nonEmpty(input.config?.keyFile);
  const key = (keyFile ? nonEmpty(input.readFile(keyFile)) : undefined) ?? nonEmpty(input.env.ELANOUS_JEV_KEY);
  return { ok: true, access: { endpoint, endpointSource, ...(key ? { key } : {}), ...(model ? { model } : {}) } };
}

/** ⛔ 값을 «돌려주지 않는다» — 존재와 길이만. 키를 로그·산출에 흘리지 않기 위해서다. */
export interface KeyProbe { present: boolean; length: number; source: 'env' | 'cache' | 'none' }

export function probeKey(
  env: NodeJS.ProcessEnv,
  readCache: () => string | undefined,
): KeyProbe {
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return { present: true, length: fromEnv.length, source: 'env' };
  const cached = readCache()?.trim();
  if (cached) return { present: true, length: cached.length, source: 'cache' };
  return { present: false, length: 0, source: 'none' };
}

/**
 * 커뮤니티 관용구를 그대로 옮긴 «자동/에스컬레이션» 판정.
 * 📏 근거: r/LLMDevs — *"if top choice probability ≥ 0.9 and confidence ≥ 0.7, act automatically;
 *    otherwise escalate to a human or larger model"* (2026-09 · 외부 그라운딩).
 * ⛔ 임계는 «우리 것이 아니다» — 그래서 인자로 받고 기본값을 여기 한 자리에만 둔다.
 */
export interface Gate { verdict: 'act' | 'escalate'; why: string }

export function gateAnswer(a: JevAnswer, minProb = 0.9, minConf = 0.7): Gate {
  if (a.type === 'noul') {
    const p = a.noul ?? 0;
    const extreme = Math.max(p, 1 - p);
    return extreme >= minProb
      ? { verdict: 'act', why: `noul ${p.toFixed(2)} (양 끝에서 ${extreme.toFixed(2)})` }
      : { verdict: 'escalate', why: `noul ${p.toFixed(2)} — 어느 쪽으로도 ${minProb} 에 못 미친다` };
  }
  const conf = a.confidence ?? 0;
  const top = Math.max(0, ...Object.values(a.probabilities ?? {}));
  if (top >= minProb && conf >= minConf) return { verdict: 'act', why: `최상위 ${top.toFixed(2)} · 신뢰도 ${conf.toFixed(2)}` };
  return { verdict: 'escalate', why: `최상위 ${top.toFixed(2)} · 신뢰도 ${conf.toFixed(2)} — 임계(${minProb}/${minConf}) 미달` };
}

/** ⛔ score 를 «분모와 함께» 읽는다. 이 함수가 없으면 0.85 가 「85%」로 읽힌다. */
export function describeScore(a: JevAnswer): string {
  const levels = a.legend ? Object.keys(a.legend).length : 0;
  const max = Math.max(0, levels - 1);
  const s = a.score ?? 0;
  const nearest = String(Math.round(s));
  const label = a.legend?.[nearest] ?? '';
  return `${s.toFixed(2)} / ${max}  (레벨 ${nearest}${label ? ` — ${label}` : ''})`;
}

export function buildQuestion(kind: 'noul' | 'choice' | 'score', instructions: string, criteria?: string[]): JevQuestion {
  if (kind === 'noul') return { type: 'noul', instructions };
  if (!criteria || criteria.length < 2) {
    throw new Error(`${kind} 는 criteria 가 둘 이상 필요하다 — ⛔ options·levels 가 아니라 criteria 다`);
  }
  if (kind === 'choice') {
    return { type: 'choice', instructions, criteria: Object.fromEntries(criteria.map((c) => [c, null])) };
  }
  if (criteria.length > 10) throw new Error(`score 는 레벨이 2~10 이다 (받은 것: ${criteria.length})`);
  return { type: 'score', instructions, criteria };
}

/** A non-2xx Jev answer — `status` lets callers tell 402 (credits) · 429 (rate) · 401 (key) apart without reading text. */
export class JevHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'JevHttpError'; }
}

export async function callJev(
  req: JevRequest,
  key: string | undefined,
  fetchImpl: typeof fetch = fetch,
  endpoint: string = JEV_ENDPOINT,
): Promise<JevResponse> {
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: req.model ?? 'jev-latest', state: req.state, questions: req.questions }),
  });
  const text = await res.text();
  if (!res.ok) {
    // ⛔ 400 은 «어느 칸이 틀렸는지 말해 주지 않는다» — 그래서 우리가 후보를 댄다.
    // ⛔ 코드마다 «다른 일»이다 — 401(키) · 402(크레딧) · 403(권한) · 429(레이트) 를 접지 않는다.
    //   🩸 2026-09-20 실측: 하루 쓰고 402 를 만났다. 그때 「인증 실패」로 읽으면 키를 다시 만들러 간다.
    const hint = res.status === 400
      ? ' — ⛔ 400 은 칸을 안 말해 준다. 흔한 원인: type 이 noul/choice/score 가 아니다 · options·levels 를 보냈다(criteria 여야 한다) · choice/score 에 criteria 가 없다'
      : res.status === 402
        ? ' — ⛔ 크레딧이 없다(키 문제가 «아니다»). console.typesafe.ai/settings/billing 에서 충전하거나 auto-reload 를 켠다'
        : res.status === 401
          ? ' — ⛔ 키가 틀렸거나 없다(크레딧 문제가 아니다)'
          : res.status === 429
            ? ' — ⛔ 레이트리밋이다. 잠시 뒤 다시 — 키·크레딧 문제가 아니다'
            : '';
    throw new JevHttpError(res.status, `Jev HTTP ${res.status}: ${text.slice(0, 200)}${hint}`);
  }
  return JSON.parse(text) as JevResponse;
}

/**
 * 🧭 **Speculative Fan-Out** — 공식 패턴(`docs.typesafe.ai/patterns`).
 *   *"한 호출에 «투기적인 것까지» 여러 질문을 보내고, 무엇이 쓸모 있는지는 «코드»가 정한다."*
 *
 * 📏 2026-09-20 실측 (같은 state · 질문 수만 늘림):
 * ```
 * 질문 1개   416 토큰 · 1,135ms
 * 질문 5개   671 토큰 ·   802ms        ← state 를 «공유»하므로 질문당 134 토큰(68% 싸다)
 * 따로 5번   2,080 토큰 · 약 5,676ms   ⇒ ***한 번에 보내면 3.1배 싸다***
 * ```
 * ⛔ *"질문이 많을수록 «빨라진다»"* 가 아니다 — 질문들이 «병렬»로 돌아
 *    ***지연이 거의 안 는다***는 뜻이다. 그래서 「쓸지 모르는 질문」을 미리 섞는 것이 이득이다.
 */
export interface FanOutFile {
  state: unknown;
  questions: Record<string, JevQuestion>;
  model?: string;
}

export function parseFanOutFile(raw: string): FanOutFile {
  const o = JSON.parse(raw) as Partial<FanOutFile>;
  if (o.state === undefined) throw new Error('state 칸이 없다 — {"state": …, "questions": {…}} 모양이어야 한다');
  if (!o.questions || typeof o.questions !== 'object') throw new Error('questions 칸이 없다(맵이어야 한다)');
  const names = Object.keys(o.questions);
  if (names.length === 0) throw new Error('questions 가 비었다');
  for (const [name, q] of Object.entries(o.questions)) {
    const t = (q as JevQuestion)?.type;
    // ⛔ 400 은 어느 칸이 틀렸는지 말해 주지 않는다 — 보내기 «전»에 우리가 잡는다.
    if (t !== 'noul' && t !== 'choice' && t !== 'score') {
      throw new Error(`questions.${name}.type 이 '${String(t)}' 이다 — noul·choice·score 중 하나여야 한다`);
    }
    // ⛔⭐ 순서가 «사유»를 정한다 — options 를 보낸 사람에게 "criteria 가 없다"고 하면
    //   맞는 말이지만 «덜 쓸모 있다». 더 «구체적인» 진단을 먼저 낸다.
    //   🩸 2026-09-20: 이 순서를 세 번 틀렸다(급여 이체 · ax-screen · 여기).
    if ('options' in (q as object) || 'levels' in (q as object)) {
      throw new Error(`questions.${name} 에 options/levels 가 있다 — ⛔ 그런 칸은 «없다». criteria 로 바꿔라`);
    }
    if ((t === 'choice' || t === 'score') && !(q as { criteria?: unknown }).criteria) {
      throw new Error(`questions.${name} 은 criteria 가 필요하다 — ⛔ options·levels 가 아니다`);
    }
  }
  return { state: o.state, questions: o.questions as Record<string, JevQuestion>, ...(o.model ? { model: o.model } : {}) };
}
