// EN13 — 반증 시험: 출력·debug.log·에러·결과 어디에도 토큰 값이 나오지 않는다. 실물 파일은 임시 HOME 의 가짜뿐.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { BotToken, detectChannelImports, normalizeUsers, parseDotEnv, parseLooseJson, pickPerPlatform, previewLine } from './detect.js';
import { channelImportHint, runChannelImport } from './run.js';

// Distinctive fake values — any appearance (whole or the last 4) is a leak.
const TG_OPENCLAW = '7700112233:AAFAKEopenclawTOKENvalue_zz9Q';
const TG_HERMES = '7700445566:AAFAKEhermesTOKENvalue_yy8W';
const DC_HERMES = 'MTFAKEdiscordTOKEN.hermes.value_xx7E';
const TG_LEGACY = '7700778899:AAFAKElegacyTOKENvalue_ww6R';
const SECRETS = [TG_OPENCLAW, TG_HERMES, DC_HERMES, TG_LEGACY];

const homes: string[] = [];
let debugLines: string[] = [];
let debugSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  debugLines = [];
  debugSpy = spyOn(debug, 'log').mockImplementation(((...args: unknown[]) => { debugLines.push(JSON.stringify(args)); }) as typeof debug.log);
});
afterEach(() => { debugSpy.mockRestore(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'en13-'));
  homes.push(home);
  mkdirSync(join(home, '.openclaw'));
  writeFileSync(join(home, '.openclaw', 'openclaw.json'), `{
    // OpenClaw keeps comments and trailing commas
    "channels": { "telegram": { "botToken": "${TG_OPENCLAW}", "allowFrom": ["tg:1111", 2222, "@someone", "*",], }, },
  }`);
  mkdirSync(join(home, '.hermes'));
  writeFileSync(join(home, '.hermes', '.env'), `# hermes\nTELEGRAM_BOT_TOKEN="${TG_HERMES}"\nTELEGRAM_ALLOWED_USERS=3333,4444\nexport DISCORD_BOT_TOKEN=${DC_HERMES}\nDISCORD_ALLOWED_USERS=123456789012345678\n`);
  return home;
}

function leaks(text: string): string[] {
  return SECRETS.flatMap((secret) => [secret, secret.slice(-4), secret.split(':')[1] ?? secret].filter((part) => text.includes(part)));
}

describe('EN13 channel import — detect · preview · consent · store · check, with zero token exposure', () => {
  test('BotToken never prints itself (String · template · JSON · inspect)', () => {
    const token = new BotToken(TG_OPENCLAW);
    const all = [String(token), `${token}`, JSON.stringify({ token }), Bun.inspect(token), Bun.inspect({ nested: { token } })].join('\n');
    expect(leaks(all)).toEqual([]);
    expect(token.reveal()).toBe(TG_OPENCLAW);
  });

  test('detects OpenClaw and Hermes; first source per platform wins; preview shows only «있음 · 끝 4자리 가림»', () => {
    const home = fakeHome();
    const { candidates, unreadable } = detectChannelImports(home);
    expect(unreadable).toEqual([]);
    expect(candidates.map((c) => `${c.source}:${c.platform}`)).toEqual(['openclaw:telegram', 'hermes:telegram', 'hermes:discord']);
    const { chosen, others } = pickPerPlatform(candidates);
    expect(chosen.map((c) => `${c.source}:${c.platform}`)).toEqual(['openclaw:telegram', 'hermes:discord']);
    expect(others.map((c) => c.source)).toEqual(['hermes']);
    const tg = chosen[0]!;
    expect(tg.allowedUsers).toEqual(['1111', '2222']);
    expect(tg.droppedUsers).toBe(2);
    const preview = chosen.map(previewLine).join('\n');
    expect(preview).toContain('토큰 있음 · 끝 4자리 가림');
    expect(preview).toContain('~/.openclaw/openclaw.json');
    expect(leaks(preview + JSON.stringify(candidates))).toEqual([]);
  });

  test('full run with consent: stores the real value, checks once, and nothing printed/logged/returned carries it', async () => {
    const home = fakeHome();
    const lines: string[] = [];
    const stored: { platform: string; token: string; users?: string[] }[] = [];
    const probes: string[] = [];
    const result = await runChannelImport({
      home,
      out: { log: (s) => lines.push(s), error: (s) => lines.push(`ERR ${s}`) },
      ask: async (q) => { lines.push(q); return true; },
      currentToken: () => null,
      store: async (platform, token, users) => { stored.push({ platform, token, ...(users ? { users } : {}) }); },
      probe: async (platform, token) => { probes.push(platform); return token === TG_OPENCLAW ? { ok: true, botName: 'fake_bot' } : { ok: false }; },
    });
    expect(stored).toEqual([
      { platform: 'telegram', token: TG_OPENCLAW, users: ['1111', '2222'] },
      { platform: 'discord', token: DC_HERMES, users: ['123456789012345678'] },
    ]);
    expect(probes).toEqual(['telegram', 'discord']);
    expect(result.exitCode).toBe(0);
    const screen = lines.join('\n');
    expect(screen).toContain('@fake_bot');
    expect(screen).toContain('연결 확인에 실패');
    expect(leaks(screen)).toEqual([]);
    expect(leaks(debugLines.join('\n'))).toEqual([]);
    expect(debugLines.some((l) => l.includes('channel-import') && l.includes('stored'))).toBe(true);
    expect(leaks(JSON.stringify(result))).toEqual([]);
  });

  test('a store failure and a throwing probe whose message carries the token still leak nothing', async () => {
    const home = fakeHome();
    const lines: string[] = [];
    const result = await runChannelImport({
      home, yes: true,
      out: { log: (s) => lines.push(s), error: (s) => lines.push(`ERR ${s}`) },
      currentToken: () => null,
      store: async (platform, token) => { if (platform === 'discord') throw new Error(`write failed for ${token}`); },
      probe: async (_p, token) => { throw new Error(`fetch https://api.telegram.org/bot${token}/getMe failed`); },
    });
    expect(result.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('✗ 디스코드: 저장하지 못했습니다');
    expect(leaks(lines.join('\n') + debugLines.join('\n') + JSON.stringify(result))).toEqual([]);
  });

  test('no consent → nothing stored; same token already in use → not asked again', async () => {
    const home = fakeHome();
    let stores = 0;
    const lines: string[] = [];
    await runChannelImport({ home, out: { log: (s) => lines.push(s), error: (s) => lines.push(s) }, currentToken: () => null, store: async () => { stores++; } });
    expect(stores).toBe(0);
    expect(lines.join('\n')).toContain('elanous nexus channel-bot import --yes');
    const asked: string[] = [];
    await runChannelImport({ home, out: { log: () => {}, error: () => {} }, ask: async (q) => { asked.push(q); return true; },
      currentToken: (p) => (p === 'telegram' ? TG_OPENCLAW : DC_HERMES), store: async () => { stores++; } });
    expect(asked).toEqual([]);
    expect(stores).toBe(0);
  });

  test('previous elanous (~/.monad) is found; a broken file is named, not quoted', () => {
    const home = mkdtempSync(join(tmpdir(), 'en13-'));
    homes.push(home);
    mkdirSync(join(home, '.monad'));
    writeFileSync(join(home, '.monad', 'config.json'), JSON.stringify({ telegram: { botToken: TG_LEGACY, allowedUsers: [5555] } }));
    mkdirSync(join(home, '.openclaw'));
    writeFileSync(join(home, '.openclaw', 'openclaw.json'), `{ "channels": { "telegram": { "botToken": "${TG_OPENCLAW}" ` /* unterminated */);
    const { candidates, unreadable } = detectChannelImports(home);
    expect(candidates.map((c) => c.source)).toEqual(['elanous-legacy']);
    expect(unreadable).toEqual([{ file: '~/.openclaw/openclaw.json', reason: '형식을 읽지 못했습니다' }]);
    expect(leaks(JSON.stringify(unreadable))).toEqual([]);
    expect(channelImportHint(home)).toBe('쓰던 채널 설정 찾음: 텔레그램(이전 엘라누스(~/.monad)) — 가져오려면: elanous nexus channel-bot import');
  });

  test('parsers: loose JSON keeps // inside strings · dotenv quotes and comments · user ids', () => {
    expect(parseLooseJson('{"u":"https://x//y", /* c */ "a":[1,],}')).toEqual({ u: 'https://x//y', a: [1] });
    expect(parseDotEnv('A="x y"\nB=z # note\n# C=1\nexport D=4')).toEqual({ A: 'x y', B: 'z', D: '4' });
    expect(normalizeUsers('telegram', 'tg:1, 2 ,abc')).toEqual({ users: ['1', '2'], dropped: 1 });
    expect(normalizeUsers('discord', ['123456789012345678', 'name'])).toEqual({ users: ['123456789012345678'], dropped: 1 });
  });
});
