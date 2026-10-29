import { describe, expect, test } from 'bun:test';
import { podChildLlmArgs, podDelegatedChildLlm, podSelfImplementSpawn, type Kubectl } from '../src/task-orchestrator/surfaces/self-implement-pod.js';
import type { PodChildProvider } from '../src/task-orchestrator/surfaces/pod-child-providers.js';
import type { UserConfig } from '../src/user-config.js';

/**
 * PR #32295 must-fix(RED 선행 수용선) 수리 — POD-CHILD-PIN-VS-CHAIN 조합 관측.
 *
 * 실물(chain 전달 · pin 보존)은 merge-base 에 이미 있으므로 구현은 건드리지 않고,
 * 이 시험이 «실물 부재 상태에서 실패한다» 는 RED 실행 원문을 남긴다(= 수용 관측).
 * RED 원문·복구 경위: 내부 문서 `PR32295-red-evidence`
 *
 * 하나의 mock kubectl 무대(인메모리 더블 · 외부 네트워크·실물 클러스터 무접촉)에서 두 관측을
 * 한 분기로 묶는다 — 어느 하나라도 깨지면(chain 전달 stub 제거 / pin 미보존) 시험 전체가 실패해야 한다:
 *  (a) host fallback chain 이 pod-config-snapshot → Secret llm-fallback-config.json →
 *      Job 스크립트(install + ELANOUS_POD_FALLBACK_CHAIN 표지)까지 순서 그대로 끝까지 전파되고
 *      설치는 pin 달린 자식 시작 줄보다 앞선다.
 *  (b) child LLM pin 이 각 하위 전달 단계에서 보존된다 — launch 옵션 → `--child-llm-*` args
 *      (podChildLlmArgs) → 위임 파서(podDelegatedChildLlm) → delegated `elanous harness say`
 *      시작 명령 라인에 셸 인용과 함께 정확히 한 번.
 */
const PIN: { provider: PodChildProvider; model: string } = { provider: 'openrouter', model: 'openrouter/openai/gpt-6-luna' };
const CHAIN = ['codex-rotate', 'codex-credits', 'grok'];

function captureLaunch() {
  const applied: unknown[] = [];
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.includes('apply') && input) applied.push(JSON.parse(input));
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const spawn = podSelfImplementSpawn({
    kubectl, env: { OPENROUTER_API_KEY: 'or-test-key', ELANOUS_POD_AUTHOR_ON_POD: '1' }, sleep: async () => {}, budgetSnapshot: () => undefined,
    credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }),
    openrouterGhToken: () => 'gh-or-test',
    fallbackConfig: () => ({ llm: { fallbackChain: [...CHAIN] } } as UserConfig),
    provider: PIN.provider, childModel: PIN.model, childProviderExplicit: true,
  });
  return { applied, done: spawn({ feature: 'pod child pin vs chain', spaceId: 'pod-child-pin-vs-chain-test' }).done };
}

describe('POD-CHILD-PIN-VS-CHAIN combination observation', () => {
  test('test_pod_child_pin_vs_chain_combination_observation', async () => {
    const { applied, done } = captureLaunch();
    await done;
    const [secret, job] = applied as [
      { stringData: Record<string, string> },
      { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } },
    ];
    // (a1) chain 전파 — pod-config-snapshot 경로로 child 설정에 host 순서 그대로.
    const childConfig = JSON.parse(secret.stringData['llm-fallback-config.json']!);
    expect(childConfig.llm.fallbackChain).toEqual(CHAIN);
    expect(Object.keys(childConfig.llm).sort()).toEqual(['fallbackChain', 'zaiCodingPlan']);
    const script = job.spec.template.spec.containers[0]!.args[0]!;
    // (a2) chain 전파 — Job 스크립트 표지(source=host · steps 순서).
    expect(script).toContain(`ELANOUS_POD_FALLBACK_CHAIN source=host steps=${CHAIN.join(',')}`);
    // (a3) chain 전파 — Secret 설치 줄이 존재하고(부재면 -1 함정), 자식 시작 줄보다 앞선다.
    expect(script).toContain('install -m 600 /creds/llm-fallback-config.json');
    // (b1) pin 보존 — launch 옵션이 --child-llm-* args 로 들어가 위임 파서가 그대로 읽어낸다.
    const pinArgs = podChildLlmArgs({ provider: PIN.provider, childModel: PIN.model, childProviderExplicit: true });
    expect(pinArgs).toEqual(['--child-llm-provider', 'openrouter', '--child-llm-model', 'openrouter/openai/gpt-6-luna']);
    expect(podDelegatedChildLlm(pinArgs)).toEqual({ provider: 'openrouter', model: 'openrouter/openai/gpt-6-luna' });
    // (b2) pin 보존 — delegated 자식 시작 명령 라인에 셸 인용과 함께 정확히 한 번.
    const sayLine = script.split('\n').find((line) => line.includes('elanous harness say'))!;
    expect(sayLine).toContain(`'--child-llm-provider' 'openrouter' '--child-llm-model' 'openrouter/openai/gpt-6-luna'`);
    expect(sayLine.split('--child-llm-provider').length - 1).toBe(1);
    // 조합 — chain 설치가 pin 달린 자식 시작보다 앞서야 한다(위 (a3)·(b2) 존재 단언 덕에 -1 함정 없음).
    expect(script.indexOf('install -m 600 /creds/llm-fallback-config.json')).toBeLessThan(script.indexOf('elanous harness say'));
  });
});
