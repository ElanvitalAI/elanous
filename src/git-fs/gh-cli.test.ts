import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDefaultTimeout, describe, expect, test } from 'bun:test';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repositoryRoot = process.cwd();
const entrypoint = [join(repositoryRoot, 'bin/elanous.mjs')];

function inIsolatedGhWorktree<T>(run: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), 'elanous-gh-cli-cwd-'));
  try {
    return run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function isolatedCliEnvironment(home: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    ELANOUS_SUPPRESS_XDG_WARNING: '1',
    // Keep child stderr byte-exact for the gh status-line contract.
    MSS_LOG_STORE_DIAGNOSTICS: '0',
  };
}

type Fixture = { stdout?: Buffer; stderr?: Buffer; status?: number; attempts?: Buffer[] };

function invokeGh(args: string[], fixture: Fixture) {
  const binDir = mkdtempSync(join(tmpdir(), 'elanous-gh-cli-'));
  const ghPath = join(binDir, 'gh');
  const outPath = join(binDir, 'out.bin');
  const errPath = join(binDir, 'err.bin');
  const countPath = join(binDir, 'count');
  writeFileSync(outPath, fixture.stdout ?? Buffer.alloc(0));
  writeFileSync(errPath, fixture.stderr ?? Buffer.alloc(0));
  if (fixture.attempts) fixture.attempts.forEach((value, index) => writeFileSync(join(binDir, `err-${index}.bin`), value));
  const retryScript = fixture.attempts
    ? `count=0; if [ -f '${countPath}' ]; then count=$(cat '${countPath}'); fi; count=$((count + 1)); printf %s "$count" > '${countPath}'; cat '${outPath}'; cat '${binDir}'/err-$((count - 1)).bin >&2; if [ "$count" -lt ${fixture.attempts.length} ]; then exit 1; fi; exit ${fixture.status ?? 0}`
    : `cat '${outPath}'; cat '${errPath}' >&2; exit ${fixture.status ?? 0}`;
  writeFileSync(ghPath, `#!/bin/sh\nprintf '<%s>\\n' "$@" > '${join(binDir, 'args')}'\n${retryScript}\n`);
  chmodSync(ghPath, 0o755);
  try {
    const result = inIsolatedGhWorktree((cwd) => {
      const home = mkdtempSync(join(tmpdir(), 'elanous-gh-cli-home-'));
      const stateDir = join(cwd, 'state');
      const registryPath = join(home, '.elanous', 'logs', 'instances.json');
      try {
        mkdirSync(join(home, '.elanous', 'logs'), { recursive: true });
        writeFileSync(registryPath, JSON.stringify({ instances: [{ stateDir }] }));
        const result = spawnSync('bun', [...entrypoint, '--test-state-dir', stateDir, 'gh', ...args], {
          cwd,
          env: isolatedCliEnvironment(home, { PATH: `${binDir}:${process.env.PATH ?? ''}` }),
          timeout: 90_000,
          maxBuffer: Infinity,
        });
        const registry = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : '';
        expect(registry).toContain(stateDir);
        expect(registry).not.toContain(process.env.HOME ?? '');
        return result;
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
    return { result, calls: existsSync(countPath) ? readFileSync(countPath, 'utf8') : '1', argv: readFileSync(join(binDir, 'args'), 'utf8') };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}
type GhValue = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  maybeTruncated: boolean;
  itemCount?: number;
  limit?: number;
};

function invokeGhValue(args: string[], fixture: Fixture) {
  const binDir = mkdtempSync(join(tmpdir(), 'elanous-gh-value-'));
  const ghPath = join(binDir, 'gh');
  const outPath = join(binDir, 'out.bin');
  const errPath = join(binDir, 'err.bin');
  const countPath = join(binDir, 'count');
  writeFileSync(outPath, fixture.stdout ?? Buffer.alloc(0));
  writeFileSync(errPath, fixture.stderr ?? Buffer.alloc(0));
  if (fixture.attempts) fixture.attempts.forEach((value, index) => writeFileSync(join(binDir, `err-${index}.bin`), value));
  const retryScript = fixture.attempts
    ? `count=0; if [ -f '${countPath}' ]; then count=$(cat '${countPath}'); fi; count=$((count + 1)); printf %s "$count" > '${countPath}'; cat '${outPath}'; cat '${binDir}'/err-$((count - 1)).bin >&2; if [ "$count" -lt ${fixture.attempts.length} ]; then exit 1; fi; exit ${fixture.status ?? 0}`
    : `printf 1 > '${countPath}'; cat '${outPath}'; cat '${errPath}' >&2; exit ${fixture.status ?? 0}`;
  writeFileSync(ghPath, `#!/bin/sh\n${retryScript}\n`);
  chmodSync(ghPath, 0o755);
  const script = `const root = process.env.REPOSITORY_ROOT; const { runGhCliWithResult } = await import(root + '/src/git-fs/gh-cli.js'); const result = runGhCliWithResult(${JSON.stringify(args)}); process.stdout.write(JSON.stringify({ ...result, stdout: result.stdout.toString('base64'), stderr: result.stderr.toString('base64') }));`;
  try {
    const result = inIsolatedGhWorktree((cwd) => spawnSync('bun', ['-e', script], {
      cwd,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, REPOSITORY_ROOT: repositoryRoot },
      timeout: 90_000,
      maxBuffer: Infinity,
    }));
    return {
      result,
      calls: readFileSync(countPath, 'utf8'),
      value: JSON.parse(result.stdout.toString()) as GhValue,
    };
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

describe('runGhCliWithResult', () => {
  test('returns distinct empty and limit-bound metadata while preserving raw stdout', () => {
    const empty = invokeGhValue(['pr', 'list', '--json', 'number'], { stdout: Buffer.from('[]\n') });
    expect(empty.result.status).toBe(0);
    expect(empty.value).toMatchObject({ ok: true, exitCode: 0, stdout: Buffer.from('[]\n').toString('base64'), maybeTruncated: false, itemCount: 0 });

    const raw = Buffer.from([0xff, 0x00, 0x80]);
    const limited = invokeGhValue(['pr', 'list', '--limit', '2'], { stdout: raw });
    expect(limited.result.status).toBe(0);
    expect(limited.value).toMatchObject({ ok: true, exitCode: 0, stdout: raw.toString('base64'), maybeTruncated: false, itemCount: 1, limit: 2 });

    const truncated = invokeGhValue(['pr', 'list', '--limit', '2'], { stdout: Buffer.from('[{"id":1},{"id":2}]\n') });
    expect(truncated.result.status).toBe(0);
    expect(truncated.value).toMatchObject({ ok: true, exitCode: 0, maybeTruncated: true, itemCount: 2, limit: 2 });
  }, 90_000);

  test('returns failed status and retains read-only retry behavior without retrying writes', () => {
    const failed = invokeGhValue(['api', '/bad'], { stderr: Buffer.from('not found'), status: 7 });
    expect(failed.result.status).toBe(0);
    expect(failed.value).toMatchObject({ ok: false, exitCode: 7, maybeTruncated: false });

    const read = invokeGhValue(['pr', 'list'], { attempts: [Buffer.from('temporary network error'), Buffer.alloc(0)] });
    expect(read.result.status).toBe(0);
    expect(read.calls).toBe('2');

    const write = invokeGhValue(['api', '--method', 'POST', '/repos/x/y/issues'], { attempts: [Buffer.from('temporary network error'), Buffer.alloc(0)] });
    expect(write.result.status).toBe(0);
    expect(write.calls).toBe('1');
  }, 90_000);
});

describe('elanous gh', () => {
  test('forwards argv and distinguishes output, empty, and limit-bound results', () => {
    const output = invokeGh(['pr', 'list', '--limit', '2'], { stdout: Buffer.from('[{"id":1},{"id":2}]\n') });
    expect(output.result.status).toBe(0);
    expect(output.argv).toBe('<pr>\n<list>\n<--limit>\n<2>\n');
    // ⛔⭐ 2026-08-09 계약 정정 — 상태 줄은 «stderr». stdout 은 «원 바이트 그대로»여야 한다.
    //   초판은 stdout 에 붙였고 그래서 `--json` 산출을 `jq` 에 넘기면 죽었다(실측 · `[S]` 가 밟았다).
    expect(output.result.stderr.toString()).toContain('[gh] pr list ok MAYBE_TRUNCATED limit=2 count=2 rc=0');
    expect(output.result.stdout.toString()).toBe('[{"id":1},{"id":2}]\n');

    const empty = invokeGh(['pr', 'list'], {});
    expect(empty.result.status).toBe(0);
    expect(empty.result.stderr.toString()).toContain('[gh] pr list ok EMPTY rc=0');

    // ⛔⭐⭐⭐ **「0건」의 «실제» 모양은 빈 바이트가 아니라 `[]` 다**(라이브 시험이 잡았다).
    //   위 케이스(stdout 0바이트)는 `gh` 가 실무에서 거의 안 내는 모양이라 «판별력이 없었다** —
    //   초판 구현(`stdout.length === 0`)에서도 통과한다. 이 케이스가 그 구현에서 «죽는다».
    //   ⇒ 이것이 `GIT-T7`(0건을 「없다」로 읽고 열린 PR 브랜치를 삭제)이 겨냥한 자리다.
    const jsonEmpty = invokeGh(['pr', 'list', '--json', 'number'], { stdout: Buffer.from('[]\n') });
    expect(jsonEmpty.result.status).toBe(0);
    expect(jsonEmpty.result.stderr.toString()).toContain('[gh] pr list ok EMPTY rc=0');
    // ⭐⭐ 그리고 stdout 은 «파싱 가능한 JSON» 그대로여야 한다 — 이것이 `[S]` 가 밟은 그 계약이다.
    expect(JSON.parse(jsonEmpty.result.stdout.toString())).toEqual([]);
  }, 90_000);

  test('preserves combined short limit argv and marks a limit-bound result as maybe truncated', () => {
    const result = invokeGh(['pr', 'list', '-L2'], { stdout: Buffer.from('[{"id":1},{"id":2}]\n') });
    expect(result.result.status).toBe(0);
    expect(result.argv).toBe('<pr>\n<list>\n<-L2>\n');
    expect(result.result.stderr.toString()).toContain('[gh] pr list ok MAYBE_TRUNCATED limit=2 count=2 rc=0');
  }, 90_000);

  test('preserves raw byte streams and reports failure with the gh exit code', () => {
    const rawOut = Buffer.from([0xff, 0xfe, 0x80]);
    const rawErr = Buffer.from([0x80, 0xc0, 0xaf]);
    const { result } = invokeGh(['api', '/bad'], { stdout: rawOut, stderr: rawErr, status: 7 });
    expect(result.status).toBe(7);
    // ⭐ stdout 은 «원 바이트만» — 접미 한 글자도 안 붙는다(새 계약)
    expect(result.stdout.equals(rawOut)).toBe(true);
    // stderr 는 원 바이트 «뒤» separator ⊕ 상태 줄
    expect((result.stderr as Buffer).equals(Buffer.concat([rawErr, Buffer.from('\n[gh] api /bad FAILED rc=7\n')]))).toBe(true);
  }, 90_000);

  test('reports an unconfirmed primary outcome when local branch deletion fails after gh work', () => {
    const stderr = Buffer.from("failed to delete local branch self-impl/example: cannot delete branch 'self-impl/example' used by worktree at '/tmp/example'");
    const { result } = invokeGh(['pr', 'merge', '10321', '--squash', '--delete-branch'], { stderr, status: 1 });
    expect(result.status).toBe(1);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.toString()).toBe(`${stderr.toString()}\n[gh] pr merge PARTIAL_OUTCOME primary-outcome=UNCONFIRMED auxiliary-failure=local-branch-delete rc=1\n`);
    expect(result.stderr.toString()).not.toContain('primary-outcome=SUCCESS');
  }, 90_000);

  test('retries transient read calls but does not retry explicit or implicit POST api calls', () => {
    const read = invokeGh(['pr', 'list'], { attempts: [Buffer.from('temporary network error'), Buffer.alloc(0)] });
    expect(read.result.status, `stdout=${read.result.stdout.toString()} stderr=${read.result.stderr.toString()} calls=${read.calls}`).toBe(0);
    expect(read.calls).toBe('2');

    for (const fieldOption of [
      ['--method', 'POST'],
      ['-XPOST'],
      ['-f', 'title=x'],
      ['--raw-field=title=x'],
      ['-Ftitle=x'],
      ['--field', 'title=x'],
    ]) {
      const write = invokeGh(['api', ...fieldOption, '/repos/x/y/issues'], { attempts: [Buffer.from('temporary network error'), Buffer.alloc(0)] });
      expect(write.result.status).toBe(1);
      expect(write.calls, fieldOption.join(' ')).toBe('1');
    }
  }, 90_000);

  test('preserves stdout and stderr larger than the default 1MB child-process buffer', () => {
    const stdout = Buffer.alloc(1_200_003, 0xff);
    const stderr = Buffer.alloc(1_200_007, 0x80);
    const { result } = invokeGh(['pr', 'list'], { stdout, stderr });
    expect(result.status).toBe(0);
    expect(result.stdout.equals(stdout)).toBe(true);
    expect(result.stderr.equals(Buffer.concat([stderr, Buffer.from('\n[gh] pr list ok OUTPUT rc=0\n')]))).toBe(true);
  }, 90_000);

  test('does not alter stdout when only stderr lacks a trailing newline', () => {
    const stdout = Buffer.from([0xff, 0x80, 0x0a]);
    const stderr = Buffer.from([0xc0]);
    const { result } = invokeGh(['pr', 'list'], { stdout, stderr });
    expect(result.status).toBe(0);
    expect(result.stdout.equals(stdout)).toBe(true);
    expect(result.stderr.equals(Buffer.concat([stderr, Buffer.from('\n[gh] pr list ok OUTPUT rc=0\n')]))).toBe(true);
  }, 90_000);

  test('records the existing four gh outcome names without changing stdout or the exit code', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'elanous-gh-cli-observation-'));
    const ghPath = join(binDir, 'gh');
    writeFileSync(ghPath, `#!/bin/sh\nprintf %s "$GH_FIXTURE_STDOUT"\nprintf %s "$GH_FIXTURE_STDERR" >&2\nexit "$GH_FIXTURE_STATUS"\n`);
    chmodSync(ghPath, 0o755);
    const script = `const root = process.env.REPOSITORY_ROOT; const { debug } = await import(root + '/src/debug/log.js'); const { runGhCli } = await import(root + '/src/git-fs/gh-cli.js'); debug.setFileEnabled(false); debug.setVerboseEnabled(true); const records = []; const off = debug.registerSink({ name: 'gh-cli-observation-capture', emit: (record) => records.push({ category: record.category, event: record.event, data: record.data }) }); runGhCli(JSON.parse(process.env.GH_ARGS)); off(); debug.setVerboseEnabled(false); process.stderr.write(JSON.stringify(records));`;
    const cases = [
      { args: ['pr', 'list'], stdout: '[{"id":1}]\n', stderr: '', status: '0', outcome: 'ok OUTPUT' },
      { args: ['pr', 'list', '--json', 'number'], stdout: '[]\n', stderr: '', status: '0', outcome: 'ok EMPTY' },
      { args: ['pr', 'list', '--limit', '2'], stdout: '[{"id":1},{"id":2}]\n', stderr: '', status: '0', outcome: 'ok MAYBE_TRUNCATED' },
      { args: ['api', '/bad'], stdout: '', stderr: 'not found', status: '7', outcome: 'FAILED' },
      {
        args: ['pr', 'merge', '10321', '--squash', '--delete-branch'],
        stdout: '',
        stderr: "failed to delete local branch self-impl/example: cannot delete branch 'self-impl/example' used by worktree at '/tmp/example'",
        status: '1',
        outcome: 'FAILED',
        auxiliaryFailure: 'local-branch-delete',
      },
    ];
    try {
      for (const fixture of cases) {
        const result = inIsolatedGhWorktree((cwd) => spawnSync('bun', ['-e', script], {
          cwd,
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, REPOSITORY_ROOT: repositoryRoot, GH_ARGS: JSON.stringify(fixture.args), GH_FIXTURE_STDOUT: fixture.stdout, GH_FIXTURE_STDERR: fixture.stderr, GH_FIXTURE_STATUS: fixture.status },
          encoding: 'utf8',
          timeout: 60_000,
        }));
        expect(result.status).toBe(Number(fixture.status));
        expect(result.stdout).toBe(fixture.stdout);
        const lines = result.stderr.trimEnd().split('\n');
        const records = JSON.parse(lines.pop()!) as Array<{ category: string; event: string; data?: Record<string, unknown> }>;
        const record = records.find(({ category, event }) => category === 'gh.cli' && event === 'completed');
        expect(record?.data).toMatchObject({ subcommand: fixture.args.slice(0, 2).join(' '), exitCode: Number(fixture.status), ok: fixture.status === '0', outcome: fixture.outcome });
        expect(record?.data?.durationMs).toBeNumber();
        if (fixture.auxiliaryFailure) {
          expect(lines).toContain('[gh] pr merge PARTIAL_OUTCOME primary-outcome=UNCONFIRMED auxiliary-failure=local-branch-delete rc=1');
          expect(records.find(({ category, event }) => category === 'gh.cli' && event === 'partial-outcome')?.data).toMatchObject({
            subcommand: 'pr merge',
            exitCode: 1,
            auxiliaryFailure: fixture.auxiliaryFailure,
          });
        }
      }
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 90_000);
});
