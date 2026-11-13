// Standalone Telegram TEST messenger — `elanous telegram-test`.
//
// Runs ONE telegram bot (a SEPARATE test token) as its own process,
// reusing the EXACT same Q&A + HITL + /cc-delegate path the production
// daemon uses (createNexusTelegramTriggerBot + makeTelegramAgentRunTurn).
// The point: iterate on code and verify behavior by restarting THIS small
// process — never the global nexus daemon (which would disrupt the live
// trading bot / autopilot / production channels).
//
// Why it's safe alongside the daemon:
//   - Different bot token ⇒ no getUpdates 409 against production pollers.
//     (⚠️ 단 `nexus run --test` 데몬과는 **같은** 테스트 토큰 — 토큰별 폴링 잠금
//     (`telegram-poll-lock.ts`)이 먼저 잡은 한쪽만 폴링하게 한다.)
//   - ELANOUS_STATE_DIR isolates ALL mutable state (sessions, acp-sessions,
//     surface_events, codex-threads, autopilot) so test turns never pollute prod.
//   - ISO-5 (2026-07-13): config 도 **완전 분기** — 물질화 사본
//     (`<stateDir>/config.json` · sync-test 변환)을 config-dir 로 걸어
//     프로세스 내 **모든** getUserConfig 소비자가 test-safe 를 본다.
//     구방식(운영 config in-memory clone 을 entry 2곳에만 주입)은 턴 내부
//     서브시스템이 전역 getUserConfig 를 부르면 운영 아웃바운드가 노출되고
//     saveUserConfig 가 운영 파일에 닿는 구멍이 있었다 — 은퇴.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { getUserConfig, reloadUserConfig, userConfigPath } from './user-config.js';
import type { UserConfig } from './user-config/types.js';
import { setElanousConfigDir } from './elanous-config-dir.js';
import { syncTestConfig, isTestConfigStale } from './cli/config-test-sync.js';
import { makeTelegramAgentRunTurn } from './telegram-agent.js';
import { createNexusTelegramTriggerBot } from './nexus/api/telegram-trigger-bot.js';

/** Canonical isolated-state dir for the Telegram test bot. Shared so
 *  `session watch --test` (and any other tooling) points at the SAME store
 *  the test bot writes to, without duplicating the path literal. */
export const DEFAULT_TELEGRAM_TEST_STATE_DIR = join(homedir(), '.elanous', 'telegram-test');

/** Only an isolated test runner may redirect Bot API traffic to a loopback fake. */
export function telegramTestApiBase(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('telegram-test: invalid API base URL'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('telegram-test: API base must be a bare loopback HTTP origin');
  }
  return url.origin;
}

export interface TelegramTestRunnerOpts {
  /** Optional override; when omitted the token comes from
   *  `telegram.testChannel.botToken` in the production config. */
  token?: string;
  stateDir?: string;
  allowedUsers?: number[];
  reset?: boolean;
}

/** Build the isolated, token-swapped test config from the production one.
 *  Exported for tests — pure, no side effects. */
export function buildTelegramTestConfig(prod: UserConfig, token: string, allowedUsers: number[]): UserConfig {
  return {
    ...prod,
    telegram: {
      ...prod.telegram,
      enabled: true,
      botToken: token,
      allowedUsers,
      // Drop outbound-to-production routes so the test bot never posts into
      // the live report/home chats.
      reportChannel: undefined,
      channels: undefined,
      homeChannel: undefined,
    },
  };
}

/** Run the standalone test bot until SIGINT. */
export async function runTelegramTestMessenger(opts: TelegramTestRunnerOpts = {}): Promise<void> {
  // Isolate ALL mutable state BEFORE any store/config is touched. The store
  // path functions are lazy (read the env at call time).
  const stateDir = opts.stateDir?.trim() || DEFAULT_TELEGRAM_TEST_STATE_DIR;
  if (opts.reset) { try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* noop */ } }
  mkdirSync(stateDir, { recursive: true });
  process.env.ELANOUS_STATE_DIR = stateDir;

  // ISO-5 — config 완전 분기 (nexus --test 동형): 사본 없으면 물질화, 있으면
  // drift 경고만. 이후 config-dir 전환 + reload 로 전역 getUserConfig 소비자
  // 전부가 test-safe 물질화본을 본다.
  if (!existsSync(join(stateDir, 'config.json'))) {
    const r = syncTestConfig(stateDir);
    console.log(`[telegram-test] 운영 config 물질화 → ${r.testConfigPath} (telegram=${r.telegramMode})`);
  } else if (isTestConfigStale(stateDir)) {
    console.error(`[telegram-test] ⚠️ 운영 config 가 사본보다 최신 — 'elanous config sync-test --state-dir ${stateDir}' 로 갱신 권장`);
  }
  setElanousConfigDir(stateDir);
  reloadUserConfig();
  if (!userConfigPath().startsWith(stateDir)) {
    throw new Error(`telegram-test: config 격리 불변식 위반 (${userConfigPath()} ∉ ${stateDir}) — 기동 거부`);
  }

  // ⚠️ 관측 통합(제1원칙) — 독립 러너 프로세스는 nexus StoreSink 를 상속 안 함. 격리 logs.db
  // 싱크를 등록해야 debug.log(category,event,data) 가 (.elanous-test) logs.db 에 닿아
  // `elanous logs --test` 로 조회된다. 미등록 시 telegram.url-route 등 계측이 파일 트레일에만
  // 남아 관측 불가(= 관측 안 한 것). discord-test-runner 선례 동형. ELANOUS_STATE_DIR 격리 완료 후.
  try {
    const { registerStandaloneLogSink } = await import('./domains/standalone-log-sink.js');
    await registerStandaloneLogSink('telegram-test');
  } catch (e) {
    console.error(`[telegram-test] ⚠️ 로그 싱크 등록 실패(관측 유실 가능): ${e instanceof Error ? e.message : String(e)}`);
  }

  // 물질화본에서 토큰 해석 — sync 변환이 이미 main botToken 을 테스트
  // 토큰으로 스왑했다(testChannel 부재 시 telegram off → 에러 안내).
  const cfg = getUserConfig();
  const token = (opts.token?.trim())
    || (cfg.telegram.enabled ? cfg.telegram.botToken?.trim() : '')
    || '';
  if (!token) {
    throw new Error(
      'telegram-test: no token. Set `telegram.testChannel.botToken` in the '
      + 'production config (elanous config set …) then `elanous config sync-test '
      + `--state-dir ${stateDir}\`, or pass --token.`,
    );
  }
  const botId = token.split(':')[0] || token;

  // Allowlist: --allow > 물질화본 allowlist(sync 가 testChannel 우선 반영).
  const allowedUsers = opts.allowedUsers && opts.allowedUsers.length > 0
    ? opts.allowedUsers
    : cfg.telegram.allowedUsers;
  // entry 파라미터(--token/--allow override 반영) — 전역도 이미 test-safe 라
  // 이중 안전. builder 는 override 적용층으로 유지.
  const testCfg = buildTelegramTestConfig(cfg, token, allowedUsers);
  const apiBase = telegramTestApiBase(process.env.ELANOUS_TELEGRAM_API_BASE);

  // `nexus run --test` 와 같은 테스트 토큰을 쓴다 — 동시에 폴링하면 409 로 메시지를 나눠 먹는다.
  const { acquireTelegramPollLock } = await import('./telegram-poll-lock.js');
  const lock = await acquireTelegramPollLock(token, 'telegram-test');
  if (!lock.ok) {
    throw new Error(
      `telegram-test: 같은 토큰을 다른 프로세스가 폴링 중 (pid=${lock.holder?.pid ?? '?'} ${lock.holder?.label ?? ''}) — 그쪽을 멈추고 다시 띄운다`,
    );
  }

  const handle = createNexusTelegramTriggerBot({
    token,
    ...(apiBase ? { apiBase } : {}),
    allowedUsers,
    // No workflow-runtime triggers in test mode — pure inbound Q&A/agent.
    dispatch: async () => undefined,
    userConfig: testCfg,
    runTurnImpl: makeTelegramAgentRunTurn(testCfg),
  });
  if (!handle) { lock.release(); throw new Error('telegram-test: bot failed to start (empty token?)'); }

  console.log(`[telegram-test] 🤖 test bot ${botId} started — full Q&A · HITL · /cc·/cdx delegate path`);
  console.log(`[telegram-test] isolated state: ${stateDir}`);
  console.log(`[telegram-test] allowlist: ${allowedUsers.length ? allowedUsers.join(', ') : '(EMPTY — refuses everyone; pass --allow <id>)'}`);
  console.log(`[telegram-test] production daemon is UNTOUCHED. Ctrl-C to stop.`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      try { void handle.stop().finally(lock.release); } catch { lock.release(); }
      process.off('SIGINT', stop);
      console.log('\n[telegram-test] stopped.');
      resolve();
    };
    process.on('SIGINT', stop);
  });
}
