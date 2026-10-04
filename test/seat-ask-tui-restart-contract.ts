import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../src/msg/msg-store.js';
import { answerSeatAsk, askSeat, deliverSeatAnswers, getTuiSeatAskClientId, type AskOrigin } from '../src/seat-dispatch/seat-ask.js';

/** Exercise the persisted return address, not merely the old in-process worker. */
export async function assertTuiSeatAskRestartContract(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'seat-ask-reconnect-'));
  const open = () => new MsgStore(join(root, 'msg', 'messages.db'));
  const received: string[] = [];
  let now = 0;
  try {
    const dashboard = await Bun.file(join(import.meta.dir, '../src/dashboard/index.ts')).text();
    expect(dashboard.includes('const tuiSeatAskClientId = getTuiSeatAskClientId();')).toBe(true);
    expect(dashboard.includes("askSeat(submitIntent.text, { channel: 'tui', clientId: tuiSeatAskClientId }")).toBe(true);
    expect(dashboard.includes("channel: 'tui' as const, clientId: tuiSeatAskClientId,")).toBe(true);
    expect(dashboard.includes('pollTuiSeatAnswers();')).toBe(true);
    const first = getTuiSeatAskClientId(open);
    const store = open();
    let answeredId: string;
    let expiredId: string;
    try {
      const deps = { ownerId: 'owner', replyTarget: 'repo#1',
        runGh: async () => 0, append: (message: Parameters<MsgStore['append']>[0]) => store.append(message) };
      const firstReceipt = await askSeat('CTO에게 물어봐 첫 질문?', { channel: 'tui', clientId: first }, deps, { open, now: () => now, send: async () => {} });
      const secondReceipt = await askSeat('CTO에게 물어봐 두 번째 질문?', { channel: 'tui', clientId: first }, deps, { open, now: () => now, send: async () => {} });
      answeredId = /요청: ([\w-]+)/.exec(firstReceipt)![1]!;
      expiredId = /요청: ([\w-]+)/.exec(secondReceipt)![1]!;
    } finally { store.close(); }
    const afterRestart = getTuiSeatAskClientId(open);
    expect(afterRestart).toBe(first);
    answerSeatAsk(answeredId!, '재접속 답변', { open, now: () => now });
    now = 2 * 60 * 60 * 1000;
    const reconnect = { open, now: () => now, channel: 'tui' as const, clientId: afterRestart,
      send: async (_origin: AskOrigin, text: string) => { received.push(text); } };
    await deliverSeatAnswers({ ...reconnect, clientId: 'unrelated-tui' });
    expect(received).toEqual([]);
    await deliverSeatAnswers(reconnect);
    expect(received).toEqual([
      `CTO 답변 (${answeredId!}): 재접속 답변`,
      `CTO 미답 (${expiredId!}): 아직 답 없음 (120분 경과).`,
    ]);
    await deliverSeatAnswers({ ...reconnect, clientId: 'unrelated-tui' });
    await deliverSeatAnswers(reconnect);
    expect(received).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
