import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePrLandHeavyRemote } from './pr-land-heavy-remote.js';
import { GATE_REMOTE_DEFAULTS, type RemoteRunOptions } from '../self-implement/gate-remote.js';
import { runBunShard } from '../self-dev/shard-run.js';
import { runSelfGateCli } from '../self-implement/gate-cli.js';

const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const NEXT_MAIN = 'c'.repeat(40);

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
    expect(argv.join(' ')).toContain('TSC_BASE_REF="$1" bun run scripts/ci-typecheck-changed.ts --local');
    expect(argv.join(' ')).toContain('self gate --changed --base "$1" --local --shards 4');
    expect(argv.join(' ')).toContain('bun scripts/pr-land-extra-remote-gates.ts "$1"');
    expect(ensurePrLandHeavyRemote({ ...input, main: NEXT_MAIN }, deps)).toMatchObject({ ok: true, source: 'remote' });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(evidenceDir, '51.json'), 'utf8'))).toMatchObject({ head: HEAD, main: NEXT_MAIN, host: 'node-b' });
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
    expect(ensurePrLandHeavyRemote(input, { settings: { ...GATE_REMOTE_DEFAULTS, host: 'host-e-wsl' } }))
      .toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-mismatch (host-e-wsl)' });
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
    schema: 2, pr: 51, head: HEAD, main: MAIN, host: 'node-b', passedAt: '2026-10-14T00:00:00.000Z',
    elapsedMs: 12, rootPlan: null, interferenceMeasured: true,
  })}\n`);
  let remoteCalls = 0;
  try {
    expect(ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, host: 'host-e-wsl' },
      observe: () => {},
      runRemote: () => { remoteCalls += 1; return { kind: 'infra', reason: 'should-not-run' }; },
    })).toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-mismatch (host-e-wsl)', elapsedMs: 0 });
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
      runRemote: () => ({ kind: 'ran', rc: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), commit: HEAD, host: 'host-e-wsl', ms: 4 }),
    });
    expect(result).toMatchObject({ ok: false, source: 'unmeasured', reason: expect.stringContaining('gate-host-mismatch (host-e-wsl) · remote-log:'), host: 'host-e-wsl', attemptedHost: 'node-b' });
    expect(events[0]).toMatchObject({ host: 'host-e-wsl', attemptedHost: 'node-b' });
    expect(existsSync(join(evidenceDir, '51.json'))).toBe(false);
    expect(ensurePrLandHeavyRemote(input, {
      settings: GATE_REMOTE_DEFAULTS,
      observe: () => {},
      runRemote: () => { throw new Error('cached success must not exist'); },
    })).toMatchObject({ ok: false, source: 'unmeasured' });
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});

test('schema 2 success without new extra-gate status cannot skip remote gates', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 51, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  writeFileSync(join(evidenceDir, '51.json'), `${JSON.stringify({
    schema: 2, pr: 51, head: HEAD, main: MAIN, host: 'node-b', passedAt: '2026-10-14T00:00:00.000Z',
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

test('an old WSL pass is never reusable landing evidence', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 54, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  writeFileSync(join(evidenceDir, '54.json'), `${JSON.stringify({
    schema: 2, pr: 54, head: HEAD, main: MAIN, host: 'host-e-wsl', passedAt: '2026-10-14T00:00:00.000Z',
    elapsedMs: 12, rootPlan: null, interferenceMeasured: true,
  })}\n`);
  try {
    expect(ensurePrLandHeavyRemote(input, {
      settings: GATE_REMOTE_DEFAULTS, observe: () => {},
      runRemote: () => ({ kind: 'infra', reason: 'fresh-remote-required' }),
    })).toMatchObject({ ok: false, source: 'unmeasured', reason: 'fresh-remote-required' });
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
    settings: { ...GATE_REMOTE_DEFAULTS, hostCaps: { node-b: 6, node-c: 3 } }, observe: () => {},
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

test('both hosts busy block landing and a failed gate never tries the second host', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'pr-land-heavy-'));
  const input = { pr: 53, head: HEAD, main: MAIN, repo: '/repo', evidenceDir };
  const busyHosts: string[] = [];
  try {
    const busyEvents: Record<string, unknown>[] = [];
    const busy = ensurePrLandHeavyRemote(input, {
      settings: { ...GATE_REMOTE_DEFAULTS, slotWaitSeconds: 0 }, observe: (_event, data) => { busyEvents.push(data); },
      runRemote: (options: RemoteRunOptions) => { busyHosts.push(options.host); return { kind: 'busy' }; },
    });
    expect(busy).toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-busy', attemptedHost: 'node-c' });
    expect(busy.host).toBeUndefined();
    expect(busyEvents[0]).toMatchObject({ host: null, attemptedHost: 'node-c' });
    expect(busyHosts).toEqual(['node-b', 'node-c']);
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

const extraPass = Buffer.from('[pr-land-extra-gates] pass global=measured interference=measured files=2\n');

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
    expect(result).toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-busy', attemptedHost: 'node-c' });
    // Rounds at t=0 and t=15s; the wait to t=30s hits the deadline, so no third round (same cadence as self gate).
    expect(hosts).toEqual(['node-b', 'node-c', 'node-b', 'node-c']);
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
        if (hosts.length < 3) return { kind: 'busy' as const };
        return { kind: 'ran' as const, rc: 0, stdout: extraPass, stderr: Buffer.alloc(0), commit: HEAD, host: options.host, ms: 8 };
      },
    });
    expect(result).toMatchObject({ ok: true, source: 'remote', host: 'node-b' });
    expect(hosts).toEqual(['node-b', 'node-c', 'node-b']);
    expect(clock).toBe(15_000);
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
        return hosts.length < 5
          ? { kind: 'busy' as const }
          : { kind: 'ran' as const, rc: 0, stdout: extraPass, stderr: Buffer.alloc(0), commit: HEAD, host: options.host, ms: 8 };
      },
    });
    expect(result).toMatchObject({ ok: false, source: 'unmeasured', reason: 'gate-host-busy' });
    expect(hosts).toEqual(['node-b', 'node-c', 'node-b', 'node-c']);
    expect(clock).toBe(20_000);
    expect(existsSync(join(evidenceDir, '72.json'))).toBe(false);
  } finally { rmSync(evidenceDir, { recursive: true, force: true }); }
});
