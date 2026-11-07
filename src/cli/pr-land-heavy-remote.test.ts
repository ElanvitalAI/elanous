import { expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessPrLandTypecheckDrift, ensurePrLandHeavyRemote, PR_LAND_HEAVY_HOSTS, validatePrLandRemoteGitReceipt, type PrLandRemoteGitRequest } from './pr-land-heavy-remote.js';
import { classifyPrLandRefusal } from './pr-land-refusal.js';
import { GATE_REMOTE_DEFAULTS, type RemoteRunOptions } from '../self-implement/gate-remote.js';
import { runBunShard } from '../self-dev/shard-run.js';
import { runSelfGateCli } from '../self-implement/gate-cli.js';
import { debug } from '../debug/log.js';
import { decideWarmReuse, type WarmReuseEvidence } from '../task-orchestrator/surfaces/pod-warm-switch.js';
import type { LandShadowSampleWindow, LandingShadowSample } from './pr-land-pod-shadow-job.js';

const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const NEXT_MAIN = 'c'.repeat(40);
const extraPass = Buffer.from('[pr-land-extra-gates] pass global=measured interference=measured files=2\n');

test('pinned typecheck delta is classified only from one matching-main summary', () => {
  const drift = `[tsc-main-delta] base=${MAIN} base_rc=1 head=${HEAD} head_rc=1 baseline_errors=3 head_errors=5 new_errors=2\nerror: main-baseline tsc introduced 2 TypeScript diagnostic(s)`;
  expect(assessPrLandTypecheckDrift(drift, MAIN)).toBe('drift');
  expect(assessPrLandTypecheckDrift(drift, NEXT_MAIN)).toBe('drift-unmeasured');
  expect(assessPrLandTypecheckDrift(`[tsc-main-delta] base=${MAIN} base_rc=0 head=${HEAD} head_rc=0 baseline_errors=0 head_errors=0 new_errors=0`, MAIN)).toBe('drift-unrelated');
  expect(assessPrLandTypecheckDrift(`[tsc-main-delta] base=${MAIN} new_errors=2`, MAIN)).toBe('drift-unmeasured');
  expect(assessPrLandTypecheckDrift(`${drift}\n${drift}`, MAIN)).toBe('drift-unmeasured');
  expect(assessPrLandTypecheckDrift(`${drift}\n[tsc-main-delta]base=${MAIN} new_errors=2`, MAIN)).toBe('drift-unmeasured');
  expect(assessPrLandTypecheckDrift(`${drift}\nerror: main-baseline tsc introduced 2 TypeScript diagnostic(s)`, MAIN)).toBe('drift-unmeasured');
  expect(assessPrLandTypecheckDrift(`${drift}\nerror: main-baseline tsc introduced 1 TypeScript diagnostic(s)`, MAIN)).toBe('drift-unmeasured');
  expect(assessPrLandTypecheckDrift(`[tsc-main-delta] base=${MAIN} base_rc=0 head=${HEAD} head_rc=0 baseline_errors=0 head_errors=0 new_errors=0\nerror: main-baseline tsc introduced 1 TypeScript diagnostic(s)`, MAIN)).toBe('drift-unmeasured');
});

test('a matching remote heavy-gate failure carries its pinned typecheck drift verdict', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-drift-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 92, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from(`[tsc-main-delta] base=${MAIN} base_rc=1 head=${HEAD} head_rc=1 baseline_errors=3 head_errors=5 new_errors=2\n`),
        stderr: Buffer.from('error: main-baseline tsc introduced 2 TypeScript diagnostic(s)\n') }),
    });
    expect(result).toMatchObject({ ok: false, typecheckDrift: 'drift' });
    expect(classifyPrLandRefusal(`✗ heavy-remote: 원격 게이트 ${result.reason} — 로컬 게이트로 폴백하지 않는다.`, {
      typecheckDrift: result.typecheckDrift,
    })).toBe('typecheck-drift');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('typecheck drift evidence does not cross a remote head or host identity mismatch', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-drift-identity-'));
  try {
    const output = Buffer.from(`[tsc-main-delta] base=${MAIN} base_rc=1 head=${HEAD} head_rc=1 baseline_errors=3 head_errors=5 new_errors=2\nerror: main-baseline tsc introduced 2 TypeScript diagnostic(s)`);
    for (const runRemote of [
      () => ({ kind: 'ran' as const, rc: 1, commit: NEXT_MAIN, host: 'node-b', ms: 1, stdout: output, stderr: Buffer.alloc(0) }),
      () => ({ kind: 'ran' as const, rc: 1, commit: HEAD, host: 'node-c', ms: 1, stdout: output, stderr: Buffer.alloc(0) }),
    ]) {
      const result = ensurePrLandHeavyRemote({ pr: 93, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
        settings: GATE_REMOTE_DEFAULTS, observe: () => {}, runRemote,
      });
      expect(result.typecheckDrift).toBeUndefined();
    }
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('remote git receipt contract requires matching pinned identity and result SHAs', () => {
  const request: PrLandRemoteGitRequest = {
    schema: 1, pr: 123, repository: 'ElanvitalAI/elanous', headRef: 'refs/heads/feature/topic',
    head: HEAD, main: MAIN, phase: 'rebase', host: 'node-b',
  };
  const receipt = { ...request, ok: true, resultHead: HEAD, mergeSha: MAIN };
  expect(validatePrLandRemoteGitReceipt(request, receipt)).toEqual({ ok: true, resultHead: HEAD, mergeSha: MAIN, remoteHeadVerification: 'pending-push' });
  expect(validatePrLandRemoteGitReceipt(request, { ...receipt, pr: 124 })).toEqual({ ok: false, reason: 'receipt-identity-mismatch' });
  expect(validatePrLandRemoteGitReceipt(request, { ...receipt, host: 'untrusted' })).toEqual({ ok: false, reason: 'receipt-identity-mismatch' });
  expect(validatePrLandRemoteGitReceipt({ ...request, host: 'untrusted' as PrLandRemoteGitRequest['host'] }, receipt))
    .toEqual({ ok: false, reason: 'invalid-request-identity' });
  expect(validatePrLandRemoteGitReceipt({ ...request, schema: 2 as 1 }, receipt))
    .toEqual({ ok: false, reason: 'invalid-request-identity' });
  expect(validatePrLandRemoteGitReceipt({ ...request, phase: 'clone' as PrLandRemoteGitRequest['phase'] }, receipt))
    .toEqual({ ok: false, reason: 'invalid-request-identity' });
  expect(validatePrLandRemoteGitReceipt(request, { ...receipt, schema: 2 })).toEqual({ ok: false, reason: 'receipt-identity-mismatch' });
  expect(validatePrLandRemoteGitReceipt(request, { ...receipt, phase: 'clone' })).toEqual({ ok: false, reason: 'receipt-identity-mismatch' });
  expect(validatePrLandRemoteGitReceipt({ ...request, repository: 'bad repo' }, receipt))
    .toEqual({ ok: false, reason: 'invalid-request-identity' });
  expect(validatePrLandRemoteGitReceipt({ ...request, headRef: 'feature/topic' }, receipt))
    .toEqual({ ok: false, reason: 'invalid-request-identity' });
  expect(validatePrLandRemoteGitReceipt({ ...request, headRef: 'refs/heads/feature/a+b' }, {
    ...receipt, headRef: 'refs/heads/feature/a+b',
  })).toEqual({ ok: true, resultHead: HEAD, mergeSha: MAIN, remoteHeadVerification: 'pending-push' });
  expect(validatePrLandRemoteGitReceipt({ ...request, headRef: 'refs/heads/@' }, {
    ...receipt, headRef: 'refs/heads/@',
  })).toEqual({ ok: true, resultHead: HEAD, mergeSha: MAIN, remoteHeadVerification: 'pending-push' });
  expect(validatePrLandRemoteGitReceipt({ ...request, headRef: 'refs/heads/feature/.hidden' }, receipt))
    .toEqual({ ok: false, reason: 'invalid-request-identity' });
  expect(validatePrLandRemoteGitReceipt(request, { ...receipt, mergeSha: NEXT_MAIN })).toEqual({ ok: false, reason: 'remote-main-mismatch' });
  expect(validatePrLandRemoteGitReceipt(request, { ...receipt, ok: false, reason: 'remote-push-rejected' }))
    .toEqual({ ok: false, reason: 'remote-push-rejected' });
  expect(validatePrLandRemoteGitReceipt(request, { ...receipt, resultHead: 'unmeasured' }))
    .toEqual({ ok: false, reason: 'receipt-result-unmeasured' });
  expect(validatePrLandRemoteGitReceipt(request, { ...receipt, resultHead: '0'.repeat(40) }))
    .toEqual({ ok: false, reason: 'receipt-result-unmeasured' });
  expect(validatePrLandRemoteGitReceipt({ ...request, head: '0'.repeat(40) }, receipt))
    .toEqual({ ok: false, reason: 'invalid-request-identity' });
  expect(validatePrLandRemoteGitReceipt({ ...request, main: '0'.repeat(40) }, receipt))
    .toEqual({ ok: false, reason: 'invalid-request-identity' });
  expect(validatePrLandRemoteGitReceipt(request, { ...receipt, mergeSha: '0'.repeat(40) }))
    .toEqual({ ok: false, reason: 'receipt-result-unmeasured' });
  const pushRequest = { ...request, phase: 'push' as const };
  const pushReceipt = { ...receipt, phase: 'push' as const, resultHead: NEXT_MAIN };
  expect(validatePrLandRemoteGitReceipt(pushRequest, pushReceipt)).toEqual({ ok: false, reason: 'post-push-ls-remote-unmeasured' });
  expect(validatePrLandRemoteGitReceipt(pushRequest, pushReceipt, MAIN)).toEqual({ ok: false, reason: 'post-push-head-mismatch' });
  expect(validatePrLandRemoteGitReceipt(pushRequest, pushReceipt, NEXT_MAIN))
    .toEqual({ ok: true, resultHead: NEXT_MAIN, mergeSha: MAIN, remoteHeadVerification: 'matched' });
  expect(validatePrLandRemoteGitReceipt(pushRequest, pushReceipt, '0'.repeat(40)))
    .toEqual({ ok: false, reason: 'post-push-ls-remote-unmeasured' });
  expect(validatePrLandRemoteGitReceipt(request, { ...receipt, ok: false, reason: { private: true } }))
    .toEqual({ ok: false, reason: 'remote-git-failed' });
});

test('a remote pass is reused only for the same PR head and main tip', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const calls: RemoteRunOptions[] = [];
  const input = { pr: 51, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const runRemote = (options: RemoteRunOptions) => {
    calls.push(options);
    return { kind: 'ran' as const, rc: 0, stdout: Buffer.from('[tsc-gate] root-plan {"mode":"affected","roots":534,"promoted":false,"reason":"large-affected-kept"}\n[pr-land-extra-gates] pass global=measured interference=measured files=6\n'), stderr: Buffer.alloc(0), commit: options.commit!, host: 'node-b', ms: 32 };
  };
  const deps = { settings: GATE_REMOTE_DEFAULTS, runRemote, observe: () => {} };
  try {
    expect(ensurePrLandHeavyRemote(input, deps)).toMatchObject({ ok: true, source: 'remote' });
    expect(ensurePrLandHeavyRemote(input, deps)).toMatchObject({ ok: true, source: 'cached', interferenceMeasured: true, rootPlan: { mode: 'affected', roots: 534, promoted: false, reason: 'large-affected-kept' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ host: 'node-b', commit: HEAD, refs: [MAIN], installPwa: true, stableCheckout: true });
    const argv = (calls[0]!.argv as (sha: (ref: string) => string) => string[])((ref) => ref);
    expect(argv).toEqual(['sh', '-c', expect.stringContaining('merge --no-ff --no-edit "$1"'), 'sh', MAIN]);
    expect(argv.join(' ')).toContain('bash scripts/ci-typecheck-main-delta.sh "$1"');
    expect(argv.join(' ')).toContain('self gate --changed --base "$1" --local --shards 4');
    expect(argv.join(' ')).toContain('bun scripts/pr-land-extra-remote-gates.ts "$1"');
    expect(ensurePrLandHeavyRemote({ ...input, main: NEXT_MAIN }, deps)).toMatchObject({ ok: true, source: 'remote' });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(evidenceDir, '51.json'), 'utf8'))).toMatchObject({ head: HEAD, main: NEXT_MAIN, host: 'node-b' });
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('old heavy-gate evidence cannot skip the main-baseline TSC check', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-stale-schema-'));
  const input = { pr: 79, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const path = join(evidenceDir, '79.json');
  writeFileSync(path, JSON.stringify({
    schema: 2, pr: 79, head: HEAD, main: MAIN, host: 'node-b', passedAt: '2026-10-30T00:00:00.000Z',
    elapsedMs: 1, rootPlan: null, interferenceMeasured: true,
  }));
  let remoteCalls = 0;
  try {
    const result = ensurePrLandHeavyRemote(input, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: (options: RemoteRunOptions) => {
        remoteCalls++;
        return { kind: 'ran', rc: 0, stdout: extraPass, stderr: Buffer.alloc(0), commit: options.commit!, host: 'node-b', ms: 2 };
      },
    });
    expect(result).toMatchObject({ ok: true, source: 'remote' });
    expect(remoteCalls).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ schema: 3 });
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('unreachable host and failed gate refuse without a local fallback or reusable pass', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 51, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  try {
    expect(ensurePrLandHeavyRemote(input, { settings: GATE_REMOTE_DEFAULTS, observe: () => {}, runRemote: () => ({ kind: 'infra', reason: 'ssh-down' }) }))
      .toMatchObject({ ok: false, source: 'unmeasured', reason: 'ssh-down' });
    expect(ensurePrLandHeavyRemote(input, { settings: { ...GATE_REMOTE_DEFAULTS, slotWaitSeconds: 0 }, observe: () => {}, runRemote: () => ({ kind: 'busy' }) }))
      .toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-busy' });
    expect(ensurePrLandHeavyRemote(input, { settings: GATE_REMOTE_DEFAULTS, observe: () => {}, runRemote: () => ({
      kind: 'ran', rc: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), commit: HEAD, host: 'node-b', ms: 2,
    }) })).toMatchObject({ ok: false, source: 'unmeasured', reason: expect.stringContaining('gate-rc-1 · remote-log:') });
    expect(ensurePrLandHeavyRemote(input, { settings: { ...GATE_REMOTE_DEFAULTS, host: 'unknown-host' } }))
      .toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-mismatch (unknown-host)' });
    expect(ensurePrLandHeavyRemote(input, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), commit: HEAD, host: 'node-c', ms: 2 }),
    })).toMatchObject({ ok: false, source: 'unmeasured', reason: expect.stringContaining('gate-host-mismatch (node-c) · remote-log:') });
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('typecheck failure carries its redacted cause into the landing refusal', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 64, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from('[tsc-gate] failed API_KEY=supersecretvalue12345 compile error at end\n'),
        stderr: Buffer.alloc(0) }),
    });
    expect(result.reason).toContain('compile error at end');
    expect(result.reason).toContain('API_KEY=***');
    expect(result.reason).not.toContain('supersecretvalue12345');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('failed gate names introduced and preexisting test files and preserves a redacted local log', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 68, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from('[gate-baseline] introduced=2, preexisting=1\n- introduced: test/cli-dev-command.test.ts > repository reader\n- introduced: src/git-fs/spawn-discipline.test.ts > waits\n- preexisting: test/preview-terminal.test.ts > terminal\n'),
        stderr: Buffer.from('error: API_KEY=supersecretvalue12345 gate failed\n') }),
    });
    expect(result.reason).toContain('introduced-files=src/git-fs/spawn-discipline.test.ts,test/cli-dev-command.test.ts');
    expect(result.reason).toContain('preexisting-files=test/preview-terminal.test.ts');
    expect(result.reason).toContain(`remote-log: ${result.failureLogPath}`);
    expect(result.failureLogPath).toStartWith(evidenceDir);
    expect(statSync(result.failureLogPath!).mode & 0o777).toBe(0o600);
    const log = readFileSync(result.failureLogPath!, 'utf8');
    expect(log).toContain('repository reader');
    expect(log).toContain('API_KEY=***');
    expect(log).not.toContain('supersecretvalue12345');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('large remote output keeps its final failure lines in the preserved log', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 69, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from(`${'가'.repeat(800_000)}\n- introduced: test/last.test.ts > final failure\n`), stderr: Buffer.alloc(0) }),
    });
    expect(result.reason).toContain('introduced-files=test/last.test.ts');
    const log = readFileSync(result.failureLogPath!, 'utf8');
    expect(log).toContain('[remote log middle truncated]');
    expect(log).toContain('final failure');
    expect(statSync(result.failureLogPath!).size).toBeLessThan(2 * 1024 * 1024 + 1024);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('a failed gate on an unexpected host still names its preserved log in the refusal', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 70, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-c', ms: 3,
        stdout: Buffer.from('- introduced: test/untrusted.test.ts\nerror: wrong host'), stderr: Buffer.alloc(0) }),
    });
    expect(result.reason).toContain('gate-host-mismatch (node-c)');
    expect(result.reason).toContain(`remote-log: ${result.failureLogPath}`);
    expect(result.reason).not.toContain('test/untrusted.test.ts');
    expect(existsSync(result.failureLogPath!)).toBe(true);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('a mismatched head after rc=0 preserves the remote output and replaces the prior refusal log', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const input = { pr: 70, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
    const run = (output: string) => ensurePrLandHeavyRemote(input, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 0, commit: MAIN, host: 'node-b', ms: 3,
        stdout: Buffer.from(output), stderr: Buffer.alloc(0) }),
    });
    const first = run('first refusal');
    const second = run('second refusal');
    expect(first.reason).toContain('head-mismatch');
    expect(second.reason).toContain(`remote-log: ${second.failureLogPath}`);
    expect(first.failureLogPath).toBe(second.failureLogPath);
    expect(readFileSync(second.failureLogPath!, 'utf8')).toContain('second refusal');
    expect(readFileSync(second.failureLogPath!, 'utf8')).not.toContain('first refusal');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('a failed run from a different head does not attribute its files to the requested PR head', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 70, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: MAIN, host: 'node-b', ms: 3,
        stdout: Buffer.from('- introduced: test/other-head.test.ts'), stderr: Buffer.alloc(0) }),
    });
    expect(result.reason).toContain('head-mismatch');
    expect(result.reason).not.toContain('introduced-files=');
    expect(readFileSync(result.failureLogPath!, 'utf8')).toContain('test/other-head.test.ts');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('a passed remote gate whose evidence cannot be written retains its output log', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    mkdirSync(join(evidenceDir, '71.json'));
    const result = ensurePrLandHeavyRemote({ pr: 71, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 0, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from('[pr-land-extra-gates] pass global=measured interference=measured files=1\n'), stderr: Buffer.alloc(0) }),
    });
    expect(result.reason).toContain('evidence-write-failed');
    expect(result.reason).toContain(`remote-log: ${result.failureLogPath}`);
    expect(readFileSync(result.failureLogPath!, 'utf8')).toContain('[pr-land-extra-gates] pass');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('an unrecognized remote failure still carries a bounded redacted output tail', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 65, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from(`unrecognized preamble ${'x'.repeat(400)} tail cause`),
        stderr: Buffer.from('unknown failure API_KEY=supersecretvalue12345'), }),
    });
    expect(result.reason).toContain('stderr: unknown failure API_KEY=***');
    expect(result.reason).toContain('tail cause');
    expect(result.reason).not.toContain('supersecretvalue12345');
    expect(result.reason!.length).toBeLessThan(500);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('typecheck root plan does not conceal an unprefixed TypeScript error', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 66, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from('[tsc-gate] root-plan {"mode":"affected"}\nsrc/main.ts(12,3): TS2322: Type string is not assignable to number\n'),
        stderr: Buffer.alloc(0) }),
    });
    expect(result.reason).toContain('TS2322: Type string is not assignable to number');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('typecheck information cannot displace an earlier gate baseline verdict', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 67, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from(['[gate-baseline] failure on changed test', ...Array.from({ length: 6 }, (_, i) => `[tsc-gate] root-plan info ${i}`)].join('\n')),
        stderr: Buffer.alloc(0) }),
    });
    expect(result.reason).toContain('[gate-baseline] failure on changed test');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('failed heavy remote gate carries bounded redacted shard verdict lines into landing refusal', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 57, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  try {
    const result = ensurePrLandHeavyRemote(input, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from([
          'shard attempt: shard-2 #2 · 지금 exit 2 · junit 없음 · 기준 exit 2 · junit 없음 · 파일 src/a.test.ts',
          'shard diagnostic: shard-2 #2 지금 · stderr: API_KEY=supersecretvalue12345 bootstrap failed',
          'shard diagnostic: shard-2 #2 기준 · stderr: baseline bootstrap failed',
          'shards: unmeasured (shard-2)',
        ].join('\n')),
        stderr: Buffer.from(Array.from({ length: 20 }, (_, i) => `error: unrelated ${i} ${'x'.repeat(800)}`).join('\n')),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('gate-rc-1 · remote:');
    expect(result.reason).toContain('shard-2 #2 · 지금 exit 2');
    expect(result.reason).toContain('API_KEY=***');
    expect(result.reason).toContain('기준 · stderr: baseline bootstrap failed');
    expect(result.reason).toContain('shards: unmeasured (shard-2)');
    expect(result.reason).not.toContain('supersecretvalue12345');
    expect(result.reason!.length).toBeLessThan(1100);
    expect(existsSync(join(evidenceDir, '57.json'))).toBe(false);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('a long shard stderr keeps its final cause in the bounded landing refusal', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 62, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from([
          'shard attempt: shard-2 #2 · 지금 exit 2 · junit 없음 · 기준 exit 2 · junit 없음',
          `shard diagnostic: shard-2 #2 지금 · stdout: ${'x'.repeat(400)} · stderr: ${'y'.repeat(400)} root cause at end`,
          'shards: unmeasured (shard-2)',
        ].join('\n')), stderr: Buffer.alloc(0) }),
    });
    expect(result.reason).toContain('root cause at end');
    expect(result.reason).toContain('shards: unmeasured (shard-2)');
    expect(result.reason!.length).toBeLessThan(850);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('a long shard stderr does not displace the stdout cause', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 63, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from([
          'shard attempt: shard-2 #2 · 지금 exit 2 · junit 없음 · 기준 exit 2 · junit 없음',
          `shard diagnostic: shard-2 #2 지금 · stdout: boot failed ${'x'.repeat(400)} · stderr: ${'y'.repeat(400)} stderr tail`,
          'shards: unmeasured (shard-2)',
        ].join('\n')), stderr: Buffer.alloc(0) }),
    });
    expect(result.reason).toContain('stdout: boot failed');
    expect(result.reason).toContain('stderr tail');
    expect(result.reason!.length).toBeLessThan(850);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('real Bun exit 2 retains stderr cause through injected self-gate and heavy-remote seams after long stdout', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-land-no-junit-'));
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const file = 'early.test.ts';
  try {
    writeFileSync(join(cwd, file), [
      "console.log('long stdout ' + 'x'.repeat(800));",
      "console.error('stderr preamble ' + 'y'.repeat(400) + ' API_KEY=supersecretvalue12345 bootstrap failed before JUnit');",
      'process.exit(2);',
    ].join('\n'));
    const processResult = runBunShard(cwd, [file]);
    expect(processResult).toMatchObject({ exitCode: 2, junit: undefined });
    const shard = { id: 'shard-2', files: [file], plannedRssMb: 1, plannedSeconds: 1 };
    const gate = runSelfGateCli(cwd, { shards: 1 }, {
      changedFiles: () => ({ files: [file], baseRef: 'HEAD' }), exists: () => true,
      runShards: () => ({ shards: [shard], attempts: [{
        shardId: 'shard-2', attempt: 2,
        currentExitCode: 2, baselineExitCode: 2,
        currentDiagnostic: processResult.diagnostic, baselineDiagnostic: processResult.diagnostic,
      }], aggregate: { status: 'unmeasured', retryShardIds: ['shard-2'] } }),
      runAndroidGate: () => 0, runIosGate: () => 0, runPwaGate: () => 0,
    });
    expect(gate.exitCode).toBe(1);
    const refusal = ensurePrLandHeavyRemote({ pr: 58, head: HEAD, main: MAIN, repo: cwd, evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: gate.exitCode, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from(gate.lines.join('\n')), stderr: Buffer.alloc(0) }),
    });
    expect(refusal.reason).toContain('bootstrap failed before JUnit');
    expect(refusal.reason).toContain('shard-2 #2');
    expect(refusal.reason).toContain('long stdout');
    expect(refusal.reason).not.toContain('supersecretvalue12345');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('a recovered no-JUnit shard does not hide the later PWA gate failure', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 59, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from([
          'shard attempt: shard-2 #1 · 지금 exit 2 · junit 없음 · 기준 exit 2 · junit 없음',
          'shard diagnostic: shard-2 #1 지금 · stderr: old bootstrap error',
          'shard attempt: shard-2 #2 · 지금 exit 0 · 기준 exit 0',
          'tests: pass (2 files)',
          '✗ pwa-gate: violation detected',
        ].join('\n')), stderr: Buffer.alloc(0) }),
    });
    expect(result.reason).toContain('✗ pwa-gate: violation detected');
    expect(result.reason).not.toContain('old bootstrap error');
    expect(result.reason).not.toContain('shard attempt: shard-2 #1');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('an unmeasured shard keeps its diagnostics when another shard later recovers', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 60, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from([
          'shard attempt: shard-1 #1 · 지금 exit 2 · junit 없음 · 기준 exit 2 · junit 없음',
          'shard diagnostic: shard-1 #1 지금 · stderr: active failure',
          'shard diagnostic: shard-1 #1 기준 · stderr: active baseline failure',
          'shard attempt: shard-2 #1 · 지금 exit 2 · junit 없음 · 기준 exit 2 · junit 없음',
          'shard diagnostic: shard-2 #1 지금 · stderr: recovered failure',
          'shard attempt: shard-2 #2 · 지금 exit 0 · 기준 exit 0',
          'shards: unmeasured (shard-1)',
        ].join('\n')), stderr: Buffer.alloc(0) }),
    });
    expect(result.reason).toContain('shard-1 #1');
    expect(result.reason).toContain('active failure');
    expect(result.reason).toContain('active baseline failure');
    expect(result.reason).not.toContain('recovered failure');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('a signalled unmeasured shard reaches the remote refusal without a JUnit wording match', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  try {
    const result = ensurePrLandHeavyRemote({ pr: 61, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 1, commit: HEAD, host: 'node-b', ms: 3,
        stdout: Buffer.from([
          'shard attempt: shard-2 #2 · 지금 signal SIGTERM · 기준 signal SIGTERM',
          'shard diagnostic: shard-2 #2 지금 · stderr: current terminated',
          'shard diagnostic: shard-2 #2 기준 · stderr: baseline terminated',
          'shards: unmeasured (shard-2)',
        ].join('\n')), stderr: Buffer.alloc(0) }),
    });
    expect(result.reason).toContain('shard-2 #2 · 지금 signal SIGTERM');
    expect(result.reason).toContain('current terminated');
    expect(result.reason).toContain('baseline terminated');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('a valid matching cache does not bypass a configured host outside the allowlist', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 51, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, '51.json'), `${JSON.stringify({
    schema: 3, pr: 51, head: HEAD, main: MAIN, host: 'node-b', passedAt: '2026-10-14T00:00:00.000Z',
    elapsedMs: 12, rootPlan: null, interferenceMeasured: true,
  })}\n`);
  let remoteCalls = 0;
  try {
    expect(ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, host: 'unknown-host' },
      observe: () => {},
      runRemote: () => { remoteCalls += 1; return { kind: 'infra', reason: 'should-not-run' }; },
    })).toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-mismatch (unknown-host)', elapsedMs: 0 });
    expect(remoteCalls).toBe(0);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('a successful remote run outside the allowlist is not pass evidence', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 51, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  try {
    const events: Record<string, unknown>[] = [];
    const result = ensurePrLandHeavyRemote(input, {
      settings: GATE_REMOTE_DEFAULTS,
      observe: (_event, data) => { events.push(data); },
      runRemote: () => ({ kind: 'ran', rc: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), commit: HEAD, host: 'unknown-host', ms: 4 }),
    });
    expect(result).toMatchObject({ ok: false, source: 'unmeasured', reason: expect.stringContaining('gate-host-mismatch (unknown-host) · remote-log:'), host: 'unknown-host', attemptedHost: 'node-b' });
    expect(events[0]).toMatchObject({ host: 'unknown-host', attemptedHost: 'node-b' });
    expect(existsSync(join(evidenceDir, '51.json'))).toBe(false);
    expect(ensurePrLandHeavyRemote(input, {
      settings: GATE_REMOTE_DEFAULTS,
      observe: () => {},
      runRemote: () => { throw new Error('cached success must not exist'); },
    })).toMatchObject({ ok: false, source: 'unmeasured' });
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('schema 3 success without new extra-gate status cannot skip remote gates', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 51, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  writeFileSync(join(evidenceDir, '51.json'), `${JSON.stringify({
    schema: 3, pr: 51, head: HEAD, main: MAIN, host: 'node-b', passedAt: '2026-10-14T00:00:00.000Z',
    elapsedMs: 12, rootPlan: null,
  })}\n`);
  let called = false;
  try {
    expect(ensurePrLandHeavyRemote(input, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => { called = true; return { kind: 'infra', reason: 'offline' }; },
    })).toMatchObject({ ok: false, source: 'unmeasured', reason: 'offline' });
    expect(called).toBe(true);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('LAND-HEAVY-MULTIHOST-FU: WSL production gate requires the complete measured heavy-gate command before caching', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 74, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const calls: RemoteRunOptions[] = [];
  try {
    const passing = ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, host: 'host-e-wsl', hostCaps: { 'host-e-wsl': 2 } },
      observe: () => {},
      runRemote: (options: RemoteRunOptions) => {
        calls.push(options);
        return {
          kind: 'ran', rc: 0,
          stdout: Buffer.from('[tsc-gate] root-plan {"mode":"affected","roots":3,"promoted":false,"reason":"changed"}\n[pr-land-extra-gates] pass global=measured interference=measured files=2\n'),
          stderr: Buffer.alloc(0), commit: options.commit!, host: options.host, ms: 9,
        };
      },
    });
    expect(passing).toMatchObject({ ok: true, source: 'remote', host: 'host-e-wsl', interferenceMeasured: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ host: 'host-e-wsl', hostCap: 2, commit: HEAD, refs: [MAIN], installPwa: true, stableCheckout: true });
    const argv = (calls[0]!.argv as (sha: (ref: string) => string) => string[])((ref) => ref);
    expect(argv[2]).toContain('git -c user.name=elanous-gate');
    expect(argv[2]).toContain('bash scripts/ci-typecheck-main-delta.sh "$1"');
    expect(argv[2]).toContain('self gate --changed --base "$1" --local --shards 4');
    expect(argv[2]).toContain('bun scripts/pr-land-extra-remote-gates.ts "$1"');
    expect(JSON.parse(readFileSync(join(evidenceDir, '74.json'), 'utf8')))
      .toMatchObject({ schema: 3, host: 'host-e-wsl', head: HEAD, main: MAIN, interferenceMeasured: true });

    const unmeasured = ensurePrLandHeavyRemote({ ...input, pr: 75 }, {
      settings: { ...GATE_REMOTE_DEFAULTS, host: 'host-e-wsl' }, observe: () => {},
      runRemote: (options: RemoteRunOptions) => ({
        kind: 'ran', rc: 0, stdout: Buffer.from('self gate passed without extra gate measurement'),
        stderr: Buffer.alloc(0), commit: HEAD, host: options.host, ms: 9,
      }),
    });
    expect(unmeasured).toMatchObject({ ok: false, source: 'unmeasured', reason: expect.stringContaining('extra-global-unmeasured') });
    expect(existsSync(join(evidenceDir, '75.json'))).toBe(false);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('the WSL host is allowlisted third and its run is reusable landing evidence', () => {
  expect(PR_LAND_HEAVY_HOSTS).toEqual(['node-b', 'node-c', 'host-e-wsl']);
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 54, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
    const hosts: string[] = [];
    const events: Record<string, unknown>[] = [];
    let wslRun: RemoteRunOptions | undefined;
  try {
    const result = ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, host: 'host-e-wsl' }, observe: (_event, data) => { events.push(data); },
      runRemote: (options: RemoteRunOptions) => {
        hosts.push(options.host);
        if (options.host !== 'host-e-wsl') return { kind: 'busy' };
        wslRun = options;
        return { kind: 'ran', rc: 0, stdout: extraPass, stderr: Buffer.alloc(0), commit: HEAD, host: options.host, ms: 7 };
      },
    });
    expect(result).toMatchObject({ ok: true, source: 'remote', host: 'host-e-wsl' });
    expect(hosts).toEqual(['host-e-wsl']);
    expect(wslRun).toMatchObject({ host: 'host-e-wsl', commit: HEAD, refs: [MAIN], installPwa: true, stableCheckout: true });
    const wslArgv = wslRun!.argv as (sha: (ref: string) => string) => string[];
    expect(wslArgv((ref) => ref)).toEqual(['sh', '-c', expect.stringContaining('git -c user.name=elanous-gate') , 'sh', MAIN]);
    expect(wslArgv((ref) => ref).join(' ')).toContain('self gate --changed --base "$1" --local --shards 4');
    expect(events[0]).toMatchObject({ host: 'host-e-wsl', attemptedHost: 'host-e-wsl', outcome: 'pass' });
    expect(JSON.parse(readFileSync(join(evidenceDir, '54.json'), 'utf8')))
      .toMatchObject({ schema: 3, host: 'host-e-wsl', head: HEAD, main: MAIN, interferenceMeasured: true });
    expect(ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, host: 'host-e-wsl' }, observe: () => {},
      runRemote: () => { throw new Error('cached WSL pass must be reused, not re-run'); },
    })).toMatchObject({ ok: true, source: 'cached', host: 'host-e-wsl' });
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('a busy WSL primary falls back through stable hosts in allowlist order', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 55, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const hosts: string[] = [];
  try {
    const result = ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, host: 'host-e-wsl' }, observe: () => {},
      runRemote: (options: RemoteRunOptions) => {
        hosts.push(options.host);
        return options.host === 'node-b'
          ? { kind: 'ran' as const, rc: 0, stdout: extraPass, stderr: Buffer.alloc(0), commit: HEAD, host: 'node-b', ms: 5 }
          : { kind: 'busy' as const };
      },
    });
    expect(result).toMatchObject({ ok: true, source: 'remote', host: 'node-b' });
    expect(hosts).toEqual(['host-e-wsl', 'node-b']);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('cached evidence from a host outside the allowlist is not reusable', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 56, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  writeFileSync(join(evidenceDir, '56.json'), `${JSON.stringify({
    schema: 3, pr: 56, head: HEAD, main: MAIN, host: 'unknown-host', passedAt: '2026-10-14T00:00:00.000Z',
    elapsedMs: 12, rootPlan: null, interferenceMeasured: true,
  })}\n`);
  try {
    expect(ensurePrLandHeavyRemote(input, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'infra', reason: 'fresh-remote-required' }),
    })).toMatchObject({ ok: false, source: 'unmeasured', reason: 'fresh-remote-required' });
    expect(JSON.parse(readFileSync(join(evidenceDir, '56.json'), 'utf8'))).toMatchObject({ host: 'unknown-host' });
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('remote success without global completion marker is unmeasured', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 51, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  try {
    const result = ensurePrLandHeavyRemote(input, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'ran', rc: 0, stdout: Buffer.from('incomplete gate output'), stderr: Buffer.alloc(0), commit: HEAD, host: 'node-b', ms: 2 }),
    });
    expect(result).toMatchObject({ ok: false, source: 'unmeasured' });
    expect(result.reason).toContain('extra-global-unmeasured');
    expect(result.reason).toContain(`remote-log: ${result.failureLogPath}`);
    expect(readFileSync(result.failureLogPath!, 'utf8')).toContain('incomplete gate output');
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('remote interference unmeasured warning is cached as unmeasured without blocking', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 51, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const deps = {
    settings: GATE_REMOTE_DEFAULTS, observe: () => {},
    runRemote: () => ({ kind: 'ran' as const, rc: 0, stdout: Buffer.from('[pr-land-extra-gates] pass global=measured interference=unmeasured files=2\n'), stderr: Buffer.alloc(0), commit: HEAD, host: 'node-b', ms: 2 }),
  };
  try {
    expect(ensurePrLandHeavyRemote(input, deps)).toMatchObject({ ok: true, source: 'remote', interferenceMeasured: false });
    expect(ensurePrLandHeavyRemote(input, deps)).toMatchObject({ ok: true, source: 'cached', interferenceMeasured: false });
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('busy node-b selects node-c and caches only its exact head/main evidence', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 52, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const hosts: Array<[string, number | undefined]> = [];
  const deps = {
    settings: { ...GATE_REMOTE_DEFAULTS, hostCaps: { 'node-b': 6, 'node-c': 3 } }, observe: () => {},
    runRemote: (options: RemoteRunOptions) => {
      hosts.push([options.host, options.hostCap]);
      return options.host === 'node-b' ? { kind: 'busy' as const } : {
        kind: 'ran' as const, rc: 0, stdout: Buffer.from('[pr-land-extra-gates] pass global=measured interference=measured files=2\n'),
        stderr: Buffer.alloc(0), commit: HEAD, host: 'node-c', ms: 8,
      };
    },
  };
  try {
    expect(ensurePrLandHeavyRemote(input, deps)).toMatchObject({ ok: true, source: 'remote', host: 'node-c' });
    expect(hosts).toEqual([['node-b', 6], ['node-c', 3]]);
    expect(ensurePrLandHeavyRemote(input, deps)).toMatchObject({ ok: true, source: 'cached', host: 'node-c' });
    expect(hosts).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(evidenceDir, '52.json'), 'utf8'))).toMatchObject({ host: 'node-c', head: HEAD, main: MAIN });
    expect(ensurePrLandHeavyRemote({ ...input, main: NEXT_MAIN }, deps)).toMatchObject({ ok: true, source: 'remote', host: 'node-c' });
    expect(hosts).toEqual([['node-b', 6], ['node-c', 3], ['node-b', 6], ['node-c', 3]]);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('LAND-HEAVY-MULTIHOST-FU: configured WSL is tried first before allowlisted fallbacks', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 73, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const hosts: string[] = [];
  try {
    const result = ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, host: 'host-e-wsl', slotWaitSeconds: 0 },
      observe: () => {},
      runRemote: (options: RemoteRunOptions) => {
        hosts.push(options.host);
        return { kind: 'busy' };
      },
    });
    expect(result).toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-busy' });
    expect(hosts).toEqual(['host-e-wsl', 'node-b', 'node-c']);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('LAND-HEAVY-MULTIHOST-FU: production argv executes in an isolated remote mock and gate failure refuses landing', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const binDir = join(evidenceDir, 'bin');
  mkdirSync(binDir);
  const input = { pr: 74, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const execute = (failGate: boolean) => {
    const argvRuns: string[][] = [];
    const commandLog = join(evidenceDir, 'commands.log');
    const runRemote = (options: RemoteRunOptions) => {
      const argv = (options.argv as (sha: (ref: string) => string) => string[])((ref) => ref === MAIN ? MAIN : HEAD);
      argvRuns.push(argv);
      const result = spawnSync(argv[0]!, argv.slice(1), {
        cwd: evidenceDir,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, MOCK_FAIL_GATE: failGate ? '1' : '0' },
        encoding: 'utf8',
      });
      return { kind: 'ran' as const, rc: result.status ?? 1,
        stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr), commit: HEAD, host: options.host, ms: 4 };
    };
    writeFileSync(join(binDir, 'git'), `#!/bin/sh\nprintf 'git %s\\n' "$*" >> '${commandLog}'\nexit 0\n`);
    writeFileSync(join(binDir, 'bun'), `#!/bin/sh\nprintf 'bun %s\\n' "$*" >> '${commandLog}'\ncase "$*" in *"self gate"*) [ "$MOCK_FAIL_GATE" = 1 ] && { echo "gate failure" >&2; exit 19; };; esac\ncase "$*" in *"pr-land-extra-remote-gates.ts"*) echo "[pr-land-extra-gates] pass global=measured interference=measured files=2";; esac\nexit 0\n`);
    writeFileSync(join(binDir, 'bash'), `#!/bin/sh\nprintf 'bash %s\\n' "$*" >> '${commandLog}'\ncase "$*" in *"ci-typecheck-main-delta.sh"*) exit 0;; esac\nexec /bin/bash "$@"\n`);
    chmodSync(join(binDir, 'git'), 0o755);
    chmodSync(join(binDir, 'bun'), 0o755);
    chmodSync(join(binDir, 'bash'), 0o755);
    const result = ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, host: 'host-e-wsl' }, observe: () => {}, runRemote,
    });
    return { result, argvRuns };
  };
  try {
    const passed = execute(false);
    expect(passed.result).toMatchObject({ ok: true, source: 'remote', host: 'host-e-wsl' });
    expect(passed.argvRuns[0]).toEqual(['sh', '-c', expect.any(String), 'sh', MAIN]);
    expect(passed.argvRuns[0]![2]).toContain('self gate --changed --base "$1" --local --shards 4');
    expect(readFileSync(join(evidenceDir, 'commands.log'), 'utf8')).toContain(`bun bin/elanous.mjs self gate --changed --base ${MAIN} --local --shards 4`);
    expect(readFileSync(join(evidenceDir, 'commands.log'), 'utf8')).toContain(`bun scripts/pr-land-extra-remote-gates.ts ${MAIN}`);
    rmSync(join(evidenceDir, '74.json'));
    writeFileSync(join(evidenceDir, 'commands.log'), '');
    const failed = execute(true);
    expect(failed.result).toMatchObject({ ok: false, source: 'unmeasured', attemptedHost: 'host-e-wsl', reason: expect.stringContaining('gate-rc-19') });
    expect(existsSync(join(evidenceDir, '74.json'))).toBe(false);
    expect(failed.argvRuns).toHaveLength(1);
    const failedCommands = readFileSync(join(evidenceDir, 'commands.log'), 'utf8');
    expect(failedCommands).toContain(`bun bin/elanous.mjs self gate --changed --base ${MAIN} --local --shards 4`);
    expect(failedCommands).not.toContain('pr-land-extra-remote-gates.ts');
    expect(failedCommands).toContain('bash scripts/ci-typecheck-main-delta.sh');
    expect(failedCommands).toContain('git -c user.name=elanous-gate');
    expect(PR_LAND_HEAVY_HOSTS).toEqual(['node-b', 'node-c', 'host-e-wsl']);
    const landingAttemptHosts: string[] = [];
    expect(ensurePrLandHeavyRemote({ ...input, pr: 75 }, {
      settings: { ...GATE_REMOTE_DEFAULTS, host: 'host-e-wsl', slotWaitSeconds: 0 }, observe: () => {},
      runRemote: (options: RemoteRunOptions) => {
        landingAttemptHosts.push(options.host);
        return { kind: 'busy' };
      },
    })).toMatchObject({ ok: false, reason: 'gate-host-busy' });
    expect(landingAttemptHosts).toEqual(['host-e-wsl', 'node-b', 'node-c']);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('each configured allowlisted host leads and fallback visits only the remaining hosts in stable order', () => {
  for (const preferredHost of PR_LAND_HEAVY_HOSTS) {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
    const hosts: string[] = [];
    try {
      const result = ensurePrLandHeavyRemote({ pr: 76, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
        settings: { ...GATE_REMOTE_DEFAULTS, host: preferredHost, slotWaitSeconds: 0 },
        observe: () => {},
        runRemote: (options: RemoteRunOptions) => {
          hosts.push(options.host);
          return { kind: 'busy' };
        },
      });
      const fallbackHosts = PR_LAND_HEAVY_HOSTS.filter((host) => host !== preferredHost);
      expect(hosts).toEqual([preferredHost, fallbackHosts[0], fallbackHosts[1]]);
      expect(result).toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-busy', attemptedHost: fallbackHosts[1] });
      expect(existsSync(join(evidenceDir, '76.json'))).toBe(false);
    } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
  }
});

test('all three allowlisted hosts busy block landing and a failed gate never tries the next host', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 53, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const busyHosts: string[] = [];
  try {
    const busyEvents: Record<string, unknown>[] = [];
    const busy = ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, slotWaitSeconds: 0 }, observe: (_event, data) => { busyEvents.push(data); },
      runRemote: (options: RemoteRunOptions) => { busyHosts.push(options.host); return { kind: 'busy' }; },
    });
    expect(busy).toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-busy', attemptedHost: 'host-e-wsl' });
    expect(busy.host).toBeUndefined();
    expect(busyEvents[0]).toMatchObject({ host: null, attemptedHost: 'host-e-wsl' });
    expect(busyHosts).toEqual(['node-b', 'node-c', 'host-e-wsl']);
    expect(existsSync(join(evidenceDir, '53.json'))).toBe(false);
    const failedHosts: string[] = [];
    expect(ensurePrLandHeavyRemote(input, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: (options: RemoteRunOptions) => {
        failedHosts.push(options.host);
        return { kind: 'ran', rc: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), commit: HEAD, host: options.host, ms: 1 };
      },
    })).toMatchObject({ ok: false, source: 'unmeasured', reason: expect.stringContaining('gate-rc-1 · remote-log:') });
    expect(failedHosts).toEqual(['node-b']);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('busy hosts wait slotWaitSeconds then retry before gate-host-busy', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 70, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const hosts: string[] = [];
  let clock = 0;
  try {
    expect(GATE_REMOTE_DEFAULTS.slotWaitSeconds).toBe(600);
    const result = ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, slotWaitSeconds: 30 },
      observe: () => {},
      now: () => clock,
      sleep: (ms) => { clock += ms; },
      runRemote: (options: RemoteRunOptions) => { hosts.push(options.host); return { kind: 'busy' }; },
    });
    expect(result).toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-busy', attemptedHost: 'host-e-wsl' });
    // Rounds at t=0 and t=15s; the wait to t=30s hits the deadline, so no third round (same cadence as self gate).
    expect(hosts).toEqual(['node-b', 'node-c', 'host-e-wsl', 'node-b', 'node-c', 'host-e-wsl']);
    expect(clock).toBe(30_000);
    expect(existsSync(join(evidenceDir, '70.json'))).toBe(false);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('a busy host that frees within slotWaitSeconds is used for landing', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 71, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const hosts: string[] = [];
  let clock = 0;
  try {
    const result = ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, slotWaitSeconds: 60 },
      observe: () => {},
      now: () => clock,
      sleep: (ms) => { clock += ms; },
      runRemote: (options: RemoteRunOptions) => {
        hosts.push(options.host);
        if (hosts.length <= 3) return { kind: 'busy' as const };
        return { kind: 'ran' as const, rc: 0, stdout: extraPass, stderr: Buffer.alloc(0), commit: HEAD, host: options.host, ms: 8 };
      },
    });
    expect(result).toMatchObject({ ok: true, source: 'remote', host: 'node-b' });
    expect(hosts).toEqual(['node-b', 'node-c', 'host-e-wsl', 'node-b']);
    expect(JSON.parse(readFileSync(join(evidenceDir, '71.json'), 'utf8'))).toMatchObject({ host: 'node-b' });
    expect(clock).toBe(15_000);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('LAND-HEAVY-MULTIHOST-FU: malformed cached root-plan evidence is remeasured on the selected allowlisted host', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 73, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, '73.json'), `${JSON.stringify({
    schema: 3, pr: 73, head: HEAD, main: MAIN, host: 'host-e-wsl', passedAt: '2026-10-14T00:00:00.000Z',
    elapsedMs: 12, rootPlan: { mode: 'affected', roots: -1, promoted: 'false', reason: 7 }, interferenceMeasured: true,
  })}\n`);
  const hosts: string[] = [];
  try {
    expect(ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, host: 'host-e-wsl' }, observe: () => {},
      runRemote: (options: RemoteRunOptions) => {
        hosts.push(options.host);
        return { kind: 'ran', rc: 0, stdout: extraPass, stderr: Buffer.alloc(0), commit: HEAD, host: options.host, ms: 7 };
      },
    })).toMatchObject({ ok: true, source: 'remote', host: 'host-e-wsl' });
    expect(hosts).toEqual(['host-e-wsl']);
    expect(JSON.parse(readFileSync(join(evidenceDir, '73.json'), 'utf8')).rootPlan).toBeNull();
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('a slot that frees exactly at the deadline is not used', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 72, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const hosts: string[] = [];
  let clock = 0;
  try {
    const result = ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, slotWaitSeconds: 20 },
      observe: () => {},
      now: () => clock,
      sleep: (ms) => { clock += ms; },
      runRemote: (options: RemoteRunOptions) => {
        hosts.push(options.host);
        return hosts.length < 7
          ? { kind: 'busy' as const }
          : { kind: 'ran' as const, rc: 0, stdout: extraPass, stderr: Buffer.alloc(0), commit: HEAD, host: options.host, ms: 8 };
      },
    });
    expect(result).toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-busy' });
    expect(hosts).toEqual(['node-b', 'node-c', 'host-e-wsl', 'node-b', 'node-c', 'host-e-wsl']);
    expect(clock).toBe(20_000);
    expect(existsSync(join(evidenceDir, '72.json'))).toBe(false);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('WARM-REUSE-LAND-CONSUMER-WIRE: heavy land gate decides warm reuse once per landing — no evidence=off · 3 matching shadow results=live · 1 mismatch=recent-mismatch', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const LOCK = 'sha256:pod-land-lock';
  const passRemote = () => ({ kind: 'ran' as const, rc: 0, stdout: Buffer.from(
    '[tsc-gate] root-plan {"mode":"affected","roots":12,"promoted":false,"reason":null}\n[pr-land-extra-gates] pass global=measured interference=measured files=2\n'),
    stderr: Buffer.alloc(0), commit: HEAD, host: 'node-b', ms: 5 });
  const sample = (agree: boolean): LandingShadowSample => ({ head: HEAD, main: MAIN, lock: LOCK, leaseValid: true, canaryPassed: true, agree });
  const gateRecheckLive = { consecutiveMatchSamples: 3, recentMismatchCount: 0, leaseValid: true, canaryPassed: true,
    expected: { head: HEAD, main: MAIN, lock: LOCK }, worker: { head: HEAD, main: MAIN, lock: LOCK } };
  const window = (samples: LandingShadowSample[]): LandShadowSampleWindow => ({ samples, lock: LOCK, gateRecheck: gateRecheckLive });
  const allOn = { gateRecheck: true, land: true };
  const landing = (pr: number, extra: Record<string, unknown> = {}) => ensurePrLandHeavyRemote({ pr, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
    settings: GATE_REMOTE_DEFAULTS, observe: (): void => {}, runRemote: passRemote, ...extra,
  });
  const spy = spyOn(debug, 'log');
  const landDecisions = () => (spy.mock.calls as Array<[string, string, Record<string, unknown>, unknown?]>)
    .filter(([category, event, data]) => category === 'pod.warm' && event === 'switch-decision' && data?.['consumer'] === 'land')
    .map(([, , data]) => data!);
  try {
    // 매 착지 1줄 — config 기본(끔)이면 이유 flag-off 로 매 판정이 남는다.
    expect(landing(81)).toMatchObject({ ok: true, source: 'remote' });
    expect(landDecisions()).toHaveLength(1);
    expect(landDecisions()[0]!).toMatchObject({ consumer: 'land', live: false, reason: 'flag-off' });
    spy.mockClear();
    // 증거 없음 = off — flag 를 켜도 land shadow Job 결과 창이 없으면 off(선행 소비자 칸도 비어 있다).
    expect(landing(82, { warmReuseConfig: () => allOn })).toMatchObject({ ok: true, source: 'remote' });
    expect(landDecisions()).toHaveLength(1);
    expect(landDecisions()[0]!).toMatchObject({ consumer: 'land', live: false, reason: 'predecessor-off:gate-recheck' });
    spy.mockClear();
    // land 표본 창만 비면 land 칸 증거 없음 = off.
    expect(landing(83, { warmReuseConfig: () => allOn, landShadowSamples: () => window([]) }))
      .toMatchObject({ ok: true, source: 'remote' });
    expect(landDecisions()).toHaveLength(1);
    expect(landDecisions()[0]!).toMatchObject({ consumer: 'land', live: false, reason: 'evidence-unmeasured' });
    spy.mockClear();
    // 가짜 shadow 결과 3건 일치 주입 → live.
    expect(landing(84, { warmReuseConfig: () => allOn, landShadowSamples: () => window([sample(true), sample(true), sample(true)]) }))
      .toMatchObject({ ok: true, source: 'remote' });
    expect(landDecisions()).toHaveLength(1);
    expect(landDecisions()[0]!).toMatchObject({ consumer: 'land', live: true, reason: 'live', flag: true, minMatchSamples: 3, samples: 3, recentMismatchCount: 0 });
    spy.mockClear();
    // 최근 창의 mismatch 1건 → recent-mismatch.
    expect(landing(85, { warmReuseConfig: () => allOn, landShadowSamples: () => window([sample(true), sample(true), sample(true), sample(false)]) }))
      .toMatchObject({ ok: true, source: 'remote' });
    expect(landDecisions()).toHaveLength(1);
    expect(landDecisions()[0]!).toMatchObject({ consumer: 'land', live: false, reason: 'recent-mismatch', samples: 0, recentMismatchCount: 1 });
    spy.mockClear();

    // Lease invalidity fails closed even when the shadow otherwise agrees and identity matches.
    const invalidLease = landing(86, {
      warmReuseConfig: () => allOn,
      landShadowSamples: () => window([
        sample(true), sample(true), sample(true), { ...sample(true), leaseValid: false },
      ]),
    });
    expect(invalidLease).toMatchObject({ ok: true, source: 'remote' });
    expect(landDecisions()).toHaveLength(1);
    expect(landDecisions()[0]!).toMatchObject({ consumer: 'land', live: false, reason: 'lease-invalid' });
    spy.mockClear();

    // An agreeing verdict with a different worker head is still rejected by the evidence builder/identity gate.
    const identityMismatch = landing(87, {
      warmReuseConfig: () => allOn,
      landShadowSamples: () => window([
        sample(true), sample(true), sample(true), { ...sample(true), head: 'c'.repeat(40) },
      ]),
    });
    expect(identityMismatch).toMatchObject({ ok: true, source: 'remote' });
    expect(landDecisions()).toHaveLength(1);
    expect(landDecisions()[0]!).toMatchObject({ consumer: 'land', live: false, reason: 'identity-mismatch:head' });
    spy.mockClear();

    const lockMismatch = landing(88, {
      warmReuseConfig: () => allOn,
      landShadowSamples: () => window([
        sample(true), sample(true), sample(true), { ...sample(true), lock: 'sha256:different-lock' },
      ]),
    });
    expect(lockMismatch).toMatchObject({ ok: true, source: 'remote' });
    expect(landDecisions()).toHaveLength(1);
    expect(landDecisions()[0]!).toMatchObject({ consumer: 'land', live: false, reason: 'identity-mismatch:lock' });
    spy.mockClear();

    const configReadFailure = landing(89, {
      warmReuseConfig: () => { throw new Error('config unavailable'); },
    });
    expect(configReadFailure).toMatchObject({ ok: true, source: 'remote' });
    expect(landDecisions()).toHaveLength(1);
    expect(landDecisions()[0]!).toMatchObject({ consumer: 'land', live: false, reason: 'flag-off' });
    spy.mockClear();

    const evidenceReadFailure = landing(90, {
      warmReuseConfig: () => allOn,
      landShadowSamples: () => { throw new Error('shadow window unavailable'); },
    });
    expect(evidenceReadFailure).toMatchObject({ ok: true, source: 'remote' });
    expect(landDecisions()).toHaveLength(1);
    expect(landDecisions()[0]!).toMatchObject({ consumer: 'land', live: false, reason: 'predecessor-off:gate-recheck' });
    spy.mockClear();
  } finally {
    spy.mockRestore();
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('WARM-REUSE-LAND-CONSUMER-WIRE: 3 matching samples per predecessor yield TA live=true', () => {
  const evidence: WarmReuseEvidence = {
    consecutiveMatchSamples: 3, recentMismatchCount: 0, leaseValid: true, canaryPassed: true,
    expected: { head: HEAD, main: MAIN, lock: 'sha256:worker-lock' },
    worker: { head: HEAD, main: MAIN, lock: 'sha256:worker-lock' },
  };
  expect(decideWarmReuse('ta', { gateRecheck: true, land: true, ta: true }, {
    'gate-recheck': evidence, land: evidence, ta: evidence,
  })).toEqual({ consumer: 'ta', live: true, reason: 'live' });
});

test('WARM-REUSE-LAND-CONSUMER-WIRE: heavy remote consumes three exact journal rows without a fixture seam', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-journal-'));
  const lock = 'd'.repeat(64);
  const row = (consumer: 'land' | 'gate-recheck', n: number) => ({ schema: 1 as const, consumer, pr: 91,
    head: HEAD, main: MAIN, recordedAt: new Date(Date.now() - n).toISOString(), workerId: 'worker-current',
    leaseId: `lease-${consumer}-${n}`, generation: n + 1, expectedLockHash: lock, workerLockHash: lock,
    leaseValid: true, canaryPassed: true, agree: true });
  const spy = spyOn(debug, 'log');
  try {
    const result = ensurePrLandHeavyRemote({ pr: 91, head: HEAD, main: MAIN, repo: '/repo', evidenceDir }, {
      settings: GATE_REMOTE_DEFAULTS, warmReuseConfig: () => ({ gateRecheck: true, land: true }),
      readWarmEvidence: ({ consumer }) => [0, 1, 2].map((n) => row(consumer, n)),
      observe: () => {}, runRemote: () => ({ kind: 'ran', rc: 0,
        stdout: Buffer.from('[tsc-gate] root-plan {"mode":"affected","roots":1,"promoted":false,"reason":null}\n[pr-land-extra-gates] pass global=measured interference=measured files=1\n'),
        stderr: Buffer.alloc(0), commit: HEAD, host: 'node-b', ms: 1 }),
    });
    expect(result).toMatchObject({ ok: true, source: 'remote' });
    expect(spy.mock.calls.some(([category, event, data]) => category === 'pod.warm' && event === 'switch-decision'
      && (data as Record<string, unknown>)?.consumer === 'land' && (data as Record<string, unknown>)?.live === true)).toBe(true);
  } finally { spy.mockRestore(); rmSync(evidenceDir, { recursive: true, force: true }); }
});
