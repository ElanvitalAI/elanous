// TA-PREFLIGHT ② 배선 시험 — podSelfImplementSpawn 실제 경로(kubectl mock)에서 이미지 digest 대조를 확인한다.
import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLedgerDir } from '../../self-implement/run-ledger.js';
import { podJobName, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';

const PIN = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;

function run(opts: { imageID: string | null; state: 'Complete' | 'Failed'; pin?: string }, root: string, tag: string) {
  const spaceId = `img-wire-${tag}`;
  const job = podJobName(spaceId);
  const kubectl: Kubectl = (args) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
    if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: opts.state, stderr: '' };
    if (args.some((arg) => arg.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('pods') && args.includes('json')) {
      const items = [{ metadata: { name: `${job}-x`, uid: 'u1', creationTimestamp: '2026-11-18T00:00:00Z', ownerReferences: [{ kind: 'Job', name: job }] },
        status: { containerStatuses: [{ name: 'child', ...(opts.imageID ? { imageID: opts.imageID } : {}) }] } }];
      return { status: 0, stdout: JSON.stringify({ items }), stderr: '' };
    }
    if (args.includes('logs')) return { status: 0, stdout: 'child done\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return podSelfImplementSpawn({ kubectl, ...(opts.pin ? { imageDigestPin: opts.pin } : {}), credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }),
    env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: `run-${tag}` } })({ feature: 'x', spaceId }).done;
}

function ledgerText(root: string): string {
  const dir = runLedgerDir(root);
  try { return readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n'); } catch { return ''; }
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'pod-img-wire-'));
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('Pod 소비 digest ≠ 요청 pin → pod-image-digest-mismatch + 원장 digestVerdict=mismatch', () => withRoot(async (root) => {
  const result = await run({ imageID: `docker://reg/x@${OTHER}`, state: 'Complete', pin: PIN }, root, 'mm');
  expect(result.exitCode).toBe(1);
  expect(result.error?.code).toBe('pod-image-digest-mismatch');
  const text = ledgerText(root);
  expect(text).toContain('"digestVerdict":"mismatch"');
  expect(text).toContain(`"digestPin":"${PIN}"`);
}), 30_000);

test('imageID 없음(미관측) + pin → 정상 종료여도 실패(unobserved)', () => withRoot(async (root) => {
  const result = await run({ imageID: null, state: 'Complete', pin: PIN }, root, 'un');
  expect(result.error?.code).toBe('pod-image-digest-mismatch');
  expect(ledgerText(root)).toContain('"digestVerdict":"unobserved"');
}), 30_000);

test('digest = pin → 실패 아님 + 원장 match', () => withRoot(async (root) => {
  const result = await run({ imageID: `docker://reg/x@${PIN}`, state: 'Complete', pin: PIN }, root, 'ok');
  expect(result.exitCode).toBe(0);
  expect(result.error).toBeUndefined();
  expect(ledgerText(root)).toContain('"digestVerdict":"match"');
}), 30_000);

test('pin 없음 → 대조 없음(no-pin), 종전 동작', () => withRoot(async (root) => {
  const result = await run({ imageID: `docker://reg/x@${OTHER}`, state: 'Complete' }, root, 'np');
  expect(result.exitCode).toBe(0);
  expect(result.error).toBeUndefined();
  expect(ledgerText(root)).toContain('"digestVerdict":"no-pin"');
}), 30_000);

test('state=Failed 는 digest 불일치로 덮지 않는다(기존 실패 처리 우선)', () => withRoot(async (root) => {
  const result = await run({ imageID: `docker://reg/x@${OTHER}`, state: 'Failed', pin: PIN }, root, 'fl');
  const baseline = await run({ imageID: `docker://reg/x@${PIN}`, state: 'Failed', pin: PIN }, root, 'flb');
  // digest 가 어긋나도 기존 실패 결과(코드·종료코드)가 그대로 — pin 일치인 같은 Failed 실행과 동일해야 한다.
  expect(result.exitCode).toBe(baseline.exitCode);
  expect(result.error?.code).toBeDefined();
  expect(result.error?.code).toBe(baseline.error?.code);
  expect(result.error?.code).not.toBe('pod-image-digest-mismatch');
}), 30_000);
