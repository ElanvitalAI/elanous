import { debug } from '../debug/log.js';
import type { ExecRequest } from '../exec-requests/store.js';
import { sendPushToAll } from './sender.js';
import { listSubscriptions } from './subscriptions.js';

export async function notifyExecRequestTransition(opts: {
  id: string;
  text: string;
  from: ExecRequest['status'];
  to: ExecRequest['status'];
  summary?: string;
  pendingApprovals: number;
}): Promise<void> {
  const { id, text, from, to, summary, pendingApprovals } = opts;
  const kind = from !== to && (to === 'done' || to === 'failed')
    ? to : pendingApprovals > 0 && from === to ? 'approval' : null;
  if (!kind) return;
  const subscribers = listSubscriptions().length;
  const details = { id, kind, subscribers, textLength: text.length };
  if (!subscribers) {
    debug.log('webpush.exec', 'skipped', details);
    return;
  }
  const title = `${kind === 'done' ? '맡긴 일 완료' : kind === 'failed' ? '맡긴 일 실패' : '게시 승인 대기'} · ${text.slice(0, 40)}`;
  const body = kind === 'approval' ? '승인하거나 보류해 주세요' : (summary ?? '').split(/\r?\n/, 1)[0]!.slice(0, 80);
  try {
    await sendPushToAll({ title, body, url: `/exec?id=${encodeURIComponent(id)}`, tag: `exec-${id}` });
    debug.log('webpush.exec', 'sent', details);
  } catch {
    debug.log('webpush.exec', 'skipped', details);
  }
}
