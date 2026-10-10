import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { podChildLlmArgs, podNamedChildProvider, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { POD_CHILD_PROVIDERS, podChildProviderOf, podChildProviderRefusal } from './pod-child-providers.js';
import { podChildProviderLaunchRefusal } from '../../harness/harness-cli-command.js';
import { resolveImplementationChildModel } from '../../self-dev/dev-cli.js';

// POD-ANTHROPIC-PROVIDER (0.2.24 · 대표 10-10 키 Pod 탑재 승인) — anthropic 자식 Pod.
// ⛔ 운영 자격을 읽지 않는다: 키는 전부 주입 심(anthropicKey · readKeyCache · env)으로만 준다.
const key = 'test-anthropic-secret-not-in-job';
const model = 'claude-haiku-5-5';

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

const codexCreds = () => ({
  elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': { tokens: { accessToken: 'a', refreshToken: '' } } } }),
  codexAuth: JSON.stringify({ tokens: { access_token: 'a', refresh_token: '' } }),
  ghToken: 'gh-test',
});

describe('POD-ANTHROPIC-PROVIDER — one list for the launch gate and the Pod', () => {
  test('ⓐ the Pod child list includes anthropic; codex alias still maps', () => {
    expect(POD_CHILD_PROVIDERS).toEqual(['openai-codex', 'grok', 'openrouter', 'anthropic']);
    expect(podChildProviderOf('anthropic')).toBe('anthropic');
    expect(podChildProviderOf('codex')).toBe('openai-codex');
    expect(podChildProviderOf('gemini')).toBeUndefined();
  });

  test('ⓓ outside the list: the launch gate (pod substrate) and the Pod refuse with the same line; local is not judged', () => {
    const pod = podNamedChildProvider('gemini', { grokSubscription: false, grokApiKey: false, anthropicKey: true }).refuse;
    const gate = podChildProviderLaunchRefusal('pod', 'gemini');
    expect(gate).toBe('pod: Pod 자식 provider 는 openai-codex|grok|openrouter|anthropic 만 — 받음 gemini');
    expect(pod).toBe(gate);
    expect(podChildProviderRefusal('gemini')).toBe(gate);
    expect(podChildProviderLaunchRefusal('pod', 'anthropic')).toBeUndefined();
    expect(podChildProviderLaunchRefusal('pod', 'codex')).toBeUndefined();
    expect(podChildProviderLaunchRefusal('pod', undefined)).toBeUndefined();
    expect(podChildProviderLaunchRefusal('local', 'gemini')).toBeUndefined();
  });

  test('blank, empty and undefined names stay «unnamed» — never an anthropic Pod even with a key (codex review must-fix)', () => {
    const cred = { grokSubscription: true, grokApiKey: true, openrouterKey: true, anthropicKey: true };
    for (const named of ['   ', '', '\t', undefined]) {
      expect(podNamedChildProvider(named, cred, model)).toEqual({});
      expect(podChildProviderLaunchRefusal('pod', named)).toBeUndefined();
    }
    expect(podNamedChildProvider(' anthropic ', cred, model)).toEqual({ provider: 'anthropic' });
  });

  test('anthropic needs a key (fail-closed); the model is passed through', () => {
    expect(podNamedChildProvider('anthropic', { grokSubscription: false, grokApiKey: false, anthropicKey: true }, model)).toEqual({ provider: 'anthropic' });
    expect(podNamedChildProvider('anthropic', { grokSubscription: false, grokApiKey: false }, model).refuse).toContain('anthropic 키 없음');
    expect(podChildLlmArgs({ provider: 'anthropic', childModel: model })).toEqual(['--child-llm-provider', 'anthropic', '--child-llm-model', model]);
  });

  test('ⓒ anthropic catalog models resolve (dash and dot spellings)', () => {
    for (const [entered, id] of [['claude-haiku-5-5', 'claude-haiku-5-5'], ['claude-sonnet-5-5', 'claude-sonnet-5-5'], ['claude-haiku-5.5', 'claude-haiku-5-5'], ['claude-sonnet-5.5', 'claude-sonnet-5-5']] as const) {
      expect(resolveImplementationChildModel('anthropic', entered).resolvedId).toBe(id);
    }
  });

  test('ⓑ anthropic Job references env-ANTHROPIC_API_KEY by secretKeyRef; the value never reaches Job or logs', async () => {
    const run = capture();
    const logs: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_c: string, _e: string, data: unknown) => { logs.push(data); }) as typeof debug.log);
    let result;
    try {
      result = await podSelfImplementSpawn({ provider: 'anthropic', childModel: model, childProviderExplicit: true, env: {}, anthropicKey: () => key, openrouterGhToken: () => 'gh-test', kubectl: run.kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'anthropic-child' }).done;
    } finally { log.mockRestore(); }
    expect(result.exitCode).toBe(0);
    const secret = run.applied.find((entry) => entry.kind === 'Secret')!;
    const job = run.applied.find((entry) => entry.kind === 'Job')!;
    expect(secret.stringData['env-ANTHROPIC_API_KEY']).toBe(key);
    expect(secret.stringData['elanous-auth.json']).toBeUndefined();
    expect(secret.stringData['codex-auth.json']).toBeUndefined();
    expect(Object.keys(secret.stringData).filter((k) => k.startsWith('codex-'))).toEqual([]);
    const container = job.spec.template.spec.containers[0];
    expect(container.env).toContainEqual({ name: 'ANTHROPIC_API_KEY', valueFrom: { secretKeyRef: { name: `${job.metadata.name}-creds`, key: 'env-ANTHROPIC_API_KEY' } } });
    expect(container.env.map((e: { name: string }) => e.name).filter((n: string) => n.endsWith('_API_KEY'))).toEqual(['ANTHROPIC_API_KEY']);
    expect(container.args[0]).toContain('mkdir -p ~/.elanous && export ELANOUS_LLM_PROVIDER=anthropic');
    expect(container.args[0]).not.toContain('/creds/codex-auth.json');
    expect(JSON.stringify(job)).toContain(model);
    expect(JSON.stringify(job)).not.toContain(key);
    expect(JSON.stringify(logs)).not.toContain(key);
    expect(logs).toContainEqual(expect.objectContaining({ anthropicKeyPresent: true }));
  });

  test('ⓑ under an injected kubectl the key comes from env, then the injected cache — never the real cache', async () => {
    const fromEnv = capture();
    await podSelfImplementSpawn({ provider: 'anthropic', childModel: model, env: { ANTHROPIC_API_KEY: key }, readKeyCache: () => undefined, openrouterGhToken: () => 'gh-test', kubectl: fromEnv.kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'anthropic-env' }).done;
    expect(fromEnv.applied.find((entry) => entry.kind === 'Secret')?.stringData['env-ANTHROPIC_API_KEY']).toBe(key);
    const fromCache = capture();
    await podSelfImplementSpawn({ provider: 'anthropic', childModel: model, env: {}, readKeyCache: (n) => (n === 'ANTHROPIC_API_KEY' ? key : undefined), openrouterGhToken: () => 'gh-test', kubectl: fromCache.kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'anthropic-cache' }).done;
    expect(fromCache.applied.find((entry) => entry.kind === 'Secret')?.stringData['env-ANTHROPIC_API_KEY']).toBe(key);
  });

  test('fail-closed: no readable key → no Pod (nothing applied, no gh token requested)', async () => {
    const missing = capture();
    const refused = await podSelfImplementSpawn({ provider: 'anthropic', childModel: model, env: {}, anthropicKey: () => undefined, openrouterGhToken: () => { throw new Error('must not request GitHub token without an anthropic key'); }, kubectl: missing.kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'anthropic-missing' }).done;
    expect(refused.error?.message).toContain('anthropic 키 없음');
    expect(missing.applied).toEqual([]);
    const blank = capture();
    const blankRefused = await podSelfImplementSpawn({ provider: 'anthropic', childModel: model, env: {}, anthropicKey: () => '   ', openrouterGhToken: () => 'gh-test', kubectl: blank.kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'anthropic-blank' }).done;
    expect(blankRefused.error?.message).toContain('anthropic 키 없음');
    expect(blank.applied).toEqual([]);
  });

  test('a terminal 429 usage_limit_reached from an anthropic child never rotates onto a codex account', async () => {
    const quota = JSON.stringify({ stage: 'abandoned', ok: false, error: '429 usage_limit_reached' });
    const success = JSON.stringify({ stage: 'pr-opened', ok: true, worktreePath: '/pod/only' });
    const applied: Array<Record<string, any>> = [];
    let attempt = -1;
    const results = [quota, success];
    const kubectl: Kubectl = (args, input) => {
      const cmd = args.join(' ');
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (cmd.includes('jsonpath={.metadata.uid} ')) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (cmd.endsWith('apply -f -')) { const manifest = JSON.parse(input!); applied.push(manifest); if (manifest.kind === 'Job') attempt++; }
      if (args.includes('logs')) return { status: 0, stdout: results[attempt] ?? '', stderr: '' };
      if (cmd.includes('get job') && cmd.includes('status.conditions[*].type')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const log = spyOn(debug, 'log').mockImplementation((() => {}) as typeof debug.log);
    try {
      // 적대적 입력: codex 브로커·회전 계정·자격이 같이 와도 anthropic 자식은 codex 계정을 안 쓴다.
      await podSelfImplementSpawn({ provider: 'anthropic', childModel: model, env: {}, anthropicKey: () => key, openrouterGhToken: () => 'gh-test', credentials: codexCreds, accountBroker: () => 'team', rotationAccounts: ['default', 'team'], kubectl, sleep: async () => {} })({ feature: 'implement', spaceId: 'anthropic-429' }).done;
    } finally { log.mockRestore(); }
    expect(applied.filter((m) => m.kind === 'Job')).toHaveLength(1);
    for (const secret of applied.filter((m) => m.kind === 'Secret')) {
      expect(Object.keys(secret.stringData).filter((k) => k.startsWith('codex-') || k === 'elanous-auth.json' || k === 'codex-auth.json')).toEqual([]);
      expect(secret.stringData['env-ANTHROPIC_API_KEY']).toBe(key);
    }
  });

  test('invariant: codex · grok · openrouter Job and Secret are byte-identical whether an anthropic key is around or not', async () => {
    const runs: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation((() => {}) as typeof debug.log);
    try {
      for (const knob of [{ env: {} }, { env: { ANTHROPIC_API_KEY: key }, anthropicKey: () => key }]) {
        const codex = capture();
        const grok = capture();
        const openrouter = capture();
        const cache = (n: string) => (n === 'ANTHROPIC_API_KEY' && knob.env.ANTHROPIC_API_KEY ? key : n === 'OPENROUTER_API_KEY' ? 'sk-or-test' : undefined);
        await podSelfImplementSpawn({ credentials: codexCreds, kubectl: codex.kubectl, sleep: async () => {}, readKeyCache: cache, ...knob })({ feature: 'implement', spaceId: 'codex-invariant' }).done;
        await podSelfImplementSpawn({ provider: 'grok', grokCredentials: () => ({ grokApiKey: 'test-grok-key', ghToken: 'gh-test' }), grokApiKeyOptIn: true, kubectl: grok.kubectl, sleep: async () => {}, readKeyCache: cache, ...knob })({ feature: 'implement', spaceId: 'grok-invariant' }).done;
        await podSelfImplementSpawn({ provider: 'openrouter', childModel: 'openrouter/z-ai/glm-5.3', openrouterGhToken: () => 'gh-test', kubectl: openrouter.kubectl, sleep: async () => {}, readKeyCache: cache, ...knob })({ feature: 'implement', spaceId: 'or-invariant' }).done;
        runs.push(JSON.stringify([...codex.applied, ...grok.applied, ...openrouter.applied].filter((entry) => entry.kind === 'Job' || entry.kind === 'Secret'))
          .replace(/run-[0-9a-f-]{36}/g, 'run-<id>'));   // 런 id 만 매번 새로 뽑힌다 — 나머지는 바이트 그대로여야 한다
      }
    } finally { log.mockRestore(); }
    expect(runs[0]!.length).toBeGreaterThan(0);
    expect(runs[1]).toBe(runs[0]!);
    expect(runs[0]).not.toContain('ANTHROPIC_API_KEY');
    expect(runs[0]).not.toContain(key);
  });
});
