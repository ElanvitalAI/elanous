import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { debug } from '../../debug/log.js';
import { podChildLlmArgs, podNamedChildProvider, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { POD_CHILD_PROVIDERS, podChildProviderOf, podLaunchProviderOptions } from './pod-child-providers.js';
import { ZAI_POD_EGRESS_LABEL, ZAI_POD_SECRET_KEY, ZAI_POD_SECRET_NAME, checkZaiPodSecret, countActiveZaiJobs, decideZaiPodSlot, zaiOverflowChildArgs } from './pod-zai-child.js';
import { podChildProviderLaunchRefusal } from '../../harness/harness-cli-command.js';
import { resolveImplementationChildModel } from '../../self-dev/dev-cli.js';
import { childLlmSelectionEnv } from '../../agent/run-context.js';
import { describePlan, run as runSecretScript, zaiPodSecretManifest } from '../../../scripts/fleet/zai-pod-secret.js';

// ZAI-POD-CHILD (0.2.24) — glm 자식 Pod = Z.ai GLM Coding Plan. 본보기 = pod-bedrock-child.test.ts.
// ⛔ 운영 자격·실 kubectl 을 읽지 않는다: Secret·Job 목록은 가짜 kubectl 로만 흉내 낸다.
const SENTINEL = 'zai-key-value-must-never-appear';
const OR_FALLBACK = 'openrouter/z-ai/glm-5.3';

function capture(secretKeys: string[] | null, activeJobs: number | null = 0) {
  const applied: Array<Record<string, any>> = [];
  const calls: string[][] = [];
  const kubectl: Kubectl = (args, input) => {
    calls.push([...args]);
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.includes('secret') && args.includes(ZAI_POD_SECRET_NAME) && args.includes('get')) {
      return secretKeys === null
        ? { status: 1, stdout: '', stderr: `Error from server (NotFound): secrets "${ZAI_POD_SECRET_NAME}" not found` }
        : { status: 0, stdout: secretKeys.map((k) => `${k}\n`).join(''), stderr: '' };
    }
    if (args.includes('jobs') && args.includes(`${ZAI_POD_EGRESS_LABEL}=true`)) {
      if (activeJobs === null) return { status: 1, stdout: '', stderr: 'connection refused' };
      return { status: 0, stdout: [...Array.from({ length: activeJobs }, (_, i) => `zai-live-${i}  \n`), 'zai-done 1 \n', 'zai-failed  1\n'].join(''), stderr: '' };
    }
    if (args.includes('apply') && input) applied.push(JSON.parse(input));
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { kubectl, applied, calls };
}

async function spawnGlm(secretKeys: string[] | null, o: { active?: number | null; overage?: 'stop' | 'balance' | 'openrouter'; maxConcurrent?: number; extra?: Record<string, unknown> } = {}) {
  const run = capture(secretKeys, o.active === undefined ? 0 : o.active);
  const logs: Array<{ cat: string; ev: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation(((cat: string, ev: string, data: unknown) => { logs.push({ cat, ev, data }); }) as typeof debug.log);
  let result;
  try {
    result = await podSelfImplementSpawn({
      ...podLaunchProviderOptions('glm', { grokApiKeyOptIn: false }), childModel: 'glm-5.3', childProviderExplicit: true,
      env: { ZAI_API_KEY: SENTINEL }, openrouterGhToken: () => 'gh-test', kubectl: run.kubectl, sleep: async () => {},
      readKeyCache: (n: string) => (n === 'OPENROUTER_API_KEY' ? 'sk-or-test' : undefined),
      zaiSettings: () => ({ overage: o.overage ?? 'stop', maxConcurrent: o.maxConcurrent ?? 3 }),
      credentials: () => { throw new Error('a glm launch must not read codex credentials'); },
      ...(o.extra ?? {}),
    })({ feature: 'implement', spaceId: 'glm-child' }).done;
  } finally { log.mockRestore(); }
  return { ...run, result, logs };
}

describe('ZAI-POD-CHILD — glm child Pods on the Z.ai GLM Coding Plan', () => {
  test('codex Pod carries an admitted zai fallback by Secret name without switching its initial provider', async () => {
    const run = capture([ZAI_POD_SECRET_KEY]);
    const result = await podSelfImplementSpawn({
      kubectl: run.kubectl, sleep: async () => {}, env: {},
      fallbackConfig: () => ({ llm: { fallbackChain: ['codex-rotate', 'zai'] } }) as never,
      zaiSettings: () => ({ overage: 'stop', maxConcurrent: 3 }),
      credentials: () => ({ elanousAuth: JSON.stringify({ version: 1, providers: {
        'openai-codex': { tokens: { accessToken: 'fake', refreshToken: '' } },
      } }), codexAuth: JSON.stringify({ tokens: { access_token: 'fake', refresh_token: '' } }), ghToken: 'gh' }),
      openrouterGhToken: () => 'gh-test',
    })({ feature: 'implement', spaceId: 'codex-zai-fallback' }).done;
    expect(result.exitCode).toBe(0);
    const job = run.applied.find(entry => entry.kind === 'Job')!;
    const secret = run.applied.find(entry => entry.kind === 'Secret')!;
    const container = job.spec.template.spec.containers[0];
    expect(container.args[0]).toContain('/creds/codex-auth.json');
    expect(container.args[0]).not.toContain('ELANOUS_LLM_PROVIDER=glm');
    expect(container.env).toContainEqual({ name: ZAI_POD_SECRET_KEY,
      valueFrom: { secretKeyRef: { name: ZAI_POD_SECRET_NAME, key: ZAI_POD_SECRET_KEY } } });
    expect(job.metadata.labels[ZAI_POD_EGRESS_LABEL]).toBe('true');
    expect(job.spec.template.metadata.labels[ZAI_POD_EGRESS_LABEL]).toBe('true');
    expect(JSON.parse(secret.stringData['llm-fallback-config.json']).llm.fallbackChain).toEqual(['codex-rotate', 'zai']);
    expect(JSON.stringify(run.applied)).not.toContain(SENTINEL);
  });
  test('the one list (launch gate ⊕ Pod) admits glm; the child gets --child-llm-provider glm (default model glm-5.3)', () => {
    expect(POD_CHILD_PROVIDERS).toContain('glm');
    expect(podChildProviderOf('glm')).toBe('glm');
    expect(podChildProviderLaunchRefusal('pod', 'glm')).toBeUndefined();
    expect(podNamedChildProvider('glm', { grokSubscription: false, grokApiKey: false })).toEqual({ provider: 'glm' });
    expect(podLaunchProviderOptions('glm', { grokApiKeyOptIn: false })).toEqual({ account: 'glm', provider: 'glm' });
    expect(podChildLlmArgs({ provider: 'glm', childModel: 'glm-5.3-flash', childProviderExplicit: true })).toEqual(['--child-llm-provider', 'glm', '--child-llm-model', 'glm-5.3-flash']);
    expect(podChildLlmArgs({ provider: 'glm', childProviderExplicit: true })).toEqual(['--child-llm-provider', 'glm', '--child-llm-model', 'glm-5.3']);
  });

  test('inside the Pod: `self implement --child-llm-provider glm` is a known provider and ZAI_API_KEY reaches the goal-loop child', () => {
    expect(resolveImplementationChildModel('glm', 'glm-5.3').resolvedId).toBe('glm-5.3');
    expect(resolveImplementationChildModel('glm', 'glm-5.3-flash').resolvedId).toBe('glm-5.3-flash');
    expect(() => resolveImplementationChildModel('glm', 'glm-9')).toThrow('--child-llm-model 알 수 없음');
    const saved = process.env.ZAI_API_KEY;
    process.env.ZAI_API_KEY = SENTINEL;
    try {
      expect(childLlmSelectionEnv({ provider: 'glm', model: 'glm-5.3', source: 'flag' })).toEqual(expect.objectContaining({ ELANOUS_LLM_PROVIDER: 'glm', ZAI_API_KEY: SENTINEL }));
      expect(childLlmSelectionEnv({ provider: 'openrouter', model: OR_FALLBACK, source: 'flag' })).not.toHaveProperty('ZAI_API_KEY');
    } finally { if (saved === undefined) delete process.env.ZAI_API_KEY; else process.env.ZAI_API_KEY = saved; }
  });

  test('glm Job: ZAI_API_KEY only by secretKeyRef to the named Secret · egress label (Pod ⊕ Job) · no codex files · value nowhere', async () => {
    const { applied, result, logs } = await spawnGlm([ZAI_POD_SECRET_KEY]);
    expect(result!.exitCode).toBe(0);
    const job = applied.find((entry) => entry.kind === 'Job')!;
    const perRun = applied.find((entry) => entry.kind === 'Secret')!;
    const container = job.spec.template.spec.containers[0];
    expect(container.env).toContainEqual({ name: ZAI_POD_SECRET_KEY, valueFrom: { secretKeyRef: { name: ZAI_POD_SECRET_NAME, key: ZAI_POD_SECRET_KEY } } });
    expect(job.spec.template.metadata.labels[ZAI_POD_EGRESS_LABEL]).toBe('true');
    expect(job.metadata.labels[ZAI_POD_EGRESS_LABEL]).toBe('true');   // 동시 상한은 Job 라벨로 센다
    expect(container.args[0]).toContain('mkdir -p ~/.elanous && export ELANOUS_LLM_PROVIDER=glm');
    expect(container.args[0]).toContain("'--child-llm-provider' 'glm'");
    expect(container.args[0]).not.toContain('/creds/codex-auth.json');
    expect(Object.keys(perRun.stringData).filter((k) => k.startsWith('codex-') || k === 'elanous-auth.json' || k.startsWith('env-'))).toEqual([]);
    expect(JSON.stringify(applied)).not.toContain(SENTINEL);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
    expect(logs).toContainEqual(expect.objectContaining({ ev: 'zai-pod-slot', data: expect.objectContaining({ route: 'zai', active: 0, maxConcurrent: 3 }) }));
    expect(logs).toContainEqual(expect.objectContaining({ ev: 'job-applied', data: expect.objectContaining({ zaiSecret: ZAI_POD_SECRET_NAME, zaiRoute: 'zai' }) }));
  });

  test.each(['openrouter', 'balance'] as const)('admitted ZAI Pod with overage=%s carries the runtime OpenRouter fallback key by run Secret', async (overage) => {
    const { applied, result, logs } = await spawnGlm([ZAI_POD_SECRET_KEY], { overage });
    expect(result!.exitCode).toBe(0);
    const job = applied.find((entry) => entry.kind === 'Job')!;
    const perRun = applied.find((entry) => entry.kind === 'Secret')!;
    const container = job.spec.template.spec.containers[0];
    expect(container.args[0]).toContain("'--child-llm-provider' 'glm'");
    expect(container.env).toContainEqual({ name: ZAI_POD_SECRET_KEY,
      valueFrom: { secretKeyRef: { name: ZAI_POD_SECRET_NAME, key: ZAI_POD_SECRET_KEY } } });
    expect(container.env).toContainEqual({ name: 'OPENROUTER_API_KEY',
      valueFrom: { secretKeyRef: { name: perRun.metadata.name, key: 'env-OPENROUTER_API_KEY' } } });
    expect(perRun.stringData['env-OPENROUTER_API_KEY']).toBe('sk-or-test');
    expect(JSON.parse(perRun.stringData['llm-fallback-config.json']).llm.zaiCodingPlan.overage).toBe(overage);
    expect(JSON.stringify(job)).not.toContain('sk-or-test');
    expect(JSON.stringify(logs)).not.toContain('sk-or-test');
  });

  test('runtime OpenRouter overage without a host key refuses the ZAI Pod before apply', async () => {
    const noKey = await spawnGlm([ZAI_POD_SECRET_KEY], { overage: 'openrouter', extra: { readKeyCache: () => undefined } });
    expect(noKey.result!.error?.message).toContain('openrouter 키 없음');
    expect(noKey.applied).toEqual([]);
  });

  test('fail-closed before launch: no Secret, or a Secret without ZAI_API_KEY → refused, nothing applied', async () => {
    const none = await spawnGlm(null, { extra: { openrouterGhToken: () => { throw new Error('must not request a GitHub token without the ZAI Secret'); } } });
    expect(none.result!.error?.message).toContain('glm(ZAI) 자격 Secret 없음');
    expect(none.result!.error?.message).toContain('zai-pod-secret.ts');
    expect(none.applied).toEqual([]);
    const noKey = await spawnGlm(['OTHER']);
    expect(noKey.result!.error?.message).toContain(`${ZAI_POD_SECRET_KEY} 키가 없다`);
    expect(noKey.applied).toEqual([]);
  });

  test('cap full ⊕ overage=openrouter → this Pod runs the existing OpenRouter GLM (no ZAI label/key, OpenRouter key passed)', async () => {
    const { applied, result, logs, calls } = await spawnGlm([ZAI_POD_SECRET_KEY], { active: 3, overage: 'openrouter' });
    expect(result!.exitCode).toBe(0);
    const job = applied.find((entry) => entry.kind === 'Job')!;
    const container = job.spec.template.spec.containers[0];
    expect(container.args[0]).toContain("'--child-llm-provider' 'openrouter'");
    expect(container.args[0]).toContain(`'--child-llm-model' '${OR_FALLBACK}'`);
    expect(container.args[0]).toContain('export ELANOUS_LLM_PROVIDER=openrouter');
    expect(JSON.stringify(job)).not.toContain(ZAI_POD_EGRESS_LABEL);
    expect(JSON.stringify(job)).not.toContain(ZAI_POD_SECRET_KEY);
    expect(container.env.map((e: { name: string }) => e.name)).toContain('OPENROUTER_API_KEY');
    expect(logs).toContainEqual(expect.objectContaining({ ev: 'zai-pod-slot', data: expect.objectContaining({ route: 'openrouter', reason: 'full', active: 3, maxConcurrent: 3 }) }));
    // 넘친 Pod 는 ZAI Secret 을 묻지 않는다.
    expect(calls.some((args) => args.includes(ZAI_POD_SECRET_NAME))).toBe(false);
    // 넘친 Pod 도 OpenRouter 키가 호스트에 없으면 apply 전에 거부한다(명시 openrouter 갈래와 같은 fail-closed).
    const noKey = await spawnGlm([ZAI_POD_SECRET_KEY], { active: 3, overage: 'openrouter', extra: { readKeyCache: () => undefined } });
    expect(noKey.result!.error?.message).toContain('openrouter 키 없음');
    expect(noKey.applied).toEqual([]);
  });

  test('cap full ⊕ overage=stop (default) → refused before apply (no money)', async () => {
    const { applied, result } = await spawnGlm([ZAI_POD_SECRET_KEY], { active: 3, overage: 'stop' });
    expect(result!.error?.message).toContain('동시 상한 3');
    expect(result!.error?.message).toContain('overage=openrouter');
    expect(applied).toEqual([]);
  });

  test('count unreadable → treated as full (never leans past the plan) · below cap → ZAI', async () => {
    const unknown = await spawnGlm([ZAI_POD_SECRET_KEY], { active: null, overage: 'balance' });
    expect(unknown.logs).toContainEqual(expect.objectContaining({ ev: 'zai-pod-slot', data: expect.objectContaining({ route: 'openrouter', reason: 'unknown-count', active: null }) }));
    const below = await spawnGlm([ZAI_POD_SECRET_KEY], { active: 2, maxConcurrent: 3 });
    expect(below.result!.exitCode).toBe(0);
    expect(below.applied.find((e) => e.kind === 'Job')!.spec.template.metadata.labels[ZAI_POD_EGRESS_LABEL]).toBe('true');
  });

  test('pure pieces: slot decision · active-job count (finished jobs excluded) · overflow args', () => {
    expect(decideZaiPodSlot({ active: 1, pending: 1, maxConcurrent: 3, overage: 'stop' })).toEqual({ route: 'zai', active: 2, maxConcurrent: 3 });
    expect(decideZaiPodSlot({ active: 2, pending: 1, maxConcurrent: 3, overage: 'openrouter' })).toEqual({ route: 'openrouter', active: 3, maxConcurrent: 3, reason: 'full' });
    expect(decideZaiPodSlot({ active: null, pending: 0, maxConcurrent: 3, overage: 'stop' }).route).toBe('refuse');
    expect(countActiveZaiJobs(capture(null, 2).kubectl, 'ns')).toBe(2);
    expect(countActiveZaiJobs(capture(null, null).kubectl, 'ns')).toBeNull();
    expect(zaiOverflowChildArgs(['--base', 'x', '--child-llm-provider', 'glm', '--child-llm-model', 'glm-5.3-flash'], OR_FALLBACK)).toEqual(['--base', 'x', '--child-llm-provider', 'openrouter', '--child-llm-model', OR_FALLBACK]);
    expect(zaiOverflowChildArgs(['--child-llm-provider', 'glm'], OR_FALLBACK)).toEqual(['--child-llm-provider', 'openrouter', '--child-llm-model', OR_FALLBACK]);
    expect(zaiOverflowChildArgs(['--child-llm-provider', 'grok'], OR_FALLBACK)).toEqual(['--child-llm-provider', 'grok']);
  });

  test('the key-name query never prints Secret values', () => {
    const { calls, kubectl } = capture([ZAI_POD_SECRET_KEY]);
    expect(checkZaiPodSecret(kubectl, 'elanous-test')).toEqual({ ok: true, spec: { secretName: ZAI_POD_SECRET_NAME } });
    const query = calls.find((args) => args.includes('secret'))!.join(' ');
    expect(query).toContain('go-template={{range $k, $v := .data}}{{$k}}');
    expect(query).not.toMatch(/\{\{\s*\$v\s*\}\}|jsonpath|-o json|-o yaml/);
  });

  test('invariant: an openrouter Pod neither queries the ZAI Secret/jobs nor carries the ZAI label', async () => {
    const run = capture([ZAI_POD_SECRET_KEY], 0);
    const log = spyOn(debug, 'log').mockImplementation((() => {}) as typeof debug.log);
    try {
      await podSelfImplementSpawn({ provider: 'openrouter', childModel: OR_FALLBACK, openrouterGhToken: () => 'gh-test', kubectl: run.kubectl, sleep: async () => {}, readKeyCache: (n: string) => (n === 'OPENROUTER_API_KEY' ? 'sk-or-test' : undefined), env: { ZAI_API_KEY: SENTINEL }, fallbackConfig: () => ({ llm: { fallbackChain: ['zai'] } }) as never })({ feature: 'implement', spaceId: 'or-invariant' }).done;
    } finally { log.mockRestore(); }
    const text = JSON.stringify(run.applied);
    expect(text).not.toContain(ZAI_POD_EGRESS_LABEL);
    expect(text).not.toContain(SENTINEL);
    expect(run.calls.some((args) => args.includes(ZAI_POD_SECRET_NAME) || args.includes(`${ZAI_POD_EGRESS_LABEL}=true`))).toBe(false);
    const secret = run.applied.find(entry => entry.kind === 'Secret')!;
    expect(JSON.parse(secret.stringData['llm-fallback-config.json']).llm.fallbackChain).not.toContain('zai');
  });

  test('wiring: index.ts treats glm like the other key-in-cluster providers (no codex plan · no --pod-account)', () => {
    const src = readFileSync('src/index.ts', 'utf8');
    expect(src).toContain("named === 'bedrock' || named === 'glm') && explicitPodAccount");
    expect(src).toContain("namedChildDecision.provider === 'bedrock' || namedChildDecision.provider === 'glm' ? null");
    expect(src).toContain("debug.log('self-implement.pod', 'provider-named', { provider: 'glm'");
  });

  test('egress policy opens 443 for the zai label only; the shared policies do not mention it', () => {
    const policy = readFileSync('docker/h1/policy-zai.yaml', 'utf8');
    expect(policy).toContain(`podSelector: { matchLabels: { ${ZAI_POD_EGRESS_LABEL}: "true" } }`);
    expect(policy).toContain('port: 443');
    expect(policy).toContain('api.z.ai');
    for (const shared of ['docker/h1/policy.yaml', 'docker/h1/policy-internet.yaml', 'docker/h1/policy-local-llm.yaml']) {
      expect(readFileSync(shared, 'utf8')).not.toContain('zai');
    }
  });

  test('secret script: plan prints the key name only · dry-run by default · value only on kubectl stdin', async () => {
    const printed: string[] = [];
    const stdin: string[] = [];
    const deps = { key: () => SENTINEL, kubectl: (_a: string[], s: string) => { stdin.push(s); return { status: 0, stdout: 'secret/x created\n', stderr: '' }; }, print: (l: string) => { printed.push(l); } };
    expect(await runSecretScript(['--context', 'k3d-elanous-pool'], deps)).toBe(0);
    expect(stdin).toEqual([]);
    expect(await runSecretScript(['--context', 'k3d-elanous-pool', '--apply'], deps)).toBe(0);
    expect(stdin).toHaveLength(1);
    expect(JSON.parse(stdin[0]!).stringData).toEqual({ [ZAI_POD_SECRET_KEY]: SENTINEL });
    expect(printed.join('\n')).not.toContain(SENTINEL);
    expect(printed.join('\n')).toContain(ZAI_POD_SECRET_KEY);
    expect(await runSecretScript([], deps)).toBe(2);
    expect(await runSecretScript(['--context', 'c'], { ...deps, key: () => undefined })).toBe(2);
    expect(describePlan({ context: 'c', namespace: 'n', apply: false })).not.toContain(SENTINEL);
    expect(zaiPodSecretManifest({ namespace: 'n', key: 'k' })).toEqual(expect.objectContaining({ metadata: expect.objectContaining({ name: ZAI_POD_SECRET_NAME }) }));
  });
});
