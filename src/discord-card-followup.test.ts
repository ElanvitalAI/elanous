import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiscordSelfOnMessage } from './discord-self-message.js';
import { getUserConfig } from './user-config.js';
import type { DiscordBot, DcIncoming } from './discord.js';
import type { GraphRunState } from './graph-runner/runner.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const report = {
  card: { name: 'Alex', company: 'Example', title: 'CEO' },
  fit: { score: 80, label: 'high' },
  approach: { problem: '문제', proposal: '제안', channel: '이메일' },
  nextAction: { what: '내일 연락', due: '내일' },
  draft: { subject: '안녕하세요', body: '반갑습니다' }, sent: false,
};
const state: GraphRunState = { graphId: 'card-followup', runId: 'test', status: 'done', path: [], nodes: [], executed: 0, dryRun: false, statePath: 'test.json' };
const CARD_TEXT = 'Alex Kim\nCEO · Example Inc\nalex@example.com\n+82 10-1234-5678';
function setup({ caption = '', width = 1600, height = 1000, ocr = CARD_TEXT, fail = false, notCard = false, attachments = 1 }: {
  caption?: string; width?: number; height?: number; ocr?: string | null; fail?: boolean; notCard?: boolean; attachments?: number;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dc-card-'));
  dirs.push(root);
  const sent: Array<{ channel: string; text: string }> = [];
  const turns: string[] = [];
  let downloads = 0, ocrCalls = 0, runs = 0;
  const bot = {
    downloadAttachment: async () => { downloads++; const localPath = join(root, 'image.jpg'); writeFileSync(localPath, 'fake'); return { localPath, fileName: 'image.jpg' }; },
    sendMessage: async (channel: string, text: string) => { sent.push({ channel, text }); return { id: 'reply' }; },
    fileSinkForChannel: () => ({ sendFile: () => {}, sendImage: () => {} }),
  } as unknown as DiscordBot;
  const handler = buildDiscordSelfOnMessage({ userConfig: getUserConfig(), getBot: () => bot,
    runTurnImpl: (async () => { turns.push('normal'); return { text: 'normal reply' }; }) as never,
    cardFollowupDeps: { rootDir: () => root, ocrText: async () => { ocrCalls++; return ocr; },
      runGraph: async (_graph, options) => {
        runs++;
        if (fail) throw new Error('graph failed');
        if (notCard) return { ...state, status: 'failed', nodes: [{ nodeId: 'read-card', ok: true, exit: 0, executed: true,
          output: '{"outcome":"fail","reason":"not a card"}' }] };
        const dir = String((options!.input as { outDir: string }).outDir);
        writeFileSync(join(dir, 'followup.json'), JSON.stringify(report));
        writeFileSync(join(dir, 'followup.md'), '# followup');
        return state;
      },
    },
  });
  const photo = { id: 'image', filename: 'image.jpg', size: 4, url: 'https://example.test/image', contentType: 'image/jpeg', width, height };
  const ctx: DcIncoming = { channelId: 'same-channel', userId: 'owner', messageId: 'photo', isDm: true,
    text: caption, attachments: Array.from({ length: attachments }, () => photo), raw: {} };
  return { handler, ctx, sent, turns, counts: () => ({ downloads, ocrCalls, runs }) };
}

test('captionless 1.6:1 image with email and phone returns three ordered card replies to the same channel', async () => {
  const f = setup();
  expect(await f.handler(f.ctx)).toBeUndefined();
  expect(f.sent.map(({ text }) => text.slice(0, 1))).toEqual(['①', '②', '③']);
  expect(f.sent.every(({ channel }) => channel === f.ctx.channelId)).toBe(true);
  expect(f.sent[0]!.text).toContain('Alex · Example · CEO');
  expect(f.sent[1]!.text).toContain('다음 행동: 내일 연락');
  expect(f.sent[2]!.text).toContain('보내지 않았습니다');
  expect(f.counts()).toEqual({ downloads: 1, ocrCalls: 1, runs: 1 });
  expect(f.turns).toEqual([]);
});

test('a streamer still sends three ordered replies and closes its placeholder', async () => {
  const f = setup();
  expect(await f.handler(f.ctx, { edit: () => {} })).toBe('명함 정리를 완료했습니다.');
  expect(f.sent.map(({ text }) => text[0])).toEqual(['①', '②', '③']);
  expect(f.sent.every(({ channel }) => channel === f.ctx.channelId)).toBe(true);
});

test('caption disables card interception; whitespace-only text counts as empty', async () => {
  const f = setup({ caption: '사진 설명' });
  expect(await f.handler(f.ctx)).toBe('normal reply');
  expect(f.counts()).toEqual({ downloads: 0, ocrCalls: 0, runs: 0 });
  expect(f.turns).toEqual(['normal']);
  const blank = setup({ caption: '  \n ' });
  expect(await blank.handler(blank.ctx)).toBeUndefined();
  expect(blank.sent.map(({ text }) => text[0])).toEqual(['①', '②', '③']);
  expect(blank.turns).toEqual([]);
});

test('square image and image with blank OCR take the normal route', async () => {
  for (const options of [{ width: 1000, height: 1000 }, { ocr: '' }, { ocr: null }, { attachments: 2 }]) {
    const f = setup(options);
    expect(await f.handler(f.ctx)).toBe('normal reply');
    expect(f.counts().runs).toBe(0);
    expect(f.turns).toEqual(['normal']);
    if (options.width) expect(f.counts().downloads).toBe(0);
  }
});

test('read-card not-a-card verdict after positive OCR falls through to normal chat', async () => {
  const f = setup({ notCard: true });
  expect(await f.handler(f.ctx)).toBe('normal reply');
  expect(f.counts()).toEqual({ downloads: 1, ocrCalls: 1, runs: 1 });
  expect(f.sent).toEqual([]);
  expect(f.turns).toEqual(['normal']);
});

test('graph failure returns one failure line and never enters normal chat', async () => {
  const f = setup({ fail: true });
  expect(await f.handler(f.ctx)).toBe('명함을 읽지 못했습니다');
  expect(f.sent).toEqual([]);
  expect(f.counts().runs).toBe(1);
  expect(f.turns).toEqual([]);
});
