// OP-CHANNEL-INGRESS-1121 ②③ wiring (JUD hold #121400 mustFix · OP #121505) — the PRODUCT path,
// end to end: the els boot (startCeoChannelWiring) provisions the per-destination secret into the
// OP tab env; the REAL session entry (wireCeoIngressEntry → startCeoIngressFromEnv) hosts the
// listener; one fake telegram message walks the real channel → ingress → authorized sink → socket
// and must land as the OP turn's input, and 👀 must be recorded exactly once — only when the entry
// consumed the frame, never at telegram/queue time. No credential → one observability line + inactive.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENV_CEO_ALLOW_CHAT, ENV_CEO_ALLOW_SENDER, ENV_CEO_TELEGRAM_TOKEN,
  provisionCeoIngressDestinations, startCeoChannelWiring, type CeoChannelWiring,
} from './ceo-ingress-wiring.js';
import { ENV_CEO_INGRESS_AUTH, ENV_CEO_INGRESS_SOCKET, wireCeoIngressEntry } from '../agent-events/ceo-ingress-entry.js';
import { type CeoClock } from '../agent-events/ceo-ingress.js';
import { readCeoSideAlert } from './ceo-side-alert.js';

const CHANNEL_MESSAGE = '대표 글 — 지금 착지 몇 개?';
const oneTelegramUpdate = (): Array<Record<string, unknown>> => [{
  update_id: 1,
  message: { message_id: 9, date: 1732190000, text: CHANNEL_MESSAGE, chat: { id: 555, type: 'private' }, from: { id: 777 } },
}];

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** A fetch that hands out `updates` once (then empty) and accepts sendMessage. Never logs the token. */
const fakeTelegramFetch = (updates: Array<Record<string, unknown>>) => (async (url: string | URL | Request): Promise<Response> => {
  const u = String(url).replace(/bot[^/\s]+/, 'bot<…>');
  if (u.includes('/getUpdates')) return jsonResponse({ ok: true, result: updates.splice(0) });
  if (u.includes('/sendMessage')) return jsonResponse({ ok: true, result: [] });
  return jsonResponse({ ok: false, description: 'unknown method' });
}) as typeof fetch;

const waitFor = async (fn: () => boolean, ms = 2000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (fn()) return true; await new Promise((resolve) => setTimeout(resolve, 20)); }
  return fn();
};

describe('CEO channel ingress wiring (JUD hold #121400 mustFix · OP #121505)', () => {
  test('ELS restart keeps the adopted OP tab secret, separate from RES', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceo-w-'));
    try {
      const before = provisionCeoIngressDestinations(dir);
      const after = provisionCeoIngressDestinations(dir);
      expect(after.get('OP')?.authSecret).toBe(before.get('OP')?.authSecret);
      expect(after.get('OP')?.authSecret).not.toBe(after.get('RES')?.authSecret);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('자격 없으면 관측 줄 하나 + 비활성(undefined) — 아무것도 시작하지 않는다', () => {
    const lines: Array<[string, Record<string, unknown>]> = [];
    const wiring = startCeoChannelWiring({
      env: {}, stateDir: mkdtempSync(join(tmpdir(), 'ceo-w-')), ws: 'test-ws',
      fetchImpl: fakeTelegramFetch([]), sleep: async () => {}, log: (event, data) => { lines.push([event, data]); },
    });
    expect(wiring).toBeUndefined(); // 비활성
    expect(lines.some(([event]) => event === 'ceo-channel-inactive')).toBe(true); // 관측 줄
  });

  test('실 els 기동 경로 e2e — 가짜 텔레그램 1 → OP 턴 입력 도착 → 👀 1회(소비 시점에만)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceo-w-'));
    let now = 0;
    const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
    const clock: CeoClock = {
      now: () => now,
      after: (ms, run) => { const timer = { at: now + ms, run, cancelled: false }; timers.push(timer); return timer; },
      cancel: (handle) => { (handle as typeof timers[number]).cancelled = true; },
    };
    const updates = oneTelegramUpdate();
    const receipts: Array<{ receipt: string; glyph: string }> = [];
    const wiring = startCeoChannelWiring({
      env: { [ENV_CEO_TELEGRAM_TOKEN]: 'test-token-1', [ENV_CEO_ALLOW_CHAT]: '555', [ENV_CEO_ALLOW_SENDER]: '777' },
      stateDir: dir, sideStateRoot: dir, ws: 'test-ws', clock, post: () => {},
      fetchImpl: fakeTelegramFetch(updates), sleep: async () => {},
      log: (event, data) => {
        if (event === 'ceo-receipt') receipts.push({ receipt: String(data.receipt), glyph: String(data.glyph) });
      },
    });
    expect(wiring).toBeDefined();
    const w: CeoChannelWiring = wiring!;
    try {
      // ② per-destination provisioning — the OP tab env gets the socket path + THIS tab's secret
      const opEnv = w.envFor('OP');
      const resEnv = w.envFor('RES');
      expect(opEnv[ENV_CEO_INGRESS_SOCKET]).toBeTruthy();
      expect(opEnv[ENV_CEO_INGRESS_AUTH]).toBeTruthy();
      expect(opEnv[ENV_CEO_INGRESS_AUTH]).not.toBe(resEnv[ENV_CEO_INGRESS_AUTH]);
      expect(opEnv[ENV_CEO_INGRESS_SOCKET]).not.toBe(resEnv[ENV_CEO_INGRESS_SOCKET]);

      // ③ the REAL OP session entry: els put the provisioned env in this tab — host the listener
      const landed: Array<{ text: string; source: string }> = [];
      const knocks: string[] = [];
      const transitions: Array<(item: { id: string; status: 'delivered' | 'cancelled' | 'superseded' }) => void> = [];
      // #122913 — the intake acks the TUI fires when a real turn accepts a dequeued notice.
      const intakes: Array<(item: { id: string; status: 'accepted' | 'failed' | 'cancelled' }) => void> = [];
      const listener = await wireCeoIngressEntry(opEnv, {
        enqueueNotice: (text, source) => { const id = `q${landed.length + 1}`; landed.push({ text, source }); return { id }; },
        knock: () => { knocks.push('knock'); },
        onTransition: (notify) => { transitions.push(notify); return () => {}; },
        onIntake: (notify) => { intakes.push(notify); return () => {}; },
      });
      expect(listener).toBeDefined();
      try {
        // ① 가짜 텔레그램 1 — the real adapter hands it to the real channel
        const handled = await w.adapter.pollOnce();
        expect(handled).toBe(1);

        // ② 턴 입력 도착 — the authorized frame landed as this turn's input, front of the queue
        expect(await waitFor(() => landed.length > 0)).toBe(true);
        expect(landed[0]!.text).toContain(CHANNEL_MESSAGE);
        expect(landed[0]!.text).toContain('555/9');
        expect(landed[0]!.source).toBe('ceo-ingress');
        expect(knocks.length).toBe(1);

        // JUD hold #122913 — the entry HOLDS its answer past the queue's drain-time `delivered`
        // transition (that fires when the idle boundary hands the batch to the caller that submits
        // it — BEFORE the turn accepts it): the drain alone must NOT record 👀…
        for (const transition of transitions) transition({ id: 'q1', status: 'delivered' });
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(w.ingress.status('telegram', '555', '9')).not.toBe('seen'); // still held — drain ≠ intake
        now += 30_000;
        for (const timer of timers) if (!timer.cancelled && timer.at <= now) { timer.cancelled = true; timer.run(); }
        expect(readCeoSideAlert(dir)).toEqual({ kind: 'ok', pendingRed: 1 });
        // …only the TUI's ACTUAL-INTAKE ack (a real turn accepted it) releases the honest 👀
        for (const intake of intakes) intake({ id: 'q1', status: 'accepted' });

        // ③ 👀 1회 — recorded only at consumption (the entry's ok answer), never at telegram time
        expect(await waitFor(() => w.ingress.status('telegram', '555', '9') === 'seen')).toBe(true);
        expect(w.ingress.status('telegram', '555', '9')).toBe('seen'); // 👀 exactly once
        expect(receipts.filter((r) => r.receipt === 'seen').length).toBe(1);
        expect(receipts.find((r) => r.receipt === 'seen')?.glyph).toBe('👀');
        expect(readCeoSideAlert(dir)).toEqual({ kind: 'ok', pendingRed: 0 });
      } finally { await listener!.close(); }
    } finally { w.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('fail-closed — 입구 비밀 없는 세션은 프레임 전부 거부: 턴 입력 0 · 👀 0(대기 pending 그대로)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceo-w-'));
    const updates = oneTelegramUpdate();
    const wiring = startCeoChannelWiring({
      env: { [ENV_CEO_TELEGRAM_TOKEN]: 'test-token-1', [ENV_CEO_ALLOW_CHAT]: '555', [ENV_CEO_ALLOW_SENDER]: '777' },
      stateDir: dir, sideStateRoot: dir, ws: 'test-ws', post: () => {},
      fetchImpl: fakeTelegramFetch(updates), sleep: async () => {},
    });
    expect(wiring).toBeDefined();
    const w: CeoChannelWiring = wiring!;
    try {
      // the entry env WITHOUT this tab's secret: the listener refuses every frame (fail-closed)
      const opEnv = w.envFor('OP');
      const entryEnv = { [ENV_CEO_INGRESS_SOCKET]: opEnv[ENV_CEO_INGRESS_SOCKET] };
      const landed: Array<{ text: string }> = [];
      const listener = await wireCeoIngressEntry(entryEnv, {
        enqueueNotice: (text) => { landed.push({ text }); return { id: 'q1' }; }, knock: () => {},
        onTransition: () => () => {},
        onIntake: () => () => {},
      });
      expect(listener).toBeDefined();
      try {
        await w.adapter.pollOnce();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(landed.length).toBe(0); // refused → no turn input
        expect(w.ingress.status('telegram', '555', '9')).toBe('pending'); // 👀 never recorded
      } finally { await listener!.close(); }
    } finally { w.stop(); rmSync(dir, { recursive: true, force: true }); }
  });

  test('중복 텔레그램 같은 글 2회 — 턴 입력 1 · 👀 1(채널+입구 이중 중복 0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ceo-w-'));
    const updates = oneTelegramUpdate();
    const wiring = startCeoChannelWiring({
      env: { [ENV_CEO_TELEGRAM_TOKEN]: 'test-token-1', [ENV_CEO_ALLOW_CHAT]: '555', [ENV_CEO_ALLOW_SENDER]: '777' },
      stateDir: dir, sideStateRoot: dir, ws: 'test-ws', post: () => {},
      fetchImpl: fakeTelegramFetch(updates), sleep: async () => {},
    });
    expect(wiring).toBeDefined();
    const w: CeoChannelWiring = wiring!;
    try {
      const opEnv = w.envFor('OP');
      const landed: Array<{ text: string }> = [];
      const transitions: Array<(item: { id: string; status: 'delivered' | 'cancelled' | 'superseded' }) => void> = [];
      // #122913 — the intake acks the TUI fires when a real turn accepts a dequeued notice.
      const intakes: Array<(item: { id: string; status: 'accepted' | 'failed' | 'cancelled' }) => void> = [];
      const listener = await wireCeoIngressEntry(opEnv, {
        enqueueNotice: (text) => { landed.push({ text }); return { id: 'q1' }; }, knock: () => {},
        onTransition: (notify) => { transitions.push(notify); return () => {}; },
        onIntake: (notify) => { intakes.push(notify); return () => {}; },
      });
      expect(listener).toBeDefined();
      try {
        const first = await w.adapter.pollOnce(); // update_id 1 handled
        const second = await w.adapter.pollOnce(); // updates drained → 0 handled
        expect(first).toBe(1);
        expect(second).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(landed.filter((l) => l.text.includes(CHANNEL_MESSAGE)).length).toBe(1);
        // JUD hold #122913 — 👀 holds until ACTUAL INTAKE: fire the drain-time delivered
        // transition AND the TUI's intake ack, then POLL — the answer rides the socket
        // round-trip back to the els producer
        for (const transition of transitions) transition({ id: 'q1', status: 'delivered' });
        for (const intake of intakes) intake({ id: 'q1', status: 'accepted' });
        expect(await waitFor(() => w.ingress.status('telegram', '555', '9') === 'seen')).toBe(true);
        expect(w.ingress.status('telegram', '555', '9')).toBe('seen'); // 👀 exactly once
      } finally { await listener!.close(); }
    } finally { w.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});
