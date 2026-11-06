import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptSiWarmBytes, createSiWarmSourceShaResolver, postprocessSiWarmChild, siWarmEligible, siWarmFallbackFiles,
  siWarmExecutionKey,
  siWarmPayload } from './pod-si-warm-host.js';
import type { SiWarmChildAttempt } from './self-implement-pod.js';
import type { SiWarmCommand, SiWarmReply } from './pod-si-warm-protocol.js';

const input = { spaceId: 'space-a', feature: 'implement a small test change', base: 'main',
  autoMerge: true, openPr: true, draft: false };

test('warm source SHA lookup is asynchronous and coalesces concurrent leases before a short-cache hit', async () => {
  let now = 0;
  let calls = 0;
  const values = ['a'.repeat(40), 'b'.repeat(40)];
  const resolveSourceSha = createSiWarmSourceShaResolver({
    cacheMs: 1_000,
    now: () => now,
    execute: async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 5));
      now += 7;
      return values[calls - 1]!;
    },
  });

  const firstPending = resolveSourceSha('main', '/repo');
  let eventLoopAdvanced = false;
  queueMicrotask(() => { eventLoopAdvanced = true; });
  const concurrentPending = resolveSourceSha('main', '/repo');
  const [first, concurrent] = await Promise.all([firstPending, concurrentPending]);
  expect(eventLoopAdvanced).toBe(true);
  expect(first).toEqual({ sha: 'a'.repeat(40), cache: 'miss', durationMs: 7 });
  expect(concurrent).toEqual({ sha: 'a'.repeat(40), cache: 'in-flight', durationMs: 7 });

  const cached = await resolveSourceSha('main', '/repo');
  expect(cached).toEqual({ sha: 'a'.repeat(40), cache: 'hit', durationMs: 0 });
  expect(calls).toBe(1);

  now += 1_000;
  const refreshed = await resolveSourceSha('main', '/repo');
  expect(refreshed).toMatchObject({ sha: 'b'.repeat(40), cache: 'miss' });
  expect(calls).toBe(2);
});

test('warm source SHA cache is scoped to both checkout and revision and never caches failures', async () => {
  let calls = 0;
  const resolveSourceSha = createSiWarmSourceShaResolver({
    execute: async (_cwd, revision) => {
      calls++;
      if (calls === 1) throw new Error('git unavailable');
      if (calls === 2) return 'not-a-source-sha';
      return revision === 'main^{commit}' ? 'c'.repeat(40) : 'd'.repeat(40);
    },
  });

  await expect(resolveSourceSha('main', '/repo-a')).rejects.toThrow('git unavailable');
  await expect(resolveSourceSha('main', '/repo-a')).rejects.toThrow('warm source SHA is invalid');
  expect(await resolveSourceSha('main', '/repo-a')).toMatchObject({ sha: 'c'.repeat(40), cache: 'miss' });
  expect(await resolveSourceSha('main', '/repo-b')).toMatchObject({ sha: 'c'.repeat(40), cache: 'miss' });
  expect(await resolveSourceSha('develop', '/repo-a')).toMatchObject({ sha: 'd'.repeat(40), cache: 'miss' });
  expect(calls).toBe(5);
});

test('default source SHA resolver invokes real Git asynchronously and refreshes a moved ref', async () => {
  const root = mkdtempSync(join(tmpdir(), 'si-source-sha-git-'));
  let now = 0;
  const resolveSourceSha = createSiWarmSourceShaResolver({ now: () => now, cacheMs: 1_000 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'OPC Test');
    git('config', 'user.email', 'opc-test@example.invalid');
    writeFileSync(join(root, 'source.txt'), 'first');
    git('add', 'source.txt');
    git('commit', '-m', 'first');
    const first = await resolveSourceSha('HEAD', root);
    expect(first).toMatchObject({ sha: git('rev-parse', 'HEAD'), cache: 'miss' });
    expect(await resolveSourceSha('HEAD', root)).toMatchObject({ sha: first.sha, cache: 'hit' });

    writeFileSync(join(root, 'source.txt'), 'second');
    git('add', 'source.txt');
    git('commit', '-m', 'second');
    now += 1_000;
    const refreshed = await resolveSourceSha('HEAD', root);
    expect(refreshed).toMatchObject({ sha: git('rev-parse', 'HEAD'), cache: 'miss' });
    expect(refreshed.sha).not.toBe(first.sha);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('source SHA cache evicts least-recent checkout refs at its configured bound', async () => {
  let calls = 0;
  const resolveSourceSha = createSiWarmSourceShaResolver({
    maxEntries: 2,
    execute: async () => `${String.fromCharCode(97 + calls++).repeat(40)}`,
  });
  await resolveSourceSha('main', '/repo-a');
  await resolveSourceSha('main', '/repo-b');
  await resolveSourceSha('main', '/repo-c');
  const evicted = await resolveSourceSha('main', '/repo-a');
  expect(evicted).toMatchObject({ sha: 'd'.repeat(40), cache: 'miss' });
  expect(calls).toBe(4);
});

test('plain SI payload preserves the cold child flags and run identity', () => {
  const result = siWarmPayload(input, { hostSupervised: true }, 'run-a', {});
  expect(result.mode).toBe('self');
  expect(result.args).toEqual(['--base', 'main', '--merge-by-host', '--open-pr', '--no-draft', '--no-supervise']);
  expect(result.env).toEqual({ ELANOUS_RUN_ID: 'run-a' });
});

test('authoring uses the delegated harness flags rather than self-implement flags', () => {
  const result = siWarmPayload({ ...input, autoMerge: false }, { hostSupervised: true }, 'run-b',
    { ELANOUS_POD_AUTHOR_ON_POD: '1' });
  expect(result.mode).toBe('say');
  expect(result.args).toEqual(['--base', 'main', '--no-auto-merge', '--no-supervise']);
});

test('unsupported source, repair and predecessor stay on the fresh Job path', () => {
  const draft = { ...input, autoMerge: false };
  expect(siWarmEligible({ ...draft, after: 123 }, {})).toBe(false);
  expect(siWarmEligible(draft, { repairCommitOnly: { pr: 1, baseHead: 'a'.repeat(40) } })).toBe(false);
  expect(siWarmEligible(draft, { provider: 'openrouter' })).toBe(false);
  expect(siWarmEligible(draft, {}, 'openrouter')).toBe(false);
  expect(siWarmEligible(draft, {}, 'glm')).toBe(false);
  expect(siWarmEligible(draft, { provider: 'auto' as never }, 'openrouter')).toBe(false);
  expect(siWarmEligible(draft, { provider: 'openai-codex' }, 'openrouter')).toBe(true);
  expect(siWarmEligible(draft, {}, 'auto')).toBe(true);
  expect(siWarmEligible(input, {})).toBe(false);
  expect(siWarmEligible(draft, {})).toBe(true);
  expect(siWarmEligible(draft, { accountBroker: () => 'team', rotationAccounts: ['team', 'backup'] })).toBe(true);
  expect(siWarmEligible(draft, { accountBroker: () => 'team' })).toBe(false);
  expect(siWarmEligible(draft, { passEnv: ['OPENROUTER_API_KEY'] })).toBe(false);
  expect(siWarmEligible(draft, { skillEnv: true })).toBe(false);
});

test('warm credential bundle carries normalized fallback config and drops unavailable Grok', () => {
  const withoutGrok = siWarmFallbackFiles(['codex-rotate', 'grok'], null, undefined);
  expect(JSON.parse(withoutGrok['llm-fallback-config.json']!)).toEqual({
    llm: { fallbackChain: ['codex-rotate'] },
  });
  expect(withoutGrok['grok-auth.json']).toBeUndefined();
  const withGrok = siWarmFallbackFiles(['codex-rotate', 'grok', 'grok'],
    { grokAuth: '{"grok.com":{"key":"fixture"}}' }, undefined);
  expect(JSON.parse(withGrok['llm-fallback-config.json']!)).toEqual({
    llm: { fallbackChain: ['codex-rotate', 'grok'] },
  });
  expect(withGrok['grok-auth.json']).toContain('fixture');
  expect(JSON.parse(siWarmFallbackFiles(['codex-rotate', 'zai', 'claude-pty', 'openrouter', 'codex-credits'], null, undefined)
    ['llm-fallback-config.json']!)).toEqual({ llm: { fallbackChain: ['codex-rotate'] } });
  expect(() => siWarmFallbackFiles(['zai'], null, undefined)).toThrow('no carryable warm fallback provider');
  expect(() => siWarmFallbackFiles(['grok'], null, undefined)).toThrow('no carryable warm fallback provider');
  // An explicitly selected single-provider default must not silently become
  // Codex/Grok just because the warm worker cannot carry OpenRouter credentials.
  expect(() => siWarmFallbackFiles(undefined, null, 'openrouter')).toThrow('no carryable warm fallback provider');
  expect(() => siWarmFallbackFiles(undefined, null, 'glm')).toThrow('no carryable warm fallback provider');
  const autoFallback = siWarmFallbackFiles(undefined, { grokAuth: 'fixture-grok-auth' }, 'auto');
  expect(JSON.parse(autoFallback['llm-fallback-config.json']!)).toEqual({ llm: { fallbackChain: ['codex-rotate', 'grok'] } });
});

test('a repeated feature receives a distinct artifact execution key for each run', () => {
  expect(siWarmExecutionKey(input, 'run-a')).toMatch(/^[a-f0-9]{64}$/);
  expect(siWarmExecutionKey(input, 'run-a')).not.toBe(siWarmExecutionKey(input, 'run-b'));
});

test('a completed warm draft records the host terminal with its child identity', async () => {
  const seen: unknown[] = [];
  const draft = { ...input, autoMerge: false };
  const result = { exitCode: 0, output: '', disposition: { ok: true, stage: 'pr-opened',
    prNumber: 321, prUrl: 'https://github.com/owner/repo/pull/321',
    checkedHeadCommit: 'a'.repeat(40), childRunId: 'run-child' } };
  const attempt = { command: { runId: 'run-parent' } } as SiWarmChildAttempt;
  expect(await postprocessSiWarmChild(draft, result, attempt, {}, async row => { seen.push(row); })).toBe(result);
  expect(seen).toMatchObject([{ childRunId: 'run-child', prNumber: 321,
    terminalClass: 'merge-ready-not-merged' }]);
});

test('verified SI ledger and artifact bytes enter the existing host collectors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'si-adopt-'));
  try {
    const ledger = '{"runId":"run-si-a","event":"start","timestamp":"2026-10-22T00:00:00.000Z","data":{}}\n';
    const bytes = { terminal: new Uint8Array(), log: new Uint8Array(),
      ledger: Buffer.from(JSON.stringify([{ name: 'run-si-a.jsonl',
        bytes: Buffer.from(ledger).toString('base64') }])),
      artifacts: [{ path: 'evidence.txt', bytes: Buffer.from('warm evidence') }] };
    const command = { runId: 'run-si-a', executionKey: 'a'.repeat(64) } as SiWarmCommand;
    await adoptSiWarmBytes(command, {} as SiWarmReply, bytes,
      { ledgerDir: join(root, 'run-ledger'), artifactDir: join(root, 'artifacts') });
    expect(readFileSync(join(root, 'run-ledger', 'run-si-a.jsonl'), 'utf8')).toBe(ledger);
    expect(readFileSync(join(root, 'artifacts', `si-${'a'.repeat(16)}`, 'evidence.txt'), 'utf8'))
      .toBe('warm evidence');
    await expect(adoptSiWarmBytes({ ...command, runId: 'run-other' }, {} as SiWarmReply, bytes,
      { ledgerDir: join(root, 'other-ledger'), artifactDir: join(root, 'other-artifacts') }))
      .rejects.toThrow('ledger run id mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
