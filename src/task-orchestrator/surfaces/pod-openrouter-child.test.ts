import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { podNamedChildProvider, podChildLlmArgs, podSelfImplementSpawn, POD_OPENROUTER_REVIEWER_PINS, resolvePodOpenRouterReviewer, type Kubectl } from './self-implement-pod.js';
import { resolveRoleLlm, type UserConfig } from '../../user-config.js';
import { resolveImplementationChildModel } from '../../self-dev/dev-cli.js';

const model = 'openrouter/z-ai/glm-5.3-flash';
const key = 'test-openrouter-secret-not-in-job';

function capture() {
  const applied: Array<Record<string, any>> = [];
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.includes('apply') && input) applied.push(JSON.parse(input));
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { kubectl, applied };
}

const creds = () => ({ elanousAuth: '{"providers":{}}', codexAuth: '{}', ghToken: 'gh-test' });

describe('explicit OpenRouter Pod child', () => {
  test('named provider requires a key and a model; codex and grok decisions remain independent', () => {
    expect(podNamedChildProvider('openrouter', { grokSubscription: false, grokApiKey: false, openrouterKey: true }, model)).toEqual({ provider: 'openrouter' });
    expect(podNamedChildProvider('openrouter', { grokSubscription: false, grokApiKey: false }, model).refuse).toContain('openrouter 키 없음');
    expect(podNamedChildProvider('openrouter', { grokSubscription: false, grokApiKey: false, openrouterKey: true }).refuse).toContain('모델 없음');
    expect(podNamedChildProvider('codex', { grokSubscription: false, grokApiKey: false })).toEqual({ provider: 'openai-codex' });
    expect(podNamedChildProvider('grok', { grokSubscription: true, grokApiKey: false })).toEqual({ provider: 'grok' });
    expect(podNamedChildProvider(undefined, { grokSubscription: false, grokApiKey: false })).toEqual({});
  });

  test('OpenRouter child flags carry GLM or Kimi and never infer a model', () => {
    for (const selected of [model, 'openrouter/moonshotai/kimi-k3']) {
      expect(podChildLlmArgs({ provider: 'openrouter', childModel: selected })).toEqual(['--child-llm-provider', 'openrouter', '--child-llm-model', selected]);
    }
    expect(() => podChildLlmArgs({ provider: 'openrouter' })).toThrow('모델 없음');
    expect(podChildLlmArgs({ provider: 'openai-codex' })).toEqual([]);
  });

  test('only OpenRouter Job references its Secret key; cache and env are both usable', async () => {
    const openrouter = capture();
    const appliedLogs: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'self-implement.pod' && event === 'job-applied') appliedLogs.push(data);
    }) as typeof debug.log);
    let result;
    try {
      result = await podSelfImplementSpawn({ provider: 'openrouter', childModel: model, env: {}, readKeyCache: () => key, openrouterGhToken: () => 'gh-test', kubectl: openrouter.kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'or-child' }).done;
    } finally { log.mockRestore(); }
    expect(result.exitCode).toBe(0);
    expect(appliedLogs).toContainEqual(expect.objectContaining({ openrouterKeyPresent: true }));
    expect(JSON.stringify(appliedLogs)).not.toContain(key);
    const secret = openrouter.applied.find((entry) => entry.kind === 'Secret')!;
    const job = openrouter.applied.find((entry) => entry.kind === 'Job')!;
    expect(secret.stringData['env-OPENROUTER_API_KEY']).toBe(key);
    expect(job.spec.template.spec.containers[0].env).toContainEqual({ name: 'OPENROUTER_API_KEY', valueFrom: { secretKeyRef: { name: `${job.metadata.name}-creds`, key: 'env-OPENROUTER_API_KEY' } } });
    expect(JSON.stringify(job)).not.toContain(key);
    expect(JSON.stringify(job)).toContain(`--child-llm-model`);
    expect(JSON.stringify(job)).toContain(model);
    expect(job.spec.template.spec.containers[0].args[0]).toContain('ELANOUS_LLM_PROVIDER=openrouter');

    const codex = capture();
    await podSelfImplementSpawn({ env: { OPENROUTER_API_KEY: key }, credentials: creds, kubectl: codex.kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'codex-child' }).done;
    const codexJob = codex.applied.find((entry) => entry.kind === 'Job')!;
    const codexSecret = codex.applied.find((entry) => entry.kind === 'Secret')!;
    expect(JSON.stringify(codexJob)).not.toContain('OPENROUTER_API_KEY');
    expect(JSON.stringify(codexSecret)).not.toContain('OPENROUTER_API_KEY');
    expect(JSON.stringify(codexJob)).not.toContain(key);
    const grok = capture();
    await podSelfImplementSpawn({ provider: 'grok', env: { OPENROUTER_API_KEY: key }, grokCredentials: () => ({ grokApiKey: 'test-grok-key', ghToken: 'gh-test' }), grokApiKeyOptIn: true, kubectl: grok.kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'grok-child' }).done;
    expect(JSON.stringify(grok.applied.find((entry) => entry.kind === 'Job'))).not.toContain('OPENROUTER_API_KEY');
    expect(JSON.stringify(grok.applied.find((entry) => entry.kind === 'Secret'))).not.toContain('OPENROUTER_API_KEY');
    const envChild = capture();
    await podSelfImplementSpawn({ provider: 'openrouter', childModel: model, env: { OPENROUTER_API_KEY: key }, readKeyCache: () => undefined, openrouterGhToken: () => 'gh-test', kubectl: envChild.kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'or-env' }).done;
    expect(envChild.applied.find((entry) => entry.kind === 'Secret')?.stringData['env-OPENROUTER_API_KEY']).toBe(key);
    const missing = capture();
    const refused = await podSelfImplementSpawn({ provider: 'openrouter', childModel: model, env: {}, readKeyCache: () => undefined, openrouterGhToken: () => { throw new Error('must not request GitHub token without OpenRouter key'); }, kubectl: missing.kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'or-missing' }).done;
    expect(refused.error?.message).toContain('openrouter 키 없음');
    expect(missing.applied).toEqual([]);
  });

  test('test universe without a snapshot accepts well-formed models; production and explicit snapshots keep catalog validation', () => {
    const previous = process.env.NODE_ENV;
    const previousSnapshot = process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
    try {
      delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
      process.env.NODE_ENV = 'test';
      for (const selected of [model, 'openrouter/moonshotai/kimi-k3']) {
        expect(resolveImplementationChildModel('openrouter', selected).resolvedId).toBe(selected);
      }
      for (const invalid of ['openrouter/z-ai/', 'openrouter//glm', 'openrouter/z-ai/glm/extra']) {
        expect(() => resolveImplementationChildModel('openrouter', invalid)).toThrow('--child-llm-model 알 수 없음');
      }
      process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = '/nonexistent/openrouter-catalog-snapshot.json';
      expect(() => resolveImplementationChildModel('openrouter', model)).toThrow('--child-llm-model 알 수 없음');
      delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
      process.env.NODE_ENV = 'production';
      expect(() => resolveImplementationChildModel('openrouter', model)).toThrow('--child-llm-model 알 수 없음');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
      if (previousSnapshot === undefined) delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
      else process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = previousSnapshot;
    }
  });

  describe('POD-ROLE-LLM — OpenRouter child Pods pin the reviewer off the kimi-k3 default', () => {
    const codexCreds = () => ({
      elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: 'a', refreshToken: '' } } } }),
      codexAuth: JSON.stringify({ tokens: { access_token: 'a', refresh_token: '' } }),
      ghToken: 'gh-test',
    });
    const containerEnv = (job: Record<string, any>) => job.spec.template.spec.containers[0].env as Array<{ name: string; value?: string }>;
    async function spawnOr(extra: Record<string, unknown>, spaceId: string) {
      const run = capture();
      const events: Array<{ event: string; data: any }> = [];
      const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
        if (category === 'self-implement.pod' && event.startsWith('role-llm')) events.push({ event, data });
      }) as typeof debug.log);
      let result;
      try {
        result = await podSelfImplementSpawn({ provider: 'openrouter', childModel: model, env: {}, readKeyCache: () => key, openrouterGhToken: () => 'gh-test', kubectl: run.kubectl, sleep: async () => {}, ...extra })({ feature: 'implement', spaceId }).done;
      } finally { log.mockRestore(); }
      return { result, events, job: run.applied.find((entry) => entry.kind === 'Job')!, secret: run.applied.find((entry) => entry.kind === 'Secret')! };
    }
    const podConfig = { llm: { provider: 'openrouter' } } as unknown as UserConfig;

    test('default: OpenRouter Job carries the glm-5.3 reviewer pin with no new credential', async () => {
      const { result, events, job, secret } = await spawnOr({}, 'or-review-glm');
      expect(result.exitCode).toBe(0);
      expect(resolvePodOpenRouterReviewer(undefined, {})).toEqual({ choice: 'glm', source: 'default' });
      expect(containerEnv(job)).toContainEqual({ name: 'ELANOUS_ROLE_LLM_REVIEW', value: POD_OPENROUTER_REVIEWER_PINS.glm });
      expect(secret.stringData['elanous-auth.json']).toBeUndefined();
      expect(secret.stringData['codex-auth.json']).toBeUndefined();
      expect(job.spec.template.spec.containers[0].args[0]).toContain('mkdir -p ~/.elanous && export ELANOUS_LLM_PROVIDER=openrouter');
      expect(events).toEqual([{ event: 'role-llm-armed', data: expect.objectContaining({ role: 'review', env: 'ELANOUS_ROLE_LLM_REVIEW', value: POD_OPENROUTER_REVIEWER_PINS.glm, choice: 'glm', source: 'default' }) }]);

      // Pod 안 해석 — 고정 전엔 kimi-k3(기본 사다리 review=best → openrouter 표), 고정 뒤엔 glm-5.3.
      expect(resolveRoleLlm('review', { config: podConfig, env: {} }).model).toBe('openrouter/moonshotai/kimi-k3');
      expect(resolveRoleLlm('review', { config: podConfig, env: { ELANOUS_ROLE_LLM_REVIEW: POD_OPENROUTER_REVIEWER_PINS.glm } }))
        .toEqual({ model: 'openrouter/z-ai/glm-5.3', provider: 'openrouter', source: 'environment' });
      expect(resolveRoleLlm('review', { config: podConfig, env: { ELANOUS_ROLE_LLM_REVIEW: POD_OPENROUTER_REVIEWER_PINS['codex-sol'] } }))
        .toEqual({ model: 'gpt-6-sol', provider: 'openai-codex', tier: 'best', source: 'environment' });
      // 다른 역할은 그 env 를 안 읽고, 못 읽는 값은 아래 층으로 흘린다.
      expect(resolveRoleLlm('implement', { config: podConfig, env: { ELANOUS_ROLE_LLM_REVIEW: POD_OPENROUTER_REVIEWER_PINS.glm } }).provider).toBe('openrouter');
      expect(resolveRoleLlm('review', { config: podConfig, env: { ELANOUS_ROLE_LLM_REVIEW: 'not-json' } }).model).toBe('openrouter/moonshotai/kimi-k3');
    });

    test('codex-sol (opt-in) ships the codex auth only when a credential is available; otherwise skips and keeps kimi', async () => {
      const armed = await spawnOr({ openrouterReviewer: 'codex-sol', credentials: codexCreds }, 'or-review-sol');
      expect(containerEnv(armed.job)).toContainEqual({ name: 'ELANOUS_ROLE_LLM_REVIEW', value: POD_OPENROUTER_REVIEWER_PINS['codex-sol'] });
      expect(armed.secret.stringData['elanous-auth.json']).toBe(codexCreds().elanousAuth);
      expect(armed.job.spec.template.spec.containers[0].args[0]).toContain('cp /creds/elanous-auth.json ~/.elanous/auth.json');
      expect(armed.events.map((e) => e.event)).toEqual(['role-llm-armed']);
      const armedPin = containerEnv(armed.job).find((entry) => entry.name === 'ELANOUS_ROLE_LLM_REVIEW')!.value!;
      expect(resolveRoleLlm('review', { config: podConfig, env: { ELANOUS_ROLE_LLM_REVIEW: armedPin } }))
        .toEqual({ model: 'gpt-6-sol', provider: 'openai-codex', tier: 'best', source: 'environment' });
      expect(JSON.stringify(armed.events)).not.toContain('accessToken');

      const skipped = await spawnOr({ env: { ELANOUS_POD_OR_REVIEWER: 'codex-sol' } }, 'or-review-sol-nocred');
      expect(JSON.stringify(skipped.job)).not.toContain('ELANOUS_ROLE_LLM_');
      expect(skipped.secret.stringData['elanous-auth.json']).toBeUndefined();
      expect(skipped.events).toEqual([{ event: 'role-llm-skipped', data: expect.objectContaining({ choice: 'codex-sol', source: 'env', reason: 'no-credential-source' }) }]);

      // 자격 형태가 불완전(빈 토큰·refresh 토큰 있음)하거나 조회가 던지면 고정을 건너뛴다 — 원문은 로그에 안 싣는다.
      const shapes: Array<[string, () => { elanousAuth: string; codexAuth: string; ghToken: string }, string]> = [
        ['empty', () => ({ elanousAuth: JSON.stringify({ providers: {} }), codexAuth: '{}', ghToken: 'gh-test' }), 'credential-shape'],
        ['refresh', () => ({ ...codexCreds(), codexAuth: JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'leak-refresh' } }) }), 'credential-shape'],
        ['throws', () => { throw new Error('boom secret-token-in-message'); }, 'credential-error'],
        ['no-elanous-access', () => ({ ...codexCreds(), elanousAuth: JSON.stringify({ providers: { 'openai-codex': { tokens: { refreshToken: '' } } } }) }), 'credential-shape'],
        ['blank-elanous-access', () => ({ ...codexCreds(), elanousAuth: JSON.stringify({ providers: { 'openai-codex': { tokens: { accessToken: ' ', refreshToken: '' } } } }) }), 'credential-shape'],
        ['no-codex-access', () => ({ ...codexCreds(), codexAuth: JSON.stringify({ tokens: { refresh_token: '' } }) }), 'credential-shape'],
        ['blank-codex-access', () => ({ ...codexCreds(), codexAuth: JSON.stringify({ tokens: { access_token: '', refresh_token: '' } }) }), 'credential-shape'],
      ];
      for (const [label, credentials, reason] of shapes) {
        const bad = await spawnOr({ openrouterReviewer: 'codex-sol', credentials }, `or-review-sol-${label}`);
        expect(JSON.stringify(bad.job)).not.toContain('ELANOUS_ROLE_LLM_');
        expect(bad.secret.stringData['elanous-auth.json']).toBeUndefined();
        expect(bad.events).toEqual([{ event: 'role-llm-skipped', data: expect.objectContaining({ choice: 'codex-sol', reason }) }]);
        expect(JSON.stringify(bad.events)).not.toMatch(/secret-token|leak-refresh/);
      }
      const rejected = await spawnOr({ env: { ELANOUS_POD_OR_REVIEWER: 'sk-not-a-choice' } }, 'or-review-rejected');
      expect(containerEnv(rejected.job)).toContainEqual({ name: 'ELANOUS_ROLE_LLM_REVIEW', value: POD_OPENROUTER_REVIEWER_PINS.glm });
      expect(rejected.events).toEqual([{ event: 'role-llm-armed', data: expect.objectContaining({ choice: 'glm', source: 'default', rejectedEnvValue: true }) }]);
      expect(JSON.stringify(rejected.events)).not.toContain('sk-not-a-choice');

      const off = await spawnOr({ openrouterReviewer: 'off' }, 'or-review-off');
      expect(JSON.stringify(off.job)).not.toContain('ELANOUS_ROLE_LLM_');
      expect(off.events.map((e) => e.event)).toEqual(['role-llm-skipped']);
    });

    test('invariant: codex and grok Pod manifests are byte-identical with or without the OR reviewer knob', async () => {
      const events: string[] = [];
      const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
        if (category === 'self-implement.pod' && event.startsWith('role-llm')) events.push(event);
      }) as typeof debug.log);
      const runs: Array<Record<string, any>[]> = [];
      try {
        for (const knob of [{}, { openrouterReviewer: 'codex-sol' as const, env: { ELANOUS_POD_OR_REVIEWER: 'glm' } }]) {
          const codex = capture();
          const grok = capture();
          await podSelfImplementSpawn({ env: {}, credentials: codexCreds, kubectl: codex.kubectl, sleep: async () => {}, ...knob })({ feature: 'implement', spaceId: 'codex-invariant' }).done;
          await podSelfImplementSpawn({ provider: 'grok', env: {}, grokCredentials: () => ({ grokApiKey: 'test-grok-key', ghToken: 'gh-test' }), grokApiKeyOptIn: true, credentials: codexCreds, kubectl: grok.kubectl, sleep: async () => {}, ...knob })({ feature: 'implement', spaceId: 'grok-invariant' }).done;
          runs.push([...codex.applied, ...grok.applied]);
        }
      } finally { log.mockRestore(); }
      const strip = (applied: Record<string, any>[]) => JSON.stringify(applied.filter((entry) => entry.kind === 'Job' || entry.kind === 'Secret'))
        .replace(/run-[0-9a-f-]{36}/g, 'run-<id>');   // 런 id 만 매번 새로 뽑힌다 — 나머지는 바이트 그대로여야 한다
      expect(strip(runs[0]!)).toBe(strip(runs[1]!));
      expect(strip(runs[0]!)).not.toContain('ELANOUS_ROLE_LLM_');
      expect(events).toEqual([]);
    });
  });
});
