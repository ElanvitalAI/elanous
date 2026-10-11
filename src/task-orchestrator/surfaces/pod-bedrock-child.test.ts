import { describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { debug } from '../../debug/log.js';
import { podChildLlmArgs, podNamedChildProvider, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { POD_CHILD_PROVIDERS, podChildProviderOf, podLaunchProviderOptions } from './pod-child-providers.js';
import { BEDROCK_POD_EGRESS_LABEL, BEDROCK_POD_SECRET_NAME, checkBedrockPodSecret } from './pod-bedrock-child.js';
import { podChildProviderLaunchRefusal } from '../../harness/harness-cli-command.js';

// BEDROCK-PROVIDER ② (0.2.24 · 대표 10-10 «bedrock Pod 에만 secretKeyRef») — bedrock 자식 Pod.
// ⛔ 운영 자격·실 kubectl 을 읽지 않는다: Secret 은 «키 이름»을 내는 가짜 kubectl 로만 흉내 낸다.
const model = 'anthropic.claude-sonnet-5-5';
const SENTINEL = 'aws-secret-value-must-never-appear';

function capture(secretKeys: string[] | null) {
  const applied: Array<Record<string, any>> = [];
  const calls: string[][] = [];
  const kubectl: Kubectl = (args, input) => {
    calls.push([...args]);
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.includes('secret') && args.includes(BEDROCK_POD_SECRET_NAME) && args.includes('get')) {
      return secretKeys === null
        ? { status: 1, stdout: '', stderr: `Error from server (NotFound): secrets "${BEDROCK_POD_SECRET_NAME}" not found` }
        : { status: 0, stdout: secretKeys.map((k) => `${k}\n`).join(''), stderr: '' };
    }
    if (args.includes('apply') && input) applied.push(JSON.parse(input));
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { kubectl, applied, calls };
}

const codexCreds = () => ({
  elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: 'a', refreshToken: '' } } } }),
  codexAuth: JSON.stringify({ tokens: { access_token: 'a', refresh_token: '' } }),
  ghToken: 'gh-test',
});

async function spawnBedrock(secretKeys: string[] | null, extra: Record<string, unknown> = {}) {
  const run = capture(secretKeys);
  const logs: unknown[] = [];
  const log = spyOn(debug, 'log').mockImplementation(((_c: string, _e: string, data: unknown) => { logs.push(data); }) as typeof debug.log);
  let result;
  try {
    result = await podSelfImplementSpawn({ provider: 'bedrock', childModel: model, childProviderExplicit: true, env: { AWS_REGION: 'ap-northeast-2', AWS_SECRET_ACCESS_KEY: SENTINEL }, openrouterGhToken: () => 'gh-test', kubectl: run.kubectl, sleep: async () => {}, ...extra })({ feature: 'implement', spaceId: 'bedrock-child' }).done;
  } finally { log.mockRestore(); }
  return { ...run, result, logs };
}

describe('BEDROCK-PROVIDER ② — bedrock child Pods', () => {
  test('the one list (launch gate ⊕ Pod) admits bedrock; the child gets --child-llm-provider bedrock', () => {
    expect(POD_CHILD_PROVIDERS).toContain('bedrock');
    expect(podChildProviderOf('bedrock')).toBe('bedrock');
    expect(podChildProviderLaunchRefusal('pod', 'bedrock')).toBeUndefined();
    expect(podNamedChildProvider('bedrock', { grokSubscription: false, grokApiKey: false }, model)).toEqual({ provider: 'bedrock' });
    expect(podChildLlmArgs({ provider: 'bedrock', childModel: model })).toEqual(['--child-llm-provider', 'bedrock', '--child-llm-model', model]);
  });

  test('bedrock Job: AWS credentials only by secretKeyRef to the named Secret · region · egress label · no codex files', async () => {
    const { applied, result, logs } = await spawnBedrock(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    expect(result!.exitCode).toBe(0);
    const job = applied.find((entry) => entry.kind === 'Job')!;
    const perRun = applied.find((entry) => entry.kind === 'Secret')!;
    const container = job.spec.template.spec.containers[0];
    expect(container.env).toContainEqual({ name: 'AWS_ACCESS_KEY_ID', valueFrom: { secretKeyRef: { name: BEDROCK_POD_SECRET_NAME, key: 'AWS_ACCESS_KEY_ID' } } });
    expect(container.env).toContainEqual({ name: 'AWS_SECRET_ACCESS_KEY', valueFrom: { secretKeyRef: { name: BEDROCK_POD_SECRET_NAME, key: 'AWS_SECRET_ACCESS_KEY' } } });
    expect(container.env).toContainEqual({ name: 'AWS_REGION', value: 'ap-northeast-2' });
    // 없는 키(세션 토큰)는 싣지 않는다 — 없는 키를 가리키는 secretKeyRef 는 Pod 를 CreateContainerConfigError 로 멈춘다.
    expect(container.env.map((e: { name: string }) => e.name)).not.toContain('AWS_SESSION_TOKEN');
    expect(job.spec.template.metadata.labels[BEDROCK_POD_EGRESS_LABEL]).toBe('true');
    expect(container.args[0]).toContain('mkdir -p ~/.elanous && export ELANOUS_LLM_PROVIDER=bedrock');
    expect(container.args[0]).not.toContain('/creds/codex-auth.json');
    expect(Object.keys(perRun.stringData).filter((k) => k.startsWith('codex-') || k === 'elanous-auth.json' || k.startsWith('env-AWS'))).toEqual([]);
    // ⛔ 값은 Job·작업별 Secret·로그 어디에도 없다.
    expect(JSON.stringify(applied)).not.toContain(SENTINEL);
    expect(JSON.stringify(logs)).not.toContain(SENTINEL);
    expect(logs).toContainEqual(expect.objectContaining({ bedrockSecretKeys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], bedrockRegionFrom: 'host' }));
  });

  test('region and a session token come from the Secret when it carries them', async () => {
    const { applied } = await spawnBedrock(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION'], { env: {} });
    const env = applied.find((entry) => entry.kind === 'Job')!.spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: 'AWS_REGION', valueFrom: { secretKeyRef: { name: BEDROCK_POD_SECRET_NAME, key: 'AWS_REGION' } } });
    expect(env).toContainEqual({ name: 'AWS_SESSION_TOKEN', valueFrom: { secretKeyRef: { name: BEDROCK_POD_SECRET_NAME, key: 'AWS_SESSION_TOKEN' } } });
    expect(env.filter((e: { name: string }) => e.name === 'AWS_REGION')).toHaveLength(1);
  });

  test('fail-closed before launch: no Secret → refused, nothing applied, no GitHub token requested', async () => {
    const { applied, result } = await spawnBedrock(null, { openrouterGhToken: () => { throw new Error('must not request a GitHub token without the bedrock Secret'); } });
    expect(result!.error?.message).toContain('bedrock 자격 Secret 없음');
    expect(result!.error?.message).toContain('bedrock-pod-secret.ts');
    expect(applied).toEqual([]);
  });

  test('fail-closed: a Secret without credential keys, or no region anywhere, is refused', async () => {
    const noCreds = await spawnBedrock(['AWS_REGION']);
    expect(noCreds.result!.error?.message).toContain('자격 키가 없다');
    expect(noCreds.applied).toEqual([]);
    const noRegion = await spawnBedrock(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'], { env: {} });
    expect(noRegion.result!.error?.message).toContain('bedrock 리전 없음');
    expect(noRegion.applied).toEqual([]);
    // 리전 꼴이 아니면(호스트 이름 주입) 리전으로 안 친다.
    expect(checkBedrockPodSecret(() => ({ status: 0, stdout: 'AWS_ACCESS_KEY_ID\nAWS_SECRET_ACCESS_KEY\n', stderr: '' }), 'ns', 'us-east-1@evil.example/')).toEqual(expect.objectContaining({ ok: false }));
  });

  test('the key-name query never prints Secret values (go-template over key names only)', () => {
    const { calls, kubectl } = capture(['AWS_BEARER_TOKEN_BEDROCK']);
    const r = checkBedrockPodSecret(kubectl, 'elanous-test', 'us-east-1');
    expect(r).toEqual({ ok: true, spec: { secretName: BEDROCK_POD_SECRET_NAME, keys: ['AWS_BEARER_TOKEN_BEDROCK'], region: { from: 'host', value: 'us-east-1' } } });
    const query = calls.find((args) => args.includes('secret'))!;
    expect(query.join(' ')).toContain('go-template={{range $k, $v := .data}}{{$k}}');
    expect(query.join(' ')).not.toMatch(/\{\{\s*\$v\s*\}\}|jsonpath|-o json|-o yaml/);
  });

  test('invariant: codex · grok · openrouter · anthropic Job and Secret are byte-identical (sha256) whether the bedrock Secret / AWS env is around or not', async () => {
    const digests: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation((() => {}) as typeof debug.log);
    try {
      for (const knob of [{ keys: null, env: {} }, { keys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'], env: { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: SENTINEL, AWS_SECRET_ACCESS_KEY: SENTINEL } }]) {
        const runs = { codex: capture(knob.keys), grok: capture(knob.keys), openrouter: capture(knob.keys), anthropic: capture(knob.keys) };
        const cache = (n: string) => (n === 'OPENROUTER_API_KEY' ? 'sk-or-test' : undefined);
        await podSelfImplementSpawn({ credentials: codexCreds, kubectl: runs.codex.kubectl, sleep: async () => {}, readKeyCache: cache, env: knob.env })({ feature: 'implement', spaceId: 'codex-invariant' }).done;
        await podSelfImplementSpawn({ provider: 'grok', grokCredentials: () => ({ grokApiKey: 'test-grok-key', ghToken: 'gh-test' }), grokApiKeyOptIn: true, kubectl: runs.grok.kubectl, sleep: async () => {}, readKeyCache: cache, env: knob.env })({ feature: 'implement', spaceId: 'grok-invariant' }).done;
        await podSelfImplementSpawn({ provider: 'openrouter', childModel: 'openrouter/z-ai/glm-5.3', openrouterGhToken: () => 'gh-test', kubectl: runs.openrouter.kubectl, sleep: async () => {}, readKeyCache: cache, env: knob.env })({ feature: 'implement', spaceId: 'or-invariant' }).done;
        await podSelfImplementSpawn({ provider: 'anthropic', childModel: 'claude-haiku-5-5', anthropicKey: () => 'test-anthropic-key', openrouterGhToken: () => 'gh-test', kubectl: runs.anthropic.kubectl, sleep: async () => {}, readKeyCache: cache, env: knob.env })({ feature: 'implement', spaceId: 'anthropic-invariant' }).done;
        const manifests = Object.values(runs).flatMap((r) => r.applied).filter((entry) => entry.kind === 'Job' || entry.kind === 'Secret');
        expect(manifests).toHaveLength(8);
        const text = JSON.stringify(manifests).replace(/run-[0-9a-f-]{36}/g, 'run-<id>');   // 런 id 만 매번 새로 뽑힌다
        expect(text).not.toContain('AWS_');
        expect(text).not.toContain(BEDROCK_POD_EGRESS_LABEL);
        expect(text).not.toContain(SENTINEL);
        // 다른 공급자 경로는 bedrock Secret 을 조회하지도 않는다.
        expect(Object.values(runs).flatMap((r) => r.calls).some((args) => args.includes(BEDROCK_POD_SECRET_NAME))).toBe(false);
        digests.push(createHash('sha256').update(text).digest('hex'));
      }
    } finally { log.mockRestore(); }
    expect(digests[1]).toBe(digests[0]!);
  });

  test('egress policy opens 443 to public addresses for the bedrock label only; the shared policies do not mention it', () => {
    const policy = readFileSync('docker/h1/policy-bedrock.yaml', 'utf8');
    expect(policy).toContain(`podSelector: { matchLabels: { ${BEDROCK_POD_EGRESS_LABEL}: "true" } }`);
    expect(policy).toContain('port: 443');
    expect(policy).toContain('bedrock-mantle.');
    for (const shared of ['docker/h1/policy.yaml', 'docker/h1/policy-internet.yaml', 'docker/h1/policy-local-llm.yaml']) {
      expect(readFileSync(shared, 'utf8')).not.toContain('bedrock');
    }
  });
});

// BEDROCK-POD-PROVIDER-DROP (10-11 · MK 실측) — `--child-llm-provider bedrock` Pod 발사가 codex(team)로 돌았다:
//   index.ts podBase 가 grok·openrouter·anthropic 만 손으로 나열해 provider 를 떨궜고, podChildLlmArgs 가 «명시 ⊕ provider 없음» 을 조용히 openai-codex 로 풀었다.
describe('BEDROCK-POD-PROVIDER-DROP — the launch hands bedrock to the Pod as provider, not a codex account', () => {
  const podBaseLine = () => readFileSync('src/index.ts', 'utf8').split('\n').find((line) => line.includes('const podBase = {'))!;

  test('wiring: index.ts podBase takes provider/account from podLaunchProviderOptions — bedrock is not dropped', () => {
    const line = podBaseLine();
    expect(line).toContain('...podProviderOptions,');
    expect(line).not.toMatch(/podProvider === '(grok|openrouter|anthropic)' \? \{ provider:/);
    const src = readFileSync('src/index.ts', 'utf8');
    expect(src).toContain('podLaunchProviderOptions(podProvider, { explicitPodAccount, grokApiKeyOptIn })');
    expect(src).toContain('account: podProviderOptions.account, passEnv');
    // --pod-account 는 codex 계정을 고정한다 — bedrock 과 함께 못 쓴다.
    expect(src).toContain("named === 'anthropic' || named === 'bedrock' || named === 'glm') && explicitPodAccount");
  });

  test('bedrock → provider bedrock · account bedrock (not team/codex); all five carry provider', () => {
    expect(podLaunchProviderOptions('bedrock', { grokApiKeyOptIn: false })).toEqual({ account: 'bedrock', provider: 'bedrock' });
    expect(podLaunchProviderOptions('grok', { grokApiKeyOptIn: true })).toEqual({ account: 'grok', provider: 'grok', grokApiKeyOptIn: true });
    expect(podLaunchProviderOptions('openrouter', { grokApiKeyOptIn: true })).toEqual({ account: 'openrouter', provider: 'openrouter' });
    expect(podLaunchProviderOptions('anthropic', { grokApiKeyOptIn: true })).toEqual({ account: 'anthropic', provider: 'anthropic' });
    expect(podLaunchProviderOptions('openai-codex', { grokApiKeyOptIn: true })).toEqual({ account: 'team', provider: 'openai-codex' });
    expect(podLaunchProviderOptions('openai-codex', { explicitPodAccount: 'ops', grokApiKeyOptIn: false })).toEqual({ account: 'ops', provider: 'openai-codex' });
  });

  test('child args: bedrock named → bedrock flags · codex named → same args as before · default (unnamed) codex → no flags', () => {
    expect(podChildLlmArgs({ ...podLaunchProviderOptions('bedrock', { grokApiKeyOptIn: false }), childModel: model, childProviderExplicit: true })).toEqual(['--child-llm-provider', 'bedrock', '--child-llm-model', model]);
    expect(podChildLlmArgs({ ...podLaunchProviderOptions('openai-codex', { grokApiKeyOptIn: false }), childModel: 'gpt-6-sol', childProviderExplicit: true })).toEqual(['--child-llm-provider', 'openai-codex', '--child-llm-model', 'gpt-6-sol']);
    expect(podChildLlmArgs({ ...podLaunchProviderOptions('openai-codex', { grokApiKeyOptIn: false }) })).toEqual([]);
    expect(podChildLlmArgs({})).toEqual([]);
  });

  test('fail-closed: named but no provider, or a provider outside the list, is refused (never a silent openai-codex)', () => {
    const logs: unknown[][] = [];
    const log = spyOn(debug, 'log').mockImplementation(((...a: unknown[]) => { logs.push(a); }) as typeof debug.log);
    try {
      expect(() => podChildLlmArgs({ childModel: model, childProviderExplicit: true })).toThrow('openai-codex 로 조용히 풀지 않는다');
      expect(() => podChildLlmArgs({ provider: 'vertex' as never, childProviderExplicit: true })).toThrow('받음 vertex');
      expect(() => podChildLlmArgs({ provider: '' as never, childProviderExplicit: true })).toThrow('openai-codex 로 조용히 풀지 않는다');
    } finally { log.mockRestore(); }
    expect(logs.filter((a) => a[0] === 'self-implement.pod' && a[1] === 'child-provider-refused')).toHaveLength(3);
  });

  test('a named launch with no provider applies nothing (refused before the Job)', () => {
    const run = capture(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    const log = spyOn(debug, 'log').mockImplementation((() => {}) as typeof debug.log);
    try {
      expect(() => podSelfImplementSpawn({ account: 'team', childModel: model, childProviderExplicit: true, credentials: codexCreds, kubectl: run.kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'named-no-provider' })).toThrow();
    } finally { log.mockRestore(); }
    expect(run.applied).toEqual([]);
  });

  test('the launch options reach the Pod: Job carries the bedrock spec (secretKeyRef · egress label), not codex auth', async () => {
    const run = capture(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    const log = spyOn(debug, 'log').mockImplementation((() => {}) as typeof debug.log);
    let result;
    try {
      result = await podSelfImplementSpawn({ ...podLaunchProviderOptions('bedrock', { grokApiKeyOptIn: false }), childModel: model, childProviderExplicit: true, env: { AWS_REGION: 'us-east-1' }, openrouterGhToken: () => 'gh-test', credentials: () => { throw new Error('a bedrock launch must not read codex credentials'); }, kubectl: run.kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'bedrock-launch' }).done;
    } finally { log.mockRestore(); }
    expect(result!.exitCode).toBe(0);
    const job = run.applied.find((entry) => entry.kind === 'Job')!;
    const container = job.spec.template.spec.containers[0];
    expect(container.env).toContainEqual({ name: 'AWS_ACCESS_KEY_ID', valueFrom: { secretKeyRef: { name: BEDROCK_POD_SECRET_NAME, key: 'AWS_ACCESS_KEY_ID' } } });
    expect(container.args[0]).toContain('export ELANOUS_LLM_PROVIDER=bedrock');
    expect(container.args[0]).toContain("'--child-llm-provider' 'bedrock'");
    expect(container.args[0]).not.toContain('/creds/codex-auth.json');
    expect(job.spec.template.metadata.labels[BEDROCK_POD_EGRESS_LABEL]).toBe('true');
  });

  test('default unnamed codex launch: Job and Secret are byte-identical with or without provider: openai-codex', async () => {
    const texts: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation((() => {}) as typeof debug.log);
    try {
      for (const opts of [{ account: 'team' }, podLaunchProviderOptions('openai-codex', { grokApiKeyOptIn: false })]) {
        const run = capture(null);
        await podSelfImplementSpawn({ ...opts, credentials: codexCreds, kubectl: run.kubectl, sleep: async () => {}, env: {} })({ feature: 'implement', spaceId: 'codex-default' }).done;
        const manifests = run.applied.filter((entry) => entry.kind === 'Job' || entry.kind === 'Secret');
        expect(manifests).toHaveLength(2);
        texts.push(JSON.stringify(manifests).replace(/run-[0-9a-f-]{36}/g, 'run-<id>'));
      }
    } finally { log.mockRestore(); }
    expect(texts[0]).not.toContain('--child-llm-provider');
    expect(texts[1]).toBe(texts[0]!);
  });
});
