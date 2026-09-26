// Standalone Discord TEST messenger — `elanous discord-test`.
//
// The Discord sibling of `telegram-test-runner.ts`, with ONE structural
// difference (PLAN-multi-surface-pty-shell M4a-0, 실측 2026-07-12):
// Discord's gateway allows CONCURRENT sessions per bot token (unlike
// telegram's getUpdates 409), so the test bot reuses the PRODUCTION
// app/token and isolates by CHANNEL instead — it only processes
// messages in the dedicated `discord.testChannel.channelId` guild text
// channel (e.g. #elanous_test). Everything else is ignored, including
// DMs (those belong to the production daemon's session).
//
// Why it's safe alongside the daemon:
//   - Production's DM-only gate drops ALL guild messages, so the test
//     channel's traffic never reaches production's chat/trigger path.
//   - This runner's channel scope (guildTextChannels + explicit filter)
//     means it never answers DMs or production channels.
//   - ELANOUS_STATE_DIR isolates ALL mutable state (sessions,
//     surface_events, codex-threads) so test turns never pollute prod.
//   - Production config is REUSED read-only (cloned in-memory); the
//     `homeChannel` outbound route is dropped so test-side tooling
//     can't push into production channels.
//
// M4a: onMessage runs the REAL elanous self turn (makeDiscordAgentRunTurn
// — tools + finance + delegate_code_agent + M1 terminal layer), with
// the channel FileSink attached so PtyShellScreenshot PNGs land as
// discord attachments. One session per channel, per runner process.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { getUserConfig, reloadUserConfig, userConfigPath, type UserConfig } from './user-config.js';
import { setElanousConfigDir } from './elanous-config-dir.js';
import { syncTestConfig, isTestConfigStale } from './cli/config-test-sync.js';
import { DiscordBot } from './discord.js';
import { resolveChannelBotToken } from './channel-bot-token.js';
import { debug } from './debug/log.js';

/** Canonical isolated-state dir for the Discord test bot. */
export const DEFAULT_DISCORD_TEST_STATE_DIR = join(homedir(), '.elanous', 'discord-test');

export interface DiscordTestRunnerOpts {
  /** Optional token override; default = `discord.testChannel.botToken`
   *  (full-isolation escape hatch) → `discord.botToken` (same-app). */
  token?: string;
  /** Optional channel override; default = `discord.testChannel.channelId`. */
  channelId?: string;
  stateDir?: string;
  allowedUsers?: string[];
  reset?: boolean;
}

/** Build the isolated test config from the production one. Pure. */
export function buildDiscordTestConfig(prod: UserConfig, token: string, allowedUsers: string[]): UserConfig {
  return {
    ...prod,
    discord: {
      ...prod.discord,
      enabled: true,
      botToken: token,
      allowedUsers,
      // Drop outbound-to-production routes + prod-app slash wiring so
      // the test bot never posts into live channels or re-registers
      // slash commands against the production application.
      homeChannel: undefined,
    },
    // 관측 격리 — 러너 로그는 prod 인스턴스와 구분되는 라벨로 태깅(elanous logs 조회 시 격리).
    logs: { ...prod.logs, instanceName: 'test:discord-runner' },
  };
}

/** Run the standalone Discord test bot until SIGINT. */
export async function runDiscordTestMessenger(opts: DiscordTestRunnerOpts = {}): Promise<void> {
  // ISO-5 (2026-07-13) — telegram-test 동형: state 격리 → config 물질화 사본
  // → config-dir 전환. 전역 getUserConfig 소비자 전부 test-safe. 물질화본의
  // discord 는 off(아웃바운드 차단)지만 토큰/testChannel 필드는 보존되므로
  // 이 러너가 entry 파라미터로만 켠다(buildDiscordTestConfig).
  const stateDirIso = opts.stateDir?.trim() || DEFAULT_DISCORD_TEST_STATE_DIR;
  if (opts.reset) { try { rmSync(stateDirIso, { recursive: true, force: true }); } catch { /* noop */ } }
  mkdirSync(stateDirIso, { recursive: true });
  process.env.ELANOUS_STATE_DIR = stateDirIso;
  if (!existsSync(join(stateDirIso, 'config.json'))) {
    const r = syncTestConfig(stateDirIso);
    console.log(`[discord-test] 운영 config 물질화 → ${r.testConfigPath}`);
  } else if (isTestConfigStale(stateDirIso)) {
    console.error(`[discord-test] ⚠️ 운영 config 가 사본보다 최신 — 'elanous config sync-test --state-dir ${stateDirIso}' 로 갱신 권장`);
  }
  setElanousConfigDir(stateDirIso);
  reloadUserConfig();
  if (!userConfigPath().startsWith(stateDirIso)) {
    throw new Error(`discord-test: config 격리 불변식 위반 (${userConfigPath()} ∉ ${stateDirIso}) — 기동 거부`);
  }

  const prod = getUserConfig(); // = 물질화본 (이하 변수명은 기존 흐름 유지)
  const testChannel = prod.discord.testChannel;
  const channelId = (opts.channelId?.trim()) || testChannel?.channelId || '';
  if (!channelId) {
    throw new Error(
      'discord-test: no channel. Set `discord.testChannel.channelId` in config '
      + '(the dedicated guild text channel, e.g. #elanous_test) or pass --channel.',
    );
  }
  const token = (opts.token?.trim()) || testChannel?.botToken?.trim() || resolveChannelBotToken('discord', prod)?.token.trim() || '';
  if (!token) {
    throw new Error('discord-test: no token. Set `discord.botToken` (same-app default) or `discord.testChannel.botToken`.');
  }

  // Observability — nexus/dashboard 부트와 동일한 해석 (config화
  // 2026-07-12): env `ELANOUS_DEBUG_LEVEL`(one-shot override) > user-config
  // `debug.level` > debug 모듈 기본(trail). M4c 때 env 옵트인으로만
  // 배선돼 이 엔트리포인트만 config 를 무시하던 비대칭 수리. diag 는
  // voice.discord.* hot-path events (STT partial/final, player state,
  // send pipeline) 를 ./log/debug-*.log 에 켠다.
  {
    const dbgCfg = prod.debug;
    const envLevel = process.env.ELANOUS_DEBUG_LEVEL?.trim().toLowerCase();
    const validLevels = ['off', 'trail', 'diag', 'normal', 'verbose', 'detail', 'keytrace'] as const;
    const startLevel = envLevel && (validLevels as readonly string[]).includes(envLevel)
      ? envLevel as typeof validLevels[number]
      : dbgCfg.level;
    debug.setLevel(startLevel);
    debug.setFileEnabled(dbgCfg.file);
  }

  const stateDir = stateDirIso; // 격리는 위(ISO-5 블록)에서 완료 — 이름만 유지

  // Allowlist: --allow > testChannel.allowedUsers > main allowlist.
  const allowedUsers = opts.allowedUsers && opts.allowedUsers.length > 0
    ? opts.allowedUsers
    : (testChannel?.allowedUsers && testChannel.allowedUsers.length > 0
        ? testChannel.allowedUsers
        : prod.discord.allowedUsers);
  const testCfg = buildDiscordTestConfig(prod, token, allowedUsers);

  // Modules that read ELANOUS_STATE_DIR at store-resolution time — import
  // AFTER the env isolation above so the session store lands in the
  // test dir, mirroring telegram-test's lazy-path discipline.
  const { makeDiscordAgentRunTurn } = await import('./discord-agent.js');
  const { buildDiscordSelfOnMessage } = await import('./discord-self-message.js');
  const { buildDiscordVoiceWire } = await import('./discord-voice-wire.js');

  // ⚠️ 관측 통합(제1원칙) — 독립 러너 프로세스는 nexus StoreSink 를 상속 안 함. logs.db sink 를
  // 등록해야 debug.log(category, event, data) 가 logs.db 에 닿아 `elanous logs` 로 조회된다. 안 하면
  // 파일 트레일에만 남아 관측 불가(= 관측 안 한 것). instanceName='test:discord-runner' 로 격리 태깅.
  const { registerStandaloneLogSink } = await import('./domains/standalone-log-sink.js');
  await registerStandaloneLogSink('discord-test');

  const log = (msg: string): void => { console.log(`[discord-test] ${msg}`); };
  // Shared self+interweave handler (M4b) — identical assembly to the
  // production nexus wire; only channelScope + isolated state differ.
  // `getBot` is late-bound: the handler needs the bot (fileSink), the
  // bot needs the handler.
  let botRef: DiscordBot | null = null;
  const runTurnImpl = makeDiscordAgentRunTurn(testCfg);
  // C1 — 위임 턴의 QUESTION을 버튼으로 표면화하는 런타임.
  const { createDiscordQuestionRuntime } = await import('./discord-question-channel.js');
  const questionRuntime = createDiscordQuestionRuntime({ getBot: () => botRef, log });
  const selfOnMessage = buildDiscordSelfOnMessage({
    userConfig: testCfg,
    runTurnImpl,
    getBot: () => botRef,
    // Belt-and-braces channel filter: even a DM (which the production
    // session also receives) is ignored here so the two same-token
    // sessions never double-answer.
    channelScope: channelId,
    questionChannelFor: (ch) => questionRuntime.channelFor(ch),
    log,
  });
  // M4c — voice channel wire (env-gated; inert without
  // ELANOUS_DISCORD_VOICE_CHANNEL). Same runTurnImpl as the text path so
  // voice turns share brains/tools/terminal observation.
  const voiceWire = buildDiscordVoiceWire({
    userConfig: testCfg,
    runTurnImpl,
    getBot: () => botRef,
    log,
  });
  const onMessage: typeof selfOnMessage = async (ctx, streamer) => {
    // Voice commands are scoped like everything else in this runner.
    if (ctx.channelId === channelId) {
      const voiceReply = await voiceWire.dispatchVoiceCommand(ctx);
      if (voiceReply !== null) return voiceReply;
    }
    return selfOnMessage(ctx, streamer);
  };
  // C3 — 네이티브 슬래시: 인터랙션을 텍스트 명령으로 합성해 같은
  // 파이프라인에 흘린다. 등록은 부팅 후 비동기(길드 스코프·즉시 반영).
  const { buildDiscordSlashWire } = await import('./discord-slash-wire.js');
  const slashWire = buildDiscordSlashWire({
    userConfig: testCfg,
    handleMessage: (ctx, streamer) => onMessage(ctx, streamer as never),
    getBot: () => botRef,
    allowedUsers,
    channelScope: channelId,
    log,
  });
  const bot: DiscordBot = new DiscordBot({
    token,
    allowedUsers,
    // Channel scope — pass the test channel through the DM-only gate.
    guildTextChannels: [channelId],
    onMessage,
    log,
    onInteraction: async (raw) => {
      // C1 버튼 탭이 우선(elanous-q: prefix 소비) → 아니면 슬래시 명령.
      if (await questionRuntime.handleComponentInteraction(raw)) return;
      await slashWire.onInteraction(raw);
    },
    ...(voiceWire.voiceTap ? { voiceTap: voiceWire.voiceTap } : {}),
  });
  botRef = bot;

  // §C5c — 디스코드 스트리밍 sink 등록(러너). nexus discord-trigger-bot 동형: 러너는 그 봇을
  // 안 쓰므로 sink 이 없어 chunkProducer(discord-self-message 에 배선됨)가 fan-out 해도 받을
  // 서피스 sink 이 없었다 → 러너에서 디스코드 flip 이 dormant. 이 등록으로 testChannel flip 활성.
  // discord.ts 가 flip 시 옛 streamer 를 억제(§793)하므로 이중 배달 없음. shadow OR streaming.discord.
  try {
    const dcSf = testCfg.sessionFabric;
    if (dcSf?.shadowFanout === true || dcSf?.streaming?.discord === true) {
      const { registerStreamingSink } = await import('./session/session-fanout.js');
      const { createDiscordStreamSink } = await import('./session/streaming/discord-stream-sink.js');
      const { splitForDiscord } = await import('./discord.js');
      const { formatForDiscord } = await import('./discord-markdown.js');
      registerStreamingSink('discord', createDiscordStreamSink(
        {
          send: async (chId, text, o) => {
            const r = await bot.sendMessage(chId, text, { ...(o.suppressEmbeds ? { suppressEmbeds: true } : {}) });
            return { messageId: r?.id ?? '' };
          },
          edit: async (chId, mId, text) => { await bot.editMessage(chId, mId, text); },
        },
        {
          split: (t) => splitForDiscord(formatForDiscord(t)), // 테이블/--- 디스코드 렌더 보정 후 분할
          ...(dcSf?.discord?.streamingMode ? { mode: dcSf.discord.streamingMode } : {}),
          ...(dcSf?.discord?.editGapMs ? { throttleMs: dcSf.discord.editGapMs } : {}),
        },
      ));
      log(`session fan-out: discord STREAMING sink registered (runner·mode=${dcSf?.discord?.streamingMode ?? 'partial'})`);
    }
  } catch (err) { log(`discord streaming sink register failed: ${err instanceof Error ? err.message : String(err)}`); }

  void slashWire.registerCommands().catch((err: unknown) => {
    log(`slash registration failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  void bot.start().catch((err: unknown) => {
    log(`bot.start exited with error: ${err instanceof Error ? err.message : String(err)}`);
  });

  console.log(`[discord-test] 🤖 test session started — SAME app/token as production, scoped to channel ${channelId}`);
  console.log(`[discord-test] isolated state: ${stateDir}`);
  console.log(`[discord-test] allowlist: ${allowedUsers.length ? allowedUsers.join(', ') : '(EMPTY — refuses everyone; pass --allow <id>)'}`);
  console.log(`[discord-test] production daemon is UNTOUCHED (concurrent gateway sessions). Ctrl-C to stop.`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void voiceWire.shutdown().catch(() => { /* best-effort */ });
      try { bot.stop(); } catch { /* noop */ }
      process.off('SIGINT', stop);
      console.log('\n[discord-test] stopped.');
      resolve();
    };
    process.on('SIGINT', stop);
  });
}
