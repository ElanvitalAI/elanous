import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  botCommandDeclarations,
  botCommandsToTelegram,
  createBotCommandDeclarationsForTest,
  type BotCommandDeclaration,
  type BotPersonaSource,
  matchChartIntent,
  defaultKoreanResolver,
  normalizeTicker,
  parseChartArgs,
} from '../src/bots/command-surface.js';
import { TeamMailbox } from '../src/agent-team/mailbox.js';
import { botCommandsToDiscord } from '../src/discord/slash-commands/bots.js';
import { defaultTelegramCommands } from '../src/telegram-commands.js';

/**
 * 지금 «있는» 텔레그램 명령 전수. ⛔ 이 목록은 「이것뿐이어야 한다」가 «아니라»
 * ***「이것들이 사라지면 안 된다」***는 뜻이다 — 더하는 것은 자유고 «지우는» 것만 이 시험이 막는다.
 * (명령을 «의도적으로» 은퇴시키면 이 목록에서 그 줄을 빼는 것이 그 결정의 «기록»이 된다.)
 */
const KNOWN_TELEGRAM_COMMANDS = [
  'help', 'status', 'new', 'clear', 'reset', 'brain', 'ping', 'provider', 'skills', 'skill',
  'digest', 'cc', 'cdx', 'gem', 'cc_clear', 'local', 'attach', 'detach', 'sessions', 'fork',
  'resume', 'intake', 'cancel', 'taste', 'bots', 'bot', 'screen', 'botsay',
] as const;

const BOTS = [
  { personaId: 'assistant', displayName: 'Assistant' },
  { personaId: 'investor', displayName: 'Investor' },
  { personaId: 'newsbot', displayName: 'News Bot' },
] as any;

function testDeclarations(
  personas = BOTS,
  mailbox?: Pick<TeamMailbox, 'send'>,
): readonly BotCommandDeclaration[] {
  return createBotCommandDeclarationsForTest(async () => personas, mailbox);
}

function withTemporaryMailbox(run: (mailbox: TeamMailbox) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'bot-command-surface-'));
  const mailbox = new TeamMailbox(root);
  return run(mailbox).finally(() => rmSync(root, { recursive: true, force: true }));
}

function command(commands: readonly BotCommandDeclaration[], name: string): BotCommandDeclaration {
  const found = commands.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

describe('bot command surface', () => {
  test('one declaration drives Telegram and Discord names and descriptions', () => {
    const telegram = botCommandsToTelegram(botCommandDeclarations);
    const discord = botCommandsToDiscord(botCommandDeclarations);
    expect(telegram.map((entry) => [entry.name, entry.description]))
      .toEqual(discord.map((entry) => [entry.schema.name, entry.schema.description]));
    // ⛔⭐ **정확값으로 걸지 «않는다»** — 41차가 `defaultTelegramCommands()` 에서 이미 밟은 자리다.
    //    ⇒ 이름 «전수»를 ***부분집합***으로 건다: 추가는 통과 · ***삭제만 빨강***.
    //    🩸 42차가 `/chart` 를 더하자 이 줄이 깨졌다 — 그때 「더한 것이 잘못」이 아니라 「자가 낡은 것」이다.
    for (const name of ['bots', 'bot', 'screen', 'routines', 'botsay']) {
      expect(telegram.map((entry) => entry.name)).toContain(name);
    }

    const renamed = [{ ...botCommandDeclarations[0]!, name: 'renamed_bots' }];
    expect(botCommandsToTelegram(renamed)[0]!.name).toBe('renamed_bots');
    expect(botCommandsToDiscord(renamed)[0]!.schema.name).toBe('renamed_bots');
  });

  test('텔레그램 명령이 «줄지 않는다» — 봇 명령이 그 안에 있고 이름이 겹치지 않는다', () => {
    const names = defaultTelegramCommands().map((entry) => entry.name);
    // ⛔ 「같다」가 아니라 「«줄면 안 된다»」로 건다 — 명령을 «더하면» 거짓 빨강이 나기 때문이다.
    //    ⚠️ 그 방향을 «먼저» 물었다: 이 수는 늘어야 옳다(명령이 는다) ⇒ 하한으로 건다.
    // 🩸 4차 리뷰 정정: 수 «하한»만 두면 ***「하나 지우고 하나 더하기」가 상쇄***돼 삭제를 못 잡는다.
    //    ⇒ 이름 «전수»를 부분집합으로 못 박는다 — 이러면 추가는 통과하고 «삭제»만 빨개진다.
    expect(names).toEqual(expect.arrayContaining([...KNOWN_TELEGRAM_COMMANDS]));
    expect(names.length).toBeGreaterThanOrEqual(KNOWN_TELEGRAM_COMMANDS.length);
    // 🆕 이름이 겹치면 디스패치가 «먼저 등록된 것»으로 갈린다 — 수 대신 이것이 진짜 관문이다.
    expect(new Set(names).size).toBe(names.length);
  });

  test('preserves bot list and status responses', async () => {
    const declarations = testDeclarations();
    await expect(command(declarations, 'bots').handler([])).resolves.toContain('assistant — Assistant · 🟢 살아있음');
    await expect(command(declarations, 'bot').handler(['investor'])).resolves.toContain('investor — Investor · 🟢 살아있음');
    const unknown = await command(declarations, 'bot').handler(['missing']);
    expect(unknown).toContain('assistant (Assistant)');
    expect(unknown).toContain('newsbot (News Bot)');
  });

  test('stores botsay in the botlab mailbox and returns its receipt id', async () => {
    await withTemporaryMailbox(async (mailbox) => {
      const declarations = testDeclarations(BOTS, mailbox);
      const before = mailbox.list('botlab', 'newsbot');

      const response = await command(declarations, 'botsay').handler(['newsbot', 'check', 'this']);
      const after = mailbox.list('botlab', 'newsbot');
      const receipt = after.at(-1);

      expect(after).toHaveLength(before.length + 1);
      expect(receipt).toBeDefined();
      expect(receipt!.body).toBe('check this');
      expect(response).toContain(receipt!.id);
    });
  });

  // 🛟 2026-08-27 — abandoned draft #13369 에서 «건져 온» 시험.
  //    📏 구현엔 그 경로가 «있었는데»(command-surface.ts 의 catch) main 에 무는 시험이 «없었다».
  //    ⛔ 저장이 실패했는데 「접수했습니다」로 답하면 사람은 «영영» 모른다.
  test('botsay returns a readable failure when mailbox storage throws', async () => {
    const mailbox: Pick<TeamMailbox, 'send'> = {
      send: () => { throw new Error('disk unavailable'); },
    };
    const response = await command(testDeclarations(BOTS, mailbox), 'botsay')
      .handler(['newsbot', 'check']);
    expect(response).toContain('남기지 못했습니다');
    expect(response).toContain('disk unavailable');
    expect(response).not.toContain('접수했습니다');
  });

  test('rejects unknown bots and empty messages before storing them', async () => {
    await withTemporaryMailbox(async (mailbox) => {
      const declarations = testDeclarations(BOTS, mailbox);

      await expect(command(declarations, 'botsay').handler(['missing', 'check', 'this']))
        .resolves.toBe("⚠️ 봇 'missing'을 찾을 수 없습니다. 있는 봇: assistant (Assistant), investor (Investor), newsbot (News Bot)");
      await expect(command(declarations, 'botsay').handler(['newsbot', ' ', ' ']))
        .resolves.toBe('⚠️ News Bot에게 남길 말을 입력하세요.');
      expect(mailbox.list('botlab', 'newsbot')).toHaveLength(0);
    });
  });

  test('returns a readable empty-registry response', async () => {
    const declarations = testDeclarations([]);
    await expect(command(declarations, 'bots').handler([])).resolves.toBe('봇이 없습니다.');
    await expect(command(declarations, 'bot').handler(['assistant'])).resolves.toBe('봇이 없습니다.');
  });

  test('Discord adapter carries declaration argument schemas', () => {
    const discord = botCommandsToDiscord(testDeclarations());
    expect(discord.find((entry) => entry.schema.name === 'bot')?.schema.options)
      .toEqual([{ name: 'id', description: 'Bot id', type: 3, required: true }]);
    expect(discord.find((entry) => entry.schema.name === 'botsay')?.schema.options)
      .toEqual([
        { name: 'id', description: 'Bot id', type: 3, required: true },
        { name: 'message', description: 'Message for the bot', type: 3, required: true },
      ]);
  });
});

// ⛔⭐ 사람이 채팅에서 «답을 기다리는» 자리다 — 여기서 던지면 사용자는 침묵이나
//    스택 트레이스를 본다. 2026-08-27 실측: 「봇이 없다」는 잘 답했는데
//    ***「레지스트리가 던진다」는 세 명령 전부 그대로 터졌다.***
//    반증: command-surface.ts 의 tryLoadPersonas/loadFailureText 를 지우면 이 절이 fail 한다.
describe('레지스트리가 «던질» 때 — 「없다」와 「못 읽었다」는 다른 답이다', () => {
  const boom: BotPersonaSource = async () => { throw new Error('레지스트리 폭발'); };
  const empty: BotPersonaSource = async () => [];
  // ⛔ 명령마다 «그 명령이 받는» 인자를 준다 — 아무 인자나 주면 이 시험이 재려는 축(레지스트리 실패)이
  //    아니라 «인자 해석 실패»를 재게 된다(2026-09-01: `/screen` 을 더하며 실제로 그렇게 됐다).
  const argsFor = (name: string): readonly string[] =>
    name === 'bots' || name === 'routines' ? [] : name === 'botsay' ? ['assistant', '안녕'] : ['assistant'];
  // ⛔⭐ `/routines` 는 crontab·ssh 를 «묻는다» — 이음매를 안 주면 이 단위 시험이 ***진짜 ssh 를 친다***.
  //    📏 2026-09-01 실측: 실제로 그렇게 됐다(113ms · 161ms). 그래서 «가짜 크론»을 준다.
  const stubCron = async (alias: string | null): Promise<string | null> =>
    alias === null ? '50 7 * * * bun scripts/botlab/bot-routine.ts newsbot' : '';
  const declsWith = (source: BotPersonaSource) =>
    createBotCommandDeclarationsForTest(source, undefined, undefined, undefined, undefined, stubCron);

  test('세 명령이 «전부» 던지지 않고 사람 말로 답한다', async () => {
    for (const d of declsWith(boom)) {
      const out = await d.handler(argsFor(d.name));
      expect(typeof out).toBe('string');
      expect(out).toContain('읽지 못했습니다');
      // ⛔ 「봇이 없다」로 접으면 안 된다 — 처방이 다르다.
      expect(out).not.toBe('봇이 없습니다.');
      // 원인을 «이름으로» 담는다
      expect(out).toContain('레지스트리 폭발');
    }
  });

  test('「비었다」는 여전히 «봇이 없습니다»다 — 두 답이 갈린다', async () => {
    for (const d of declsWith(empty)) {
      // ⛔ `/routines` 는 «예외»다 — 그 답은 crontab 이지 명부가 아니라서 봇이 0대여도 «일정»을 낸다.
      //    ⇒ 그 갈래를 여기서 「똑같이 답해야 한다」로 묶으면 «틀린 계약»을 못 박게 된다.
      if (d.name === 'routines') {
        const out = await d.handler([]);
        expect(out).toContain('봇 일정');
        expect(out).not.toBe('봇이 없습니다.');
        continue;
      }
      expect(await d.handler(argsFor(d.name))).toBe('봇이 없습니다.');
    }
  });
});

describe('🔭⭐⭐ 디스패치 «경계»에 관측이 남는다 — ⛔ 45분을 「이유를 못 봐서」 썼다', () => {
  // 🚨 계기(2026-09-01 · 42차): `/chart` 가 폰에서 무응답인데
  //    `elanous logs … | (chart|slash)` 가 ***0건***이었다. 가설과 반증으로만 좁혀야 했다.
  // 🔑 ***조회에 안 뜨면 관측 db 문제가 아니라 계측 누락이다.***
  const events = (): { category: string; event: string; data?: unknown }[] => captured;
  let captured: { category: string; event: string; data?: unknown }[] = [];

  beforeEach(async () => {
    captured = [];
    const { debug } = await import('../src/debug/log.js');
    spyOn(debug, 'log').mockImplementation(((c: string, e: string, d?: unknown) => {
      captured.push({ category: c, event: e, ...(d === undefined ? {} : { data: d }) });
    }) as never);
  });
  afterEach(() => { mock.restore(); });

  const chartCmd = () => botCommandsToTelegram(botCommandDeclarations).find((c) => c.name === 'chart')!;

  test('⭐ 진입과 이탈을 «둘 다» 남긴다 — 하나만이면 「들어갔는데 안 나왔다」를 못 가른다', async () => {
    await chartCmd().handler([], {} as never, {} as never);
    const names = events().filter((e) => e.category === 'bots.command').map((e) => e.event);
    expect(names).toContain('dispatch-enter');
    expect(names).toContain('dispatch-exit');
  });

  test('⭐ 핸들러 «안»에도 짝이 있다 — 어댑터만이면 「거기까지 왔나」를 못 가른다', async () => {
    await chartCmd().handler([], {} as never, {} as never);
    expect(events().some((e) => e.category === 'bots.chart' && e.event === 'enter')).toBeTrue();
  });

  test('🔑⭐⭐ 「답이 비었다」를 «센다» — ⛔ 빈 답을 «실제로» 만들어 재야 한다', async () => {
    // 🩸 첫 판은 `chartHandler([])` 만 재서 ***replyChars 가 항상 양수라 늘 통과***했다
    //    (자기 리뷰가 GOODHART 로 잡았다). ⇒ 「0이 나오는 경우」를 «만들어» 잰다.
    const empty = botCommandsToTelegram([{
      name: 'empty', description: 'x', arguments: [],
      handler: async () => '',
    }])[0]!;
    await empty.handler([], {} as never, {} as never);
    const exit0 = events().find((e) => e.event === 'dispatch-exit')!;
    expect((exit0.data as { replyChars: number }).replyChars).toBe(0);
    // ⊕ 대조군 — 답이 «있는» 경우는 양수다(그래야 이 수가 «가른다»).
    captured = [];
    await chartCmd().handler([], {} as never, {} as never);
    const exit1 = events().find((e) => e.event === 'dispatch-exit')!;
    expect((exit1.data as { replyChars: number }).replyChars).toBeGreaterThan(0);
  });

  test('⛔ 던지면 «남기고 다시 던진다» — 삼키면 부르는 쪽의 처리가 바뀐다', async () => {
    const boom = botCommandsToTelegram([{
      name: 'boom', description: 'x', arguments: [],
      handler: async () => { throw new TypeError('터졌다'); },
    }])[0]!;
    await expect(boom.handler([], {} as never, {} as never)).rejects.toThrow('터졌다');
    const threw = events().find((e) => e.event === 'dispatch-threw');
    expect(threw).toBeDefined();
    // ⭐ 진단에 필요한 것은 「무엇이 던졌나」다.
    expect((threw!.data as { errorName: string }).errorName).toBe('TypeError');
    expect((threw!.data as { whyChars: number }).whyChars).toBe('터졌다'.length);
  });

  test('🔒⭐⭐ 예외 «메시지»가 로그로 «안 샌다» — 오류에 사용자 인자가 섞인다', async () => {
    // 🩸 자기 리뷰 must-fix: 첫 판은 `e.message` 를 200자 실었다.
    //    ⛔ 아래 핸들러의 오류에는 ***사용자 인자가 그대로 섞인다***
    //       (예: 「삼성전자」를 못 찾았습니다 · 파일 경로 · URL).
    // 🔑 한 문(dispatch-enter)을 잠그고 다른 문(dispatch-threw)을 열어 두면 잠근 것이 아니다.
    const secret = '내-비밀-검색어-8827';
    const leaky = botCommandsToTelegram([{
      name: 'leaky', description: 'x', arguments: [],
      handler: async (args) => { throw new Error(`「${args[0]}」를 못 찾았습니다`); },
    }])[0]!;
    await expect(leaky.handler([secret], {} as never, {} as never)).rejects.toThrow();
    const serialized = JSON.stringify(events());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('못 찾았습니다');
  });

  test('🖼️ 그림을 «낼 수 있는 표면인가»를 잰다 — /chart 가 사진을 보낼지 가르는 값이다', async () => {
    await chartCmd().handler([], {} as never, { fileSink: { sendImage: () => {} } } as never);
    const enter = events().find((e) => e.event === 'dispatch-enter')!;
    expect((enter.data as { canSendImage: boolean }).canSendImage).toBeTrue();
    captured = [];
    await chartCmd().handler([], {} as never, {} as never);
    const enter2 = events().find((e) => e.event === 'dispatch-enter')!;
    expect((enter2.data as { canSendImage: boolean }).canSendImage).toBeFalse();
  });

  test('⛔ 인자 «내용»은 안 싣는다 — 사람 글이 로그로 샌다', async () => {
    await chartCmd().handler(['삼성전자', '--from', '-6m'], {} as never, {} as never);
    const enter = events().find((e) => e.event === 'dispatch-enter')!;
    expect(JSON.stringify(enter.data)).not.toContain('삼성전자');
    expect((enter.data as { argCount: number }).argCount).toBe(3);
  });
});

describe('🌏⭐⭐ 아는 자산 «별칭» — ⛔ 능력은 있었는데 «부를 이름»이 없었다', () => {
  // 📏 계기(2026-09-01 실측): 차트는 암호화폐·지수·ETF·미국주식을 «전부» 그리는데
  //    「말로」는 한국 상장사만 잡혔다 — DART 표만 봤기 때문이다.
  const nl = (t: string) => matchChartIntent(t, defaultKoreanResolver);

  test('⭐ 흔한 이름이 «실측한» 심볼로 간다', () => {
    expect(nl('비트코인 차트 보여줘')).toBe('/chart BTC-USD.CC');
    expect(nl('코스피 차트')).toBe('/chart ^KS11');
    expect(nl('나스닥 차트 보여줘')).toBe('/chart ^IXIC');
    expect(nl('테슬라 차트')).toBe('/chart TSLA.US');
    expect(nl('금값 차트')).toBe('/chart GC=F');
  });
  test('⭐ 「긴 것부터」 본다 — 다우존스가 다우에 먼저 걸리면 안 된다', () => {
    expect(nl('다우존스 차트')).toBe('/chart ^DJI');
    expect(nl('다우 차트')).toBe('/chart ^DJI');
  });
  test('⛔⭐ 낱말의 «일부»면 안 잡는다 — 경계를 본다', () => {
    // 🔑 「비트」가 「비트맵」에, 「금값」이 아닌 「현금」이 걸리면 사람이 «엉뚱한 차트»를 본다.
    expect(nl('비트맵 차트')).toBeNull();
    expect(nl('현금 차트 보여줘')).toBeNull();
  });
  test('🔑 한국 상장사는 여전히 «표»가 답한다 — 별칭이 그것을 가리지 않는다', () => {
    // ⛔⭐ **표를 «주입»한다** — `defaultKoreanResolver` 는 29MB DART XML(`~/.cache/dart/`)에 매인다.
    //    🩸 첫 판은 그것을 그대로 썼고, ***그 캐시가 «없는» 환경(하니스 게이트)에서 깨졌다***
    //       — `elanous self gate` 가 그것을 `introduced` 로 잡아 줬다.
    //    🔑 ***시험은 「그 기계에 무엇이 있나」에 매이면 안 된다.***
    const fakeTable = (name: string) => (name === '삼성전자' ? '005930' : null);
    expect(matchChartIntent('삼성전자 차트', fakeTable)).toBe('/chart 005930.KO');
    // ⊕ 별칭이 «먼저»여도 표가 답할 자리를 «안 가린다» — 별칭에 없는 이름이니 표로 간다.
    expect(matchChartIntent('테슬라 차트', fakeTable)).toBe('/chart TSLA.US');
  });
  test('⭐ 기간도 같이 읽는다', () => {
    expect(nl('비트코인 6개월 차트 보여줘')).toBe('/chart BTC-USD.CC --from -6m');
  });
  test('⛔ 별칭 심볼이 «정규화»에 안 망가진다 — ^ 와 = 가 살아야 한다', () => {
    for (const sym of ['^KS11', '^IXIC', '^DJI', '^GSPC', 'GC=F', 'BTC-USD.CC', 'ETH-USD.CC']) {
      expect(normalizeTicker(sym)).toBe(sym);
      expect(parseChartArgs([sym]).symbol).toBe(sym);
    }
  });
  test('🩸⛔⭐ «첫 발생»만 보면 놓친다 — 사후 자기 리뷰가 잡았다', () => {
    // 📏 실측: 「btcusd 말고 btc 차트」가 ***안 잡혔다*** —
    //    `btc` 의 «첫» 발생이 `btcusd` 안이라 경계 검사에 걸려 그 키를 «통째로» 버렸다.
    // 🔑 ***한 자리가 「아니다」인 것과 그 낱말이 「없다」는 다른 값이다.***
    expect(nl('btcusd 말고 btc 차트')).toBe('/chart BTC-USD.CC');
    expect(nl('비트맵 말고 비트코인 차트')).toBe('/chart BTC-USD.CC');
    // ⊕ 그래도 경계는 «살아 있다» — 부분문자열만 있으면 여전히 안 잡는다.
    expect(nl('btcusd 차트')).toBeNull();
    expect(nl('비트맵 차트')).toBeNull();
  });

  test('⛔ 표에 «없는» 이름은 안 잡는다 — 지어내지 않는다', () => {
    expect(nl('도지코인 차트')).toBeNull();
    expect(nl('니케이 차트')).toBeNull();
  });
});
