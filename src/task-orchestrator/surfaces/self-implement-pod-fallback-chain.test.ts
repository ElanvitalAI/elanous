import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getUserConfig, type UserConfig } from '../../user-config.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { podJobManifest, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';

function captureLaunch(config?: UserConfig, useRealHostConfig = false) {
  const applied: unknown[] = [];
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.includes('apply') && input) applied.push(JSON.parse(input));
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const spawn = podSelfImplementSpawn({
    kubectl, env: {}, sleep: async () => {}, budgetSnapshot: () => undefined,
    credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }),
    ...(!useRealHostConfig ? { fallbackConfig: () => config ?? ({ llm: {} } as UserConfig) } : {}),
  });
  return { applied, done: spawn({ feature: 'fix fallback chain', spaceId: 'fallback-chain-test' }).done };
}

describe('Pod fallback chain relay', () => {
  test('carries only the host ZAI overage policy in the child config', async () => {
    const { applied, done } = captureLaunch({ llm: {
      fallbackChain: ['codex-rotate', 'grok'],
      zaiCodingPlan: { overage: 'openrouter', maxConcurrent: 9 },
    } } as UserConfig);
    await done;
    const [secret] = applied as [{ stringData: Record<string, string> }];
    const childConfig = JSON.parse(secret.stringData['llm-fallback-config.json']!);
    expect(childConfig).toEqual({ llm: {
      fallbackChain: ['codex-rotate', 'grok'],
      zaiCodingPlan: { overage: 'openrouter' },
    } });
    expect(Object.keys(childConfig.llm).sort()).toEqual(['fallbackChain', 'zaiCodingPlan']);
  });

  test('carries the host chain in order and installs it before the child starts', async () => {
    const { applied, done } = captureLaunch({ llm: { fallbackChain: ['codex-rotate', 'codex-credits', 'grok'] } } as UserConfig);
    await done;
    const [secret, job] = applied as [
      { stringData: Record<string, string> },
      { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } },
    ];
    expect(JSON.parse(secret.stringData['llm-fallback-config.json']!)).toEqual({ llm: { fallbackChain: ['codex-rotate', 'codex-credits', 'grok'], zaiCodingPlan: { overage: 'stop' } } });
    expect(Object.keys(JSON.parse(secret.stringData['llm-fallback-config.json']!).llm).sort()).toEqual(['fallbackChain', 'zaiCodingPlan']);
    expect(Object.keys(JSON.parse(secret.stringData['llm-fallback-config.json']!))).toEqual(['llm']);
    const script = job.spec.template.spec.containers[0]!.args[0]!;
    expect(script).toContain('ELANOUS_POD_FALLBACK_CHAIN source=host steps=codex-rotate,codex-credits,grok');
    expect(script.indexOf('install -m 600 /creds/llm-fallback-config.json')).toBeLessThan(script.indexOf('elanous self implement'));
  });

  test('an absent host setting is explicitly observed as the default chain', async () => {
    const { applied, done } = captureLaunch();
    await done;
    const [secret, job] = applied as [
      { stringData: Record<string, string> },
      { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } },
    ];
    expect(JSON.parse(secret.stringData['llm-fallback-config.json']!)).toEqual({ llm: { fallbackChain: ['codex-rotate', 'grok'], zaiCodingPlan: { overage: 'stop' } } });
    expect(Object.keys(JSON.parse(secret.stringData['llm-fallback-config.json']!).llm).sort()).toEqual(['fallbackChain', 'zaiCodingPlan']);
    expect(job.spec.template.spec.containers[0]!.args[0]).toContain('ELANOUS_POD_FALLBACK_CHAIN source=default steps=codex-rotate,grok');
  });

  test('a real host config reaches the Pod even when kubectl is injected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-host-config-'));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    writeFileSync(join(root, 'config.json'), JSON.stringify({ llm: { fallbackChain: ['codex-rotate', 'codex-credits', 'grok'] } }));
    setElanousConfigDir(root);
    try {
      const { applied, done } = captureLaunch(undefined, true);
      await done;
      const [secret, job] = applied as [
        { stringData: Record<string, string> },
        { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } },
      ];
      expect(JSON.parse(secret.stringData['llm-fallback-config.json']!)).toEqual({ llm: { fallbackChain: ['codex-rotate', 'codex-credits', 'grok'], zaiCodingPlan: { overage: 'stop' } } });
      expect(Object.keys(JSON.parse(secret.stringData['llm-fallback-config.json']!).llm).sort()).toEqual(['fallbackChain', 'zaiCodingPlan']);
      expect(job.spec.template.spec.containers[0]!.args[0]).toContain('ELANOUS_POD_FALLBACK_CHAIN source=host steps=codex-rotate,codex-credits,grok');
    } finally {
      resetElanousConfigDir();
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unknown host steps are removed before either the Secret or Pod log is built', async () => {
    const { applied, done } = captureLaunch({ llm: { fallbackChain: ['codex-rotate', 'unknown-step', 'codex-credits'] } } as UserConfig);
    await done;
    const [secret, job] = applied as [
      { stringData: Record<string, string> },
      { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } },
    ];
    expect(JSON.parse(secret.stringData['llm-fallback-config.json']!)).toEqual({ llm: { fallbackChain: ['codex-rotate', 'codex-credits'], zaiCodingPlan: { overage: 'stop' } } });
    expect(job.spec.template.spec.containers[0]!.args[0]).not.toContain('unknown-step');
  });

  test('the Pod script creates a private config file from its mounted Secret', () => {
    const secret = JSON.stringify({ llm: { fallbackChain: ['codex-rotate', 'codex-credits', 'grok'] } });
    const job = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60,
      fallbackChain: { steps: ['codex-rotate', 'codex-credits', 'grok'], source: 'host' },
    }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
    const script = job.spec.template.spec.containers[0]!.args[0]!;
    const install = script.split('\n').find((line) => line.includes('install -m 600 /creds/llm-fallback-config.json'))!;
    const root = mkdtempSync(join(tmpdir(), 'pod-fallback-chain-'));
    const mount = join(root, 'creds');
    mkdirSync(mount);
    writeFileSync(join(mount, 'llm-fallback-config.json'), secret);
    try {
      const result = Bun.spawnSync(['bash', '-c', install.replace('/creds/', `${mount}/`)], { env: { ...process.env, HOME: root } });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(root, '.elanous', 'config.json'), 'utf8'))).toEqual(JSON.parse(secret));
      expect(getUserConfig(join(root, '.elanous', 'config.json')).llm.fallbackChain).toEqual(['codex-rotate', 'codex-credits', 'grok']);
      const podEnv: NodeJS.ProcessEnv = { ...process.env, HOME: root };
      delete podEnv.ELANOUS_STATE_DIR;
      delete podEnv.XDG_CONFIG_HOME;
      const child = Bun.spawnSync(['bun', '-e', `import { getUserConfig } from ${JSON.stringify(new URL('../../user-config.ts', import.meta.url).pathname)}; console.log(JSON.stringify(getUserConfig().llm.fallbackChain));`], { env: podEnv });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString().trim())).toEqual(['codex-rotate', 'codex-credits', 'grok']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
