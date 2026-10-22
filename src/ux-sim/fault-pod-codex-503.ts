// 결함 주입 심 «Pod 자식 공급자 폴백» ── codex 응답 503(server_is_overloaded) 이 생산 폴백 사다리(FALLBACK_STEPS)를
// 타고 승인된 zai(glm) 로 이어가고, 503 이 아닌 오류는 폴백 없이 끝나는지를 프로세스 안(S1)에서 재현한다.
//
// 🚨 왜 이것이 있나 (POD-CHILD-PROVIDER-FALLBACK · 2026-10-21)
// 폴백 코드 #29340(e9553897) 은 main 에 착지했지만 E4 증거(10-19 격리 node-b Pod · fake HTTP 503 → GLM)는
// scratch 장치라 새 초록 규칙의 장치 조건 ①(main 착지 · 자기 시험)을 못 채웠다. 이 심이 그 완료 경계를
// 상주 시험으로 만든다 — 503 이면(한 번) zai 로 이어감 · 503 아닌 오류 → 폴백 안 함, 두 경우를 가른다.
//
// ⛔ 흉내 내지 않는다 — 진짜 `streamLLMWithTools`(Pod 자식이 도는 도구 경로) ⊕ 진짜 재시도 정책
// (`fetchApiWithRetry` 의 503 streak → `OverloadFailoverError` 전환) ⊕ 진짜 `FALLBACK_STEPS` 사다리를 그대로
// 부른다. 폴백 대상도 진짜다 — 생산 `PROVIDERS.glm`(zaiCodingPlanAvailable → makeZaiCodingPlanProvider →
// OpenAI 호환 HTTP)을 바꾸지 않고, Pod 자식이 받는 zai 자격 env(ZAI_POD_SECRET_KEY) 하나만 가짜 값으로 둔다.
// 주입은 HTTP 경계 하나뿐: codex 쪽은 스크립트된 503/401 · zai 코딩 엔드포인트는 정상 SSE(kubectl·네트워크·Pod 없음).
// 심이 주는 Pod 사실 하나: codex 자식 Pod 엔 grok 자격이 없다(호스트 grok auth.json 이 섞이지 않게).
// 관측 = 결과 provider · llm.retry 관측 · llm.router 이벤트 · 영수증(명령 ⊕ injectionId ⊕ 결과) · 층 L1.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetKeyCacheForTests } from '../config.js';
import { debug } from '../debug/log.js';
import { PROVIDERS, streamLLMWithTools } from '../llm.js';
import { ZAI_CODING_PLAN_URL } from '../llm/zai-coding-plan.js';
import { FALLBACK_STEPS, type FallbackStep } from '../oauth/fallback-chain.js';
import { ZAI_POD_SECRET_KEY } from '../task-orchestrator/surfaces/pod-zai-child.js';
import { setUserConfigOverlay } from '../user-config.js';

/** zai 코딩 엔드포인트(HTTP 경계)가 돌려주는 답 — 폴백이 실제로 zai 응답을 흘렸는지 대조한다. */
export const POD_CODEX_503_ZAI_ANSWER = '[pod-codex-503] zai OK';

/** 이 심의 사다리 층 — event-monkey(L0)가 원장·logs.db 에 줄을 싣는 데 대해, 이 심은 진짜 LLM 폴백 경로를 프로세스 안에서 돈다. */
export const POD_CODEX_503_LEVEL = 'L1' as const;

/** 격리 시험 환경에서 지우는 자격 키 — 폴백 사다리의 다른 칸이 우연히 «사용 가능»해지지 않게 한다(zai 칸만 심이 채운다). */
const ISOLATED_LLM_ENV_KEYS = [
  'OPENAI_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'GROK_CODE_XAI_API_KEY', 'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'LOCAL_LLM_URL', 'OPENROUTER_API_KEY', 'OPENGATEWAY_API_KEY', 'ZAI_API_KEY',
] as const;

/** 주입할 codex 결함 — 503 server_is_overloaded(폴백 사다리를 탄다) · 401(폴백 자격 없음 → 폴백 없음). */
export type PodCodex503Fault = 'overload-503' | 'auth-401';

export const POD_CODEX_503_FAULT_RESPONSES: Readonly<Record<PodCodex503Fault, { status: number; body: string }>> = {
  'overload-503': { status: 503, body: '{"error":{"message":"server_is_overloaded"}}' },
  'auth-401': { status: 401, body: '{"error":{"message":"invalid_api_key"}}' },
} as const;

export interface PodCodex503Scenario {
  /** 주입할 결함(기본 'overload-503' — 칸의 결함). */
  readonly fault: PodCodex503Fault;
  /** 주입 식별자 — 영수증에 실린다(기본 `inj-<uuid>`). */
  readonly injectionId?: string;
}

export function podCodex503Scenario(overrides: Partial<PodCodex503Scenario> = {}): Required<PodCodex503Scenario> {
  return { fault: 'overload-503', injectionId: `inj-${randomUUID()}`, ...overrides };
}

/** 관측 행 — debug.log 를 가로챈 원본(category ⊕ event ⊕ data). */
export interface PodCodex503ObservedRow {
  readonly category: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export interface PodCodex503Observation {
  readonly level: typeof POD_CODEX_503_LEVEL;
  readonly injectionId: string;
  readonly fault: PodCodex503Fault;
  readonly faultStatus: number;
  /** 생산 폴백 사다리 — `FALLBACK_STEPS` 정본 칸들(Pod 자식이 받는 체인과 같은 어휘). */
  readonly chain: readonly FallbackStep[];
  /** 완료 경계 판정 — 503 → 'zai-fallback' · 503 아닌 오류 → 'no-fallback'. */
  readonly result: 'zai-fallback' | 'no-fallback';
  readonly resultProvider: string | null;
  readonly answer: string | null;
  readonly error: string | null;
  readonly glmCalls: number;
  readonly scriptedResponses: number;
  /** llm.retry 관측 — 재시도·전환 판정 원본(retry · switch-provider · abort). */
  readonly retryRows: readonly PodCodex503ObservedRow[];
  /** llm.router 이벤트 — overload-failover · 후보 스캔. */
  readonly events: readonly PodCodex503ObservedRow[];
  /** zai.coding-plan 관측 — 생산 glm(zai 코딩 플랜) 공급자가 실제로 요청을 냈다는 원본. */
  readonly zaiRows: readonly PodCodex503ObservedRow[];
}

/** 완료 경계 증거 명령 — 칸 문면이 지정한 이 장치의 재는 명령. */
export const POD_CODEX_503_EVIDENCE_COMMAND = 'bun test src/ux-sim/fault-pod-codex-503.test.ts';

/** 영수증 = 명령 ⊕ injectionId ⊕ 결과. */
export function podCodex503Receipt(observation: Pick<PodCodex503Observation, 'injectionId' | 'result'>): string {
  return `영수증: ${POD_CODEX_503_EVIDENCE_COMMAND} ⊕ ${observation.injectionId} ⊕ ${observation.result}`;
}

/** 한 화면 — 층 · injectionId · 결과 · 사다리 · 관측 · 영수증. */
export function renderPodCodex503(observation: PodCodex503Observation): string[] {
  const outcome = observation.answer !== null
    ? `  결과 provider: ${observation.resultProvider ?? '-'} · 답: ${observation.answer}`
    : `  결과 provider: ${observation.resultProvider ?? '-'} · 오류: ${observation.error ?? '-'}`;
  return [
    `pod-codex-503 · 층 ${observation.level} · 주입 ${observation.injectionId} · 결함 ${observation.fault} · 결과 ${observation.result}`,
    `  사다리(FALLBACK_STEPS): ${observation.chain.join(' → ')}`,
    `  주입 응답 ${observation.faultStatus} × ${observation.scriptedResponses}회 · glm 호출 ${observation.glmCalls}회`,
    outcome,
    ...observation.retryRows.map((row) => `  llm.retry ${row.event} ${JSON.stringify(row.data)}`),
    ...observation.events.map((row) => `  llm.router ${row.event} ${JSON.stringify(row.data)}`),
    ...observation.zaiRows.map((row) => `  zai.coding-plan ${row.event} ${JSON.stringify(row.data)}`),
    podCodex503Receipt(observation),
  ];
}

/** 결함 주입 본체 — 생산 `streamLLMWithTools`(도구 경로 · Pod 자식이 도는 그 경로)를 그대로 부른다. */
export async function simPodCodex503(scenario: PodCodex503Scenario = podCodex503Scenario()): Promise<PodCodex503Observation> {
  const injectionId = scenario.injectionId ?? `inj-${randomUUID()}`;
  const fault: PodCodex503Fault = scenario.fault;
  const scripted = POD_CODEX_503_FAULT_RESPONSES[fault];
  const chain: readonly FallbackStep[] = [...FALLBACK_STEPS];
  const savedEnv = { ...process.env };
  const savedGrok = PROVIDERS.grok;
  const savedFetch = globalThis.fetch;
  const savedLog = debug.log;
  const home = mkdtempSync(join(tmpdir(), 'fault-pod-codex-503-'));
  const rows: PodCodex503ObservedRow[] = [];
  let glmCalls = 0;
  let scriptedResponses = 0;
  try {
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, '.config');
    process.env.CODEX_HOME = join(home, '.codex');
    // zai 한도 원장·quota 신호(quotaSignalDir)가 운영 ~/.elanous/budget 이 아니라 임시 뿌리로 간다.
    process.env.ELANOUS_STATE_DIR = join(home, 'state');
    for (const key of ISOLATED_LLM_ENV_KEYS) delete process.env[key];
    // 키 캐시 파일(os.homedir() 기준 · HOME 을 안 따른다)을 끄고 이미 기억된 값도 비운다 —
    // 그래야 호스트의 진짜 키가 이 심에 섞이지 않는다.
    process.env.ELANOUS_KEEP_ENV_KEYS = '1';
    _resetKeyCacheForTests();
    // Pod 자식의 zai 자격 = Job 이 Secret 에서 내려 주는 env 하나(zaiPodEnv · ZAI_POD_SECRET_KEY) — 그 꼴 그대로 둔다.
    // 생산 `PROVIDERS.glm`(zaiCodingPlanAvailable → makeZaiCodingPlanProvider → OpenAI 호환 HTTP)은 바꾸지 않는다.
    process.env[ZAI_POD_SECRET_KEY] = 'fake-zai-test-only';
    // codex 자식 Pod 에는 grok 자격이 실리지 않는다(podJobManifest 는 grok 자식에만 grokCredential 을 깐다).
    // grok 자격은 os.homedir() 의 auth.json 이라 HOME 격리로는 못 지운다 — 그 Pod 사실 하나만 심이 준다.
    PROVIDERS.grok = { ...savedGrok!, available: () => false };
    setUserConfigOverlay((config) => ({
      ...config,
      llm: { ...config.llm, provider: 'openai-codex', apiKey: 'fake-codex-test-only', fallbackChain: [...FALLBACK_STEPS] },
    }));
    // 주입 = HTTP 경계 하나. codex(그 밖 전부)는 스크립트된 결함, zai 코딩 엔드포인트는 정상 SSE 한 줄.
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === ZAI_CODING_PLAN_URL) {
          glmCalls += 1;
          const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: POD_CODEX_503_ZAI_ANSWER } }] })}\n\n`
            + 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
          return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        scriptedResponses += 1;
        return new Response(scripted.body, { status: scripted.status });
      },
      { preconnect: (savedFetch as unknown as { preconnect?: unknown }).preconnect },
    ) as typeof fetch;
    debug.log = ((category: string, event: string, data: Record<string, unknown>): void => {
      rows.push({ category, event, data });
    }) as typeof debug.log;
    let answer: string | null = null;
    let error: string | null = null;
    try {
      answer = await streamLLMWithTools(
        [{ role: 'user', content: `pod-codex-503 ${injectionId}: go` }],
        { onText: () => {}, dispatchTool: async () => ({ ok: true }) },
        { tools: [{ name: 'pod_codex_503_probe', description: 'pod-codex-503 probe', parameters: {} }], maxTurns: 1 },
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const retryRows = rows.filter((row) => row.category === 'llm.retry');
    const events = rows.filter((row) => row.category === 'llm.router');
    const zaiRows = rows.filter((row) => row.category === 'zai.coding-plan');
    const failover = events.find((row) => row.event === 'overload-failover' && (row.data as { fallbackProvider?: unknown }).fallbackProvider === 'glm');
    const fellBack = failover !== undefined && answer === POD_CODEX_503_ZAI_ANSWER && glmCalls === 1;
    return {
      level: POD_CODEX_503_LEVEL,
      injectionId,
      fault,
      faultStatus: scripted.status,
      chain,
      result: fellBack ? 'zai-fallback' : 'no-fallback',
      resultProvider: fellBack ? 'glm' : null,
      answer: fellBack ? answer : null,
      error: fellBack ? null : error,
      glmCalls,
      scriptedResponses,
      retryRows,
      events,
      zaiRows,
    };
  } finally {
    debug.log = savedLog;
    globalThis.fetch = savedFetch;
    PROVIDERS.grok = savedGrok!;
    setUserConfigOverlay(null);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    _resetKeyCacheForTests();
    rmSync(home, { recursive: true, force: true });
  }
}
