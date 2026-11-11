import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCronGitCredentials } from './cron-git-credential-audit.js';

test('cron HTTPS Git probe uses noninteractive credentials and reports only redacted status', async () => {
  const calls: Array<{ input: string; env: NodeJS.ProcessEnv; cwd: string }> = [];
  const observations = await auditCronGitCredentials([
    { id: 'runner-sync', remote: 'https://github.com/elanous/private.git', cwd: '/tmp/runner-sync' },
    { id: 'internal-publish', remote: 'https://github.com/elanous/internal.git', cwd: '/tmp/internal-publish' },
  ], (input, env, cwd) => {
    calls.push({ input, env, cwd });
    return input.includes('private.git')
      ? { status: 0, stdout: 'protocol=https\nusername=app\npassword=TOP_SECRET\n' }
      : { status: 128, stdout: 'fatal: password=SHOULD_NOT_LEAK' };
  }, {}, remote => ({ status: 0, stdout: remote + '\n' }));
  expect(observations).toEqual([
    { id: 'runner-sync', status: 'ready', reason: 'credential-present' },
    { id: 'internal-publish', status: 'unmeasured', reason: 'credential-unavailable' },
  ]);
  expect(calls[0]!.input).toBe('url=https://github.com/elanous/private.git\n\n');
  expect(calls.map(call => call.cwd)).toEqual(['/tmp/runner-sync', '/tmp/internal-publish']);
  expect(calls[0]!.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false',
    GCM_INTERACTIVE: 'never', GIT_CREDENTIAL_INTERACTIVE: 'never' });
  expect(JSON.stringify(observations)).not.toContain('TOP_SECRET');
  expect(JSON.stringify(observations)).not.toContain('SHOULD_NOT_LEAK');
});

test('cron Git probe rejects non-HTTPS and embedded credentials without calling a helper', async () => {
  let calls = 0;
  const observations = await auditCronGitCredentials([
    { id: 'ssh-job', remote: 'git@github.com:elanous/private.git', cwd: '/tmp/ssh-job' },
    { id: 'embedded-secret', remote: 'https://token@github.com/elanous/private.git', cwd: '/tmp/embedded-secret' },
    { id: 'backslash-user', remote: 'https://safe.example\\alice:secret@evil.example/repo', cwd: '/tmp/backslash-user' },
  ], () => { calls++; return { status: 0, stdout: '' }; });
  expect(observations.map(item => item.status)).toEqual(['unsupported', 'unsupported', 'unsupported']);
  expect(calls).toBe(0);
});

test('cron Git probe resolves configured insteadOf rewrites before checking credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cron-git-rewrite-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'url.ssh://git@evil.example/.insteadOf', 'https://safe.example/']);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const observations = await auditCronGitCredentials([
      { id: 'rewritten', remote: 'https://safe.example/private.git', cwd: root },
    ], () => { throw new Error('credential helper must not run for SSH rewrite'); }, env);
    expect(observations).toEqual([{ id: 'rewritten', status: 'unsupported', reason: 'non-https-or-invalid' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cron Git probe queries credentials for the rewritten HTTPS host and treats resolver failure as unmeasured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cron-git-https-rewrite-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'url.https://actual.example/.insteadOf', 'https://alias.example/']);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const inputs: string[] = [];
    const observed = await auditCronGitCredentials([
      { id: 'rewritten', remote: 'https://alias.example/private.git', cwd: root },
    ], input => { inputs.push(input); return { status: 0, stdout: 'username=probe\npassword=fake\n' }; }, env);
    expect(observed[0]?.status).toBe('ready');
    expect(inputs).toEqual(['url=https://actual.example/private.git\n\n']);
    const unavailable = await auditCronGitCredentials([
      { id: 'resolver-failed', remote: 'https://alias.example/private.git', cwd: root },
    ], () => { throw new Error('credential command must not run'); }, env,
    () => ({ status: null, stdout: '' }));
    expect(unavailable).toEqual([{ id: 'resolver-failed', status: 'unmeasured', reason: 'credential-unavailable' }]);
    const failedWithUrl = await auditCronGitCredentials([
      { id: 'resolver-error', remote: 'https://alias.example/private.git', cwd: root, direction: 'fetch' },
    ], () => { throw new Error('credential command must not run'); }, env,
    remote => ({ status: 128, stdout: remote + '\n' }));
    expect(failedWithUrl).toEqual([{ id: 'resolver-error', status: 'unmeasured', reason: 'credential-unavailable' }]);
    const pushFailedWithUrl = await auditCronGitCredentials([
      { id: 'push-error', remote: 'https://alias.example/private.git', cwd: root },
    ], () => { throw new Error('credential command must not run'); }, env,
    (remote, _env, _cwd, direction) => ({ status: direction === 'push' ? 128 : 0, stdout: remote + '\n' }));
    expect(pushFailedWithUrl).toEqual([{ id: 'push-error', status: 'unmeasured', reason: 'credential-unavailable' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cron Git probe refuses to claim push readiness when pushInsteadOf may change the host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cron-git-push-rewrite-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'url.https://push.example/.pushInsteadOf', 'https://alias.example/']);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const inputs: string[] = [];
    const observations = await auditCronGitCredentials([
      { id: 'unknown', remote: 'https://alias.example/repo.git', cwd: root },
      { id: 'fetch', remote: 'https://alias.example/repo.git', cwd: root, direction: 'fetch' },
      { id: 'push', remote: 'https://alias.example/repo.git', cwd: root, direction: 'push' },
      { id: 'unrelated-push-rule', remote: 'https://other.example/repo.git', cwd: root, direction: 'push' },
    ], input => { inputs.push(input); return { status: 0, stdout: 'username=probe\npassword=fake\n' }; }, env);
    expect(observations.map(item => item.status)).toEqual(['unmeasured', 'ready', 'unmeasured', 'ready']);
    expect(inputs).toEqual([
      'url=https://alias.example/repo.git\n\n',
      'url=https://other.example/repo.git\n\n',
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cron Git probe accepts root HTTPS remotes', async () => {
  const observations = await auditCronGitCredentials([
    { id: 'bare-host', remote: 'https://example.test', cwd: '/tmp/bare-host' },
    { id: 'host-slash', remote: 'https://example.test/', cwd: '/tmp/host-slash' },
  ], () => ({ status: 0, stdout: 'username=probe\npassword=fake\n' }), {},
  remote => ({ status: 0, stdout: remote + '\n' }));
  expect(observations.map(item => item.status)).toEqual(['ready', 'ready']);
});

test('cron Git probe uses each repository helper and Git-decoded URL path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cron-git-credentials-'));
  const configured = join(root, 'configured');
  const other = join(root, 'other');
  const capture = join(root, 'helper-input');
  try {
    execFileSync('git', ['init', '-q', configured]);
    execFileSync('git', ['init', '-q', other]);
    execFileSync('git', ['-C', configured, 'config', 'credential.useHttpPath', 'true']);
    execFileSync('git', ['-C', configured, 'config', 'credential.helper',
      '!f() { test "$GCM_INTERACTIVE" = never && test "$GIT_CREDENTIAL_INTERACTIVE" = never || exit 1; cat > "$CRON_CRED_CAPTURE"; printf "username=probe\npassword=fake\n"; }; f']);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CRON_CRED_CAPTURE: capture };
    const observations = await auditCronGitCredentials([
      { id: 'configured', remote: 'https://example.test/org/a%20b.git', cwd: configured },
      { id: 'other', remote: 'https://example.test/org/a%20b.git', cwd: other },
    ], undefined, env);
    expect(observations.map(item => item.status)).toEqual(['ready', 'unmeasured']);
    expect(readFileSync(capture, 'utf8')).toContain('path=org/a b.git');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cron Git probe shares one timeout budget across URL resolution and credential lookup', async () => {
  const originalNow = Date.now;
  let clock = 0;
  const timeouts: number[] = [];
  // 출처: deterministic fake-clock step; it measures budget consumption and is not a product timeout.
  const fakeClockStepMs = 1_000;
  Date.now = () => { const current = clock; clock += fakeClockStepMs; return current; };
  try {
    const observed = await auditCronGitCredentials([
      { id: 'bounded', remote: 'https://example.test/repo.git', cwd: '/tmp/bounded' },
    ], (_input, _env, _cwd, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { status: 0, stdout: 'username=probe\npassword=fake\n' };
    }, {}, (_remote, _env, _cwd, _direction, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { status: 0, stdout: 'https://example.test/repo.git\n' };
    });
    expect(observed[0]?.status).toBe('ready');
    expect(timeouts).toHaveLength(3);
    // Source: #36783 review finding 2 — child calls consume one shared per-job deadline.
    expect(timeouts[0]).toBeGreaterThan(timeouts[1]!);
    // Source: #36783 review finding 2 — each later child receives only the remaining budget.
    expect(timeouts[1]).toBeGreaterThan(timeouts[2]!);
  } finally { Date.now = originalNow; }
});

test('cron Git probe kills a hung credential helper and its child process group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cron-git-hung-helper-'));
  const timeoutMs = 500; // Source: #36783 Terra must-fix; short test deadline for a deliberately sleeping helper.
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'credential.helper',
      `!f() { (trap '' TERM; sleep 30) & wait; }; f`]);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const startedAt = Date.now();
    const observed = await auditCronGitCredentials([
      { id: 'hung-helper', remote: 'https://example.test/repo.git', cwd: root, direction: 'fetch' },
    ], undefined, env, undefined, timeoutMs);
    const elapsedMs = Date.now() - startedAt;
    expect(observed).toEqual([{ id: 'hung-helper', status: 'unmeasured', reason: 'credential-unavailable' }]);
    // Source: #36783 Terra must-fix; process-group cleanup must finish well before the fixture sleep completes.
    expect(elapsedMs).toBeLessThan(timeoutMs * 6);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cron Git probe kills a TERM-resistant helper child after it closes inherited pipes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cron-git-closed-pipes-'));
  const childPidFile = join(root, 'helper-child.pid');
  const timeoutMs = 500; // Source: #36783 Terra must-fix; short test deadline for a deliberately sleeping helper.
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'credential.helper',
      `!f() { (trap '' TERM; sleep 30) </dev/null >/dev/null 2>&1 & echo $! > "$CRON_HELPER_CHILD_PID_FILE"; wait; }; f`]);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CRON_HELPER_CHILD_PID_FILE: childPidFile };
    const startedAt = Date.now();
    const observed = await auditCronGitCredentials([
      { id: 'closed-pipes', remote: 'https://example.test/repo.git', cwd: root, direction: 'fetch' },
    ], undefined, env, undefined, timeoutMs);
    const elapsedMs = Date.now() - startedAt;
    expect(observed).toEqual([{ id: 'closed-pipes', status: 'unmeasured', reason: 'credential-unavailable' }]);
    // Source: #36783 Terra must-fix; process-group cleanup must finish well before the fixture sleep completes.
    expect(elapsedMs).toBeLessThan(timeoutMs * 6);
    const childPidText = readFileSync(childPidFile, 'utf8').trim();
    expect(childPidText).toMatch(/^\d+$/);
    let processState = '';
    try { processState = execFileSync('ps', ['-o', 'stat=', '-p', childPidText], { encoding: 'utf8' }).trim(); } catch { /* no process remains */ }
    expect(processState === '' || processState.startsWith('Z')).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cron Git credential CLI validates jobs and keeps real process output secret-free', () => {
  const root = mkdtempSync(join(tmpdir(), 'cron-git-audit-cli-'));
  const jobsFile = join(root, 'jobs.json');
  const script = fileURLToPath(new URL('./cron-git-credential-audit.ts', import.meta.url));
  const runCli = (jobs: unknown, extraEnv: NodeJS.ProcessEnv = {}) => {
    writeFileSync(jobsFile, JSON.stringify(jobs));
    return spawnSync(process.execPath, [script, '--jobs-file', jobsFile], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extraEnv },
    });
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'credential.helper',
      '!f() { printf "username=probe\\npassword=CLI_SECRET\\n"; }; f']);
    const ready = runCli([{ id: 'ready', remote: 'https://example.test/repo.git', cwd: root }]);
    // 출처: Node process exit-code convention — zero means successful CLI completion.
    expect(ready.status).toBe(0);
    expect(JSON.parse(ready.stdout).observations).toEqual([
      { id: 'ready', status: 'ready', reason: 'credential-present' },
    ]);
    expect(ready.stdout).not.toContain('CLI_SECRET');

    const unsupported = runCli([{ id: 'ssh', remote: 'git@example.test:repo.git', cwd: root }]);
    // 출처: Node process exit-code convention — nonzero reports an unready audit.
    expect(unsupported.status).not.toBe(0);
    expect(JSON.parse(unsupported.stdout).observations[0]?.status).toBe('unsupported');
    expect(unsupported.stdout).not.toContain('CLI_SECRET');

    const malformed = runCli([null]);
    // 출처: Node process exit-code convention — nonzero reports invalid CLI input.
    expect(malformed.status).not.toBe(0);
    expect(malformed.stdout).toBe('');
    expect(malformed.stderr).toContain('invalid cron Git jobs file');
    expect(malformed.stderr).not.toContain('CLI_SECRET');

    const childPidFile = join(root, 'cli-helper-child.pid');
    execFileSync('git', ['-C', root, 'config', 'credential.helper',
      `!f() { (trap '' TERM; sleep 30) </dev/null >/dev/null 2>&1 & echo $! > "$CRON_HELPER_CHILD_PID_FILE"; wait; }; f`]);
    const timedOut = runCli([{ id: 'hung-cli-helper', remote: 'https://example.test/repo.git', cwd: root }], {
      CRON_HELPER_CHILD_PID_FILE: childPidFile,
    });
    // Source: #36783 Terra must-fix — actual CLI must remain alive until its child process group is killed.
    expect(timedOut.status).not.toBe(0);
    expect(timedOut.stderr).not.toContain('CLI_SECRET');
    const childPidText = readFileSync(childPidFile, 'utf8').trim();
    expect(childPidText).toMatch(/^\d+$/);
    let processState = '';
    try { processState = execFileSync('ps', ['-o', 'stat=', '-p', childPidText], { encoding: 'utf8' }).trim(); } catch { /* no process remains */ }
    expect(processState === '' || processState.startsWith('Z')).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000); // Source: #36783 production probe timeout plus process-group cleanup grace.
