// 결함 주입 심 «glm 자식 자격 없음» ── 하니스 자식 공급자를 glm(Z.ai GLM Coding Plan)으로 쐈는데 이 프로세스에
// Z.ai 자격이 없을 때, 발사 직전 해석(생산 `toSelfImplementOptions`)이 무엇을 내는지 프로세스 안(S1)에서 잰다.
//
// 🚨 왜 이것이 있나 (GLM-NO-CREDENTIAL-FALLBACK · OP #28375 · 2026-10-22)
// run-6c85c69f 부검이 «provider: glm / glm-5.3 · no provider configured» 한 줄로 «자격 결손 → 구현 0» 을 추정했다.
// 실측(Pod 로그)은 자격이 살아 있었고(Z.ai 200 OK) 그 줄은 배너가 glm 칸을 몰라 찍은 «거짓 표시»였다.
// 이 심은 두 축을 상주 시험으로 만든다 —
//   ① 자격이 정말 없을 때: OpenRouter 키 있음 → openrouter/z-ai/glm-5.3 로 바꿔 발사 · 둘 다 없음 → 발사 전 거부
//   ② 자격이 있을 때: 배너가 «no provider configured» 라고 거짓말하지 않는다
//
// ⛔ 흉내 내지 않는다 — 진짜 `toSelfImplementOptions`(dev-pipeline 이 runSelfImplement 직전에 부르는 그 함수) ⊕
// 진짜 `zaiCodingPlanAvailable`·`getOpenRouterApiKey`(키 캐시 → env) ⊕ 진짜 `oneLineProvider` 를 부른다.
// 주입은 «자격 env» 하나뿐이다(키 캐시 파일은 ELANOUS_KEEP_ENV_KEYS 로 끄고 기억된 값도 비운다 — 호스트의 진짜 키가 섞이지 않게).
// 관측 = 결과 선택 · 거부 문면 · self-dev.child-llm 관측 원본 · 배너 한 줄 · 영수증(명령 ⊕ injectionId ⊕ 결과) · 층 L1.

import { randomUUID } from 'node:crypto';
import { _resetKeyCacheForTests } from '../config.js';
import { debug } from '../debug/log.js';
import type { ChildLlmSelection } from '../agent/run-context.js';
import { planDevPipeline, toSelfImplementOptions } from '../self-dev/dev-pipeline.js';
import type { SelfImplementSeams } from '../self-implement/orchestrator.js';
import { inspectActiveProvider, oneLineProvider } from '../provider-summary.js';
import { getUserConfig, setUserConfigOverlay } from '../user-config.js';

export const GLM_NO_CREDENTIAL_LEVEL = 'L1' as const;
export const GLM_NO_CREDENTIAL_EVIDENCE_COMMAND = 'bun test src/ux-sim/fault-glm-no-credential.test.ts';

const ISOLATED_KEYS = ['ZAI_API_KEY', 'OPENROUTER_API_KEY'] as const;

export interface GlmNoCredentialScenario {
  /** Z.ai 자격(env ZAI_API_KEY)을 둔다. */
  readonly zaiKey: boolean;
  /** OpenRouter 자격(env OPENROUTER_API_KEY)을 둔다. */
  readonly openrouterKey: boolean;
  /** 발사 인자 모델(기본 glm-5.3). */
  readonly model?: string;
  readonly injectionId?: string;
}

export interface GlmNoCredentialObservedRow {
  readonly category: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export interface GlmNoCredentialObservation {
  readonly level: typeof GLM_NO_CREDENTIAL_LEVEL;
  readonly injectionId: string;
  readonly scenario: { zaiKey: boolean; openrouterKey: boolean; model: string };
  /** keep = glm 그대로 · fallback = openrouter 로 바꿈 · refused = 발사 전 거부. */
  readonly result: 'keep' | 'fallback' | 'refused';
  readonly childLlm: ChildLlmSelection | null;
  readonly error: string | null;
  readonly rows: readonly GlmNoCredentialObservedRow[];
  /** 같은 자격 상태에서 llm.provider=glm 일 때 배너가 찍는 한 줄(자식 PTY 첫 줄과 같은 함수). */
  readonly banner: string;
}

export function glmNoCredentialReceipt(observation: Pick<GlmNoCredentialObservation, 'injectionId' | 'result'>): string {
  return `영수증: ${GLM_NO_CREDENTIAL_EVIDENCE_COMMAND} ⊕ ${observation.injectionId} ⊕ ${observation.result}`;
}

export function renderGlmNoCredential(observation: GlmNoCredentialObservation): string[] {
  const { scenario } = observation;
  return [
    `glm-no-credential · 층 ${observation.level} · 주입 ${observation.injectionId} · zai=${scenario.zaiKey ? '있음' : '없음'} · openrouter=${scenario.openrouterKey ? '있음' : '없음'} · 결과 ${observation.result}`,
    observation.childLlm ? `  자식 선택: ${observation.childLlm.provider}/${observation.childLlm.model}` : `  거부: ${observation.error ?? '-'}`,
    ...observation.rows.map((row) => `  ${row.category} ${row.event} ${JSON.stringify(row.data)}`),
    `  배너: ${observation.banner}`,
    glmNoCredentialReceipt(observation),
  ];
}

/** 결함 주입 본체 — 생산 `toSelfImplementOptions` 를 그대로 부른다(runSelfImplement 는 부르지 않는다 · 발사 0). */
export function simGlmNoCredential(scenario: GlmNoCredentialScenario): GlmNoCredentialObservation {
  const injectionId = scenario.injectionId ?? `inj-${randomUUID()}`;
  const model = scenario.model ?? 'glm-5.3';
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of [...ISOLATED_KEYS, 'ELANOUS_KEEP_ENV_KEYS']) savedEnv[key] = process.env[key];
  const savedLog = debug.log;
  const rows: GlmNoCredentialObservedRow[] = [];
  try {
    for (const key of ISOLATED_KEYS) delete process.env[key];
    process.env.ELANOUS_KEEP_ENV_KEYS = '1';
    _resetKeyCacheForTests();
    if (scenario.zaiKey) process.env.ZAI_API_KEY = 'fake-zai-test-only';
    if (scenario.openrouterKey) process.env.OPENROUTER_API_KEY = 'fake-openrouter-test-only';
    debug.log = ((category: string, event: string, data: Record<string, unknown>): void => {
      if (category === 'self-dev.child-llm') rows.push({ category, event, data });
    }) as typeof debug.log;
    const requested: ChildLlmSelection = { provider: 'glm', model, source: 'flag' };
    const plan = planDevPipeline({ input: { text: `glm-no-credential ${injectionId}` }, executor: { kind: 'self' }, completion: 'worktree-only', self: { childLlm: requested } });
    let childLlm: ChildLlmSelection | null = null;
    let error: string | null = null;
    try {
      childLlm = toSelfImplementOptions(plan.input && 'text' in plan.input ? plan.input.text : '', plan, {} as SelfImplementSeams).childLlm ?? null;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    setUserConfigOverlay((config) => ({ ...config, llm: { ...config.llm, provider: 'glm', model } }));
    let banner: string;
    // 자격이 없으면 생산 해석기가 glm 을 «배선 안 됨» 오류로 던진다 — 그 문면을 그대로 배너 칸에 싣는다(삼키지 않는다).
    try { banner = oneLineProvider(inspectActiveProvider(getUserConfig())); }
    catch (caught) { banner = `throw: ${caught instanceof Error ? caught.message : String(caught)}`; }
    finally { setUserConfigOverlay(null); }
    const result = error !== null ? 'refused' as const : childLlm?.provider === 'glm' ? 'keep' as const : 'fallback' as const;
    return { level: GLM_NO_CREDENTIAL_LEVEL, injectionId, scenario: { zaiKey: scenario.zaiKey, openrouterKey: scenario.openrouterKey, model }, result, childLlm, error, rows, banner };
  } finally {
    debug.log = savedLog;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetKeyCacheForTests();
  }
}
