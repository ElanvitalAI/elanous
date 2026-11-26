// MAIL-ENVELOPE-INFO-NOT-ORDER · CEO-UTTERANCE-TAGGED-LAST · TUI-JOINED-MIDTURN-REMOVE — sim + synthetic events.
//
// Seeded floods (seeds 1..3 · 40 mails each, info/status mixed with request/decision/alert and one crown relay) go
// through the real producers: the notice producer + bundle text (idle door), the mid-turn interjection builder, the
// real runTurn wire assembly (fake provider), the session compactor's stub/speaker, the summary schema, recall keying
// and the public history. Expectations are independent literals (never built from the product's constants).
// The failure case of 11-26 05:05 KST (session 553f08a1 · three CEO lines under a mail/wake bundle) is replayed.

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, LLMMessage, LLMProvider } from '../llm.js';
import * as actualMemory from '../memory.js';
import * as actualSurfaceEvents from '../domains/surface-events.js';
import * as actualUserIntent from '../user-intent/index.js';
import { buildInterjectionContent, type PendingInterjection } from '../chat/interjection.js';
import { seatMessageNoticeParts } from '../tui/core/notice-producers.js';
import { seatMailBundleText, seatMailDigestLine } from '../tui/seat-mail-digest.js';
import { recallKeyText } from './human-envelope.js';
import { isHumanUserMessage } from '../compact/pipeline.js';
import { nextTuiPublicHistory } from '../tui/core/public-history.js';
import { createSession } from './index.js';
import { mailStubBody } from './compact-session.js';

const spies = [
  spyOn(actualMemory, 'buildMemoryInjection').mockImplementation(() => ({ block: '', tokens: 0, injectedIds: [] })),
  spyOn(actualMemory, 'buildMemoryInjectionLLM').mockImplementation(async () => ({ block: '', tokens: 0, injectedIds: [] })),
  spyOn(actualSurfaceEvents, 'openSurfaceEventsDb').mockImplementation(() => ({ close() {} } as never)),
  spyOn(actualSurfaceEvents, 'recallEvents').mockImplementation(() => []),
  spyOn(actualUserIntent, 'userIntentLogger').mockImplementation(() => ({ emit: () => null } as never)),
];
const { runTurn, RESUME_BOUNDARY_BLOCK } = await import('./chat.js');

let root = '';
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'envelope-ceo-last-'));
  for (const key of ['HOME', 'ELANOUS_SESSION_ROOT']) savedEnv[key] = process.env[key];
  process.env.HOME = root;
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

// ── synthetic events ──────────────────────────────────────────────────────────────────────────────────────────────
const DECLARED = new Set(['TC', 'RES', 'REL', 'JUD-C', 'CLAUDE-OP', 'UX']);
const SENDERS = ['TC', 'RES', 'REL', 'JUD-C', 'UX'];
const INTENTS = ['info', 'info', 'info', 'status', 'request', 'decision', 'alert'];
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x1_0000_0000; };
}
interface Mail { id: number; from: string; intent: string; body: string; crown?: string }
function flood(seed: number, n = 40): Mail[] {
  const r = rng(seed);
  const out: Mail[] = [];
  for (let i = 0; i < n; i++) {
    const intent = INTENTS[Math.floor(r() * INTENTS.length)]!;
    out.push({ id: 177000 + seed * 100 + i, from: SENDERS[Math.floor(r() * SENDERS.length)]!, intent, body: `seed${seed} mail${i} ${intent} 본문 원장 대조 결과` });
  }
  out[7] = { id: 177000 + seed * 100 + 7, from: 'CLAUDE-OP', intent: 'request', crown: `crown-${seed}`, body: `seed${seed} crown relay: 판정국 재편 질의` };
  return out;
}
const isOrder = (m: Mail): boolean => Boolean(m.crown) || ['request', 'decision', 'alert'].includes(m.intent);

// The three CEO lines of 11-26 05:05–05:07 KST (session 553f08a1, verbatim).
const CEO_0505 = '그리고 버전 발행이 끝나면 신규 조직 구조도에 맞게 판정국도 재편되는것이죠?';
const CEO_0506 = 'claude op 에 이내용 물어봐주세요';
const CEO_0507 = '그뜻이 아니라 바로 위엣말과 연결해보면 claude op 가 전체 조직도 개편을 같이 해서 판정국 재편을 물어보란 이야기자나요?';
const WAKE_BATCH = '[예약 깨움 묶음 · 2건 · 시각 지난 예약을 한 번에 배달] 스스로 예약한 점검들이다 — 이미 처리한 것은 건너뛰고 남은 것만 이어라:';

const RITUAL = '받음 + 첫 행동';
const tagged = (line: string): string => `<human from="CEO">\n${line}\n</human>`;

function noticeOf(m: Mail, unread: number): { text: string; source: string; msgId: number; digest: string; passive?: boolean } {
  const parts = seatMessageNoticeParts({ id: m.id, sender: m.from, fromSeat: m.from, body: m.body, kind: m.intent, intent: m.intent,
    crownDirective: m.crown ?? null, unreadTotal: unread } as never, DECLARED, true);
  return { text: parts.text, source: 'seat-mail', msgId: m.id, digest: seatMailDigestLine({ id: m.id, sender: m.from, body: m.body, kind: m.intent, intent: m.intent }) };
}

/** Every `<federation_work_order …>` block's msg ids. */
const orderIds = (text: string): number[] => [...text.matchAll(/<federation_work_order [^>]*msg="(\d+)"/gu)].map((x) => Number(x[1]));

describe.each([1, 2, 3])('seed %i — 40-mail flood', (seed) => {
  const mails = flood(seed);

  test('idle bundle: info never framed as an order · one <mail_digest> · one lead note · one unread count', () => {
    const bundle = seatMailBundleText(mails.map((m, i) => noticeOf(m, mails.length - i - 1)));
    const framed = orderIds(bundle);
    expect(framed.sort()).toEqual(mails.filter(isOrder).map((m) => m.id).sort());
    for (const m of mails.filter((x) => !isOrder(x))) expect(framed).not.toContain(m.id);
    expect(bundle.split('<mail_digest ').length - 1).toBe(1);
    const infoCount = mails.filter((x) => !isOrder(x)).length;
    expect(bundle).toContain(`<mail_digest count="${infoCount}"`);
    expect(bundle.split('Information mail from other seats (not orders).').length - 1).toBe(1);
    // One unread count for the whole turn (the per-mail «[미읽음 총 N통]» tails are gone).
    expect(bundle.split('[미읽음 총 ').length - 1).toBe(0);
    expect(bundle.split('unread="').length - 1).toBe(1);
    // Every info body is kept in the digest (one line each).
    for (const m of mails.filter((x) => !isOrder(x))) expect(bundle).toContain(`- #${m.id} · ${m.from} · ${m.intent} · ${m.body}`);
    // The ritual only rides with orders (one lead note for the order frames at most per order notice).
    expect(bundle.includes(RITUAL)).toBe(mails.some(isOrder));
  });

  test('crown relay is an order (work-order frame with crown="yes")', () => {
    const crown = mails[7]!;
    const text = noticeOf(crown, 0).text;
    expect(text).toContain(`<federation_work_order from="CLAUDE-OP" intent="request" msg="${crown.id}" crown="yes">`);
    expect(text).toContain(RITUAL);
  });

  test('mid-turn: a CEO line in the middle of the flood is tagged and LAST · info only in the digest', () => {
    const items: PendingInterjection[] = mails.map((m) => ({ kind: 'seat-mail', msgId: m.id, from: m.from, intent: m.intent,
      crownDirective: m.crown ?? null, viaLedger: true, text: m.body }));
    items.splice(20, 0, CEO_0505);
    const content = buildInterjectionContent(items, 'mid-turn', DECLARED);
    expect(typeof content).toBe('string');
    const text = content as string;
    expect(text.endsWith(tagged(CEO_0505))).toBe(true);
    const framed = orderIds(text);
    for (const m of mails.filter((x) => !isOrder(x))) expect(framed).not.toContain(m.id);
    expect(text.split('<mail_digest ').length - 1).toBe(1);
    expect(text).toContain(`<mail_digest count="${mails.filter((x) => !isOrder(x)).length}">`);
    expect(text.split('<human from="CEO">').length - 1).toBe(1);
  });

  test('turn wire (runTurn): CEO part tagged and last after recall · notifications · wake batch · digest', async () => {
    const calls: LLMMessage[][] = [];
    const provider: LLMProvider = {
      name: `env-seed-${seed}`, defaultModel: 'env-model', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(messages) { calls.push(structuredClone(messages)); yield { type: 'text', delta: 'ok' } as const; },
    };
    const userConfig = { chat: {}, llm: { provider: provider.name, model: provider.defaultModel, memoryJudge: { enabled: false, crossRecall: true } } } as never;
    const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'cli' });
    const digest = seatMailBundleText(mails.slice(0, 10).map((m, i) => noticeOf(m, 9 - i)));
    const harness: ContentBlock[] = [
      { type: 'text', text: '## seat memory recall\n### release-cadence [project]\n컷은 늦게' },
      { type: 'text', text: '<task-notification><task-id>t1</task-id><status>completed</status></task-notification>' },
      { type: 'text', text: WAKE_BATCH },
      { type: 'text', text: digest },
    ];
    await runTurn({ userConfig, sessionId: session.id, userText: CEO_0506, userImages: harness, from: { kind: 'human' }, provider });
    const last = calls[0]!.at(-1)!;
    expect(last.role).toBe('user');
    const parts = last.content as ContentBlock[];
    expect(parts.at(-1)).toEqual({ type: 'text', text: tagged(CEO_0506) });
    for (const part of parts.slice(0, -1)) {
      expect(part.type).toBe('text');
      expect((part as { text: string }).text.startsWith('<harness_notice kind="')).toBe(true);
      expect((part as { text: string }).text).not.toContain('<human from="CEO">');
    }
    expect(parts).toHaveLength(5);
  });

  test('recall ignores bundle noise: human turn keys on the line · bundle keys on bodies only', () => {
    expect(recallKeyText(CEO_0505, 'human')).toBe(CEO_0505);
    const bundle = seatMailBundleText(mails.map((m, i) => noticeOf(m, mails.length - i - 1)));
    const key = recallKeyText(bundle, undefined);
    for (const noise of ['Information mail from other seats', '<mail_digest', '<federation_work_order', '[미읽음 총', RITUAL]) expect(key).not.toContain(noise);
    expect(key).toContain(mails[0]!.body);
  });
});

describe('11-26 05:05 failure replay (session 553f08a1)', () => {
  test('three CEO turns under a wake/mail bundle: each request ends with its tagged CEO line', async () => {
    const calls: LLMMessage[][] = [];
    const provider: LLMProvider = {
      name: 'replay-0505', defaultModel: 'replay-model', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(messages) { calls.push(structuredClone(messages)); yield { type: 'text', delta: '확인했습니다' } as const; },
    };
    const userConfig = { chat: {}, llm: { provider: provider.name, model: provider.defaultModel, memoryJudge: { enabled: false, crossRecall: true } } } as never;
    const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'cli' });
    const info = flood(9, 6).map((m) => ({ ...m, intent: 'info', crown: undefined }));
    // The 05:04 wake batch and an info bundle, then the three CEO lines (05:05:15 · 05:06:05 · 05:07:14).
    await runTurn({ userConfig, sessionId: session.id, userText: WAKE_BATCH, from: { kind: 'system', origin: 'scheduled' }, provider });
    for (const line of [CEO_0505, CEO_0506, CEO_0507]) {
      const digest = seatMailBundleText(info.map((m, i) => noticeOf(m, 5 - i)));
      await runTurn({ userConfig, sessionId: session.id, userText: line, userImages: [{ type: 'text', text: digest }], from: { kind: 'human' }, provider });
    }
    expect(calls).toHaveLength(4);
    // The wake turn is not the person: no human tag.
    expect(JSON.stringify(calls[0]!.at(-1))).not.toContain('<human from=');
    const expected = [CEO_0505, CEO_0506, CEO_0507];
    for (const [i, line] of expected.entries()) {
      const parts = calls[i + 1]!.at(-1)!.content as ContentBlock[];
      expect(parts.at(-1)).toEqual({ type: 'text', text: tagged(line) });
      const digestPart = (parts[0] as { text: string }).text;
      expect(digestPart.startsWith('<harness_notice kind="context" speaker="harness">')).toBe(true);
      expect(digestPart).not.toContain(RITUAL);
    }
  });
});

describe('compaction with mixed rows', () => {
  test('human = from.kind human; a notice row without from is machine mail', () => {
    expect(isHumanUserMessage({ role: 'user', content: CEO_0505, speaker: 'human' })).toBe(true);
    expect(isHumanUserMessage({ role: 'user', content: '[seat-mail 1 from TC] x', speaker: 'agent' })).toBe(false);
    expect(isHumanUserMessage({ role: 'user', content: WAKE_BATCH, speaker: 'system' })).toBe(false);
  });

  test('mail stub keeps the body (not the lead note) · CEO rows stay verbatim · summary has who\'s who', async () => {
    const mail = flood(4, 3)[0]!;
    const orderNotice = seatMessageNoticeParts({ id: 9001, sender: 'TC', fromSeat: 'TC', body: 'PR #40199 리뷰 착수 요청 — 07:30 까지', kind: 'request', intent: 'request' } as never, DECLARED, true).text;
    expect(mailStubBody(orderNotice)).toBe('PR #40199 리뷰 착수 요청 — 07:30 까지');
    expect(mailStubBody(noticeOf(mail, 0).text)).toBe(mail.body);
    const src = readFileSync(join(import.meta.dir, '../compact/summarize.ts'), 'utf8');
    for (const heading of ["## Who's who", '## CEO instructions (verbatim)', '## World']) expect(src).toContain(heading);
  });
});

describe('/new and resume', () => {
  test('a fresh session (/new) tags the first CEO line and puts it last', async () => {
    const calls: LLMMessage[][] = [];
    const provider: LLMProvider = {
      name: 'new-session', defaultModel: 'nm', available: () => true,
      async *chat() { yield 'unused'; },
      async *streamChat(messages) { calls.push(structuredClone(messages)); yield { type: 'text', delta: 'ok' } as const; },
    };
    const userConfig = { chat: {}, llm: { provider: provider.name, model: provider.defaultModel, memoryJudge: { enabled: false, crossRecall: true } } } as never;
    const session = createSession({ provider: provider.name, model: provider.defaultModel, source: 'cli' });
    await runTurn({ userConfig, sessionId: session.id, userText: CEO_0507, from: { kind: 'human' }, provider });
    expect(calls[0]!.at(-1)!.content).toEqual([{ type: 'text', text: tagged(CEO_0507) }]);
  });

  test('resume boundary keeps standing CEO directives', () => {
    expect(RESUME_BOUNDARY_BLOCK).toContain('Standing CEO directives');
    expect(RESUME_BOUNDARY_BLOCK).not.toContain('is already finished or superseded');
  });
});

describe('TUI-JOINED-MIDTURN-REMOVE', () => {
  test('a steer row shows the person\'s words only (no «(joined mid-turn)»)', () => {
    const shown = nextTuiPublicHistory([{ role: 'user', content: CEO_0506, ts: '2026-11-25T20:06:05.006Z', steerJoined: true } as never]);
    expect(shown[0]!.content).toBe('claude op 에 이내용 물어봐주세요');
  });
});
