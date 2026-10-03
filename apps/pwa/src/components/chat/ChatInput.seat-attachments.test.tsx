import { afterEach, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { useState } from 'react';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import { SeatRequestError } from '@/lib/daemon-client';
import type { AttachmentMeta } from '@/lib/upload-attachment';
import { ChatInput } from './ChatInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const attachment = (id: string): AttachmentMeta => ({ id, filename: `${id}.pdf`, size: 20,
  mediaType: 'application/pdf', downloadUrl: `/v1/attachments/${id}` });
const mounted: Array<ReturnType<typeof create>> = [];
afterEach(async () => { for (const tree of mounted.splice(0)) await act(async () => { tree.unmount(); }); });

async function setup(initial: AttachmentMeta[], outcome: (request: { seat?: string; text: string; attachments?: AttachmentMeta[] }) => Promise<{
  receiptId: string; seat: string; queuedAt: string; attachments?: number; channel?: string;
}>) {
  const requests: Array<{ request: { seat?: string; text: string; attachments?: AttachmentMeta[] }; key: string }> = [];
  const chats: string[] = [];
  const client = {
    listSeatRequests: async () => ({ items: [], seats: [{ id: 'MK', title: 'CMO' }, { id: 'TC', title: 'CTO' }] }),
    submitSeatRequest: async (request: { seat?: string; text: string; attachments?: AttachmentMeta[] }, key: string) => {
      requests.push({ request, key });
      return outcome(request);
    },
  };
  const daemon = { client: client as never, config: { baseUrl: '', token: '', provider: '' },
    sessionId: '', setSessionId: () => {}, setConfig: () => {} };
  function Composer() {
    const [queue, setQueue] = useState(initial);
    return <DaemonContext.Provider value={daemon}><ChatInput onSubmit={(text) => chats.push(text)}
      attachments={queue} onRemoveAttachment={(id) => setQueue((prev) => prev.filter((item) => item.id !== id))}
    /></DaemonContext.Provider>;
  }
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<Composer />); });
  mounted.push(tree);
  const type = async (text: string) => { await act(async () => { tree.root.findByType('textarea').props.onChange({ target: { value: text } }); }); };
  const send = async () => { await act(async () => { tree.root.findAllByType('button').at(-1)!.props.onClick(); }); };
  const chip = async (title: string) => { await act(async () => {
    tree.root.findAllByType('button').find((button) => button.children.join('') === title)!.props.onClick();
  }); };
  const chips = () => tree.root.findAllByType('button').filter((button) => String(button.props['aria-label'] ?? '').startsWith('remove '));
  const error = () => tree.root.findAllByProps({ role: 'alert' }).map((node) => node.children.join('')).join('');
  return { tree, requests, chats, type, send, chip, chips, error };
}

test('selected seat sends queued attachment id; receipt count appears and success clears chips', async () => {
  const ui = await setup([attachment('file-1')], async (request) => ({
    receiptId: 'R-1', seat: 'MK', queuedAt: 'now', attachments: request.attachments?.length, channel: 'sent',
  }));
  await ui.chip('CMO'); await ui.type('draft'); await ui.send();
  expect(ui.requests[0]!.request.attachments?.[0]?.id).toBe('file-1');
  expect(ui.requests[0]!.request).toMatchObject({ seat: 'MK', text: 'draft' });
  expect(ui.tree.root.findByProps({ role: 'status' }).children.join('')).toContain('받음 · 첨부 1 · 채널 sent');
  expect(ui.chips()).toHaveLength(0);
  expect(ui.chats).toEqual([]);
});

test('@seat sends attachments without selecting a chip', async () => {
  const ui = await setup([attachment('file-2')], async () => ({ receiptId: 'R-2', seat: 'TC', queuedAt: 'now', attachments: 1 }));
  await ui.type('@cto draft'); await ui.send();
  expect(ui.requests[0]!.request).toMatchObject({ text: '@cto draft', attachments: [{ id: 'file-2' }] });
  expect(ui.requests[0]!.request.seat).toBeUndefined();
  expect(ui.chips()).toHaveLength(0);
});

test('seat accepts exactly four attachments', async () => {
  const ui = await setup(Array.from({ length: 4 }, (_, index) => attachment(`file-${index}`)),
    async () => ({ receiptId: 'R-4', seat: 'MK', queuedAt: 'now', attachments: 4 }));
  await ui.chip('CMO'); await ui.type('draft'); await ui.send();
  expect(ui.requests).toHaveLength(1);
  expect(ui.requests[0]!.request.attachments?.map((entry) => entry.id)).toEqual(['file-0', 'file-1', 'file-2', 'file-3']);
  expect(ui.tree.root.findByProps({ role: 'status' }).children.join('')).toContain('받음 · 첨부 4');
  expect(ui.chips()).toHaveLength(0);
});

test('seat limit blocks five attachments and retains the queue and text', async () => {
  const ui = await setup(Array.from({ length: 5 }, (_, index) => attachment(`file-${index}`)),
    async () => ({ receiptId: 'R', seat: 'MK', queuedAt: 'now' }));
  await ui.chip('CMO'); await ui.type('draft'); await ui.send();
  expect(ui.error()).toBe('자리 요청 첨부는 4개까지');
  expect(ui.requests).toHaveLength(0);
  expect(ui.chips()).toHaveLength(5);
  expect(ui.tree.root.findByType('textarea').props.value).toBe('draft');
});

for (const [code, message] of [
  ['attachments-unsupported', '이 자리는 첨부를 받지 않습니다'],
  ['unknown-attachment', '첨부가 만료됐습니다 — 다시 올려 주세요'],
] as const) {
  test(`${code} keeps the attachment chip and shows the actionable error`, async () => {
    const ui = await setup([attachment('file-1')], async () => { throw new SeatRequestError(400, code); });
    await ui.chip('CMO'); await ui.type('draft'); await ui.send();
    expect(ui.error()).toBe(message);
    expect(ui.chips()).toHaveLength(1);
    expect(ui.tree.root.findByType('textarea').props.value).toBe('draft');
    expect(ui.chats).toEqual([]);
  });
}

test('retry key is reused only when seat, text and attachment id sequence match', async () => {
  const ui = await setup([attachment('a'), attachment('b')], async () => { throw new Error('lost response'); });
  await ui.chip('CMO'); await ui.type('draft'); await ui.send();
  await ui.send();
  expect(ui.requests[1]!.key).toBe(ui.requests[0]!.key);
  expect(ui.chips()).toHaveLength(2);
  await act(async () => { ui.chips()[0]!.props.onClick(); });
  await ui.send();
  expect(ui.requests[2]!.key).not.toBe(ui.requests[1]!.key);
  expect(ui.requests[2]!.request.attachments?.map((entry) => entry.id)).toEqual(['b']);
});
