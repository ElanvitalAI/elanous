// `elanous telegram run` — 넥서스 «밖»의 정식 텔레그램 Q&A 폴러.
//
// 넥서스와 «같은» 경로(`wireNexusTelegramQaPollers` → `createNexusTelegramTriggerBot` ⊕
// `makeTelegramAgentRunTurn`)를 따로 떠 있는 프로세스로 돌린다 — 봇 코드를 고쳐도 넥서스를
// 재시작하지 않게 하는 첫 조각(RFC-nexus-restart-minimization §R2).
//
// - `telegram-test` 와 달리 격리하지 않는다: 실행 우주의 config·토큰을 그대로 쓴다.
// - 토큰마다 폴링 잠금을 잡은 «뒤에만» 띄운다(`telegram-poll-lock.ts`). 넥서스가 폴링 중이면
//   그 토큰은 «뒤로 미루고» 15초마다 다시 잡으러 간다(`retryingAcquire`) — 🩸 2026-09-25: 종전엔 포기했다.
//   운영 봇이 둘인데 전환 순간 넥서스가 잠금을 하나씩 놓으면 러너가 하나만 잡고 나머지는 «영영» 안 폴링됐다.
// - 워크플로 트리거는 core 의 `POST /v1/workflows/telegram-dispatch` 로 넘긴다(`telegram-dispatch-forward.ts`).

import { debug } from './debug/log.js';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { effectiveInstanceRoot } from './instance/resolve.js';
import { getUserConfig } from './user-config.js';
import { resolveChannelBotToken } from './channel-bot-token.js';
import { forwardTelegramDispatch } from './telegram-dispatch-forward.js';
import { mergeCapturedPath, warmCapturedEnv } from './shell-env-bootstrap.js';
import type { NexusTelegramQaPollerWireHandle } from './nexus/index.js';

export interface TelegramRunResult {
  started: NexusTelegramQaPollerWireHandle[];
  refusedBotIds: string[];
  /** 처음엔 못 잡았다가 «나중에» 잡아 띄운 폴러(멈출 때 같이 멈춘다). */
  late: NexusTelegramQaPollerWireHandle[];
}

let stopping = false;

/** 잠금을 잡을 때까지(또는 멈출 때까지) 되풀이한다 — 한 번의 시도는 `acquireOnce`(최대 30초 대기)가 한다. */
export async function retryingAcquire<T extends { ok: boolean }>(
  acquireOnce: () => Promise<T>,
  opts: { sleep?: (ms: number) => Promise<void>; isStopping?: () => boolean; intervalMs?: number; onRetry?: (attempt: number) => void } = {},
): Promise<T | { ok: false }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isStopping = opts.isStopping ?? (() => stopping);
  for (let attempt = 1; ; attempt++) {
    if (isStopping()) return { ok: false };
    const r = await acquireOnce();
    if (r.ok) return r;
    opts.onRetry?.(attempt);
    await sleep(opts.intervalMs ?? 15_000);
  }
}

let pollLockForTesting: {
  acquire: typeof import('./telegram-poll-lock.js').acquireTelegramPollLock;
  retry: typeof retryingAcquire;
} | undefined;

export function setTelegramPollLockForTesting(deps: typeof pollLockForTesting): () => void {
  const previous = pollLockForTesting;
  pollLockForTesting = deps;
  return () => { pollLockForTesting = previous; };
}

/** 폴러를 띄우고 핸들을 돌려준다(시험용으로 분리 — 대기는 `runTelegramPoller` 가 한다). */
export async function startTelegramPollers(): Promise<TelegramRunResult> {
  const cfg = getUserConfig();
  if (cfg.telegram.enabled === false) throw new Error('telegram run: telegram.enabled 가 꺼져 있다');
  const resolved = resolveChannelBotToken('telegram', cfg);
  if (!resolved.token) throw new Error(`telegram run: bot token 못 풂 — ${resolved.reason}`);
  const mainToken = resolved.token;
  if (cfg.telegram.poller !== 'standalone') {
    console.warn('[telegram run] ⚠️ telegram.poller 가 standalone 이 아니다 — 넥서스도 같은 토큰을 폴링하려 한다. 토큰 잠금이 먼저 잡은 쪽만 띄운다.');
  }
  const [{ wireNexusTelegramQaPollers }, { makeTelegramAgentRunTurn }, channels, { createNexusTelegramTriggerBot }, lock] = await Promise.all([
    import('./nexus/index.js'),
    import('./telegram-agent.js'),
    import('./domains/telegram-channels.js'),
    import('./nexus/api/telegram-trigger-bot.js'),
    import('./telegram-poll-lock.js'),
  ]);
  // 토큰마다 잠금을 «먼저» 기다려 잡는다(넥서스 재시작 겹침이면 30초 안에 풀린다).
  const tokens = channels.interactivePollerTokens(channels.resolveTelegramChannels({ ...cfg.telegram, botToken: mainToken })).map((c) => c.botToken);
  const held = new Map<string, () => void>();
  const refusedBotIds: string[] = [];
  const late: NexusTelegramQaPollerWireHandle[] = [];
  for (const token of tokens) {
    const r = await (pollLockForTesting?.acquire ?? lock.acquireTelegramPollLock)(token, 'telegram-run');
    if (r.ok) held.set(token, r.release);
    else refusedBotIds.push(lock.telegramBotId(token));
  }
  const started = wireNexusTelegramQaPollers(cfg, {
    dispatchTelegram: (event) => forwardTelegramDispatch(event),
  }, {
    makeTelegramAgentRunTurn,
    resolveTelegramChannels: channels.resolveTelegramChannels,
    interactivePollerTokens: channels.interactivePollerTokens,
    createTriggerBot: createNexusTelegramTriggerBot,
    pollLock: {
      tryAcquire: (token) => {
        const release = held.get(token);
        return release ? { ok: true, release } : { ok: false };
      },
      // 처음에 못 잡은 토큰 — 잡힐 때까지 되풀이한다(넥서스가 놓는 순간 이어받는다).
      acquire: (token) => (pollLockForTesting?.retry ?? retryingAcquire)(() => lock.acquireTelegramPollLock(token, 'telegram-run'), {
        onRetry: (attempt) => { if (attempt === 1 || attempt % 20 === 0) debug.log('telegram.run', 'late-acquire-retry', { botId: lock.telegramBotId(token), attempt }); },
      }),
    },
    onLateStart: (handle) => {
      late.push(handle);
      debug.log('telegram.run', 'late-started', { channel: handle.channel.name, botId: handle.channel.botToken.split(':')[0] });
      console.log(`[telegram run] 채널 '${handle.channel.name}' 폴러 활성 (늦게 잡음 · ${handle.channel.botToken.split(':')[0]})`);
    },
  });
  return { started, refusedBotIds, late };
}

function failurePath(): string { return join(effectiveInstanceRoot(), 'telegram', 'run-failures.json'); }

function failureState(): { count: number; alerted: boolean } {
  const path = failurePath();
  if (!existsSync(path)) return { count: 0, alerted: false };
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || typeof data !== 'object' || !('count' in data) || !Number.isSafeInteger(data.count)
    || (data.count as number) < 0 || ('alerted' in data && typeof data.alerted !== 'boolean')) {
    throw new Error(`invalid telegram run failures at ${path}`);
  }
  return { count: data.count as number, alerted: 'alerted' in data ? data.alerted as boolean : false };
}

function writeFailureState(count: number, alerted: boolean): void {
  const path = failurePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ count, alerted }), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}

/** SIGINT/SIGTERM 까지 돈다. Failure exit policy is tested without a live poller. */
export async function runTelegramPoller(deps: {
  start?: typeof startTelegramPollers;
  alert?: (text: string, kind: string) => boolean;
  wait?: () => Promise<void>;
  registerLogSink?: () => Promise<void>;
  warm?: () => Promise<boolean>;
} = {}): Promise<void> {
  void (deps.warm ?? warmCapturedEnv)().then((ok) => {
    if (ok) mergeCapturedPath();
  }).catch((error) => {
    debug.log('shell.envbootstrap.capture', 'warm-failed', { error: String(error) });
  });
  try {
    if (deps.registerLogSink) await deps.registerLogSink();
    else {
      const { registerStandaloneLogSink } = await import('./domains/standalone-log-sink.js');
      await registerStandaloneLogSink('telegram-run');
    }
  } catch (e) {
    console.error(`[telegram run] ⚠️ 로그 싱크 등록 실패(관측 유실 가능): ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log('[telegram run] 토큰 잠금을 잡는 중 (토큰마다 최대 30초)…');
  let result: TelegramRunResult;
  try {
    if (!deps.start) {
      const [{ registerAllCloudBackends }, { selectBackendFromConfig }] = await Promise.all([
        import('./nexus/config/secrets/register-cloud.js'), import('./nexus/config/secrets/registry.js'),
      ]);
      registerAllCloudBackends();
      selectBackendFromConfig();
    }
    result = await (deps.start ?? startTelegramPollers)();
    if (result.started.length === 0) throw new Error('telegram run: 띄운 폴러가 없다');
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown start failure';
    const previous = failureState();
    const count = previous.count + 1;
    writeFailureState(count, previous.alerted);
    debug.log('telegram.run', 'start-failed', { count, reason });
    if (count >= 3) {
      if (!previous.alerted) {
        try {
          const alert = deps.alert ?? (await import('./domains/outbound-alert.js')).sendOutbound;
          if (!alert(`텔레그램 폴러가 3번 연속 못 떴다 — ${reason}`, 'alert')) {
            throw new Error('telegram run: outbound alert not delivered');
          }
        } catch (alertError) {
          debug.log('telegram.run', 'alert-failed', { count, reason });
          throw alertError;
        }
        writeFailureState(count, true);
        debug.log('telegram.run', 'alerted', { count, reason });
      }
      return;
    }
    throw error;
  }
  const { started, refusedBotIds, late } = result;
  const path = failurePath();
  if (existsSync(path)) unlinkSync(path);
  debug.log('telegram.run', 'started', { pid: process.pid, pollers: started.length, refusedBotIds });
  for (const botId of refusedBotIds) {
    console.warn(`[telegram run] 봇 ${botId}: 다른 프로세스가 폴링 중 — 15초마다 다시 잡으러 간다 (elanous logs --category telegram.run)`);
  }
  for (const { channel } of started) console.log(`[telegram run] 채널 '${channel.name}' 폴러 활성 (${channel.botToken.split(':')[0]})`);
  console.log('[telegram run] Ctrl-C 로 멈춘다.');
  await (deps.wait?.() ?? new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      stopping = true;
      void Promise.all([...started, ...late].map(({ handle }) => handle.stop().catch(() => undefined))).then(() => {
        debug.log('telegram.run', 'stopped', { pid: process.pid });
        resolve();
      });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }));
}
