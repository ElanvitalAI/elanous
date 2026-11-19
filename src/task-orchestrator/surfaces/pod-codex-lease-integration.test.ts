import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { debug } from '../../debug/log.js';
let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'pod-lease-integration-')); });
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

const kubectlFixture = (manifests: any[]): Kubectl => (args, input) => {
    const command = args.join(' ');
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
    if (command.includes('jsonpath={.metadata.uid} ')) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (command.endsWith('apply -f -') && input) manifests.push(JSON.parse(input));
    if (args.includes('pods')) return { status: 0, stdout: 'si-test-pod Running\n', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: '{"stage":"merged","ok":true}\n', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

test('Pod Job mounts only the official refresh-free lease and revokes it after completion', async () => {
  const manifests: any[] = [], calls: string[] = [];
  const kubectl = kubectlFixture(manifests);
  const expiresAt = Date.now() + 600_000;
  const raw = JSON.stringify({ version: 1, providers: { 'openai-codex': { source: 'mirror', authMode: 'chatgpt', chatGPT: { accountId: 'fake-account' },
    tokens: { accessToken: 'fake-access', expiresAt, refreshToken: '', refresh_token: '' },
    lease: { leaseId: 'lease-fake', kind: 'oauth', provider: 'codex', owner: 'mshq', issuedAt: Date.now(), expiresAt } } } });
  const transport = { issue: async (_to: string, account: string, ttl: number) => { calls.push(`issue:${account}:${ttl}`); return { leaseId: 'lease-fake' }; },
    read: async () => raw, revoke: async (id: string) => { calls.push(`revoke:${id}`); } };
  const result = await podSelfImplementSpawn({ kubectl, podLeaseTransport: transport, planningCodexQuota: () => ({ usable: true }),
    openrouterGhToken: () => 'fake-gh', env: { ELANOUS_STATE_DIR: stateDir }, armEnv: { ELANOUS_CODEX_QUOTA_POLICY: 'credits' }, sleep: async () => {}, budgetSnapshot: () => undefined, deadlineSeconds: 60 })({ feature: 'x', spaceId: 'lease-job' }).done;
  expect(result.exitCode).toBe(0);
  const secret = manifests.find(m => m.kind === 'Secret');
  const store = JSON.parse(secret.stringData['elanous-auth.json']);
  expect(store.providers['openai-codex'].lease.leaseId).toBe('lease-fake');
  expect(store.providers['openai-codex'].tokens.refreshToken).toBe('');
  expect(secret.stringData['codex-auth.json']).toBeUndefined(); // eln Responses HTTP provider, not Codex CLI
  expect(calls).toEqual(['issue:default:5', 'revoke:lease-fake']); // 출처: secret oauth-lease 5m 하한
  const container = manifests.find(m => m.kind === 'Job').spec.template.spec.containers[0];
  expect(container.args[0]).not.toContain('/creds/codex-auth.json');
  expect(container.args[0]).toContain('ELANOUS_REMOTE_CODEX_ACCESS_ONLY=1'); // eln HTTP provider, not Codex CLI
  const env = container.env;
  expect(env.filter((item: { name: string }) => item.name === 'ELANOUS_CODEX_QUOTA_POLICY')).toEqual([{ name: 'ELANOUS_CODEX_QUOTA_POLICY', value: 'within-quota' }]);
});

test('a missing lease runs Luna explicitly and records codex-mirror-missing', async () => {
  const events: unknown[] = [], manifests: any[] = [];
  const off = debug.registerSink({ name: 'pod-codex-lease-fallback-test', emit: row => {
    if (row.category === 'self-implement.pod' && row.event === 'codex-fallback') events.push(row.data);
  } });
  const kubectl = kubectlFixture(manifests);
  const transport = { issue: async () => { throw new Error('missing'); }, read: async () => '', revoke: async () => {} };
  try {
    const result = await podSelfImplementSpawn({ kubectl, podLeaseTransport: transport, planningCodexQuota: () => ({ usable: true }),
      openrouterGhToken: () => 'fake-gh', env: { ELANOUS_STATE_DIR: stateDir, OPENROUTER_API_KEY: 'fake-or' }, sleep: async () => {}, budgetSnapshot: () => undefined, deadlineSeconds: 60 })({ feature: 'x', spaceId: 'lease-fallback' }).done;
    expect(result.exitCode).toBe(0);
    const script = manifests.find(m => m.kind === 'Job').spec.template.spec.containers[0].args[0];
    expect(script).toContain("'--child-llm-provider' 'openrouter'");
    expect(script).toContain("'--child-llm-model' 'openai/gpt-6-luna'");
    expect(events).toContainEqual(expect.objectContaining({ reason: 'codex-mirror-missing', provider: 'openrouter' }));
    const ledgerDir = join(stateDir, 'run-ledger');
    const ledger = readdirSync(ledgerDir).map(file => readFileSync(join(ledgerDir, file), 'utf8')).join('');
    expect(ledger).toContain('codex-mirror-missing');
    const secret = manifests.find(m => m.kind === 'Secret');
    expect(secret.stringData['elanous-auth.json']).toBeUndefined();
  } finally { off(); }
});
