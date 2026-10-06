// M4b — discord self+interweave onMessage handler.
//
// Locks the interweaving contract (텔레그램 동형): explicit /cc·/cdx·/gem
// delegate over ACP and ARM active delegation; plain NL follow-ups
// continue the bound backend; "self로" override / /brain exit return to
// the brain; everything else runs the injected self turn.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as turnRunner from '../src/acp/turn-runner.js';
import { _resetActiveDelegationForTests, delegationChatKey, getActiveDelegation } from '../src/acp/active-delegation.js';
import { buildDiscordSelfOnMessage, parseDiscordAcpCommand } from '../src/discord-self-message.js';
import type { DcIncoming } from '../src/discord.js';
import type { UserConfig } from '../src/user-config.js';
import type { RunTurnResult } from '../src/session/chat.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-self-msg-'));
  process.env.ELANOUS_SESSION_ROOT = join(root, 'sessions');
  _resetActiveDelegationForTests();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.ELANOUS_SESSION_ROOT;
  _resetActiveDelegationForTests();
  mock.restore();
});

function cfg(): UserConfig {
  return {
    llm: { provider: 'grok', model: 'grok-4' },
    acp: { slashMaxTurns: 4 },
    discord: { enabled: true, allowedUsers: [] },
    raw: {},
  } as unknown as UserConfig;
}

function incoming(text: string, channelId = 'CH1'): DcIncoming {
  return {
    channelId, userId: 'u1', userName: 'alice', text,
    messageId: 'm1', isDm: false, attachments: [], raw: {},
  };
}

describe('parseDiscordAcpCommand', () => {
  test('maps /cc·/cdx·/gem·/brain; plain text → null', () => {
    expect(parseDiscordAcpCommand('/cc build X')).toEqual({ kind: 'delegate', backend: 'claude', prompt: 'build X' });
    expect(parseDiscordAcpCommand('/cdx fix Y')).toEqual({ kind: 'delegate', backend: 'codex', prompt: 'fix Y' });
    expect(parseDiscordAcpCommand('/gem review Z')).toEqual({ kind: 'delegate', backend: 'gemini', prompt: 'review Z' });
    expect(parseDiscordAcpCommand('/cc')).toEqual({ kind: 'delegate', backend: 'claude', prompt: '' });
    expect(parseDiscordAcpCommand('/brain')).toEqual({ kind: 'brain' });
    // `!` aliases — the discord client hijacks `/` for its native
    // slash palette, so `!cc` is the friction-free spelling.
    expect(parseDiscordAcpCommand('!cc build X')).toEqual({ kind: 'delegate', backend: 'claude', prompt: 'build X' });
    expect(parseDiscordAcpCommand('!brain')).toEqual({ kind: 'brain' });
    expect(parseDiscordAcpCommand('안녕')).toBeNull();
    expect(parseDiscordAcpCommand('/ccx typo')).toBeNull();
    expect(parseDiscordAcpCommand('!ccx typo')).toBeNull();
  });
});

describe('buildDiscordSelfOnMessage — interweaving', () => {
  function makeHandler(selfReplies: string[]) {
    const selfCalls: Array<{ userText: string; dcChannel?: { channelId: string } }> = [];
    const handler = buildDiscordSelfOnMessage({
      userConfig: cfg(),
      runTurnImpl: (async (opts: { userText: string; dcChannel?: { channelId: string } }) => {
        selfCalls.push({ userText: opts.userText, ...(opts.dcChannel ? { dcChannel: opts.dcChannel } : {}) });
        return { text: selfReplies.shift() ?? 'self-reply' } as RunTurnResult;
      }) as never,
      getBot: () => null,
    });
    return { handler, selfCalls };
  }

  test('/cc delegates via runAcpTurn (carry-in + focus budget) and arms delegation; NL follow-up continues; self로 override exits', async () => {
    const acpCalls: Array<{ backendId: string; promptText: string; chatId: unknown; focusTurns?: number }> = [];
    spyOn(turnRunner, 'runAcpTurn').mockImplementation((async (opts: turnRunner.RunAcpTurnOpts) => {
      acpCalls.push({ backendId: opts.backendId, promptText: opts.promptText, chatId: opts.chatId, ...(opts.focusTurns !== undefined ? { focusTurns: opts.focusTurns } : {}) });
      return { text: 'acp-done', stopReason: 'end_turn' };
    }) as typeof turnRunner.runAcpTurn);
    const { handler, selfCalls } = makeHandler(['brain-reply']);

    // 1) explicit delegation
    const r1 = await handler(incoming('/cc build the thing'));
    expect(acpCalls).toHaveLength(1);
    expect(acpCalls[0]!.backendId).toBe('claude');
    expect(acpCalls[0]!.chatId).toBe('CH1');
    expect(acpCalls[0]!.focusTurns).toBe(4); // cfg.acp.slashMaxTurns
    expect(acpCalls[0]!.promptText).toContain('build the thing');
    expect(String(r1)).toContain('acp-done');
    expect(String(r1)).toContain('acp-claude'); // execution footer
    expect(getActiveDelegation(delegationChatKey('dc', 'CH1'))).toBe('claude');

    // 2) plain NL follow-up continues the SAME backend
    await handler(incoming('그것도 고쳐줘'));
    expect(acpCalls).toHaveLength(2);
    expect(acpCalls[1]!.backendId).toBe('claude');
    expect(acpCalls[1]!.promptText).toContain('그것도 고쳐줘');
    expect(selfCalls).toHaveLength(0); // brain untouched so far

    // 3) explicit self override → clears delegation, routes to the brain
    await handler(incoming('self로 해줘'));
    expect(acpCalls).toHaveLength(2);
    expect(selfCalls).toHaveLength(1);
    expect(getActiveDelegation(delegationChatKey('dc', 'CH1'))).toBeNull();
    // self turn carries the discord arming key (M4b NL-delegate seam)
    expect(selfCalls[0]!.dcChannel).toEqual({ channelId: 'CH1' });
  });

  test('/brain exits delegation; /cc without prompt → usage; ACP error clears delegation', async () => {
    let fail = false;
    spyOn(turnRunner, 'runAcpTurn').mockImplementation((async () => {
      if (fail) throw new Error('backend down');
      return { text: 'ok', stopReason: 'end_turn' };
    }) as typeof turnRunner.runAcpTurn);
    const { handler } = makeHandler([]);

    expect(String(await handler(incoming('/cc')))).toContain('Usage: /cc');

    await handler(incoming('/cdx do it'));
    expect(getActiveDelegation(delegationChatKey('dc', 'CH1'))).toBe('codex');
    expect(String(await handler(incoming('/brain')))).toContain('브레인');
    expect(getActiveDelegation(delegationChatKey('dc', 'CH1'))).toBeNull();

    await handler(incoming('/cdx again'));
    fail = true;
    const r = await handler(incoming('계속 해줘')); // continue fails
    expect(String(r)).toContain('backend down');
    expect(getActiveDelegation(delegationChatKey('dc', 'CH1'))).toBeNull(); // not trapped
  });

  test('TUI-only slash replies once without a self turn; supported slash and system grade stay private', async () => {
    const { handler, selfCalls } = makeHandler(['normal']);
    expect(await handler(incoming('/model'))).toBe('/model은(는) 디스코드에서 아직 지원되지 않습니다. TUI에서 /model을(를) 사용하세요.');
    expect(await handler(incoming('/run-skill something'))).toBe('/run-skill은(는) 디스코드에서 아직 지원되지 않습니다. TUI에서 /run-skill을(를) 사용하세요.');
    expect(selfCalls).toHaveLength(0);
    expect(await handler(incoming('/brain'))).toContain('브레인');
    expect(await handler(incoming('/mystery'))).toBe('normal');
    expect(selfCalls.map(({ userText }) => userText)).toEqual(['/mystery']);
  });

  test('injected system grade does not reveal a TUI-only command on the Discord message path', async () => {
    const selfCalls: string[] = [];
    const handler = buildDiscordSelfOnMessage({
      userConfig: cfg(),
      runTurnImpl: (async (opts: { userText: string }) => {
        selfCalls.push(opts.userText);
        return { text: 'ordinary self reply' } as RunTurnResult;
      }) as never,
      getBot: () => null,
      tuiSlashAvailability: [{ name: 'model', maturity: 'system', telegram: false, discord: false }],
    });

    expect(await handler(incoming('/model'))).toBe('ordinary self reply');
    expect(await handler(incoming('/mystery'))).toBe('ordinary self reply');
    expect(selfCalls).toEqual(['/model', '/mystery']);
  });

  test('channelScope filters other channels; /voice-* stays silent', async () => {
    const { handler: scoped, selfCalls } = (() => {
      const selfCalls: Array<{ userText: string }> = [];
      const handler = buildDiscordSelfOnMessage({
        userConfig: cfg(),
        runTurnImpl: (async (opts: { userText: string }) => {
          selfCalls.push({ userText: opts.userText });
          return { text: 'ok' } as RunTurnResult;
        }) as never,
        getBot: () => null,
        channelScope: 'ONLY',
      });
      return { handler, selfCalls };
    })();
    expect(await scoped(incoming('hi', 'OTHER'))).toBeUndefined();
    expect(await scoped(incoming('/voice-join', 'ONLY'))).toBeUndefined();
    await scoped(incoming('hi', 'ONLY'));
    expect(selfCalls).toEqual([{ userText: 'hi' }]);
  });
});

describe('S1 — persistent channel→session binding + session commands', () => {
  function makeSessionHandler() {
    const turns: Array<{ sessionId: string; userText: string }> = [];
    const handler = buildDiscordSelfOnMessage({
      userConfig: cfg(),
      runTurnImpl: (async (opts: { sessionId: string; userText: string }) => {
        turns.push({ sessionId: opts.sessionId, userText: opts.userText });
        return { text: 'ok' } as RunTurnResult;
      }) as never,
      getBot: () => null,
    });
    return { handler, turns };
  }

  test('binding survives a "restart" — a rebuilt handler reuses the same session', async () => {
    const a = makeSessionHandler();
    await a.handler(incoming('첫 메시지'));
    expect(a.turns).toHaveLength(1);
    const firstSession = a.turns[0]!.sessionId;
    // Simulate process restart: brand-new handler, empty in-memory map.
    const b = makeSessionHandler();
    await b.handler(incoming('재시작 후 메시지'));
    expect(b.turns[0]!.sessionId).toBe(firstSession);
  });

  test('!new unbinds (transcript preserved) and next message mints a fresh session', async () => {
    const { handler, turns } = makeSessionHandler();
    await handler(incoming('hello'));
    const oldSession = turns[0]!.sessionId;
    const reply = await handler(incoming('!new'));
    expect(String(reply)).toContain('새 세션');
    expect(String(reply)).toContain(oldSession.slice(0, 8));
    await handler(incoming('fresh start'));
    expect(turns[1]!.sessionId).not.toBe(oldSession);
    // Old transcript still loadable (unbind ≠ delete).
    const { loadSession } = await import('../src/session/index.js');
    expect(loadSession(oldSession)).not.toBeNull();
  });

  test('!attach rebinds the channel to an existing session by prefix', async () => {
    const { handler, turns } = makeSessionHandler();
    await handler(incoming('메시지 in CH1'));
    const ch1Session = turns[0]!.sessionId;
    // Different channel gets its own session…
    await handler(incoming('메시지 in CH2', 'CH2'));
    expect(turns[1]!.sessionId).not.toBe(ch1Session);
    // CH2 must release the binding before CH1's session can attach —
    // conflict path first:
    const conflict = await handler(incoming(`!attach ${turns[1]!.sessionId.slice(0, 8)}`));
    expect(String(conflict)).toContain('연결했습니다'); // CH1 rebinds to CH2's session? No — CH1 attaches to prefix of CH2's session id
    // After the attach above, CH1 and CH2 would share… assert actual state:
    await handler(incoming('after attach'));
    expect(turns[2]!.sessionId).toBe(turns[1]!.sessionId);
  });

  test('!sessions lists bound sessions and marks the current channel', async () => {
    const { handler } = makeSessionHandler();
    await handler(incoming('시작'));
    const reply = await handler(incoming('!sessions'));
    expect(String(reply)).toContain('바인딩된 세션');
    expect(String(reply)).toContain('▸');
    expect(String(reply)).toContain('dc:');
  });
});

describe('S2 — !fork command', () => {
  test('!fork forks the channel session, rebinds, and old session stays intact', async () => {
    const turns: Array<{ sessionId: string; userText: string }> = [];
    const handler = buildDiscordSelfOnMessage({
      userConfig: cfg(),
      runTurnImpl: (async (opts: { sessionId: string; userText: string }) => {
        turns.push({ sessionId: opts.sessionId, userText: opts.userText });
        return { text: 'ok' } as RunTurnResult;
      }) as never,
      getBot: () => null,
    });
    await handler(incoming('원본 첫 턴'));
    const original = turns[0]!.sessionId;
    const reply = await handler(incoming('!fork'));
    expect(String(reply)).toContain('⑂');
    expect(String(reply)).toContain(original.slice(0, 8));
    // Next turn runs on the FORK, not the original.
    await handler(incoming('포크 후 턴'));
    const forked = turns[1]!.sessionId;
    expect(forked).not.toBe(original);
    const { loadSession } = await import('../src/session/index.js');
    expect(loadSession(forked)!.meta.forkedFromId).toBe(original);
    // Original transcript untouched by the fork-side turn.
    const originalMsgs = loadSession(original)!.messages.length;
    await handler(incoming('포크에서 한 턴 더'));
    expect(loadSession(original)!.messages.length).toBe(originalMsgs);
  });
});

describe('S3 — !fork before:N', () => {
  test('!fork before:2 rebinds to a time-traveled fork', async () => {
    const turns: Array<{ sessionId: string }> = [];
    const handler = buildDiscordSelfOnMessage({
      userConfig: cfg(),
      runTurnImpl: (async (opts: { sessionId: string }) => {
        turns.push({ sessionId: opts.sessionId });
        return { text: 'ok' } as RunTurnResult;
      }) as never,
      getBot: () => null,
    });
    await handler(incoming('바인딩 시드'));
    const original = turns[0]!.sessionId;
    // The fake runTurnImpl does not persist turns — seed the JSONL
    // directly so the time-travel boundary has real user rows.
    const { appendMessage, loadSession } = await import('../src/session/index.js');
    const ts = new Date().toISOString();
    appendMessage(original, { role: 'user', content: 'Q1', ts });
    appendMessage(original, { role: 'assistant', content: 'A1', ts });
    appendMessage(original, { role: 'user', content: 'Q2', ts });
    const reply = await handler(incoming('!fork before:2'));
    expect(String(reply)).toContain('⑂');
    await handler(incoming('갈라진 후'));
    const fork = turns[1]!.sessionId;
    expect(fork).not.toBe(original);
    const forkMsgs = loadSession(fork)!.messages.map((m) => m.content);
    // Fork history = strictly before user turn #2 (Q1+A1 only).
    expect(forkMsgs).toEqual(['Q1', 'A1']);
  });
});

describe('C2 — attachment normalization into ACP turns', () => {
  test('/cc with an image attachment downloads + passes NormalizedAttachment[]', async () => {
    const acpCalls: Array<Record<string, unknown>> = [];
    spyOn(turnRunner, 'runAcpTurn').mockImplementation((async (opts: turnRunner.RunAcpTurnOpts) => {
      acpCalls.push(opts as unknown as Record<string, unknown>);
      return { text: 'acp-done', stopReason: 'end_turn' };
    }) as typeof turnRunner.runAcpTurn);
    const downloads: string[] = [];
    const fakeBot = {
      downloadAttachment: async (a: { filename: string }) => {
        downloads.push(a.filename);
        return { localPath: `/tmp/fake/${a.filename}`, fileName: a.filename };
      },
    };
    const handler = buildDiscordSelfOnMessage({
      userConfig: cfg(),
      runTurnImpl: (async () => ({ text: 'x' })) as never,
      getBot: () => fakeBot as never,
    });
    const ctx = incoming('!cc 이 스크린샷 봐줘');
    ctx.attachments = [{
      id: 'a1', filename: 'shot.png', size: 1234,
      url: 'https://cdn.discordapp.com/a/shot.png',
      contentType: 'image/png', width: 800, height: 600,
    }];
    await handler(ctx);
    expect(downloads).toEqual(['shot.png']);
    const atts = acpCalls[0]!.attachments as Array<Record<string, unknown>>;
    expect(atts).toHaveLength(1);
    expect(atts[0]).toMatchObject({
      name: 'shot.png', kind: 'photo', mimeType: 'image/png',
      localPath: '/tmp/fake/shot.png', width: 800, height: 600, sizeBytes: 1234,
      sourceUrl: 'https://cdn.discordapp.com/a/shot.png',
    });
  });

  test('attachment-only /cc (no prompt text) is allowed', async () => {
    const acpCalls: Array<Record<string, unknown>> = [];
    spyOn(turnRunner, 'runAcpTurn').mockImplementation((async (opts: turnRunner.RunAcpTurnOpts) => {
      acpCalls.push(opts as unknown as Record<string, unknown>);
      return { text: 'ok', stopReason: 'end_turn' };
    }) as typeof turnRunner.runAcpTurn);
    const handler = buildDiscordSelfOnMessage({
      userConfig: cfg(),
      runTurnImpl: (async () => ({ text: 'x' })) as never,
      getBot: () => ({ downloadAttachment: async () => ({ localPath: '/tmp/f.png', fileName: 'f.png' }) }) as never,
    });
    const ctx = incoming('!cc');
    ctx.attachments = [{ id: 'a2', filename: 'f.png', size: 10, url: 'https://x/f.png', contentType: 'image/png' }];
    const reply = await handler(ctx);
    expect(String(reply)).not.toContain('Usage:');
    expect((acpCalls[0]!.attachments as unknown[]).length).toBe(1);
  });

  test('failed downloads are skipped (partial success) without failing the turn', async () => {
    const acpCalls: Array<Record<string, unknown>> = [];
    spyOn(turnRunner, 'runAcpTurn').mockImplementation((async (opts: turnRunner.RunAcpTurnOpts) => {
      acpCalls.push(opts as unknown as Record<string, unknown>);
      return { text: 'ok', stopReason: 'end_turn' };
    }) as typeof turnRunner.runAcpTurn);
    const fakeBot = {
      downloadAttachment: async (a: { filename: string }) => {
        if (a.filename === 'bad.bin') throw new Error('404');
        return { localPath: `/tmp/${a.filename}`, fileName: a.filename };
      },
    };
    const handler = buildDiscordSelfOnMessage({
      userConfig: cfg(),
      runTurnImpl: (async () => ({ text: 'x' })) as never,
      getBot: () => fakeBot as never,
    });
    const ctx = incoming('!cc 검토');
    ctx.attachments = [
      { id: 'b1', filename: 'bad.bin', size: 1, url: 'https://x/bad.bin' },
      { id: 'g1', filename: 'good.pdf', size: 2, url: 'https://x/good.pdf', contentType: 'application/pdf' },
    ];
    const reply = await handler(ctx);
    expect(String(reply)).toContain('acp-claude');
    const atts = acpCalls[0]!.attachments as Array<{ name: string; kind: string }>;
    expect(atts.map((a) => a.name)).toEqual(['good.pdf']);
    expect(atts[0]!.kind).toBe('document');
  });
});

describe('C2+ — recent-attachment adoption (사진 먼저, 명령은 다음 메시지)', () => {
  test('attachment-less !cdx adopts the same user\'s photo from the previous message', async () => {
    const acpCalls: Array<Record<string, unknown>> = [];
    spyOn(turnRunner, 'runAcpTurn').mockImplementation((async (opts: turnRunner.RunAcpTurnOpts) => {
      acpCalls.push(opts as unknown as Record<string, unknown>);
      return { text: 'ok', stopReason: 'end_turn' };
    }) as typeof turnRunner.runAcpTurn);
    const fakeBot = {
      downloadAttachment: async (a: { filename: string }) => ({ localPath: `/tmp/${a.filename}`, fileName: a.filename }),
    };
    const selfCalls: string[] = [];
    const handler = buildDiscordSelfOnMessage({
      userConfig: cfg(),
      runTurnImpl: (async (o: { userText: string }) => { selfCalls.push(o.userText); return { text: 'self' }; }) as never,
      getBot: () => fakeBot as never,
    });
    // 1) 사진만 올린 메시지 (self 턴으로 흐름 — 첨부 기억됨)
    const photoMsg = incoming('졸업식 사진이에요');
    photoMsg.attachments = [{ id: 'p1', filename: 'grad.png', size: 5, url: 'https://x/grad.png', contentType: 'image/png' }];
    await handler(photoMsg);
    // 2) 첨부 없는 !cdx — 직전 첨부 채택
    await handler(incoming('!cdx 이 이미지가 무엇인가요?'));
    const atts = acpCalls[0]!.attachments as Array<{ name: string }>;
    expect(atts.map((a) => a.name)).toEqual(['grad.png']);
    // 3) 다른 사용자의 명령은 채택 안 함
    const other = incoming('!cdx 나도 볼래');
    other.userId = 'u2';
    await handler(other);
    expect(acpCalls[1]!.attachments).toBeUndefined();
  });
});
