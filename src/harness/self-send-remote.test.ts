import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemotePodOwnershipAmbiguousError, remoteChildOwnershipUnconfirmed, remotePodCardForRun, remotePodControlForOptions, sendRemotePodRun } from './self-send-remote.js';
import { mayLookupRemotePodRun, SELF_SEND_LOCAL_ONLY_ENV } from './self-send-routing-guard.js';

const parent = 'run-12984d48-dd72-40c2-a985-a8e6607ea4d0';
const child = 'run-966c0266-2fee-4c1c-abf6-9242e9b210fd';
const card = { id: 'ta-20261022-d7f55d', runId: parent, parentHost: { host: 'node-b' } };

test('remote Pod control requires exactly one action before any SSH call', () => {
  expect(() => remotePodControlForOptions({})).toThrow('--stop 또는 --memo 한 가지만');
  expect(() => remotePodControlForOptions({ stop: true, memo: 'memo' })).toThrow('--stop 또는 --memo 한 가지만');
  expect(() => remotePodControlForOptions({ memo: '' })).toThrow('non-empty single line');
  expect(() => remotePodControlForOptions({ memo: 'F6', readWait: 'broken' })).toThrow('--read-wait');
  expect(remotePodControlForOptions({ memo: 'F6', readWait: '0' })).toEqual({ memo: 'F6', readWait: '0' });
  expect(remotePodControlForOptions({ stop: true })).toEqual({ stop: true });
});

test('remote child command disables the next SSH lookup', () => {
  expect(mayLookupRemotePodRun({ [SELF_SEND_LOCAL_ONLY_ENV]: '1' })).toBe(false);
  expect(mayLookupRemotePodRun({})).toBe(true);
});

test('F6: an HQ card with no runChildId still routes its parent and mirrored child to the same remote Pod host', () => {
  const cards = [card, { id: 'ta-other', runId: 'run-other', parentHost: { host: 'node-c' } }];
  const children = (candidate: typeof cards[number]) => candidate.id === card.id ? [child] : [];
  expect(remotePodCardForRun(parent, cards, children)).toEqual(card);
  expect(remotePodCardForRun(child, cards, children)).toEqual(card);
  expect(remotePodCardForRun('run-unrelated', cards, children)).toBeNull();
  expect(remotePodCardForRun(parent, [{ ...card, status: 'done' }], () => [child])).toBeNull();
  expect(remotePodCardForRun(child, [{ ...card, runChildId: child, status: 'done' }], () => [child])).toBeNull();
  expect(remoteChildOwnershipUnconfirmed(null, [card])).toBe(true);
  expect(remoteChildOwnershipUnconfirmed(null, cards)).toBe(false);
  expect(remoteChildOwnershipUnconfirmed(card, cards)).toBe(false);
  expect(remoteChildOwnershipUnconfirmed(null, [{ ...card, status: 'done' }])).toBe(false);
});

test('remote send uses only the exact card owner host and preserves the Pod read receipt', () => {
  const calls: Array<{ host: string; script: string; timeout: number }> = [];
  const receipt = sendRemotePodRun(card, child, { memo: "F6 'narrow' test", readWait: '10' }, (host, script, timeout) => {
    calls.push({ host, script, timeout });
    return { status: 0, stdout: 'Pod 조각에 감독 메모 기록: task-x\n자식이 메모 기록을 수거함: record-abc\n', stderr: '' };
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.host).toBe('node-b');
  expect(calls[0]?.script).toContain(`self send --run ${child} --memo 'F6 `);
  expect(calls[0]?.script).toStartWith('ELANOUS_SELF_SEND_LOCAL_ONLY=1 ');
  expect(calls[0]?.script).toContain("--read-wait 10");
  expect(receipt.stdout).toContain('record-abc');
  expect(calls[0]?.timeout).toBeGreaterThan(120_000);
});

test('remote refusal remains a failure and cannot silently target another local screen', () => {
  expect(() => sendRemotePodRun(card, parent, { memo: 'memo', readWait: '0' }, () => ({
    status: 1, stdout: '', stderr: 'Pod 조각 기록도 0',
  }))).toThrow('Pod 조각 기록도 0');
  expect(() => remotePodCardForRun(parent, [card, { ...card, id: 'duplicate' }], () => []))
    .toThrow(RemotePodOwnershipAmbiguousError);
  expect(() => remotePodCardForRun(parent, [card, { id: 'other', runId: 'run-other', parentHost: { host: 'node-c' } }],
    (candidate) => candidate.id === 'other' ? [parent] : [])).toThrow(RemotePodOwnershipAmbiguousError);
  expect(() => sendRemotePodRun(card, parent, { memo: 'memo', readWait: '0' }, () => ({
    status: 0, stdout: '감독 메모 기록: local.inbox.ready/record-x', stderr: '',
  }))).toThrow('원격 Pod 전달 미확인');
});

test('memo shell metacharacters remain one inert argument on the remote shell', () => {
  const home = mkdtempSync(join(tmpdir(), 'self-send-remote-shell-'));
  try {
    const binary = join(home, '.local/share/elanous/bin/elanous');
    mkdirSync(join(home, '.local/share/elanous/bin'), { recursive: true });
    writeFileSync(binary, '#!/bin/sh\nprintf "Pod 조각에 감독 메모 기록: task-x\\n"\nprintf "LOCAL_ONLY=%s\\n" "$ELANOUS_SELF_SEND_LOCAL_ONLY"\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const payload = "F6'; touch \"$HOME/owned\"; echo 'escaped";
    let shellResult: ReturnType<typeof spawnSync> | undefined;
    sendRemotePodRun(card, parent, { memo: payload, readWait: '0' }, (_host, script) => {
      shellResult = spawnSync('/bin/sh', ['-c', script], { env: { HOME: home }, encoding: 'utf8' });
      return { status: shellResult.status, stdout: shellResult.stdout ?? '', stderr: shellResult.stderr ?? '' };
    });
    expect(shellResult?.status).toBe(0);
    expect(shellResult?.stdout).toContain('LOCAL_ONLY=1');
    expect(shellResult?.stdout.split('\n')).toContain(payload);
    expect(existsSync(join(home, 'owned'))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
