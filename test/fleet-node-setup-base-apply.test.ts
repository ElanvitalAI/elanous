import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = readFileSync('scripts/fleet/node-setup.sh', 'utf8');
const helpers = script.slice(script.indexOf('ok() {'), script.indexOf('FAIL=0; TODO=0'));
const stage = script.slice(script.indexOf('# 8. 네임스페이스'), script.indexOf('# 9. 판 대조'));
const serviceAccountError = 'pods "core" is forbidden: error looking up service account elanous-prod/default: serviceaccount "default" not found';

type Step = { command: 'get' | 'diff' | 'apply'; status: number; output?: string };

function run(steps: Step[], check = false) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-base-apply-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls');
  const responses = join(dir, 'responses');
  writeFileSync(responses, steps.map(({ command, status, output = '' }) => `${command}|${status}|${output}`).join('\n') + '\n');
  writeFileSync(join(bin, 'kubectl'), `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_CALLS"
command=''
for arg in "$@"; do
  case "$arg" in get|diff|apply) command="$arg"; break;; esac
done
count=$(wc -l < "$FAKE_CALLS")
line=$(sed -n "\${count}p" "$FAKE_RESPONSES")
IFS='|' read -r expected status output <<< "$line"
if [ "$command" != "$expected" ]; then
  printf 'unexpected kubectl command %s at call %s (expected %s)\\n' "$command" "$count" "$expected" >&2
  exit 99
fi
[ -z "$output" ] || printf '%s\\n' "$output" >&2
exit "$status"
`, { mode: 0o755 });
  try {
    const result = spawnSync('bash', ['-c', `${helpers}FAIL=0; TODO=0\n${stage}\nprintf 'FAIL=%s TODO=%s\\n' "$FAIL" "$TODO"`], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        FAKE_CALLS: calls,
        FAKE_RESPONSES: responses,
        CHECK: check ? '1' : '0',
        CTX: 'pool-fixture',
        ROOT: process.cwd(),
        FLEET_APPLY_RETRY_SLEEP: '0',
      },
    });
    const invocations = readFileSync(calls, 'utf8').trim().split('\n');
    expect(result.status).toBe(0);
    expect(invocations).toHaveLength(steps.length);
    return { output: result.stdout, stderr: result.stderr, invocations };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const apply = (status = 0, output = ''): Step => ({ command: 'apply', status, output });

describe('fleet node setup stage 8', () => {
  test('네임스페이스가 이미 있어도 두 파일을 apply 한다', () => {
    const result = run([apply()]);
    expect(result.invocations[0]).toBe(`--context pool-fixture apply -f ${process.cwd()}/docker/h1/base.yaml -f ${process.cwd()}/docker/h1/policy-internet.yaml`);
    expect(result.output).toContain('✓ elanous-test 네임스페이스 ⊕ 정책 (적용)');
    expect(result.output).toContain('FAIL=0 TODO=0');
    expect(result.stderr).toBe('');
  });

  test('서비스 계정 경합이면 다시 apply 해 성공하고 재시도 1을 표시한다', () => {
    const result = run([apply(1, serviceAccountError), apply()]);
    expect(result.invocations).toHaveLength(2);
    expect(result.output).toContain('✓ elanous-test 네임스페이스 ⊕ 정책 (적용 · 재시도 1)');
    expect(result.output).toContain('FAIL=0 TODO=0');
    expect(result.stderr).toBe('');
  });

  test('다른 오류는 재시도하지 않고 bad', () => {
    const result = run([apply(1, 'connection refused')]);
    expect(result.invocations).toHaveLength(1);
    expect(result.output).toContain('✗ 적용 실패 (재시도 0)');
    expect(result.output).toContain('FAIL=1 TODO=0');
    expect(result.stderr).toContain('connection refused');
  });

  test('default 외 서비스 계정 오류는 재시도하지 않는다', () => {
    const result = run([apply(1, 'serviceaccount "other" not found')]);
    expect(result.invocations).toHaveLength(1);
    expect(result.output).toContain('✗ 적용 실패 (재시도 0)');
    expect(result.stderr).toContain('serviceaccount "other" not found');
  });

  test('서비스 계정 경합이 여섯 번 계속되면 bad', () => {
    const result = run(Array.from({ length: 6 }, (_, index) => apply(1, `${serviceAccountError} (attempt ${index + 1})`)));
    expect(result.invocations).toHaveLength(6);
    expect(result.output).toContain('✗ 적용 실패 (재시도 5)');
    expect(result.output).toContain('FAIL=1 TODO=0');
    expect(result.stderr).toContain(`${serviceAccountError} (attempt 6)`);
    expect(result.stderr).not.toContain('(attempt 1)');
  });

  test('check 모드는 네임스페이스가 없으면 읽기만 하고 todo', () => {
    const result = run([{ command: 'get', status: 1 }], true);
    expect(result.invocations).toEqual(['--context pool-fixture --request-timeout=10s get ns elanous-test']);
    expect(result.output).toContain('→ base.yaml ⊕ policy-internet.yaml 적용');
  });

  test.each([
    { status: 0, result: '✓ elanous-test 네임스페이스 ⊕ 정책' },
    { status: 1, result: '→ base.yaml ⊕ policy-internet.yaml 적용' },
    { status: 2, result: '→ base.yaml ⊕ policy-internet.yaml 적용 (못 쟀다)' },
  ])('check 모드의 diff 종료 코드 $status 는 쓰지 않고 판정한다', ({ status, result }) => {
    const checked = run([{ command: 'get', status: 0 }, { command: 'diff', status }], true);
    expect(checked.invocations[1]).toBe(`--context pool-fixture diff -f ${process.cwd()}/docker/h1/base.yaml -f ${process.cwd()}/docker/h1/policy-internet.yaml`);
    expect(checked.output).toContain(result);
    expect(checked.output).toContain(`FAIL=0 TODO=${status === 0 ? 0 : 1}`);
  });
});
