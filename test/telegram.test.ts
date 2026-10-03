// ── Telegram bot tests ──
//
// Drives TelegramBot with a stubbed fetch that serves a pre-queued
// sequence of Bot API responses. No network. Polling loop is exercised
// by feeding an update batch, then an empty batch, then stop().

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TelegramBot, parseUpdate, splitForTelegram, botFromConfig, buildTelegramVoiceAdapterFromConfig,
} from '../src/telegram';
import { defaultTelegramCommands } from '../src/telegram-commands.js';
import { listSessions, findTelegramSession } from '../src/session/index';
import { resetUserConfig, type UserConfig } from '../src/user-config';
import { TaskDispatcher } from '../src/task-orchestrator/dispatcher.ts';
import { TaskEventBus } from '../src/task-orchestrator/events.ts';
import { TaskGenerator, type DecomposeCallable } from '../src/task-orchestrator/generator.ts';
import { TaskGraph } from '../src/task-orchestrator/graph.ts';
import {
  clearPendingDecomposeForTest,
  resetToxRuntimeDepsForTest,
  setToxRuntimeDeps,
} from '../src/task-orchestrator/runtime-deps.ts';
import { SurfaceRegistry } from '../src/task-orchestrator/surface-registry.ts';
import type { TaskSurface } from '../src/task-orchestrator/types.ts';
import { setIntakeStoreForTest } from '../src/intake-plane/runtime.ts';
import { createIntakeStore } from '../src/intake-plane/store.ts';
import { setDaemonInputHostForTesting } from '../src/voice/daemon-input-host-singleton';
import { setDaemonSttProviderForTesting } from '../src/voice/voice-rest-handler';
import { setDaemonTtsProviderForTesting } from '../src/voice/voice-tts-singleton';
import type { STTProvider } from '../src/voice/stt-provider';
import type { TTSProvider } from '../src/voice/tts/tts-provider';
import type { TelegramVoiceCodec } from '../src/voice/channel-adapters/telegram-voice-adapter';

const surfaceLlm: TaskSurface = { kind: 'llm-direct', prompt: 'p' };

function makeGenerator(proposal: unknown): TaskGenerator {
  return new TaskGenerator({
    callable: (async () => ({ text: JSON.stringify(proposal) })) as DecomposeCallable,
  });
}

function baseConfig(): UserConfig {
  return {
    skillRouter: {
      autoRoute: false, autoRouteCountdownMs: 1000, llmFallback: false,
      keywordScoreThreshold: 2, llmConfidenceThreshold: 0.5,
      autoRouteMinScore: 1, autoRouteRequireAutoTrigger: true,
    },
    llm: { provider: 'auto' },
    skills: { activeSet: 'opencode', dirs: [] },
    obsidian: { vault: '/tmp/v' },
    telegram: {
      enabled: true,
      botToken: '12345:FAKEFAKE',
      allowedUsers: [42, 100],
      homeChannel: undefined,
    },
    discord: { enabled: false, allowedUsers: [] },
    onboarding: { completed: true, version: 1 },
    debug: { file: false, level: 'info' },
    shell: {
      allowDashboardPty: false,
      allowDashboardBash: false,
      allowDashboardTerminalInject: false,
      allowDashboardApiCall: false,
      allowDashboardRunShell: false,
      allowDashboardState: true,
    },
    chat: {
      conciseness: { enabled: true, finalMessageMaxLines: 10, preambleMaxWords: 12, flatBullets: true },
      toolOutput: { persistOnOverflow: true, retentionDays: 7, previewLines: 20 },
      autoCompact: { enabled: true, triggerRatio: 0.85, preserveLastN: 4, partial: true },
      autoCopyQaToClipboard: false,
      systemPrompt: { taskVariant: 'default' },
      rendering: {
        streaming: { mode: 'byte', catchUpThresholdLines: 50, catchUpAgeMs: 200 },
        compactBoundary: { enabled: true },
        wrap: { urlAware: false, preserveOsc8: true },
        tool: { displayMode: 'inline-to-block', blockMaxLines: 20 },
        hud: { gaugeWarnRatio: 0.7, gaugeDangerRatio: 0.85 },
        diff: {
          colorTier: 'auto', adaptiveBg: true, syntaxPerHunk: true, cache: true, headerStyle: 'legacy',
          turnSummary: true, turnBrowser: true, turnBrowserHistory: 8, turnBrowserMode: 'all',
        },
      },
    },
    voice: { stt: {}, tts: {}, vad: {}, chat: {}, discord: {}, telegram: {}, pwa: {} },
    intake: { telegram: {}, discord: {} },
    dashboard: { promptBank: { enabled: false, dashboardTurns: false, skillRuns: false } },
    vw: { windowNames: {}, paneNames: {} },
    acp: { hopCap: { enabled: false, maxHops: 0 } },
    lsp: { providers: {}, registry: {}, polling: {}, symbol: {}, completion: {} } as any,
    plan: { autoOpen: false, autoAskForMissing: true, defaultMode: 'plan' } as any,
    raw: {},
  };
}

type Call = { url: string; body: any };

function makeStubFetch(responder: (call: Call) => any): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: any = async (url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const call: Call = { url, body };
    calls.push(call);
    const result = responder(call);
    return {
      json: async () => ({ ok: true, result }),
    };
  };
  return { fetchImpl, calls };
}

const FAST_TG_OPTS = {
  errorBackoffMs: 0,
  pollTimeoutSec: 0,
  perChatGapMs: 0,
  streamEditGapMs: 0,
} as const;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-'));
  process.env.XDG_CONFIG_HOME = join(root, '_config');
  process.env.ELANOUS_STATE_DIR = join(root, '_elanous-state');
  process.env.XDG_DATA_HOME = root;
  process.env.XDG_STATE_HOME = join(root, '_state');
  resetUserConfig();
});
afterEach(() => {
  clearPendingDecomposeForTest();
  resetToxRuntimeDepsForTest();
  setIntakeStoreForTest(null);
  resetUserConfig();
  rmSync(root, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.ELANOUS_STATE_DIR;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_STATE_HOME;
});

describe('parseUpdate', () => {
  test('extracts DM context', () => {
    const u = parseUpdate({
      update_id: 1,
      message: {
        message_id: 7,
        from: { id: 42, first_name: 'Alice' },
        chat: { id: 42, type: 'private' },
        text: 'hi',
      },
    })!;
    expect(u.isDm).toBe(true);
    expect(u.userId).toBe(42);
    expect(u.text).toBe('hi');
    expect(u.attachments).toEqual([]);
  });

  test('photo attachment selects largest size', () => {
    const u = parseUpdate({
      update_id: 9,
      message: {
        message_id: 1,
        from: { id: 7 },
        chat: { id: 7, type: 'private' },
        caption: 'look at this',
        photo: [
          { file_id: 'small', width: 90, height: 90 },
          { file_id: 'med', width: 320, height: 320 },
          { file_id: 'big', width: 1280, height: 1280 },
        ],
      },
    })!;
    expect(u.text).toBe('look at this');
    expect(u.attachments).toHaveLength(1);
    expect(u.attachments[0].kind).toBe('photo');
    expect(u.attachments[0].fileId).toBe('big');
    expect(u.attachments[0].width).toBe(1280);
  });

  test('voice attachment', () => {
    const u = parseUpdate({
      update_id: 10,
      message: {
        message_id: 1,
        from: { id: 7 },
        chat: { id: 7, type: 'private' },
        voice: { file_id: 'voice1', duration: 8, mime_type: 'audio/ogg', file_size: 4096 },
      },
    })!;
    expect(u.text).toBe('');
    expect(u.attachments).toHaveLength(1);
    expect(u.attachments[0]).toMatchObject({ kind: 'voice', fileId: 'voice1', duration: 8, mimeType: 'audio/ogg' });
  });

  test('document attachment', () => {
    const u = parseUpdate({
      update_id: 11,
      message: {
        message_id: 1,
        from: { id: 7 },
        chat: { id: 7, type: 'private' },
        document: { file_id: 'doc1', file_name: 'notes.pdf', mime_type: 'application/pdf', file_size: 2048 },
      },
    })!;
    expect(u.attachments[0]).toMatchObject({
      kind: 'document', fileId: 'doc1', fileName: 'notes.pdf', mimeType: 'application/pdf',
    });
  });

  test('photo + document in same message yields two attachments', () => {
    const u = parseUpdate({
      update_id: 12,
      message: {
        message_id: 1,
        from: { id: 7 },
        chat: { id: 7, type: 'private' },
        photo: [{ file_id: 'p', width: 100, height: 100 }],
        document: { file_id: 'd', mime_type: 'text/plain' },
      },
    })!;
    expect(u.attachments).toHaveLength(2);
    expect(u.attachments.map(a => a.kind).sort()).toEqual(['document', 'photo']);
  });

  test('service updates with no message.text and no attachments → null', () => {
    const u = parseUpdate({
      update_id: 13,
      message: { message_id: 1, from: { id: 7 }, chat: { id: 7, type: 'private' } } as any,
    });
    expect(u).toBeNull();
  });

  test('group + thread', () => {
    const u = parseUpdate({
      update_id: 2,
      message: {
        message_id: 1,
        from: { id: 10 },
        chat: { id: -100, type: 'supergroup' },
        text: 'x',
        message_thread_id: 55,
      },
    })!;
    expect(u.isDm).toBe(false);
    expect(u.isGroup).toBe(true);
    expect(u.threadId).toBe(55);
  });

  test('non-text updates without attachments return null', () => {
    expect(parseUpdate({ update_id: 3 } as any)).toBeNull();
    expect(parseUpdate({ update_id: 4, message: { message_id: 1, chat: { id: 1, type: 'private' } } } as any)).toBeNull();
  });
});

describe('TelegramBot.downloadFile', () => {
  test('two-step getFile + download writes bytes', async () => {
    // Minimal PNG bytes (8 bytes signature + rest zeros) — sharp would
    // reject, but downloadFile only writes bytes; sharp-consuming
    // tests mock loadImageAsAttachment.
    const binBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const fetchImpl: any = async (url: string, init: any) => {
      if (url.endsWith('/getFile')) {
        return { json: async () => ({ ok: true, result: { file_id: 'fid1', file_path: 'photos/abc.png', file_size: 10 } }) };
      }
      if (url.includes('/file/bot')) {
        return { ok: true, status: 200, arrayBuffer: async () => binBuffer.buffer.slice(binBuffer.byteOffset, binBuffer.byteOffset + binBuffer.byteLength) };
      }
      return { json: async () => ({ ok: true, result: {} }) };
    };
    const bot = new TelegramBot({ token: 't', allowedUsers: [], onMessage: async () => undefined, fetchImpl, ...FAST_TG_OPTS });
    const res = await bot.downloadFile('fid1');
    expect(res.localPath).toMatch(/\.png$/);
    expect(res.fileName).toBe('abc.png');
    const { readFileSync } = require('node:fs');
    const got = readFileSync(res.localPath);
    expect(got.length).toBe(binBuffer.length);
    require('node:fs').unlinkSync(res.localPath);
  });

  test('404 on binary fetch surfaces a clear error', async () => {
    const fetchImpl: any = async (url: string) => {
      if (url.endsWith('/getFile')) {
        return { json: async () => ({ ok: true, result: { file_id: 'x', file_path: 'p.bin' } }) };
      }
      return { ok: false, status: 404 };
    };
    const bot = new TelegramBot({ token: 't', allowedUsers: [], onMessage: async () => undefined, fetchImpl, ...FAST_TG_OPTS });
    await expect(bot.downloadFile('x')).rejects.toThrow(/download failed/);
  });
});

describe('splitForTelegram', () => {
  test('short text → single chunk', () => {
    expect(splitForTelegram('hello', 100)).toEqual(['hello']);
  });

  test('splits at paragraph boundaries when possible', () => {
    const text = 'aaaa\n\nbbbb\n\ncccc';
    const chunks = splitForTelegram(text, 6);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(7);
  });

  test('hard-splits at maxChars when no break available', () => {
    const text = 'x'.repeat(20);
    const chunks = splitForTelegram(text, 6);
    expect(chunks.length).toBe(4); // 20/6 = 3 full + 1 leftover ... actually 6*3 = 18, +2 = 4 chunks
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(6);
  });
});

describe('TelegramBot', () => {
  test('sendMessage posts to Bot API', async () => {
    const { fetchImpl, calls } = makeStubFetch(() => ({}));
    const bot = new TelegramBot({
      token: 't', allowedUsers: [],
      onMessage: async () => undefined,
      fetchImpl,
      ...FAST_TG_OPTS,
    });
    await bot.sendMessage(42, 'hello');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain('/sendMessage');
    expect(calls[0].body.chat_id).toBe(42);
    expect(calls[0].body.text).toBe('hello');
  });

  test('sendMessage chunks long text', async () => {
    const { fetchImpl, calls } = makeStubFetch(() => ({}));
    const bot = new TelegramBot({
      token: 't', allowedUsers: [],
      onMessage: async () => undefined,
      fetchImpl,
      maxMessageChars: 10,
      ...FAST_TG_OPTS,
    });
    await bot.sendMessage(42, 'x'.repeat(35));
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every(c => c.url.includes('/sendMessage'))).toBe(true);
  });

  test('reaction emoji start and success stay on without a config switch', async () => {
    const updates = [{ update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'hello' } }];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 777 };
      return {};
    });
    bot = new TelegramBot({ token: 't', allowedUsers: [42], onMessage: async () => 'ok', fetchImpl, ...FAST_TG_OPTS });
    await bot.start();
    expect(calls.filter(c => c.url.endsWith('/setMessageReaction')).map(c => c.body)).toEqual([
      { chat_id: 42, message_id: 1, reaction: [{ type: 'emoji', emoji: '👀' }] },
      { chat_id: 42, message_id: 1, reaction: [{ type: 'emoji', emoji: '👍' }] },
    ]);
  });

  test('reaction emoji start and failure stay on without a config switch', async () => {
    const updates = [{ update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'hello' } }];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 777 };
      return {};
    });
    bot = new TelegramBot({ token: 't', allowedUsers: [42], onMessage: async () => { throw new Error('oops'); }, fetchImpl, ...FAST_TG_OPTS });
    await bot.start();
    expect(calls.filter(c => c.url.endsWith('/setMessageReaction')).map(c => c.body)).toEqual([
      { chat_id: 42, message_id: 1, reaction: [{ type: 'emoji', emoji: '👀' }] },
      { chat_id: 42, message_id: 1, reaction: [{ type: 'emoji', emoji: '👎' }] },
    ]);
  });

  test('poll loop routes updates to onMessage + sends reply', async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'hello' } },
    ];
    let served = false;
    let bot: TelegramBot;
    // stubFetch returns a message_id for sendMessage so handleIncoming
    // can edit the placeholder in place.
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        // Second poll → stop, return empty.
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 777 };
      return {};
    });
    const gotTexts: string[] = [];
    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async (ctx) => { gotTexts.push(ctx.text); return `echo: ${ctx.text}`; },
      fetchImpl,
      ...FAST_TG_OPTS,
    });
    await bot.start();

    expect(gotTexts).toEqual(['hello']);
    // First outbound sendMessage is the placeholder (user sees
    // acknowledgement while we wait for the handler to resolve).
    const placeholder = calls.find(c => c.url.endsWith('/sendMessage'));
    expect(placeholder).toBeDefined();
    expect(placeholder!.body.text).toBe('⏳ Working…');
    expect(placeholder!.body.reply_to_message_id).toBe(1);
    // Final reply rides on editMessageText (in-place replacement of
    // the placeholder). onMessage returned plain "echo: hello"; after
    // markdown conversion it's the same string.
    const edit = calls.find(c => c.url.endsWith('/editMessageText'));
    expect(edit).toBeDefined();
    expect(edit!.body.text).toBe('echo: hello');
    expect(edit!.body.message_id).toBe(777);
  });

  // Telegram does NOT push-notify on message EDITS. A long turn (a /cc
  // delegation, a HITL-approved job) that finalized by editing the
  // placeholder would land silently — "승인 후 알림 없음". So turns past the
  // notify threshold deliver their result as FRESH messages.
  test('long turn (>threshold) delivers result as a FRESH message so Telegram notifies', async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '오래 걸리는 잡' } },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 777 };
      return {};
    });
    // Controllable clock — onMessage advances it PAST the 20s threshold so
    // finalizeReply takes the fresh-message (notifying) path.
    let clock = 1_000_000;
    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async () => { clock += 25_000; return '리드미갱신완료'; },
      fetchImpl, nowImpl: () => clock,
      ...FAST_TG_OPTS,
    });
    await bot.start();

    const sends = calls.filter(c => c.url.endsWith('/sendMessage'));
    // Placeholder still posted first…
    expect(sends[0]!.body.text).toBe('⏳ Working…');
    // …then collapsed to a POINTER via edit (the '결과 ↓' text only appears
    // on the notify path — distinguishes it from a plain edit).
    const edit = calls.find(c => c.url.endsWith('/editMessageText'));
    expect(edit!.body.text).toContain('결과 ↓');
    // The pointer must NOT claim "완료" — it sits above the mid-turn
    // "✓ 승인됨" ack, so "완료" here would read as done-before-approved.
    expect(edit!.body.text).not.toContain('완료');
    // …and the RESULT rides on a FRESH sendMessage (which DOES notify),
    // NOT on the edit.
    expect(sends).toHaveLength(2);
    expect((sends[1]!.body.text ?? '')).toContain('리드미갱신완료');
  });

  test('short turn keeps the quiet edit-in-place (result on the edit, no extra send)', async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'hi' } },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 777 };
      return {};
    });
    let clock = 1_000_000;
    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async () => { clock += 3_000; return '빠른 답'; }, // < threshold
      fetchImpl, nowImpl: () => clock,
      ...FAST_TG_OPTS,
    });
    await bot.start();

    const sends = calls.filter(c => c.url.endsWith('/sendMessage'));
    expect(sends).toHaveLength(1); // only the placeholder — no fresh result msg
    const edit = calls.find(c => c.url.endsWith('/editMessageText'));
    expect(edit!.body.text).toContain('빠른 답'); // result carried by the edit
  });

  test('rejects users not on allowlist', async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, from: { id: 999 }, chat: { id: 999, type: 'private' }, text: 'hi' } },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      return {};
    });
    let handlerFired = false;
    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async () => { handlerFired = true; return 'ok'; },
      fetchImpl, ...FAST_TG_OPTS,
    });
    await bot.start();
    expect(handlerFired).toBe(false);
    const refusal = calls.find(c => c.url.endsWith('/sendMessage'));
    expect(refusal).toBeDefined();
    expect(refusal!.body.text).toMatch(/private/i);
  });

  test('voice attachment flows through voiceAdapter (transcribe → onMessage → sendVoice)', async () => {
    const updates = [
      {
        update_id: 1,
        message: {
          message_id: 11, from: { id: 42 }, chat: { id: 42, type: 'private' },
          voice: { file_id: 'voice_abc', duration: 3, mime_type: 'audio/ogg' },
        },
      },
    ];
    let served = false;
    let bot: TelegramBot;

    // Capture multipart sendVoice calls separately — makeStubFetch
    // assumes JSON bodies. We use a custom fetchImpl here.
    const sendVoiceCalls: Array<{ chatId?: string; bytes: number }> = [];
    const editCalls: Array<{ url: string; body: any }> = [];
    const fetchImpl: any = async (url: string, init: any) => {
      if (url.endsWith('getUpdates')) {
        if (!served) { served = true; return { json: async () => ({ ok: true, result: updates }) }; }
        bot.stop();
        return { json: async () => ({ ok: true, result: [] }) };
      }
      if (url.endsWith('/getFile')) {
        return { json: async () => ({ ok: true, result: { file_id: 'voice_abc', file_path: 'voice/abc.ogg', file_size: 5 } }) };
      }
      if (url.includes('/file/bot')) {
        const ab = new ArrayBuffer(5);
        new Uint8Array(ab).set([0x4f, 0x67, 0x67, 0x53, 0x00]); // "OggS\0" magic
        return { ok: true, status: 200, arrayBuffer: async () => ab };
      }
      if (url.endsWith('/sendVoice')) {
        // multipart form-data body — Bun FormData is iterable.
        let bytes = 0;
        let chatId: string | undefined;
        if (init?.body && typeof (init.body as FormData).get === 'function') {
          const form = init.body as FormData;
          chatId = form.get('chat_id') as string | null ?? undefined;
          const blob = form.get('voice') as Blob | null;
          if (blob) bytes = blob.size;
        }
        sendVoiceCalls.push({ chatId, bytes });
        return { json: async () => ({ ok: true, result: { message_id: 999 } }) };
      }
      if (url.endsWith('/sendMessage')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        return { json: async () => ({ ok: true, result: { message_id: 777 } }) };
      }
      if (url.endsWith('/editMessageText')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        editCalls.push({ url, body });
        return { json: async () => ({ ok: true, result: {} }) };
      }
      return { json: async () => ({ ok: true, result: {} }) };
    };

    // Fake voice adapter — captures inputs + emits canned outputs.
    const transcribeCalls: Buffer[] = [];
    const generateReplyCalls: Array<{ text: string; fromVoice: boolean }> = [];
    const voiceAdapter = {
      available: true,
      unavailableReason: null,
      replyMode: 'auto' as const,
      async transcribeOgg(ogg: Buffer) {
        transcribeCalls.push(ogg);
        return { transcript: '안녕하세요', language: 'ko' };
      },
      async generateReply(text: string, opts: { fromVoice: boolean }) {
        generateReplyCalls.push({ text, fromVoice: opts.fromVoice });
        return { text, voiceOgg: Buffer.from([0x4f, 0x67, 0x67]) };
      },
    };

    const onMessageInputs: string[] = [];
    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async (ctx) => { onMessageInputs.push(ctx.text); return `네, ${ctx.text} 들었습니다`; },
      fetchImpl,
      voiceAdapter,
      ...FAST_TG_OPTS,
    });
    await bot.start();

    // 1. STT was called with the downloaded .ogg bytes
    expect(transcribeCalls.length).toBe(1);
    expect(transcribeCalls[0].length).toBe(5);
    // 2. onMessage received the transcript text (not the original empty)
    expect(onMessageInputs).toEqual(['안녕하세요']);
    // 3. generateReply called with fromVoice: true
    expect(generateReplyCalls.length).toBe(1);
    expect(generateReplyCalls[0].fromVoice).toBe(true);
    expect(generateReplyCalls[0].text).toBe('네, 안녕하세요 들었습니다');
    // 4. sendVoice was hit with the chatId + a non-zero binary blob
    expect(sendVoiceCalls.length).toBe(1);
    expect(sendVoiceCalls[0].chatId).toBe('42');
    expect(sendVoiceCalls[0].bytes).toBeGreaterThan(0);
    // 5. placeholder edit shows the transcript reply text (so mute users see it)
    const transcriptEdit = editCalls.find(c => c.body.text?.includes('네, 안녕하세요'));
    expect(transcriptEdit).toBeDefined();
  });

  test('telegram voice reply fan-out keeps raw text even when speakable rewrite exists', async () => {
    const updates = [
      {
        update_id: 1,
        message: {
          message_id: 12,
          from: { id: 42 },
          chat: { id: 42, type: 'private' },
          voice: { file_id: 'voice_raw', duration: 2, mime_type: 'audio/ogg' },
        },
      },
    ];
    let served = false;
    let bot: TelegramBot;
    const sendVoiceCalls: Array<{ caption?: string }> = [];
    const editCalls: Array<{ body: any }> = [];
    const fetchImpl: any = async (url: string, init: any) => {
      if (url.endsWith('getUpdates')) {
        if (!served) { served = true; return { json: async () => ({ ok: true, result: updates }) }; }
        bot.stop();
        return { json: async () => ({ ok: true, result: [] }) };
      }
      if (url.endsWith('/getFile')) {
        return { json: async () => ({ ok: true, result: { file_id: 'voice_raw', file_path: 'voice/raw.ogg', file_size: 5 } }) };
      }
      if (url.includes('/file/bot')) {
        const ab = new ArrayBuffer(5);
        new Uint8Array(ab).set([0x4f, 0x67, 0x67, 0x53, 0x00]);
        return { ok: true, status: 200, arrayBuffer: async () => ab };
      }
      if (url.endsWith('/sendVoice')) {
        const form = init.body as FormData;
        sendVoiceCalls.push({ caption: form.get('caption') as string | null ?? undefined });
        return { json: async () => ({ ok: true, result: { message_id: 999 } }) };
      }
      if (url.endsWith('/sendMessage')) {
        return { json: async () => ({ ok: true, result: { message_id: 777 } }) };
      }
      if (url.endsWith('/editMessageText')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        editCalls.push({ body });
        return { json: async () => ({ ok: true, result: {} }) };
      }
      return { json: async () => ({ ok: true, result: {} }) };
    };

    const voiceAdapter = {
      available: true,
      unavailableReason: null,
      replyMode: 'auto' as const,
      async transcribeOgg() {
        return { transcript: '안녕하세요', language: 'ko' };
      },
      async generateReply() {
        return {
          text: '경로는 /tmp/demotxt 입니다.',
          voiceOgg: Buffer.from([0x4f, 0x67, 0x67]),
        };
      },
    };

    bot = new TelegramBot({
      token: 't',
      allowedUsers: [42],
      onMessage: async () => 'ignored',
      fetchImpl,
      voiceAdapter,
      ...FAST_TG_OPTS,
    });
    await bot.start();

    expect(sendVoiceCalls.length).toBe(1);
    const transcriptEdit = editCalls.find((c) => c.body.text === '경로는 /tmp/demotxt 입니다.');
    expect(transcriptEdit).toBeDefined();
  });

  test('ambient capture mode turns memo-like text into an intake instead of a normal turn', async () => {
    const updates = [
      {
        update_id: 1,
        message: {
          message_id: 31,
          from: { id: 42 },
          chat: { id: 42, type: 'private' },
          text: [
            '- compare two repos',
            '- investigate image preview bug',
            'https://github.com/example/a',
            'https://github.com/example/b',
          ].join('\n'),
        },
      },
    ];
    let served = false;
    let bot: TelegramBot;
    const sends: Array<{ text?: string }> = [];
    const fetchImpl: any = async (url: string, init: any) => {
      if (url.endsWith('getUpdates')) {
        if (!served) { served = true; return { json: async () => ({ ok: true, result: updates }) }; }
        bot.stop();
        return { json: async () => ({ ok: true, result: [] }) };
      }
      if (url.endsWith('/sendMessage')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        sends.push({ text: body.text });
        return { json: async () => ({ ok: true, result: { message_id: 701 } }) };
      }
      return { json: async () => ({ ok: true, result: {} }) };
    };
    let onMessageCalled = false;
    const cfg = baseConfig();
    cfg.intake.telegram.ambientCapture = 'capture';
    bot = new TelegramBot({
      token: 't',
      allowedUsers: [42],
      onMessage: async () => {
        onMessageCalled = true;
        return 'should not run';
      },
      fetchImpl,
      slashCommands: defaultTelegramCommands(),
      slashContext: { userConfig: cfg },
      ...FAST_TG_OPTS,
    });
    await bot.start();
    expect(onMessageCalled).toBe(false);
    expect(sends.some((s) => s.text?.includes('Ambient intake: intake-'))).toBe(true);
  });

  test('spoken intake in a voice attachment bypasses onMessage and replies through sendVoice', async () => {
    const updates = [
      {
        update_id: 1,
        message: {
          message_id: 21, from: { id: 42 }, chat: { id: 42, type: 'private' },
          voice: { file_id: 'voice_intake', duration: 3, mime_type: 'audio/ogg' },
        },
      },
    ];
    let served = false;
    let bot: TelegramBot;
    const sendVoiceCalls: Array<{ caption?: string; bytes: number }> = [];
    const sendMessageCalls: Array<{ text?: string }> = [];
    const fetchImpl: any = async (url: string, init: any) => {
      if (url.endsWith('getUpdates')) {
        if (!served) { served = true; return { json: async () => ({ ok: true, result: updates }) }; }
        bot.stop();
        return { json: async () => ({ ok: true, result: [] }) };
      }
      if (url.endsWith('/getFile')) {
        return { json: async () => ({ ok: true, result: { file_id: 'voice_intake', file_path: 'voice/intake.ogg', file_size: 5 } }) };
      }
      if (url.includes('/file/bot')) {
        const ab = new ArrayBuffer(5);
        new Uint8Array(ab).set([0x4f, 0x67, 0x67, 0x53, 0x00]);
        return { ok: true, status: 200, arrayBuffer: async () => ab };
      }
      if (url.endsWith('/sendVoice')) {
        const form = init.body as FormData;
        const caption = form.get('caption') as string | null;
        const blob = form.get('voice') as Blob | null;
        sendVoiceCalls.push({ caption: caption ?? undefined, bytes: blob?.size ?? 0 });
        return { json: async () => ({ ok: true, result: { message_id: 901 } }) };
      }
      if (url.endsWith('/sendMessage')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        sendMessageCalls.push({ text: body.text });
        return { json: async () => ({ ok: true, result: { message_id: 777 } }) };
      }
      return { json: async () => ({ ok: true, result: {} }) };
    };

    let onMessageCalled = false;
    const voiceAdapter = {
      available: true,
      unavailableReason: null,
      replyMode: 'auto' as const,
      async transcribeOgg() {
        return { transcript: 'intake compare two repos', language: 'en' };
      },
      async generateReply(text: string) {
        return { text, voiceOgg: Buffer.from([0x4f, 0x67, 0x67]) };
      },
    };

    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async () => {
        onMessageCalled = true;
        return 'should not run';
      },
      fetchImpl,
      voiceAdapter,
      ...FAST_TG_OPTS,
    });
    await bot.start();

    expect(onMessageCalled).toBe(false);
    expect(sendVoiceCalls.length).toBe(1);
    expect(sendVoiceCalls[0]?.caption).toContain('I captured that as intake');
    expect(sendVoiceCalls[0]?.bytes).toBeGreaterThan(0);
    expect(sendMessageCalls.length).toBe(0);
  });

  test('spoken intake follow-up apply in a voice attachment bypasses onMessage and replies through sendVoice', async () => {
    const updates = [
      {
        update_id: 1,
        message: {
          message_id: 31, from: { id: 42 }, chat: { id: 42, type: 'private' },
          voice: { file_id: 'voice_intake_1', duration: 3, mime_type: 'audio/ogg' },
        },
      },
      {
        update_id: 2,
        message: {
          message_id: 32, from: { id: 42 }, chat: { id: 42, type: 'private' },
          voice: { file_id: 'voice_intake_2', duration: 2, mime_type: 'audio/ogg' },
        },
      },
    ];
    let served = false;
    let bot: TelegramBot;
    const sendVoiceCalls: Array<{ caption?: string; bytes: number }> = [];
    const fetchImpl: any = async (url: string, init: any) => {
      if (url.endsWith('getUpdates')) {
        if (!served) { served = true; return { json: async () => ({ ok: true, result: updates }) }; }
        bot.stop();
        return { json: async () => ({ ok: true, result: [] }) };
      }
      if (url.endsWith('/getFile')) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const fileId = body.file_id;
        return { json: async () => ({ ok: true, result: { file_id: fileId, file_path: `voice/${fileId}.ogg`, file_size: 5 } }) };
      }
      if (url.includes('/file/bot')) {
        const ab = new ArrayBuffer(5);
        new Uint8Array(ab).set([0x4f, 0x67, 0x67, 0x53, 0x00]);
        return { ok: true, status: 200, arrayBuffer: async () => ab };
      }
      if (url.endsWith('/sendVoice')) {
        const form = init.body as FormData;
        const caption = form.get('caption') as string | null;
        const blob = form.get('voice') as Blob | null;
        sendVoiceCalls.push({ caption: caption ?? undefined, bytes: blob?.size ?? 0 });
        return { json: async () => ({ ok: true, result: { message_id: 902 } }) };
      }
      return { json: async () => ({ ok: true, result: {} }) };
    };

    const graph = new TaskGraph();
    const dispatcher = new TaskDispatcher({
      graph,
      registry: new SurfaceRegistry(),
      bus: new TaskEventBus(),
    });
    setToxRuntimeDeps({
      getGraph: () => graph,
      getDispatcher: () => dispatcher,
      getGenerator: () => makeGenerator({
        rationale: 'split work',
        tasks: [{ index: 0, title: 'Investigate', surface: surfaceLlm }],
      }),
    });

    let callCount = 0;
    const voiceAdapter = {
      available: true,
      unavailableReason: null,
      replyMode: 'auto' as const,
      async transcribeOgg() {
        callCount += 1;
        return callCount === 1
          ? { transcript: 'intake compare two repos', language: 'en' }
          : { transcript: 'intake apply', language: 'en' };
      },
      async generateReply(text: string) {
        return { text, voiceOgg: Buffer.from([0x4f, 0x67, 0x67]) };
      },
    };

    let onMessageCalled = false;
    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async () => {
        onMessageCalled = true;
        return 'should not run';
      },
      fetchImpl,
      voiceAdapter,
      ...FAST_TG_OPTS,
    });
    await bot.start();

    expect(onMessageCalled).toBe(false);
    expect(sendVoiceCalls.length).toBe(2);
    expect(sendVoiceCalls[0]?.caption).toContain('I captured that as intake');
    expect(sendVoiceCalls[1]?.caption).toContain('I updated intake');
    expect(sendVoiceCalls[1]?.caption).toContain('TaskDecomposeApply');
    expect(graph.size()).toBe(1);
  });

  test('sendMessage returns { messageId } so callers can edit', async () => {
    const { fetchImpl } = makeStubFetch(() => ({ message_id: 7 }));
    const bot = new TelegramBot({
      token: 't', allowedUsers: [],
      onMessage: async () => undefined,
      fetchImpl,
      ...FAST_TG_OPTS,
    });
    const r = await bot.sendMessage(42, 'hello');
    expect(r).toEqual({ messageId: 7 });
  });

  test('editMessageText posts to /editMessageText with the correct body', async () => {
    const { fetchImpl, calls } = makeStubFetch(() => ({}));
    const bot = new TelegramBot({
      token: 't', allowedUsers: [],
      onMessage: async () => undefined,
      fetchImpl,
      ...FAST_TG_OPTS,
    });
    await bot.editMessageText(42, 7, 'edited');
    const c = calls.find(x => x.url.endsWith('/editMessageText'));
    expect(c).toBeDefined();
    expect(c!.body).toEqual({ chat_id: 42, message_id: 7, text: 'edited' });
  });

  test('editMessageText swallows "message is not modified" 400', async () => {
    let callCount = 0;
    const fetchImpl: any = async (_url: string, init: any) => {
      callCount++;
      const b = init?.body ? JSON.parse(init.body as string) : {};
      return {
        json: async () => ({
          ok: false,
          error_code: 400,
          description: 'Bad Request: message is not modified',
        }),
      };
    };
    const bot = new TelegramBot({
      token: 't', allowedUsers: [],
      onMessage: async () => undefined,
      fetchImpl,
      ...FAST_TG_OPTS,
    });
    // Should not throw.
    await bot.editMessageText(42, 7, 'same as before');
    expect(callCount).toBe(1); // no retry loop
  });

  test('sendMessage retries once on 429 respecting retry_after', async () => {
    let first = true;
    const fetchImpl: any = async (_url: string, init: any) => {
      if (first) {
        first = false;
        return {
          json: async () => ({
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 0 },
          }),
        };
      }
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    };
    const bot = new TelegramBot({
      token: 't', allowedUsers: [],
      onMessage: async () => undefined,
      fetchImpl,
      ...FAST_TG_OPTS,
    });
    const r = await bot.sendMessage(42, 'hi');
    expect(r).toEqual({ messageId: 1 });
  });

  test('per-chat rate limiter gates two same-chat sends by ~900ms', async () => {
    const { fetchImpl } = makeStubFetch(() => ({ message_id: 1 }));
    let now = 10_000;
    const waits: number[] = [];
    const bot = new TelegramBot({
      token: 't', allowedUsers: [],
      onMessage: async () => undefined,
      fetchImpl,
      nowImpl: () => now,
      sleepImpl: async (ms) => { waits.push(ms); now += ms; },
    });
    const t0 = now;
    await bot.sendMessage(99, 'one');
    const t1 = now;
    await bot.sendMessage(99, 'two');
    const t2 = now;
    expect(t1 - t0).toBe(0);
    expect(t2 - t1).toBeGreaterThanOrEqual(800);
    expect(waits.some(ms => ms >= 800)).toBe(true);
  });

  test('poll loop recognises 409 Conflict distinctly from generic errors', async () => {
    // We can't wait the real 5s conflict backoff inside a unit test,
    // so instead stop the bot IMMEDIATELY after the first 409 lands:
    // the conflict branch checks `if (!this.running) break;` before
    // sleeping, so the loop exits without hitting the timer.
    let got409 = false;
    let bot: TelegramBot;
    const fetchImpl: any = async (url: string) => {
      if (url.endsWith('/getUpdates')) {
        got409 = true;
        bot.stop();
        return { json: async () => ({
          ok: false,
          error_code: 409,
          description: 'Conflict: terminated by other getUpdates',
        }) };
      }
      return { json: async () => ({ ok: true, result: {} }) };
    };
    bot = new TelegramBot({
      token: 't', allowedUsers: [],
      onMessage: async () => undefined,
      fetchImpl,
      ...FAST_TG_OPTS,
    });
    await bot.start();
    expect(got409).toBe(true);
  });

  test('posts placeholder, streamer edits land on the same message', async () => {
    // Simulates an onMessage handler that streams partial text via
    // the streamer before returning the final reply. Each edit call
    // should reach editMessageText with message_id matching the
    // placeholder mid.
    const updates = [
      { update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'hi' } },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 555 };
      return {};
    });
    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async (_ctx, streamer) => {
        streamer?.edit('part 1');
        // Give the coalescing path one tick so the first edit flushes
        // before the gap window locks it out — the throttle's 1100ms
        // default is long relative to the test, so we expect at most
        // one intermediate edit plus the final one.
        await new Promise(r => setTimeout(r, 5));
        streamer?.edit('part 1 + 2');
        return 'final answer';
      },
      fetchImpl,
      ...FAST_TG_OPTS,
    });
    await bot.start();

    const placeholder = calls.find(c => c.url.endsWith('/sendMessage'));
    expect(placeholder?.body.text).toBe('⏳ Working…');
    const edits = calls.filter(c => c.url.endsWith('/editMessageText'));
    expect(edits.length).toBeGreaterThan(0);
    // Every edit points at the placeholder.
    expect(edits.every(e => e.body.message_id === 555)).toBe(true);
    // Final edit carries the final answer.
    const finalEdit = edits[edits.length - 1]!;
    expect(finalEdit.body.text).toBe('final answer');
  });

  test('finalizeReply keeps raw text for telegram fan-out when assistant mentions paths', async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'show raw path' } },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 555 };
      return {};
    });
    bot = new TelegramBot({
      token: 't',
      allowedUsers: [42],
      onMessage: async () => '경로는 /tmp/demotxt 입니다.',
      fetchImpl,
      ...FAST_TG_OPTS,
    });
    await bot.start();

    const edits = calls.filter(c => c.url.endsWith('/editMessageText'));
    const finalEdit = edits[edits.length - 1]!;
    expect(finalEdit.body.text).toBe('경로는 /tmp/demotxt 입니다.');
  });

  test('streamer with HTML markdown: bold converts on final edit', async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'list' } },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 42 };
      return {};
    });
    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async () => '1. **태조**',
      fetchImpl,
      ...FAST_TG_OPTS,
    });
    await bot.start();

    const edits = calls.filter(c => c.url.endsWith('/editMessageText'));
    const finalEdit = edits[edits.length - 1]!;
    // Markdown → HTML conversion applied on the final edit.
    expect(finalEdit.body.text).toBe('1. <b>태조</b>');
    expect(finalEdit.body.parse_mode).toBe('HTML');
  });

  test('publishes slash commands via setMyCommands on start', async () => {
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return []; }
        bot.stop();
        return [];
      }
      return {};
    });
    bot = new TelegramBot({
      token: 't', allowedUsers: [],
      onMessage: async () => undefined,
      fetchImpl,
      ...FAST_TG_OPTS,
      slashCommands: [
        { name: 'ping', description: 'health check', handler: async () => 'pong' },
      ],
      slashContext: { userConfig: baseConfig() },
    });
    await bot.start();
    const setCall = calls.find(c => c.url.endsWith('/setMyCommands'));
    expect(setCall).toBeDefined();
    expect(setCall!.body.commands).toEqual([{ command: 'ping', description: 'health check' }]);
  });

  test('slash command dispatches without placeholder + replies directly', async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '/ping' } },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 500 };
      return {};
    });
    let onMessageCalled = false;
    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async () => { onMessageCalled = true; return 'unused'; },
      fetchImpl,
      ...FAST_TG_OPTS,
      slashCommands: [
        { name: 'ping', description: 'x', handler: async () => 'pong' },
      ],
      slashContext: { userConfig: baseConfig() },
    });
    await bot.start();
    // Slash dispatch short-circuits the LLM path: onMessage never ran.
    expect(onMessageCalled).toBe(false);
    // No placeholder "⏳ Working…" was posted — only the direct reply.
    const sends = calls.filter(c => c.url.endsWith('/sendMessage'));
    expect(sends.length).toBe(1);
    expect(sends[0]!.body.text).toBe('pong');
    // No edits either.
    const edits = calls.filter(c => c.url.endsWith('/editMessageText'));
    expect(edits.length).toBe(0);
  });

  test('/intake slash command dispatches directly through the intake plane', async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '/intake compare two repos' } },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 700 };
      return {};
    });
    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async () => 'unused',
      fetchImpl,
      ...FAST_TG_OPTS,
      slashCommands: defaultTelegramCommands(),
      slashContext: { userConfig: baseConfig() },
    });
    await bot.start();
    const sends = calls.filter(c => c.url.endsWith('/sendMessage'));
    expect(sends.length).toBe(1);
    expect(sends[0]!.body.text).toContain('Intake:');
    expect(sends[0]!.body.text).toContain('/intake decide apply-now');
    const edits = calls.filter(c => c.url.endsWith('/editMessageText'));
    expect(edits.length).toBe(0);
  });

  test('/intake answer shorthand resolves the latest clarify intake in telegram flow', async () => {
    // The default intake archive directory is chosen at module import time, before per-test env isolation.
    setIntakeStoreForTest(createIntakeStore({ archiveDir: join(root, 'intake') }));
    const updates = [
      { update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '/intake ====' } },
      { update_id: 2, message: { message_id: 2, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '/intake answer keep this in backlog' } },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 701 };
      return {};
    });
    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async () => 'unused',
      fetchImpl,
      ...FAST_TG_OPTS,
      slashCommands: defaultTelegramCommands(),
      slashContext: { userConfig: baseConfig() },
    });
    await bot.start();
    const sends = calls.filter(c => c.url.endsWith('/sendMessage'));
    expect(sends.length).toBe(2);
    expect(sends[0]!.body.text).toContain('/intake answer &lt;answer...&gt;');
    expect(sends[1]!.body.text).toContain('backlog-only');
  });

  test('handler error replaces placeholder with Error: line', async () => {
    const updates = [
      { update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'x' } },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 99 };
      return {};
    });
    bot = new TelegramBot({
      token: 't', allowedUsers: [42],
      onMessage: async () => { throw new Error('boom'); },
      fetchImpl,
      ...FAST_TG_OPTS,
    });
    await bot.start();

    // Error surfaces via editMessageText on the placeholder, not a
    // fresh sendMessage — keeps the chat tidy.
    const edits = calls.filter(c => c.url.endsWith('/editMessageText'));
    expect(edits.length).toBe(1);
    expect(edits[0]!.body.text).toBe('Error: boom');
    expect(edits[0]!.body.message_id).toBe(99);
  });
});

describe('botFromConfig end-to-end', () => {
  test('creates session on first telegram message, reuses on second', async () => {
    const cfg = baseConfig();
    const updates1 = [
      { update_id: 1, message: { message_id: 10, from: { id: 42, username: 'alice' }, chat: { id: 42, type: 'private' }, text: 'hi' } },
    ];
    const updates2 = [
      { update_id: 2, message: { message_id: 11, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'again' } },
    ];
    let turn = 0;
    let bot: TelegramBot;
    const { fetchImpl } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (turn === 0) { turn++; return updates1; }
        if (turn === 1) { turn++; return updates2; }
        bot.stop();
        return [];
      }
      return {};
    });

    bot = botFromConfig({
      userConfig: cfg,
      fetchImpl,
      telegramBotOpts: FAST_TG_OPTS,
      runTurnImpl: async () => ({ text: 'ok' }),
    });
    await bot.start();

    // Even if runTurn failed (no real provider), a session should
    // have been created for chat 42.
    const sessions = listSessions({ source: 'telegram' });
    expect(sessions.length).toBe(1);
    expect(sessions[0].tgChatId).toBe(42);
    const found = findTelegramSession(42);
    expect(found?.id).toBe(sessions[0].id);
  });

  test('botFromConfig throws when telegram disabled', () => {
    const cfg = baseConfig();
    cfg.telegram.enabled = false;
    expect(() => botFromConfig({ userConfig: cfg })).toThrow(/disabled/);
  });

  test('botFromConfig throws when bot token missing', () => {
    const cfg = baseConfig();
    cfg.telegram.botToken = undefined;
    expect(() => botFromConfig({ userConfig: cfg })).toThrow(/botToken/);
  });

  test('botFromConfig preserves progressive edit output even when final text is empty', async () => {
    const cfg = baseConfig();
    const updates = [
      { update_id: 1, message: { message_id: 10, from: { id: 42, username: 'alice' }, chat: { id: 42, type: 'private' }, text: 'stream it' } },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 777 };
      return {};
    });

    bot = botFromConfig({
      userConfig: cfg,
      fetchImpl,
      telegramBotOpts: FAST_TG_OPTS,
      runTurnImpl: async ({ onDelta }) => {
        onDelta?.('hello');
        onDelta?.(' world');
        return { text: '' };
      },
    });
    await bot.start();

    const edits = calls.filter(c => c.url.endsWith('/editMessageText'));
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.some(c => c.body.text === 'hello world')).toBe(true);
    expect(edits[edits.length - 1]?.body.text).toBe('hello world');
  });

  test('voice.telegram.dispatch=tui-bridge routes text into the dashboard input', async () => {
    const cfg = baseConfig();
    cfg.voice = {
      stt: {}, tts: {}, vad: {}, chat: {}, discord: {},
      telegram: { dispatch: 'tui-bridge' },
      pwa: {},
    };
    const dictated: string[] = [];
    const restoreHost = setDaemonInputHostForTesting({
      dictateTranscript: async (text: string) => {
        dictated.push(text);
        return true;
      },
    });
    const updates = [
      { update_id: 1, message: { message_id: 10, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'hello from telegram' } },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 777 };
      return {};
    });

    try {
      bot = botFromConfig({
        userConfig: cfg,
        fetchImpl,
        telegramBotOpts: FAST_TG_OPTS,
        runTurnImpl: async () => { throw new Error('should not run'); },
      });
      await bot.start();
    } finally {
      restoreHost();
    }

    expect(dictated).toEqual(['hello from telegram']);
    const edit = calls.find(c => c.url.endsWith('/editMessageText'));
    expect(edit?.body.text).toBe('✓ Routed to the dashboard input.');
  });

  test('voice.telegram.dispatch=tui-bridge transcribes voice then routes transcript into dashboard input', async () => {
    const cfg = baseConfig();
    cfg.voice = {
      stt: {}, tts: {}, vad: {}, chat: {}, discord: {},
      telegram: { dispatch: 'tui-bridge' },
      pwa: {},
    };
    const dictated: string[] = [];
    const restoreHost = setDaemonInputHostForTesting({
      dictateTranscript: async (text: string) => {
        dictated.push(text);
        return true;
      },
    });
    const updates = [
      {
        update_id: 1,
        message: {
          message_id: 10,
          from: { id: 42 },
          chat: { id: 42, type: 'private' },
          voice: { file_id: 'voice_abc', duration: 3, mime_type: 'audio/ogg' },
        },
      },
    ];
    let served = false;
    let bot: TelegramBot;
    const { fetchImpl, calls } = makeStubFetch((call) => {
      if (call.url.endsWith('getUpdates')) {
        if (!served) { served = true; return updates; }
        bot.stop();
        return [];
      }
      if (call.url.endsWith('/getFile')) {
        return { file_id: 'voice_abc', file_path: 'voice/abc.ogg', file_size: 5 };
      }
      if (call.url.endsWith('/sendMessage')) return { message_id: 777 };
      return {};
    });
    const voiceAdapter = {
      available: true,
      unavailableReason: null,
      replyMode: 'text' as const,
      async transcribeOgg() {
        return { transcript: 'voice transcript', language: 'en' };
      },
      async generateReply(text: string) {
        return { text, voiceOgg: null };
      },
    };
    const fetchImplWithVoiceDownload: typeof fetch = (async (url: string, init?: RequestInit) => {
      if (url.includes('/file/bot')) {
        const ab = new ArrayBuffer(5);
        new Uint8Array(ab).set([0x4f, 0x67, 0x67, 0x53, 0x00]);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => ab,
        } as Response;
      }
      return fetchImpl(url, init as any);
    }) as typeof fetch;

    try {
      bot = botFromConfig({
        userConfig: cfg,
        fetchImpl: fetchImplWithVoiceDownload,
        telegramBotOpts: { ...FAST_TG_OPTS, voiceAdapter },
        runTurnImpl: async () => { throw new Error('should not run'); },
      });
      await bot.start();
    } finally {
      restoreHost();
    }

    expect(dictated).toEqual(['voice transcript']);
    const edit = calls.find(c => c.url.endsWith('/editMessageText'));
    expect(edit?.body.text).toBe('✓ Routed to the dashboard input.');
  });

  test('buildTelegramVoiceAdapterFromConfig wires daemon STT/TTS singletons', async () => {
    const cfg = baseConfig();
    cfg.voice = {
      stt: {}, tts: {}, vad: {}, chat: {}, discord: {},
      telegram: { replyMode: 'voice' },
      pwa: {},
    };
    const sttProvider: STTProvider = {
      id: 'openai-whisper',
      async transcribeBatch() {
        return { text: 'voice transcript', language: 'en' };
      },
    };
    const ttsProvider: TTSProvider = {
      id: 'openai-tts',
      format: { sampleRate: 24000, channels: 1, bitsPerSample: 16 },
      async synthesizeBatch(text: string) {
        return {
          pcm: Buffer.from(`pcm:${text}`),
          format: { sampleRate: 24000, channels: 1, bitsPerSample: 16 },
          charCount: text.length,
        };
      },
    };
    const restoreStt = setDaemonSttProviderForTesting(sttProvider);
    const restoreTts = setDaemonTtsProviderForTesting(ttsProvider);
    const oggToPcm16k = async (ogg: Buffer) => Buffer.from(`pcm16:${ogg.toString()}`);
    const pcm24kToOgg = async (pcm: Buffer) => Buffer.from(`ogg:${pcm.toString()}`);
    const codec: TelegramVoiceCodec = {
      oggToPcm16k, pcm24kToOgg,
      inputToPcm16k: oggToPcm16k, pcm24kToOutput: pcm24kToOgg,
    };

    try {
      const adapter = buildTelegramVoiceAdapterFromConfig(cfg, undefined, { codec });
      expect(adapter).toBeDefined();
      expect(adapter?.available).toBe(true);
      const transcript = await adapter!.transcribeOgg(Buffer.from('voice-bytes'));
      expect(transcript.transcript).toBe('voice transcript');
      const reply = await adapter!.generateReply('reply over voice', { fromVoice: true });
      expect(reply.voiceOgg).not.toBeNull();
      expect(reply.voiceOgg?.toString()).toContain('pcm:reply over voice');
    } finally {
      restoreTts();
      restoreStt();
    }
  });
});
