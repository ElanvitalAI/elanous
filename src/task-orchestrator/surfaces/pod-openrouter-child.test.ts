import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { podNamedChildProvider, podChildLlmArgs, podSelfImplementSpawn, POD_OPENROUTER_REVIEWER_PINS, resolvePodOpenRouterReviewer, type Kubectl } from './self-implement-pod.js';
import { getUserConfig, resetUserConfig, resolveRoleLlm, type UserConfig } from '../../user-config.js';
import { resolveImplementationChildModel } from '../../self-dev/dev-cli.js';
import { stablePodManifestText } from './pod-manifest-test-normalize.js';
import { inspectCodexRotation } from '../../oauth/codex-account-store.js';
import { runArrivalElaboration } from '../../self-implement/goal-elaborate.js';
import { buildDefaultSelfImplementSeams, planDevPipeline } from '../../self-dev/dev-pipeline.js';
import { streamLLM } from '../../llm.js';
import { getOpenAIApiKey, getOpenRouterApiKey, _resetKeyCacheForTests } from '../../config.js';
import { resetElanousConfigDir, setElanousConfigDir, getElanousConfigDirOverride } from '../../elanous-config-dir.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const model = 'openrouter/z-ai/glm-5.3-flash';
const key = 'test-openrouter-secret-not-in-job';

test('manifest comparison keeps timestamps outside the budget snapshot', () => {
  const applied = [{ kind: 'Job', metadata: { measuredAt: 7 }, spec: { template: { spec: { containers: [{
    env: [{ name: 'ELANOUS_BUDGET_SNAPSHOT', value: JSON.stringify({ measuredAt: 123, provider: 'openrouter' }) }],
  }] } } } }, { kind: 'Secret', metadata: { measuredAt: 9 } }];
  const stable = JSON.parse(stablePodManifestText(applied));
  expect(stable[0].metadata.measuredAt).toBe(7);
  expect(stable[1].metadata.measuredAt).toBe(9);
  expect(JSON.parse(stable[0].spec.template.spec.containers[0].env[0].value)).toEqual({ measuredAt: 0, provider: 'openrouter' });
  const changed = structuredClone(applied);
  changed[0]!.spec!.template.spec.containers[0]!.env[0]!.value = '{ "measuredAt":123,"provider":"openrouter"}';
  expect(stablePodManifestText(changed)).not.toBe(stablePodManifestText(applied));
  changed[0]!.spec!.template.spec.containers[0]!.env[0]!.value = '{"provider":"openrouter"}';
  expect(() => stablePodManifestText(changed)).toThrow('exactly one numeric measuredAt');
  changed[0]!.spec!.template.spec.containers[0]!.env = [];
  expect(() => stablePodManifestText(changed)).toThrow('requires a budget snapshot');
});

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
      // 2026-10-11 CATALOG-DEEPSEEK-FLASH: `model`(glm-5.3-flash)은 이제 손 YAML(catalog/models/openrouter/)이 있어
      //   스냅숏 없이도 카탈로그에 있다 ⇒ 「카탈로그 검증이 막는다」는 손 레코드가 «없는» id 로 잰다.
      const unlisted = 'openrouter/acme/not-in-catalog';
      process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = '/nonexistent/openrouter-catalog-snapshot.json';
      expect(() => resolveImplementationChildModel('openrouter', unlisted)).toThrow('--child-llm-model 알 수 없음');
      expect(resolveImplementationChildModel('openrouter', model).resolvedId).toBe(model);
      delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
      process.env.NODE_ENV = 'production';
      expect(() => resolveImplementationChildModel('openrouter', unlisted)).toThrow('--child-llm-model 알 수 없음');
      expect(resolveImplementationChildModel('openrouter', model).resolvedId).toBe(model);
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
        if (category === 'self-implement.pod' && (event.startsWith('role-llm') || event === 'planning-model-fallback')) events.push({ event, data });
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

    test('Codex Job passes an available OpenRouter reviewer key through its Secret; keyless remains launchable', async () => {
      const pin = POD_OPENROUTER_REVIEWER_PINS.glm;
      const fallbackConfig = () => ({ llm: { provider: 'openai-codex' } }) as UserConfig;
      const withKey = capture();
      const result = await podSelfImplementSpawn({ provider: 'openai-codex', env: { OPENROUTER_API_KEY: key }, credentials: codexCreds,
        extraArgs: ['--child-llm-provider', 'openai-codex'], armEnv: { ELANOUS_ROLE_LLM_REVIEW: pin },
        fallbackConfig, readKeyCache: () => undefined, kubectl: withKey.kubectl, sleep: async () => {},
      })({ feature: 'review provider credential', spaceId: 'codex-openrouter-review-key' }).done;
      expect(result.exitCode).toBe(0);
      const secret = withKey.applied.find((entry) => entry.kind === 'Secret')!;
      const job = withKey.applied.find((entry) => entry.kind === 'Job')!;
      expect(secret.stringData['env-OPENROUTER_API_KEY']).toBe(key);
      expect(job.spec.template.spec.containers[0].env).toContainEqual({ name: 'OPENROUTER_API_KEY', valueFrom: { secretKeyRef: { name: secret.metadata.name, key: 'env-OPENROUTER_API_KEY' } } });
      expect(JSON.stringify(job)).not.toContain(key);
    }, 15_000);

    test('keyless fake Pod review provider failure skips elaboration and continues the run', async () => {
      const fakePod = capture();
      await podSelfImplementSpawn({ provider: 'openai-codex', env: {}, credentials: creds,
        extraArgs: ['--child-llm-provider', 'openai-codex'],
        armEnv: { ELANOUS_ROLE_LLM_REVIEW: POD_OPENROUTER_REVIEWER_PINS.glm }, readKeyCache: () => undefined,
        fallbackConfig: () => ({ llm: { provider: 'openai-codex' } }) as UserConfig,
        kubectl: fakePod.kubectl, sleep: async () => {},
      })({ feature: 'keyless review provider', spaceId: 'keyless-review-provider' }).done;
      const job = fakePod.applied.find((entry) => entry.kind === 'Job')!;
      const podSpec = job.spec.template.spec;
      const containers = [...(podSpec.initContainers ?? []), ...podSpec.containers];
      const childCommand = podSpec.containers[0].args[0];
      const podEnv = Object.fromEntries(containerEnv(job).filter((entry) => entry.value !== undefined)
        .map((entry) => [entry.name, entry.value!]));
      expect(childCommand).toContain("'--child-llm-provider' 'openai-codex'");
      expect(podEnv.OPENROUTER_API_KEY).toBeUndefined();
      expect(containers.flatMap((container) => container.env ?? []).some((entry) => /OPENROUTER_API_KEY/i.test(entry.name))).toBe(false);
      expect(containers.flatMap((container) => container.envFrom ?? [])).toEqual([]);
      const referencedSecretNames = new Set<string>();
      const secretVolumeNames = new Set<string>();
      for (const container of containers) {
        for (const entry of container.env ?? []) {
          if (entry.valueFrom?.secretKeyRef?.name) referencedSecretNames.add(entry.valueFrom.secretKeyRef.name);
        }
        for (const entry of container.envFrom ?? []) {
          if (entry.secretRef?.name) referencedSecretNames.add(entry.secretRef.name);
        }
      }
      for (const volume of podSpec.volumes ?? []) {
        if (volume.secret?.secretName) {
          referencedSecretNames.add(volume.secret.secretName);
          secretVolumeNames.add(volume.name);
        }
        for (const source of volume.projected?.sources ?? []) {
          if (source.secret?.name) {
            referencedSecretNames.add(source.secret.name);
            secretVolumeNames.add(volume.name);
          }
        }
      }
      const mountedSecretVolumeNames = new Set(containers.flatMap((container) => container.volumeMounts ?? [])
        .filter((mount) => secretVolumeNames.has(mount.name)).map((mount) => mount.name));
      expect(mountedSecretVolumeNames).toEqual(secretVolumeNames);
      const referencedSecrets = fakePod.applied.filter((entry) => entry.kind === 'Secret'
        && referencedSecretNames.has(entry.metadata.name));
      expect(referencedSecrets.map((entry) => entry.metadata.name).sort()).toEqual([...referencedSecretNames].sort());
      const referencedSecretKeys = referencedSecrets.flatMap((entry) => [
        ...Object.keys(entry.stringData ?? {}), ...Object.keys(entry.data ?? {}),
      ]);
      expect(referencedSecretKeys.some((name) => /OPENROUTER/i.test(name))).toBe(false);
      const referencedSecretPayloads = referencedSecrets.flatMap((entry) => [
        ...Object.values(entry.stringData ?? {}),
        ...Object.values(entry.data ?? {}).map((value: string) => Buffer.from(value, 'base64').toString('utf8')),
      ]);
      expect(referencedSecretPayloads.some((value) => value.includes(key))).toBe(false);
      expect(podEnv.ELANOUS_ROLE_LLM_REVIEW).toBe(POD_OPENROUTER_REVIEWER_PINS.glm);
      expect(resolveRoleLlm('review', { config: { llm: { provider: 'openai-codex' } } as UserConfig, env: podEnv }))
        .toMatchObject({ provider: 'openrouter', source: 'environment' });

      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const attemptedProviders: string[] = [];
      let missingCredentialFailure: string | undefined;
      const oldEnv = { ...process.env };
      const oldConfigDirOverride = getElanousConfigDirOverride();
      const isolationRoot = mkdtempSync(join(tmpdir(), 'opt-keyless-openrouter-'));
      const keyCacheDir = join(isolationRoot, 'cache');
      mkdirSync(keyCacheDir);
      writeFileSync(join(isolationRoot, 'config.json'), JSON.stringify({ llm: { reviewFallbackModels: ['gpt-4o-mini'] } }));
      setElanousConfigDir(isolationRoot);
      try {
        // Rebuild the main Pod container environment from literal env entries and Secret key refs.
        const secretByName = new Map(referencedSecrets.map((entry) => [entry.metadata.name, entry]));
        const podProcessEnv: Record<string, string> = {};
        for (const container of podSpec.containers) {
          for (const entry of container.env ?? []) {
            if (entry.value !== undefined) podProcessEnv[entry.name] = entry.value;
            const ref = entry.valueFrom?.secretKeyRef;
            if (ref) {
              const secret = secretByName.get(ref.name);
              const value = secret?.stringData?.[ref.key] ?? (secret?.data?.[ref.key]
                ? Buffer.from(secret.data[ref.key], 'base64').toString('utf8') : undefined);
              if (value !== undefined) podProcessEnv[entry.name] = value;
            }
          }
        }
        for (const name of Object.keys(process.env)) delete process.env[name];
        Object.assign(process.env, podProcessEnv, {
          ELANOUS_KEY_CACHE_DIR: keyCacheDir,
          ELANOUS_STATE_DIR: join(isolationRoot, 'state'),
        });
        mkdirSync(process.env.ELANOUS_STATE_DIR!, { recursive: true });
        _resetKeyCacheForTests();
        resetUserConfig();
        expect(getOpenRouterApiKey()).toBeUndefined();
        expect(getOpenAIApiKey()).toBeUndefined();
        const seams = await buildDefaultSelfImplementSeams(planDevPipeline({ input: { text: 'keyless Pod review' }, context: 'mission' }), {
          toolReviewerRate: 0,
          streamLLM: async (_messages, _onChunk, opts) => {
            const providerName = opts?.provider?.name ?? 'default';
            attemptedProviders.push(providerName);
            // Let every production provider attempt resolve its own cache+env credential. The isolated
            // config selects only a keyless OpenAI fallback, so neither attempt can reach the network.
            try {
              return await streamLLM(_messages, _onChunk, opts);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (message === 'openrouter unavailable: configure apiKey via `elanous setup`') {
                missingCredentialFailure = message;
              }
              throw error;
            }
          },
        });
        const step = await runArrivalElaboration({
          goal: '키 없는 Pod에서도 원래 골로 계속 진행한다', prompt: 'ROUND0', fileExists: () => true,
          callLLM: seams.elaborateCallLLM,
          observe: (event, data) => events.push({ event, data }),
        });
        expect(attemptedProviders[0]).toBe('openrouter');
        expect(attemptedProviders.every((provider) => provider === 'openrouter' || provider === 'openai')).toBe(true);
        expect(missingCredentialFailure).toBe('openrouter unavailable: configure apiKey via `elanous setup`');
        expect(step).toMatchObject({ parked: false, prompt: 'ROUND0' });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ event: 'goal-elaboration-skipped', data: { outcome: 'skipped', reason: 'provider-failed' } });
      } finally {
        _resetKeyCacheForTests();
        resetUserConfig();
        if (oldConfigDirOverride === undefined) resetElanousConfigDir();
        else setElanousConfigDir(oldConfigDirOverride);
        for (const name of Object.keys(process.env)) delete process.env[name];
        Object.assign(process.env, oldEnv);
        rmSync(isolationRoot, { recursive: true, force: true });
      }
    }, 15_000);

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

    test('planning sol on an OpenRouter author Pod reuses the reviewer Codex Secret path', async () => {
      const config = { ...podConfig, roleLlm: { planning: { model: 'gpt-6-sol' } } } as UserConfig;
      const armed = await spawnOr({ env: { ELANOUS_POD_AUTHOR_ON_POD: '1' }, authorConfig: () => config, credentials: codexCreds, planningCodexQuota: () => ({ usable: true }) }, 'or-author-sol');
      expect(armed.result.exitCode).toBe(0);
      expect(armed.secret.stringData['elanous-auth.json']).toBe(codexCreds().elanousAuth);
      expect(armed.secret.stringData['codex-auth.json']).toBe(codexCreds().codexAuth);
      expect(containerEnv(armed.job)).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL', value: 'gpt-6-sol' });
      expect(containerEnv(armed.job)).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL_RELAY', value: 'pod' });
      expect(containerEnv(armed.job)).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL_SOURCE', value: 'config-role' });
      expect(armed.job.spec.template.spec.containers[0].args[0]).toContain('cp /creds/elanous-auth.json ~/.elanous/auth.json');
      expect(armed.events).toContainEqual({ event: 'role-llm-armed', data: expect.objectContaining({ role: 'planning', source: 'config-role', model: 'gpt-6-sol' }) });
      expect(JSON.stringify(armed.job) + JSON.stringify(armed.events)).not.toContain('accessToken');
      expect(JSON.stringify(armed.job) + JSON.stringify(armed.events)).not.toContain('access_token');
    });

    test('planning sol falls back to the GLM child when quota or credential is unavailable', async () => {
      const baseConfig = getUserConfig();
      const config = { ...baseConfig, llm: { ...baseConfig.llm, provider: 'openrouter' }, roleLlm: { planning: { model: 'gpt-6-sol' } } } as UserConfig;
      const exhausted = { config, inspectCodex: (() => ({ candidates: [{ name: 'team', storeKey: 'openai-codex:team', home: '/tmp/team', reached: false, usedPercent: 98 }], policy: undefined })) as unknown as typeof inspectCodexRotation };
      for (const [label, extra, reason] of [
        ['quota', { credentials: codexCreds, budgetInputDeps: exhausted }, 'quota-exhausted'],
        ['quota-unmeasured', { credentials: codexCreds, planningCodexQuota: () => ({ usable: false, reason: 'quota-unmeasured' }) }, 'quota-unmeasured'],
        ['credential', { planningCodexQuota: () => ({ usable: true }) }, 'no-credential-source'],
        ['untrusted-reason', { planningCodexQuota: () => ({ usable: false, reason: 'secret-value-should-not-leak' }) }, 'unavailable'],
      ] as const) {
        const fallback = await spawnOr({ env: { ELANOUS_POD_AUTHOR_ON_POD: '1' }, authorConfig: () => config, ...extra }, `or-author-sol-${label}`);
        expect(fallback.result.exitCode).toBe(0);
        expect(containerEnv(fallback.job)).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL', value: model });
        expect(containerEnv(fallback.job)).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL_RELAY', value: 'pod' });
        expect(containerEnv(fallback.job)).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL_SOURCE', value: 'fallback-child' });
        expect(containerEnv(fallback.job)).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL_FALLBACK_REASON', value: reason });
        expect(containerEnv(fallback.job)).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_REQUESTED_MODEL', value: 'gpt-6-sol' });
        expect(containerEnv(fallback.job)).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_REQUESTED_SOURCE', value: 'config-role' });
        expect(fallback.events).toContainEqual({ event: 'planning-model-fallback', data: expect.objectContaining({ provider: 'openrouter', model, reason }) });
        expect(fallback.secret.stringData['elanous-auth.json']).toBeUndefined();
        expect(JSON.stringify(fallback.job) + JSON.stringify(fallback.events)).not.toContain('secret-value-should-not-leak');
      }
    });

    test('an explicit OpenRouter child replaces only the default author model without asking Codex quota', async () => {
      const available = await spawnOr({
        env: { ELANOUS_POD_AUTHOR_ON_POD: '1', ELANOUS_PR_REVIEW_MODEL: 'gpt-6-sol' },
        credentials: codexCreds,
        planningCodexQuota: () => { throw new Error('default planning must not ask Codex quota'); },
      }, 'or-author-default-codex-available');
      expect(available.result.exitCode).toBe(0);
      expect(containerEnv(available.job)).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL', value: model });
      expect(containerEnv(available.job)).toContainEqual({ name: 'ELANOUS_PROMPT_ENHANCE_MODEL_SOURCE', value: 'child' });

      expect(containerEnv(available.job).some((entry: { name: string }) => entry.name === 'ELANOUS_PROMPT_ENHANCE_REQUESTED_SOURCE')).toBe(false);

      const noChild = capture();
      expect(() => podSelfImplementSpawn({
        provider: 'openrouter', env: { ELANOUS_POD_AUTHOR_ON_POD: '1', ELANOUS_PR_REVIEW_MODEL: 'gpt-6-sol' },
        readKeyCache: () => key, openrouterGhToken: () => 'gh-test',
        planningCodexQuota: () => ({ usable: false, reason: 'quota-unmeasured' }),
        kubectl: noChild.kubectl, sleep: async () => {},
      })({ feature: 'implement', spaceId: 'or-author-both-unavailable' })).toThrow('openrouter 자식 모델 없음');
      expect(noChild.applied).toEqual([]);
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
      const strip = stablePodManifestText;
      expect(strip(runs[0]!)).toBe(strip(runs[1]!));
      expect(strip(runs[0]!)).not.toContain('ELANOUS_ROLE_LLM_');
      expect(events).toEqual([]);
    });
  });
});
