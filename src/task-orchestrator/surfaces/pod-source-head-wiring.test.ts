// TA-PREFLIGHT ① 배선 시험 — 순수 함수가 아니라 podSelfImplementSpawn 실제 경로(kubectl mock)로 확인한다.
import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLedgerDir } from '../../self-implement/run-ledger.js';
import { podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';

const PIN = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function run(logs: string, state: 'Complete' | 'Failed', root: string, runId: string) {
  const kubectl: Kubectl = (args) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
    if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: state, stderr: '' };
    if (args.some((arg) => arg.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: logs, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return podSelfImplementSpawn({ kubectl, source: { kind: 'commit', sha: PIN }, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }),
    env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: runId } })({ feature: 'x', spaceId: `head-wire-${runId}` }).done;
}

function ledgerText(root: string): string {
  const dir = runLedgerDir(root);
  try { return readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n'); } catch { return ''; }
}

test('자식 로그 HEAD ≠ 핀 → pod-source-head-mismatch + 원장 pod-source-head-check(mismatch)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-head-wire-'));
  try {
    const result = await run(`ELANOUS_POD_SOURCE commit ${OTHER}\nchild done\n`, 'Complete', root, 'run-head-mismatch');
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe('pod-source-head-mismatch');
    const text = ledgerText(root);
    expect(text).toContain('pod-source-head-check');
    expect(text).toContain('"verdict":"mismatch"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('정상 종료인데 영수증 줄 없음 → pod-source-head-mismatch(missing) · 원장 기록', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-head-wire-'));
  try {
    const result = await run('child done\n', 'Complete', root, 'run-head-missing');
    expect(result.error?.code).toBe('pod-source-head-mismatch');
    expect(ledgerText(root)).toContain('"verdict":"missing"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HEAD = 핀이면 mismatch 로 실패하지 않는다 + 원장 match', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-head-wire-'));
  try {
    const result = await run(`ELANOUS_POD_SOURCE commit ${PIN}\nchild done\n`, 'Complete', root, 'run-head-match');
    expect(result.error?.code).not.toBe('pod-source-head-mismatch');
    expect(ledgerText(root)).toContain('"verdict":"match"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('자식이 영수증 전에 실패(state=failed)하면 mismatch 로 덮지 않는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-head-wire-'));
  try {
    const result = await run('clone died\n', 'Failed', root, 'run-head-failed');
    expect(result.error?.code).not.toBe('pod-source-head-mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('고아 PR: 정상 종료 + 다른 HEAD 로 이미 PR 을 열었으면 실패 사유에 PR 번호·가지가 남는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-head-wire-'));
  try {
    const terminal = JSON.stringify({ stage: 'pr-opened', ok: true, prNumber: 777, branch: 'feat/orphan-x' });
    const result = await run(`ELANOUS_POD_SOURCE commit ${OTHER}\n${terminal}\n`, 'Complete', root, 'run-head-orphan');
    expect(result.error?.code).toBe('pod-source-head-mismatch');
    expect(result.error?.message).toContain('PR #777');
    expect(result.error?.message).toContain('feat/orphan-x');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('시도 리셋: 1차(gh 로그인 실패 exit 7)가 match 영수증을 냈어도 2차에 영수증이 없으면 실패한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-head-wire-'));
  try {
    let applies = 0;
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input && JSON.parse(input).kind === 'Job') applies += 1;
      if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: applies < 2 ? 'Failed' : 'Complete', stderr: '' };
      if (args.some((arg) => arg.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('pods') && !args.includes('json')) return { status: 0, stdout: '2026-11-18T00:00:00Z\tError\t7\n', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: applies < 2 ? `ELANOUS_POD_SOURCE commit ${PIN}\n` : 'second attempt without receipt\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = await podSelfImplementSpawn({ kubectl, source: { kind: 'commit', sha: PIN }, sleep: async () => {},
      credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }),
      env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: 'run-head-reset' } })({ feature: 'x', spaceId: 'head-wire-reset' }).done;
    expect(applies).toBe(2);
    expect(result.error?.code).toBe('pod-source-head-mismatch');
    expect(result.error?.message).toContain('영수증 없음');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
