import { expect, test } from 'bun:test';
import { seatLineIsPublicSafe } from './seat-public';
import { publicAccountLabel, publicDecisionText, publicEventLabel, publicNodeLabel, publicRunLabel, publicUniverseLabel, publicSiteLabel, publicModelLabel } from './stage-public';

test('stable run order and universe/account aliases never expose identifiers', () => {
  const id = 'run-f22cea41-2868-48d5-a426-5c3a9efab5b4';
  expect(publicRunLabel(id, 0)).toBe('런 1');
  expect(publicRunLabel(id, 0)).toBe(publicRunLabel(id, 0));
  expect(publicRunLabel('run-12345678', 1)).toBe('런 2');
  expect(publicRunLabel('run-outside-snapshot', -1)).toBe('미등록 런');
  expect(publicRunLabel('run-outside-snapshot', -1)).not.toBe(publicRunLabel(id, 0));
  expect(publicUniverseLabel('ELANOUS HARNESS:HARVEST')).toBe('본부');
  const accounts = ['account-2', 'remote-1', 'default', 'team', 'third', 'account-27', 'unknown-private-account'];
  const labels = accounts.map(publicAccountLabel);
  expect(new Set(labels).size).toBe(accounts.length);
  for (const [i, name] of accounts.entries()) {
    expect(labels[i]).toMatch(/^계정 [A-Z]+$/);
    expect(publicAccountLabel(name)).toBe(labels[i]);
    expect(seatLineIsPublicSafe(labels[i]!)).toBe(true);
  }
});

test('event categories map to public kinds; unknown categories never appear', () => {
  expect(publicEventLabel('harness.substrate', 'dispatch-pod-exit')).toBe('경로 정하기');
  expect(publicEventLabel('self-dev.supervisor', 'decompose-proposal.backfill')).toBe('계획');
  expect(publicEventLabel('oauth.codex-account', 'reset-credit-available')).toBe('신호');
  expect(publicEventLabel('review-loop', 'rework-start')).toBe('스스로 수리');
  expect(publicEventLabel('review-loop', 'merged')).toBe('착지');
  expect(publicEventLabel('self-gate', 'pass')).toBe('검증');
  expect(publicEventLabel('dev-pipeline', 'rejected')).toBe('사람에게 묻기');
  for (const kind of ['ROUTE', 'PLAN', 'HEAL', 'SHIP', 'VERIFY', 'ESCALATE'] as const) {
    expect(seatLineIsPublicSafe(publicDecisionText(kind))).toBe(true);
  }
});

test('site and model labels use public families and numbered unknowns without leaking originals', () => {
  expect(publicSiteLabel('stream-llm')).toBe('대화');
  expect(publicSiteLabel('agent-turn')).toBe('자리 턴');
  expect(publicSiteLabel('pod-rollup')).toBe('파드 작업');
  expect(publicSiteLabel('stream-internal')).toBe('대화 작업');
  expect(publicSiteLabel('agent-internal')).toBe('자리 작업');
  expect(publicSiteLabel('secret.site-unique')).toMatch(/^작업 \d+$/);
  expect(publicSiteLabel('secret.site-unique')).toBe(publicSiteLabel('secret.site-unique'));
  expect(publicSiteLabel('other.secret.site')).toMatch(/^작업 \d+$/);
  expect(publicSiteLabel('other.secret.site')).not.toBe(publicSiteLabel('secret.site-unique'));
  expect(publicModelLabel('gpt-5.6-terra')).toBe('GPT');
  expect(publicModelLabel('Claude-4.5-sonnet')).toBe('Claude');
  expect(publicModelLabel('grok-4.6')).toBe('Grok');
  expect(publicModelLabel('secret-model-v10')).toMatch(/^모델 \d+$/);
  expect(publicModelLabel('secret-model-v10')).toBe(publicModelLabel('secret-model-v10'));
  expect(publicModelLabel('other-secret-model')).toMatch(/^모델 \d+$/);
  expect(publicModelLabel('other-secret-model')).not.toBe(publicModelLabel('secret-model-v10'));
  for (const raw of ['stream-llm', 'agent-turn', 'pod-rollup', 'secret.site-unique', 'other.secret.site']) {
    expect(publicSiteLabel(raw)).not.toContain(raw);
  }
  for (const raw of ['gpt-5.6-terra', 'Claude-4.5-sonnet', 'grok-4.6', 'secret-model-v10', 'other-secret-model']) {
    expect(publicModelLabel(raw)).not.toContain(raw);
  }
});

test('canvas labels preserve models but fold private graph node identifiers', () => {
  const id = 'run-f22cea41-2868-48d5-a426-5c3a9efab5b4';
  const nodes = [
    { id: `run:${id}`, kind: 'run', label: 'f22cea' },
    { id: 'uni:ELANOUS HARNESS:HARVEST', kind: 'universe', label: 'ELANOUS HARNESS:HARVEST' },
    { id: 'acct:account-2', kind: 'account', label: 'account-2' },
    { id: 'pod:remote-1', kind: 'pod', label: 'remote-1' },
    { id: 'pr:22745', kind: 'pr', label: '#22745' },
    { id: 'target:private', kind: 'target', label: 'private' },
  ] as const;
  for (const node of nodes) expect(seatLineIsPublicSafe(publicNodeLabel(node, [id]))).toBe(true);
  expect(publicNodeLabel({ id: 'pod:pool-private@remote', kind: 'pod', label: 'private' }, [id])).toBe(publicAccountLabel('pool-private@remote'));
  expect(publicNodeLabel({ id: 'model:gpt-5', kind: 'model', label: 'gpt-5' }, [id])).toBe('gpt-5');
});
