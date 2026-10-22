import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { dispatchReplMessageTool, isReplMessageTool } from './ops-msg-bridge.js';

test('REPL 우편 브리지는 생산 MsgStore의 게시·조회·ack만 열고 다른 도구는 거부한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-msg-'));
  const openStore = () => new MsgStore(join(dir, 'messages.db'));
  try {
    expect(['MsgList', 'MsgPost', 'MsgAsk', 'MsgAck'].every(isReplMessageTool)).toBe(true);
    expect(isReplMessageTool('ChecklistMove')).toBe(false);
    await expect(dispatchReplMessageTool('ChecklistMove', {})).rejects.toThrow('not a REPL message tool');
    const posted = await dispatchReplMessageTool('MsgPost', { from: 'OP', to: 'TC', body: '문자 하나' }, { ledger: { openStore } });
    const id = (posted.message as { id: number }).id;
    const listed = await dispatchReplMessageTool('MsgList', { to: 'TC' }, { ledger: { openStore } });
    expect((listed.messages as Array<{ id: number }>)[0]?.id).toBe(id);
    const acked = await dispatchReplMessageTool('MsgAck', { to: 'TC', id }, { ledger: { openStore } });
    expect(acked.cursor).toBe(id);
    const empty = await dispatchReplMessageTool('MsgList', { to: 'TC' }, { ledger: { openStore } });
    expect(empty.count).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('REPL MsgAsk는 replyTo로 결속된 답만 받고 질문을 한 번 남긴다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repl-msg-ask-'));
  const openStore = () => new MsgStore(join(dir, 'messages.db'));
  const replyStore = openStore();
  try {
    const result = await dispatchReplMessageTool('MsgAsk', { from: 'OP', to: 'TC', question: '상태?', waitSeconds: 2 }, {
      ask: {
        openStore,
        sleep: async () => {
          const question = replyStore.list('TC')[0]!;
          replyStore.post({ from: 'TC', to: 'OP', body: '진행 중', replyTo: question.id });
        },
      },
    });
    expect(result.ok).toBe(true);
    expect((result.reply as { replyTo: number }).replyTo).toBe((result.question as { id: number }).id);
    expect(replyStore.list('TC')).toHaveLength(1);
  } finally { replyStore.close(); rmSync(dir, { recursive: true, force: true }); }
});
