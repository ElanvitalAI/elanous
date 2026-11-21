import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wireCeoIngressEntry } from '../agent-events/ceo-ingress-entry.js';
import { CEO_ESCALATION_TEXT, type CeoClock } from '../agent-events/ceo-ingress.js';
import { readCeoSideAlert } from './ceo-side-alert.js';
import { ENV_CEO_ALLOW_CHAT, ENV_CEO_ALLOW_SENDER, ENV_CEO_TELEGRAM_TOKEN, startCeoChannelWiring } from './ceo-ingress-wiring.js';

function syntheticClock() {
  let now = 0;
  const timers: Array<{ at: number; fire: () => void; cancelled: boolean }> = [];
  const clock: CeoClock = {
    now: () => now,
    after: (ms, fire) => { const timer = { at: now + ms, fire, cancelled: false }; timers.push(timer); return timer; },
    cancel: (handle) => { (handle as typeof timers[number]).cancelled = true; },
  };
  return { clock, advance(ms: number) {
    now += ms;
    for (const timer of timers) if (!timer.cancelled && timer.at <= now) { timer.cancelled = true; timer.fire(); }
  } };
}

const waitFor = async (ready: () => boolean): Promise<void> => {
  const until = Date.now() + 2_000;
  while (!ready() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(ready()).toBe(true);
};

for (const opCase of ['busy', 'tab-dead'] as const) {
  test(`CEO ${opCase}: one real channel update makes side red at 30s, then same-thread alert and RES tab event at 5m`, async () => {
    const root = mkdtempSync(join(tmpdir(), `ceo-sla-${opCase}-`));
    const timer = syntheticClock();
    const replies: Array<{ chat_id: string; text: string; reply_to_message_id: number }> = [];
    let updates = [{ update_id: 1, message: { message_id: 9, date: 1732190000, text: 'CEO asks', chat: { id: 555, type: 'private' }, from: { id: 777 } } }];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/getUpdates')) { const result = updates; updates = []; return Response.json({ ok: true, result }); }
      if (String(url).includes('/sendMessage')) {
        replies.push(JSON.parse(String(init?.body)) as typeof replies[number]);
        return Response.json({ ok: true, result: {} });
      }
      throw new Error('unexpected Telegram request');
    }) as typeof fetch;
    const wiring = startCeoChannelWiring({
      env: { [ENV_CEO_TELEGRAM_TOKEN]: 'synthetic-token', [ENV_CEO_ALLOW_CHAT]: '555', [ENV_CEO_ALLOW_SENDER]: '777' },
      stateDir: join(root, 'channel'), sideStateRoot: root, ws: 'test-ws', clock: timer.clock,
      fetchImpl, post: () => {},
    });
    expect(wiring).toBeDefined();
    const resEvents: string[] = [];
    const resIntakes: Array<(item: { id: string; status: 'accepted' }) => void> = [];
    const res = await wireCeoIngressEntry(wiring!.envFor('RES'), {
      enqueueNotice: (text) => { resEvents.push(text); return { id: `res-${resEvents.length}` }; },
      knock: () => {}, onTransition: () => () => {}, onIntake: (notify) => { resIntakes.push(notify); return () => {}; },
    });
    expect(res).toBeDefined();
    const opIntakes: Array<(item: { id: string; status: 'accepted' }) => void> = [];
    const op = opCase === 'busy' ? await wireCeoIngressEntry(wiring!.envFor('OP'), {
      enqueueNotice: () => ({ id: 'op-1' }), knock: () => {},
      onTransition: () => () => {}, onIntake: (notify) => { opIntakes.push(notify); return () => {}; },
    }) : undefined;
    try {
      expect(await wiring!.adapter.pollOnce()).toBe(1);
      expect(readCeoSideAlert(root)).toEqual({ kind: 'ok', pendingRed: 0 });
      timer.advance(29_999);
      expect(readCeoSideAlert(root)).toEqual({ kind: 'ok', pendingRed: 0 });
      timer.advance(1);
      expect(readCeoSideAlert(root)).toEqual({ kind: 'ok', pendingRed: 1 });
      timer.advance(270_000);
      await waitFor(() => replies.length === 1 && resEvents.length >= 2);
      expect(replies).toEqual([expect.objectContaining({ chat_id: '555', text: CEO_ESCALATION_TEXT, reply_to_message_id: 9 })]);
      expect(resEvents.some((event) => event.includes('CEO asks'))).toBe(true);
      expect(resEvents.some((event) => event.includes(CEO_ESCALATION_TEXT))).toBe(true);
      expect(readCeoSideAlert(root)).toEqual({ kind: 'ok', pendingRed: 0 });
    } finally {
      for (const notify of opIntakes) notify({ id: 'op-1', status: 'accepted' });
      for (const notify of resIntakes) for (let i = 1; i <= resEvents.length; i++) notify({ id: `res-${i}`, status: 'accepted' });
      if (op) await op.close();
      await res!.close();
      wiring!.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('untrusted CEO sender never arms the five-minute external failover or reaches RES', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ceo-sla-untrusted-'));
  const timer = syntheticClock();
  const sends: unknown[] = [];
  let updates = [{ update_id: 1, message: { message_id: 9, date: 1732190000, text: 'forged CEO', chat: { id: 555, type: 'private' }, from: { id: 888 } } }];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/getUpdates')) { const result = updates; updates = []; return Response.json({ ok: true, result }); }
    if (String(url).includes('/sendMessage')) { sends.push(init?.body); return Response.json({ ok: true, result: {} }); }
    throw new Error('unexpected Telegram request');
  }) as typeof fetch;
  const wiring = startCeoChannelWiring({
    env: { [ENV_CEO_TELEGRAM_TOKEN]: 'synthetic-token', [ENV_CEO_ALLOW_CHAT]: '555', [ENV_CEO_ALLOW_SENDER]: '777' },
    stateDir: join(root, 'channel'), sideStateRoot: root, ws: 'test-ws', clock: timer.clock,
    fetchImpl, post: () => {},
  });
  expect(wiring).toBeDefined();
  const resEvents: string[] = [];
  const res = await wireCeoIngressEntry(wiring!.envFor('RES'), {
    enqueueNotice: (text) => { resEvents.push(text); return { id: 'res-1' }; },
    knock: () => {}, onTransition: () => () => {}, onIntake: () => () => {},
  });
  try {
    expect(await wiring!.adapter.pollOnce()).toBe(0);
    timer.advance(300_000);
    await Bun.sleep(20);
    expect(sends).toHaveLength(0);
    expect(resEvents).toHaveLength(0);
    expect(readCeoSideAlert(root)).toEqual({ kind: 'absent' });
    expect(wiring!.ingress.status('telegram', '555', '9')).toBeUndefined();
  } finally {
    await res?.close();
    wiring!.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
