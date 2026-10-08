import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

setDefaultTimeout(60_000);
const root = resolve(import.meta.dir, '../..');

function spawnWizard(...args: string[]) {
  const state = mkdtempSync(join(tmpdir(), 'graph-wizard-cli-'));
  try {
    const proc = Bun.spawnSync(['bun', join(root, 'bin/elanous.mjs'), `--test=${state}`, 'graph', 'wizard', ...args], {
      cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ELANOUS_STATE_DIR: state },
    });
    return { code: proc.exitCode, stdout: new TextDecoder().decode(proc.stdout), stderr: new TextDecoder().decode(proc.stderr) };
  } finally { rmSync(state, { recursive: true, force: true }); }
}

// 인자 거부는 LLM 을 부르기 «전»에 끝난다 — 이 시험은 자격 없이 결정적이다.
test('graph wizard rejects a real run, an unknown kind and a workflow dry-run before any LLM call', () => {
  const run = spawnWizard('뉴스 요약', '--run');
  expect(run.code).toBe(1);
  expect(run.stderr).toContain('--run is only supported with --dry-run');
  const kind = spawnWizard('뉴스 요약', '--kind', 'other');
  expect(kind.code).toBe(1);
  expect(kind.stderr).toContain('--kind must be harness or workflow');
  const workflowRun = spawnWizard('뉴스 요약', '--kind', 'workflow', '--run', '--dry-run');
  expect(workflowRun.code).toBe(1);
  expect(workflowRun.stderr).toContain('harness graphs only');
});

test('graph step: the last stdout line is the JSON outcome the runner reads, failures exit 1 and --retries retries in place', () => {
  const state = mkdtempSync(join(tmpdir(), 'graph-step-cli-'));
  try {
    const proc = Bun.spawnSync(['bun', join(root, 'bin/elanous.mjs'), `--test=${state}`, 'graph', 'step', 'custom', '--arg', '노션 업로드', '--retries', '1'], {
      cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ELANOUS_STATE_DIR: state },
    });
    expect(proc.exitCode).toBe(1);
    const last = new TextDecoder().decode(proc.stdout).trim().split('\n').at(-1)!;
    expect(JSON.parse(last)).toMatchObject({ outcome: 'fail', tries: 2, error: expect.stringContaining('노션 업로드') });
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('graph wizard is listed with its options', () => {
  const help = spawnWizard('--help');
  expect(help.code).toBe(0);
  for (const flag of ['--kind', '--from', '--out', '--json', '--run', '--dry-run']) expect(help.stdout).toContain(flag);
});
