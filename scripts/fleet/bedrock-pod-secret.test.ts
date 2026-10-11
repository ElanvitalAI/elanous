import { describe, expect, test } from 'bun:test';
import { run, type Deps } from './bedrock-pod-secret.js';

// BEDROCK-PROVIDER ② — Secret 생성 도구. ⛔ 실 ~/.aws·실 kubectl 0 — 전부 주입.
const KEY = 'AKIA-FAKE-ID-NEVER-PRINTED';
const SECRET = 'fake-secret-never-printed';

function deps(over: Partial<Deps> = {}) {
  const lines: string[] = [];
  const applied: string[] = [];
  const d: Deps = {
    resolve: async () => ({ accessKeyId: KEY, secretAccessKey: SECRET }),
    readConfig: () => '[profile elanous-bedrock]\nregion = ap-northeast-2\n',
    kubectl: (_args, stdin) => { applied.push(stdin); return { status: 0, stdout: 'secret/elanous-bedrock-aws created\n', stderr: '' }; },
    print: (line) => lines.push(line),
    ...over,
  };
  return { d, lines, applied };
}

describe('bedrock-pod-secret — host ~/.aws → bedrock Pod Secret, values never printed', () => {
  test('default is a dry-run: key names only, no cluster contact', async () => {
    const { d, lines, applied } = deps();
    expect(await run(['--context', 'k3d-elanous-pool'], d)).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION');
    expect(out).toContain('ap-northeast-2');
    expect(out).toContain('dry-run');
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(SECRET);
    expect(applied).toEqual([]);
  });

  test('--apply sends values only on kubectl stdin to the named context', async () => {
    const calls: string[][] = [];
    const { d, lines, applied } = deps({ kubectl: (args, stdin) => { calls.push(args); applied.push(stdin); return { status: 0, stdout: 'secret/elanous-bedrock-aws created\n', stderr: '' }; } });
    expect(await run(['--context', 'k3d-elanous-pool', '--apply'], d)).toBe(0);
    expect(calls).toEqual([['--context', 'k3d-elanous-pool', 'apply', '-f', '-']]);
    const manifest = JSON.parse(applied[0]!);
    expect(manifest.metadata).toEqual(expect.objectContaining({ name: 'elanous-bedrock-aws', namespace: 'elanous-test' }));
    expect(manifest.stringData.AWS_SECRET_ACCESS_KEY).toBe(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(KEY);
  });

  test('refuses: no --context · temporary credentials · no region · unresolvable profile (no message text echoed)', async () => {
    expect(await run([], deps().d)).toBe(2);
    const session = deps({ resolve: async () => ({ accessKeyId: KEY, secretAccessKey: SECRET, sessionToken: 'tok' }) });
    expect(await run(['--context', 'c', '--apply'], session.d)).toBe(2);
    expect(session.applied).toEqual([]);
    expect(await run(['--context', 'c', '--allow-session-token'], deps({ resolve: async () => ({ accessKeyId: KEY, secretAccessKey: SECRET, sessionToken: 'tok' }) }).d)).toBe(0);
    expect(await run(['--context', 'c'], deps({ readConfig: () => undefined }).d)).toBe(2);
    const broken = deps({ resolve: async () => { throw Object.assign(new Error(`bad ${SECRET}`), { name: 'CredentialsProviderError' }); } });
    expect(await run(['--context', 'c'], broken.d)).toBe(2);
    expect(broken.lines.join('\n')).not.toContain(SECRET);
  });
});
