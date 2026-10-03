import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import * as sender from './sender.js';
import { _setPushSubsPathForTest, addSubscription } from './subscriptions.js';
import { notifyExecRequestTransition } from './notify-exec-request.js';

const dirs: string[] = [];
afterEach(() => { _setPushSubsPathForTest(null); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function isolatedSubscriptions(subscribed: boolean): void {
  const dir = mkdtempSync(join(tmpdir(), 'exec-push-'));
  dirs.push(dir);
  _setPushSubsPathForTest(join(dir, 'subs.json'));
  if (subscribed) addSubscription({ subscription: { endpoint: 'https://example.test/push', keys: { p256dh: 'a', auth: 'b' } } });
}

const base = { id: 'request-id', text: '요청 원문 비밀 ' + '가'.repeat(50), from: 'running' as const, pendingApprovals: 0 };

test('completion and failure push contain first-line summaries, bounded titles and stable navigation/tag', async () => {
  isolatedSubscriptions(true);
  const send = spyOn(sender, 'sendPushToAll').mockResolvedValue({ attempted: 1, delivered: 1, removed: 0, errors: [] });
  try {
    await notifyExecRequestTransition({ ...base, to: 'done', summary: '요약'.repeat(50) + '\n비밀 두 번째 줄' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual({ title: `맡긴 일 완료 · ${base.text.slice(0, 40)}`, body: '요약'.repeat(40), url: '/exec?id=request-id', tag: 'exec-request-id' });
    await notifyExecRequestTransition({ ...base, to: 'failed', summary: '실패 사유\n나머지' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toEqual({ title: `맡긴 일 실패 · ${base.text.slice(0, 40)}`, body: '실패 사유', url: '/exec?id=request-id', tag: 'exec-request-id' });
  } finally { send.mockRestore(); }
});

test('new approval sends once, while unchanged status without a new approval and zero subscribers send nothing', async () => {
  isolatedSubscriptions(true);
  const send = spyOn(sender, 'sendPushToAll').mockResolvedValue({ attempted: 1, delivered: 1, removed: 0, errors: [] });
  try {
    await notifyExecRequestTransition({ ...base, from: 'running', to: 'running', pendingApprovals: 1 });
    expect(send.mock.calls[0]![0]).toEqual({ title: `게시 승인 대기 · ${base.text.slice(0, 40)}`, body: '승인하거나 보류해 주세요', url: '/exec?id=request-id', tag: 'exec-request-id' });
    await notifyExecRequestTransition({ ...base, to: 'running' });
    await notifyExecRequestTransition({ ...base, to: 'done', from: 'done' });
    expect(send).toHaveBeenCalledTimes(1);
    isolatedSubscriptions(false);
    await notifyExecRequestTransition({ ...base, to: 'done' });
    expect(send).toHaveBeenCalledTimes(1);
  } finally { send.mockRestore(); }
});

test('push exceptions are swallowed and diagnostic events contain length, not original request', async () => {
  isolatedSubscriptions(true);
  const send = spyOn(sender, 'sendPushToAll').mockRejectedValue(new Error('push failed'));
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    await expect(notifyExecRequestTransition({ ...base, to: 'failed', summary: 'failed' })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('webpush.exec', 'skipped', { id: base.id, kind: 'failed', subscribers: 1, textLength: base.text.length });
    expect(JSON.stringify(log.mock.calls)).not.toContain(base.text);
  } finally { send.mockRestore(); log.mockRestore(); }
});
