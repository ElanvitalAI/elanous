import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from './debug/log.js';
import { TelegramBot } from './telegram.js';
import type { GraphRunState } from './graph-runner/runner.js';

const OWNER = 10;
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const report = {
  card: { name: 'Alex', company: 'Example', title: 'CEO', email: 'a@example.com' },
  fit: { score: 80, label: 'high' },
  approach: { problem: '문제', proposal: '제안', channel: '이메일' },
  nextAction: { what: '내일 연락', due: '내일' },
  draft: { subject: '안녕하세요', body: '반갑습니다' }, sent: false,
};
function state(status: GraphRunState['status'], readOk = true): GraphRunState {
  return { graphId: 'card-followup', runId: 'test', status, path: ['read-card'],
    nodes: [{ nodeId: 'read-card', ok: readOk, exit: 0, executed: true,
      output: readOk ? '{"outcome":"ok"}' : '{"outcome":"fail"}' }],
    executed: 1, dryRun: false, statePath: 'test.json' };
}

const CARD_TEXT = 'Alex Kim\nCEO · Example Inc\nalex@example.com\n+82 10-1234-5678';
type Sent = { chat: number; text: string; replyTo: number | undefined };
function setup(caption: string | undefined, options: {
  type?: 'private' | 'group'; userId?: number; mediaGroupId?: string;
  execute?: (input: Record<string, unknown>) => Promise<GraphRunState>;
  failResultSend?: boolean;
  failDocument?: boolean;
  failPreparation?: 'download' | 'directory';
  /** Further photo messages delivered in the same poll (album items). */
  extra?: Array<{ messageId: number; caption?: string; mediaGroupId?: string }>;
  /** Largest photo size (default: a card-like 1600×1000). */
  photo?: { width: number; height: number };
  /** OCR stub (default: card-like text). */
  ocr?: (path: string) => Promise<string | null>;
} = {}) {
  const ocrCalls: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'tg-card-'));
  roots.push(root);
  if (options.failPreparation === 'directory') writeFileSync(join(root, 'blocked'), 'not a directory');
  const sent: Sent[] = [], turns: string[] = [], docs: Array<{ name: string; bytes: string; replyTo: string | null }> = [];
  const runs: Array<{ input: Record<string, unknown>; runId: string; root: string }> = [], downloads: string[] = [];
  let polls = 0;
  let bot: TelegramBot;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]));
    const method = url.split('/').at(-1);
    if (method === 'sendDocument') {
      if (options.failDocument) return Response.json({ ok: false, description: 'document rejected' });
      const form = init?.body as FormData;
      docs.push({ name: (form.get('document') as File).name, bytes: await (form.get('document') as File).text(), replyTo: form.get('reply_to_message_id') as string | null });
      return Response.json({ ok: true, result: { message_id: 80 } });
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (method === 'getUpdates') {
      if (++polls > 1) { bot.stop(); return Response.json({ ok: true, result: [] }); }
      return Response.json({ ok: true, result: [{ update_id: 1, message: {
        message_id: 7, from: { id: options.userId ?? OWNER },
        chat: { id: options.type === 'group' ? -20 : OWNER, type: options.type ?? 'private' },
        ...(caption === undefined ? {} : { caption }),
        ...(options.mediaGroupId ? { media_group_id: options.mediaGroupId } : {}),
        photo: [{ file_id: 'small', width: 1, height: 1 }, { file_id: 'big', ...(options.photo ?? { width: 1600, height: 1000 }) }],
      } }, ...(options.extra ?? []).map((m, i) => ({ update_id: 2 + i, message: {
        message_id: m.messageId, from: { id: options.userId ?? OWNER },
        chat: { id: options.type === 'group' ? -20 : OWNER, type: options.type ?? 'private' },
        ...(m.caption === undefined ? {} : { caption: m.caption }),
        ...(m.mediaGroupId ? { media_group_id: m.mediaGroupId } : {}),
        photo: [{ file_id: `big-${m.messageId}`, ...(options.photo ?? { width: 1600, height: 1000 }) }],
      } }))] });
    }
    if (method === 'getFile') {
      downloads.push(String(body.file_id));
      if (options.failPreparation === 'download') return Response.json({ ok: false, description: 'file unavailable', error_code: 400 });
      return Response.json({ ok: true, result: { file_path: 'photos/card.jpg' } });
    }
    if (method === 'sendMessage') {
      if (options.failResultSend && String(body.text).startsWith('①')) return Response.json({ ok: false, description: 'message rejected', error_code: 400 });
      sent.push({ chat: Number(body.chat_id), text: String(body.text), replyTo: body.reply_to_message_id as number | undefined });
    }
    return Response.json({ ok: true, result: { message_id: 80 } });
  }) as typeof fetch;
  bot = new TelegramBot({ token: '123:test', allowedUsers: [OWNER], fetchImpl,
    perChatGapMs: 0, log: () => {}, onMessage: async (ctx) => { turns.push(ctx.text); },
    // Field uploads stay in this test's temp root and never spawn a real reel render.
    fieldRootDir: () => join(root, 'field'), fieldReel: { quietMs: 60_000, autoFeed: false, runner: async () => ({ ok: false, seconds: 0, error: 'test' }) },
    cardFollowupDeps: { ocrText: async (path) => { ocrCalls.push(path); return options.ocr ? options.ocr(path) : CARD_TEXT; }, rootDir: () => options.failPreparation === 'directory' ? join(root, 'blocked') : root, runGraph: async (_path, graphOptions) => {
      const { input, runId, deps } = graphOptions!;
      const graphInput = input as Record<string, unknown>;
      runs.push({ input: graphInput, runId: runId!, root: deps?.root! });
      if (options.execute) return options.execute(graphInput);
      const dir = String(graphInput.outDir);
      writeFileSync(join(dir, 'followup.json'), JSON.stringify(report));
      writeFileSync(join(dir, 'followup.md'), '# full report\n## ② CRM 한 줄\n파일: crm.csv\nname: Alex · company: Example');
      return state('done');
    } },
  });
  return { bot, root, sent, turns, docs, runs, downloads, ocrCalls };
}
async function finished(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

test('captionless owner photo starts immediately and also reaches the normal turn; three replies and private report', async () => {
  let complete!: (value: GraphRunState) => void;
  const deferred = new Promise<GraphRunState>((resolve) => { complete = resolve; });
  const fixture = setup(undefined, { execute: async (input) => {
    writeFileSync(join(String(input.outDir), 'followup.json'), JSON.stringify(report));
    writeFileSync(join(String(input.outDir), 'followup.md'), '# full report\n## ② CRM 한 줄\n파일: crm.csv\nname: Alex · company: Example');
    return deferred;
  } });
  await fixture.bot.start();
  expect(fixture.turns).toEqual(['']);
  await finished(() => fixture.runs.length === 1);
  expect(fixture.sent.filter((s) => s.text.startsWith('명함으로'))).toHaveLength(1);
  expect(fixture.runs).toHaveLength(1);
  expect(fixture.downloads).toContain('big');
  const dir = String(fixture.runs[0]!.input.outDir);
  expect(dir).toBe(join(fixture.root, 'graph-runs', 'card-followup', fixture.runs[0]!.runId));
  expect(fixture.runs[0]!.root).toBe(fixture.root);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.jpg'))!)).mode & 0o777).toBe(0o600);
  expect(fixture.sent.some((s) => s.text.startsWith('①'))).toBe(false);
  complete(state('done'));
  await finished(() => fixture.docs.length === 1);
  expect(fixture.sent.filter((s) => /^[①②③]/.test(s.text)).map((s) => s.text[0])).toEqual(['①', '②', '③']);
  expect(fixture.sent.filter((s) => /^[①②③]/.test(s.text)).every((s) => s.replyTo === 7 && s.chat === OWNER)).toBe(true);
  const sections = fixture.sent.filter((s) => /^[①②③]/.test(s.text));
  expect(sections[0]!.text).toContain('Alex · Example · CEO');
  expect(sections[0]!.text).toContain('타겟 판정: 80 · high');
  expect(sections[1]!.text).toContain('다음 행동: 내일 연락');
  expect(sections[2]!.text).toContain('보내지 않았습니다');
  expect(fixture.docs).toEqual([{ name: 'followup.md', bytes: '# full report\n## ② CRM 한 줄\n파일: crm.csv\nname: Alex · company: Example', replyTo: '7' }]);
  expect(readFileSync(join(dir, 'followup.json'), 'utf8')).toContain('"sent":false');
});

for (const [caption, prefix] of [['전략', '② 전략'], ['메일 초안', '③ 팔로업 초안'], ['초안', '③ 팔로업 초안'], ['CRM', 'CRM 한 줄']] as const) {
  test(`${caption} picks only its requested part and skips normal turn`, async () => {
    const { bot, sent, turns, docs } = setup(caption);
    await bot.start();
    await finished(() => docs.length === 1);
    expect(turns).toEqual([]);
    expect(sent.map((s) => s.text.startsWith('명함으로') ? 'ack' : s.text.slice(0, prefix.length))).toEqual(['ack', prefix]);
    expect(sent.every((s) => s.chat === OWNER && s.replyTo === 7)).toBe(true);
    if (caption === 'CRM') expect(sent[1]!.text).toContain('name: Alex · company: Example');
  });
}

test('read-card named fail is not-a-card, no additional reply', async () => {
  const observed: Array<{ event: string; data: unknown }> = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
    if (category === 'card.followup') observed.push({ event, data });
  }) as typeof debug.log);
  try {
    const { bot, sent, docs, turns } = setup('명함', { execute: async () => ({
      ...state('failed'), nodes: [{ nodeId: 'read-card', ok: true, exit: 0, executed: true,
        output: '{"outcome":"fail","reason":"not a card"}' }],
    }) });
    await bot.start();
    await finished(() => observed.some((entry) => entry.event === 'not-a-card'));
    expect(sent.map((s) => s.text)).toEqual(['명함으로 보고 정리하는 중입니다(1~3분)']);
    expect(docs).toEqual([]);
    expect(turns).toEqual([]);
    expect(observed.map((entry) => entry.event)).toEqual(['started', 'not-a-card']);
    expect(observed.every(({ data }) => Object.keys(data as object).sort().join(',') === 'chatId,ms,picked')).toBe(true);
  } finally { spy.mockRestore(); }
});

test('read-card with no identifiable fields is a non-card without a second reply', async () => {
  const events: string[] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
    if (category === 'card.followup') events.push(event);
  }) as typeof debug.log);
  try {
    const { bot, sent, docs, turns } = setup(undefined, { execute: async () => ({
      ...state('failed'), nodes: [{ nodeId: 'read-card', ok: true, exit: 0, executed: true,
        output: '{"outcome":"ok","card":{"name":null,"company":null,"title":null,"email":null,"phone":null,"url":null,"linkedin":null}}' }],
    }) });
    await bot.start();
    await finished(() => events.includes('not-a-card'));
    expect(sent.filter((s) => s.text.startsWith('명함으로'))).toHaveLength(1);
    expect(sent.some((s) => /^[①②③]/.test(s.text) || s.text.startsWith('명함 정리에 실패'))).toBe(false);
    expect(turns).toEqual(['']);
    expect(docs).toEqual([]);
  } finally { spy.mockRestore(); }
});

test('graph failure after card reading is observed as failed and closes the pending reply', async () => {
  const events: string[] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
    if (category === 'card.followup') events.push(event);
  }) as typeof debug.log);
  try {
    const { bot, sent, docs } = setup('명함', { execute: async () => ({
      ...state('failed'), path: ['read-card', 'research'],
      nodes: [...state('done').nodes, { nodeId: 'research', ok: false, exit: 0, executed: true, output: '{"outcome":"fail"}' }],
    }) });
    await bot.start();
    await finished(() => sent.some((s) => s.text === '명함 정리에 실패했습니다. 다시 시도해 주세요.'));
    expect(events).toEqual(['started', 'failed']);
    expect(sent.map((s) => s.text)).toEqual(['명함으로 보고 정리하는 중입니다(1~3분)', '명함 정리에 실패했습니다. 다시 시도해 주세요.']);
    expect(sent[1]).toMatchObject({ chat: OWNER, replyTo: 7 });
    expect(docs).toEqual([]);
  } finally { spy.mockRestore(); }
});

for (const [failure, options] of [
  ['graph execution', { execute: async () => { throw new Error('runner failed'); } }],
  ['report reading', { execute: async () => state('done') }],
  ['reply delivery', { failResultSend: true }],
  ['document delivery', { failDocument: true }],
] as const) {
  test(`${failure} failure ends with a failure reply to the original photo`, async () => {
    const events: string[] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
      if (category === 'card.followup') events.push(event);
    }) as typeof debug.log);
    try {
      const { bot, sent, turns } = setup('명함', options);
      await bot.start();
      await finished(() => events.includes('failed') && sent.some((s) => s.text === '명함 정리에 실패했습니다. 다시 시도해 주세요.'));
      expect(events).toEqual(['started', 'failed']);
      expect(turns).toEqual([]);
      expect(sent.at(-1)).toMatchObject({ chat: OWNER, replyTo: 7, text: '명함 정리에 실패했습니다. 다시 시도해 주세요.' });
    } finally { spy.mockRestore(); }
  });
}

for (const failure of ['download', 'directory'] as const) {
  for (const caption of ['명함', undefined] as const) {
    test(`${failure} preparation failure replies to the photo and ${caption ? 'consumes keyword request' : 'preserves captionless normal turn'}`, async () => {
      const events: string[] = [];
      const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
        if (category === 'card.followup') events.push(event);
      }) as typeof debug.log);
      try {
        const { bot, sent, turns, runs, docs } = setup(caption, { failPreparation: failure });
        await bot.start();
        if (!caption) await finished(() => events.includes('failed'));
        // A bare photo was never claimed as a card, so its preparation failure stays silent.
        expect(sent.filter((message) => message.text === '명함 정리에 실패했습니다. 다시 시도해 주세요.'))
          .toEqual(caption ? [{ chat: OWNER, replyTo: 7, text: '명함 정리에 실패했습니다. 다시 시도해 주세요.' }] : []);
        expect(sent.some((message) => message.text === '⏳ Working…')).toBe(!caption);
        expect(turns).toEqual(caption ? [] : ['']);
        expect(runs).toEqual([]);
        expect(docs).toEqual([]);
        expect(events).toEqual(['failed']);
      } finally { spy.mockRestore(); }
    });
  }
}

test('captionless non-card still reaches the normal turn and only acknowledges the graph attempt', async () => {
  const { bot, sent, turns, docs } = setup(undefined, { execute: async () => ({
    ...state('failed'), nodes: [{ nodeId: 'read-card', ok: true, exit: 0, executed: true,
      output: '{"outcome":"fail","reason":"not a card"}' }],
  }) });
  await bot.start();
  expect(turns).toEqual(['']);
  expect(sent.filter((s) => s.text.startsWith('명함으로'))).toHaveLength(1);
  expect(docs).toEqual([]);
});

test('read-card execution error is a failure, not a non-card verdict', async () => {
  const events: string[] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
    if (category === 'card.followup') events.push(event);
  }) as typeof debug.log);
  try {
    const { bot, sent, docs } = setup('명함', { execute: async () => ({
      ...state('failed', false), nodes: [{ nodeId: 'read-card', ok: false, exit: 1, executed: true,
        output: '{"outcome":"fail","reason":"OCR process exited"}' }],
    }) });
    await bot.start();
    await finished(() => sent.length === 2);
    expect(sent[1]).toMatchObject({ text: '명함 정리에 실패했습니다. 다시 시도해 주세요.', replyTo: 7 });
    expect(docs).toEqual([]);
    expect(events).toEqual(['started', 'failed']);
  } finally { spy.mockRestore(); }
});

test('read-card explicit OCR failure is not silently classified as a non-card', async () => {
  const events: string[] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
    if (category === 'card.followup') events.push(event);
  }) as typeof debug.log);
  try {
    const { bot, sent } = setup('명함', { execute: async () => ({
      ...state('failed'), nodes: [{ nodeId: 'read-card', ok: true, exit: 0, executed: true,
        output: '{"outcome":"fail","reason":"명함을 판독하지 못했습니다: OCR 오류"}' }],
    }) });
    await bot.start();
    await finished(() => sent.length === 2);
    expect(sent.at(-1)!.text).toBe('명함 정리에 실패했습니다. 다시 시도해 주세요.');
    expect(events).toEqual(['started', 'failed']);
  } finally { spy.mockRestore(); }
});

test('incomplete valid JSON is rejected before any success reply or document', async () => {
  const events: string[] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string) => {
    if (category === 'card.followup') events.push(event);
  }) as typeof debug.log);
  try {
    const { bot, sent, docs } = setup('명함', { execute: async (input) => {
      writeFileSync(join(String(input.outDir), 'followup.json'), '{"sent":false}');
      writeFileSync(join(String(input.outDir), 'followup.md'), '# incomplete');
      return state('done');
    } });
    await bot.start();
    await finished(() => sent.length === 2);
    expect(sent.map((s) => s.text)).toEqual([
      '명함으로 보고 정리하는 중입니다(1~3분)', '명함 정리에 실패했습니다. 다시 시도해 주세요.',
    ]);
    expect(docs).toEqual([]);
    expect(events).toEqual(['started', 'failed']);
  } finally { spy.mockRestore(); }
});

test('unknown fit score is displayed as unknown rather than fabricated', async () => {
  const { bot, sent, docs } = setup('명함', { execute: async (input) => {
    writeFileSync(join(String(input.outDir), 'followup.json'), JSON.stringify({ ...report, fit: { score: null, label: 'unknown' } }));
    writeFileSync(join(String(input.outDir), 'followup.md'), '# full report');
    return state('done');
  } });
  await bot.start();
  await finished(() => docs.length === 1);
  expect(sent.find((s) => s.text.startsWith('①'))!.text).toContain('타겟 판정: — · unknown');
});

test('#현장 goes to the field upload before card detection', async () => {
  const { bot, runs, sent } = setup('#현장');
  await bot.start();
  expect(runs).toEqual([]);
  expect(sent.map((s) => s.text)).toEqual([expect.stringContaining('현장 폴더에 저장')]);
});

test('group and non-owner never start the card graph', async () => {
  for (const options of [{ type: 'group' as const }, { userId: 11 }]) {
    const { bot, runs, downloads } = setup('명함', options);
    await bot.start();
    expect(runs).toEqual([]);
    expect(downloads).toEqual([]);
  }
});

test('untagged albums can be assessed as card photos without interfering with field albums', async () => {
  const { bot, runs, turns } = setup('', { mediaGroupId: 'album' });
  await bot.start();
  await finished(() => runs.length === 1);
  expect(turns).toEqual(['']);
});

test('name-only card keyword still returns all three parts', async () => {
  const { bot, sent, turns, docs } = setup('명함');
  await bot.start();
  await finished(() => docs.length === 1);
  expect(turns).toEqual([]);
  expect(sent.filter((s) => /^[①②③]/.test(s.text)).map((s) => s.text[0])).toEqual(['①', '②', '③']);
});

test('non-keyword caption is not intercepted', async () => {
  for (const options of [{ caption: '그냥 사진' }, { caption: 'hello' }]) {
    const { bot, runs, turns } = setup(options.caption);
    await bot.start();
    expect(runs).toEqual([]);
    expect(turns).toEqual([options.caption]);
  }
});

test('Latin keywords match whole words only — a postcard caption is not a card request', async () => {
  for (const caption of ['postcard from vacation', 'cardinal red', 'CRMs everywhere']) {
    const { bot, runs, turns } = setup(caption);
    await bot.start();
    expect(runs).toEqual([]);
    expect(turns).toEqual([caption]);
  }
  for (const caption of ['business card', 'CRM please']) {
    const { bot, runs, turns } = setup(caption);
    await bot.start();
    await finished(() => runs.length === 1);
    expect(turns).toEqual([]);
  }
});

test('a #현장 album never reaches card detection, including its captionless items', async () => {
  const { bot, runs, turns, sent } = setup('#현장', { mediaGroupId: 'field-album', extra: [
    { messageId: 8, mediaGroupId: 'field-album' }, { messageId: 9, mediaGroupId: 'field-album' },
  ] });
  await bot.start();
  await new Promise((r) => setTimeout(r, 1700));
  expect(runs).toEqual([]);
  expect(turns).toEqual([]);
  expect(sent.some((s) => s.text.startsWith('명함으로 보고'))).toBe(false);
  expect(sent.map((s) => s.text)).toEqual([expect.stringContaining('현장 폴더에 저장')]);
});

test('an untagged captionless album starts one card run, and every item still reaches the normal turn', async () => {
  const { bot, runs, turns, sent } = setup(undefined, { mediaGroupId: 'plain-album', extra: [
    { messageId: 8, mediaGroupId: 'plain-album' }, { messageId: 9, mediaGroupId: 'plain-album' },
  ] });
  await bot.start();
  await finished(() => runs.length === 1);
  await finished(() => turns.length === 3);
  expect(runs).toHaveLength(1);
  expect(sent.filter((s) => s.text.startsWith('명함으로 보고'))).toHaveLength(1);
});

describe('captionless photos start a card run only when they look like a business card', () => {
  test('square photo → no run, no acknowledgement, no OCR', async () => {
    const { bot, runs, turns, sent, ocrCalls } = setup(undefined, { photo: { width: 1200, height: 1200 } });
    await bot.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toEqual([]);
    expect(ocrCalls).toEqual([]);
    expect(sent.some((s) => s.text.startsWith('명함으로'))).toBe(false);
    expect(turns).toEqual(['']);
  });
  test('phone screenshot ratio (9:19.5) → no run', async () => {
    const { bot, runs, sent, ocrCalls } = setup(undefined, { photo: { width: 1170, height: 2532 } });
    await bot.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toEqual([]);
    expect(ocrCalls).toEqual([]);
    expect(sent.some((s) => s.text.startsWith('명함으로'))).toBe(false);
  });
  test('card ratio with contact patterns → one run', async () => {
    const { bot, runs, sent, ocrCalls } = setup(undefined, { photo: { width: 1000, height: 1700 } });
    await bot.start();
    await finished(() => runs.length === 1);
    expect(ocrCalls).toHaveLength(1);
    expect(sent.filter((s) => s.text.startsWith('명함으로'))).toHaveLength(1);
  });
  for (const [name, ocr] of [
    ['OCR unavailable', async () => null],
    ['too little text', async () => 'hi'],
    ['one weak signal', async () => 'Meeting notes for tomorrow at the office, call me'],
  ] as const) {
    test(`ambiguous (${name}) → nothing: no run, no acknowledgement, photo removed, normal turn intact`, async () => {
      const events: Array<Record<string, unknown>> = [];
      const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: Record<string, unknown>) => {
        if (category === 'telegram.card-followup' && event === 'detect') events.push(data);
      }) as typeof debug.log);
      try {
        const { bot, runs, sent, turns, root } = setup(undefined, { ocr });
        await bot.start();
        await finished(() => events.length === 1);
        expect(events[0]!.decision === 'ambiguous' || events[0]!.decision === 'skip').toBe(true);
        expect(JSON.stringify(events[0])).not.toContain('Meeting');
        expect(runs).toEqual([]);
        expect(sent.some((s) => s.text.startsWith('명함으로'))).toBe(false);
        expect(turns).toEqual(['']);
        expect(readdirSync(join(root, 'graph-runs', 'card-followup'))).toEqual([]);
      } finally { spy.mockRestore(); }
    });
  }
  test('a long document text is not a card', async () => {
    const { bot, runs, sent } = setup(undefined, { ocr: async () => `${'contract clause '.repeat(80)} a@b.com +1 415 555 0100` });
    await bot.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(runs).toEqual([]);
    expect(sent.some((s) => s.text.startsWith('명함으로'))).toBe(false);
  });
  test('a keyword caption still starts immediately without OCR', async () => {
    const { bot, runs, ocrCalls } = setup('명함', { photo: { width: 1200, height: 1200 } });
    await bot.start();
    await finished(() => runs.length === 1);
    expect(ocrCalls).toEqual([]);
  });
});
