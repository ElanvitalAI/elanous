import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptSiWarmBytes, postprocessSiWarmChild, siWarmEligible, siWarmFallbackFiles,
  siWarmExecutionKey,
  siWarmPayload } from './pod-si-warm-host.js';
import type { SiWarmChildAttempt } from './self-implement-pod.js';
import type { SiWarmCommand, SiWarmReply } from './pod-si-warm-protocol.js';

const input = { spaceId: 'space-a', feature: 'implement a small test change', base: 'main',
  autoMerge: true, openPr: true, draft: false };

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
  expect(siWarmEligible(input, {})).toBe(false);
  expect(siWarmEligible(draft, {})).toBe(true);
  expect(siWarmEligible(draft, { accountBroker: () => 'team', rotationAccounts: ['team', 'backup'] })).toBe(true);
  expect(siWarmEligible(draft, { accountBroker: () => 'team' })).toBe(false);
  expect(siWarmEligible(draft, { passEnv: ['OPENROUTER_API_KEY'] })).toBe(false);
  expect(siWarmEligible(draft, { skillEnv: true })).toBe(false);
});

test('warm credential bundle carries normalized fallback config and drops unavailable Grok', () => {
  const withoutGrok = siWarmFallbackFiles(['codex-rotate', 'grok'], null);
  expect(JSON.parse(withoutGrok['llm-fallback-config.json']!)).toEqual({
    llm: { fallbackChain: ['codex-rotate'] },
  });
  expect(withoutGrok['grok-auth.json']).toBeUndefined();
  const withGrok = siWarmFallbackFiles(['codex-rotate', 'grok', 'grok'],
    { grokAuth: '{"grok.com":{"key":"fixture"}}' });
  expect(JSON.parse(withGrok['llm-fallback-config.json']!)).toEqual({
    llm: { fallbackChain: ['codex-rotate', 'grok'] },
  });
  expect(withGrok['grok-auth.json']).toContain('fixture');
  expect(JSON.parse(siWarmFallbackFiles(['codex-rotate', 'zai', 'claude-pty', 'openrouter', 'codex-credits'], null)
    ['llm-fallback-config.json']!)).toEqual({ llm: { fallbackChain: ['codex-rotate'] } });
  expect(() => siWarmFallbackFiles(['zai'], null)).toThrow('no carryable warm fallback provider');
  expect(() => siWarmFallbackFiles(['grok'], null)).toThrow('no carryable warm fallback provider');
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
