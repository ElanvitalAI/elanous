// NEXUS · channel-bot kind tests (Phase N-2 PR θ)
// Classification: removed — 25ef579f96ef87118fff6e002c6d383d7e0be935
// feat(nexus): delete kind-detail-view + trim 3 kind TabView funcs (U3 · PLAN-nexus-shell-followup) (#2853)
// removed createChannelBotTabView with the TUI detail surface; retain spec, restart,
// external-detection, and runNexus contracts because Bun executes this file directly.

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootNexus,
  drainNexusBoots,
  warmNexusModule,
  NEXUS_DRAIN_TIMEOUT_MS,
  NEXUS_WARM_TIMEOUT_MS,
} from './helpers/nexus-boot-guard.js';
import {
  createChannelBotTabSpec,
  detectExternalChannelBot,
  CHANNEL_BOT_KIND,
  CHANNEL_BOT_HALT_PATTERNS,
  type ChannelBotMeta,
} from '../src/nexus/kinds/channel-bot.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { detectExternalLock } from '../src/nexus/supervisor/external-detect.js';
import { maybeScheduleRestart } from '../src/nexus/supervisor/restart.js';
import type { LockMeta } from '../src/telegram-lock.js';

let tmpRoot: string;
let prevNexus: string | undefined;
let prevTg: string | undefined;
let prevDc: string | undefined;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-n2-bot-'));
  prevNexus = process.env.ELANOUS_NEXUS_DIR;
  prevTg = process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  prevDc = process.env.ELANOUS_DISCORD_BOT_TOKEN;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  delete process.env.ELANOUS_DISCORD_BOT_TOKEN;
});
// 0.2.30 게이트 간섭(OP #9292) — 무거운 nexus import 는 시험 5s 예산 밖에서 데운다.
beforeAll(warmNexusModule, NEXUS_WARM_TIMEOUT_MS);

afterEach(async () => {
  // env 를 되돌리기 «전»에 남은 runNexus 를 끝까지 기다린다 — 시간초과된 시험의 부팅이
  // 다음 시험 폴더의 잠금을 잡지 못하게(TelegramLockError 간섭).
  await drainNexusBoots();
  if (prevNexus === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexus;
  if (prevTg === undefined) delete process.env.ELANOUS_TELEGRAM_BOT_TOKEN;
  else process.env.ELANOUS_TELEGRAM_BOT_TOKEN = prevTg;
  if (prevDc === undefined) delete process.env.ELANOUS_DISCORD_BOT_TOKEN;
  else process.env.ELANOUS_DISCORD_BOT_TOKEN = prevDc;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}, NEXUS_DRAIN_TIMEOUT_MS);

function metaOf(spec: ReturnType<typeof createChannelBotTabSpec>): ChannelBotMeta {
  return spec.meta as unknown as ChannelBotMeta;
}

describe('createChannelBotTabSpec · token detection', () => {
  test('telegram missing token → meta.disabled=true', () => {
    const spec = createChannelBotTabSpec({ platform: 'telegram' });
    const meta = metaOf(spec);
    expect(meta.platform).toBe('telegram');
    expect(meta.tokenEnvName).toBe('ELANOUS_TELEGRAM_BOT_TOKEN');
    expect(meta.disabled).toBe(true);
    expect(meta.disabledReason).toContain('ELANOUS_TELEGRAM_BOT_TOKEN');
  });

  test('telegram token present → disabled=false + token forwarded in env', () => {
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = 'TG-SECRET';
    const spec = createChannelBotTabSpec({ platform: 'telegram' });
    expect(metaOf(spec).disabled).toBe(false);
    expect(spec.spawn?.env).toEqual({ ELANOUS_TELEGRAM_BOT_TOKEN: 'TG-SECRET' });
  });

  test('discord token name + env forwarding', () => {
    process.env.ELANOUS_DISCORD_BOT_TOKEN = 'DC-SECRET';
    const spec = createChannelBotTabSpec({ platform: 'discord' });
    const meta = metaOf(spec);
    expect(meta.platform).toBe('discord');
    expect(meta.tokenEnvName).toBe('ELANOUS_DISCORD_BOT_TOKEN');
    expect(meta.disabled).toBe(false);
    expect(spec.spawn?.env).toEqual({ ELANOUS_DISCORD_BOT_TOKEN: 'DC-SECRET' });
  });

  test('whitespace-only token treated as missing', () => {
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = '   ';
    const spec = createChannelBotTabSpec({ platform: 'telegram' });
    expect(metaOf(spec).disabled).toBe(true);
  });
});

describe('createChannelBotTabSpec · default policy', () => {
  test('telegram defaults', () => {
    const spec = createChannelBotTabSpec({ platform: 'telegram' });
    expect(spec.id).toBe('telegram:1');
    expect(spec.kind).toBe(CHANNEL_BOT_KIND);
    expect(spec.spawn?.command).toContain('telegram');
    expect(spec.spawn?.command).toContain('--gateway-mode');
  });

  test('ipc-ping health every 30s, stale after 90s', () => {
    const spec = createChannelBotTabSpec({ platform: 'telegram' });
    expect(spec.health).toMatchObject({
      kind: 'ipc-ping',
      intervalMs: 30_000,
      timeoutMs: 2_000,
      staleAfterMs: 90_000,
    });
  });

  test('restart [10s,30s,60s] · maxPerHour 10 · grace 3s · halt patterns', () => {
    const spec = createChannelBotTabSpec({ platform: 'telegram' });
    expect(spec.restart).toMatchObject({
      policy: 'on-crash',
      backoffMs: [10_000, 30_000, 60_000],
      maxPerHour: 10,
      graceMs: 3_000,
    });
    expect(spec.restart?.haltPatterns).toEqual([...CHANNEL_BOT_HALT_PATTERNS]);
  });

  test('discord lockPath != telegram lockPath', () => {
    const tg = createChannelBotTabSpec({ platform: 'telegram' });
    const dc = createChannelBotTabSpec({ platform: 'discord' });
    expect(metaOf(tg).lockPath).toContain('telegram.lock');
    expect(metaOf(dc).lockPath).toContain('discord.lock');
  });

  test('opts override id/label/command/cwd/lockPath', () => {
    const spec = createChannelBotTabSpec({
      platform: 'telegram',
      id: 'tg:custom',
      label: 'My Bot',
      command: ['/usr/bin/elanous', 'telegram', '--gateway-mode', '--verbose'],
      cwd: '/srv/bot',
      lockPath: '/tmp/custom-tg.lock',
    });
    expect(spec.id).toBe('tg:custom');
    expect(spec.label).toBe('My Bot');
    expect(spec.spawn?.command[3]).toBe('--verbose');
    expect(spec.spawn?.cwd).toBe('/srv/bot');
    expect(metaOf(spec).lockPath).toBe('/tmp/custom-tg.lock');
  });
});

describe('halt-pattern integration via maybeScheduleRestart', () => {
  test('401 stderr triggers halt outcome', () => {
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = 'tok';
    const state = createNexusState({ nexusVersion: '0.8.0', phase: 'test' });
    const registry = new TabRegistry(state);
    const spec = createChannelBotTabSpec({ platform: 'telegram' });
    registry.register(spec);
    const result = maybeScheduleRestart({
      state, registry, tabId: spec.id,
      lastError: 'Error: 401 Unauthorized from API',
      callbacks: { async stop() {}, async start() {} },
    });
    expect(result.outcome).toBe('halted-pattern');
    expect(result.matchedPattern).toMatch(/401|Unauthorized/);
    expect(registry.get(spec.id)!.status).toBe('crashed');
  });

  test('Invalid token halt', () => {
    process.env.ELANOUS_DISCORD_BOT_TOKEN = 'tok';
    const state = createNexusState({ nexusVersion: '0.8.0', phase: 'test' });
    const registry = new TabRegistry(state);
    const spec = createChannelBotTabSpec({ platform: 'discord' });
    registry.register(spec);
    const result = maybeScheduleRestart({
      state, registry, tabId: spec.id,
      lastError: 'discord.com: Invalid token',
      callbacks: { async stop() {}, async start() {} },
    });
    expect(result.outcome).toBe('halted-pattern');
    expect(result.matchedPattern).toBe('Invalid token');
  });

  test('non-auth crash goes through backoff (10s)', () => {
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = 'tok';
    const state = createNexusState({ nexusVersion: '0.8.0', phase: 'test' });
    const registry = new TabRegistry(state);
    const spec = createChannelBotTabSpec({ platform: 'telegram' });
    registry.register(spec);
    const result = maybeScheduleRestart({
      state, registry, tabId: spec.id,
      lastError: 'network timeout',
      callbacks: { async stop() {}, async start() {} },
      random: () => 0,
    });
    expect(result.outcome).toBe('scheduled');
    expect(result.delayMs).toBe(10_000);
    result.cancel?.();
  });
});

describe('detectExternalLock + detectExternalChannelBot', () => {
  test('generic helper · alive external pid → status=external', () => {
    const state = createNexusState({ nexusVersion: '0.8.0', phase: 'test' });
    const registry = new TabRegistry(state);
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = 'tok';
    const spec = createChannelBotTabSpec({ platform: 'telegram' });
    registry.register(spec);
    const meta: LockMeta = {
      pid: 33333, host: 'h', startedAt: new Date().toISOString(), label: 'tg',
    };
    const result = detectExternalLock({
      state, registry, tabId: spec.id,
      lockPath: metaOf(spec).lockPath,
      readLock: () => meta,
      isAlive: () => true,
      reasonLabel: 'external-telegram',
    });
    expect(result.outcome).toBe('external');
    expect(result.externalPid).toBe(33333);
    expect(registry.get(spec.id)!.status).toBe('external');
    expect(state.events.find((e) => e.detail?.reason === 'external-telegram')).toBeDefined();
  });

  test('detectExternalChannelBot wraps the helper using spec meta', () => {
    const state = createNexusState({ nexusVersion: '0.8.0', phase: 'test' });
    const registry = new TabRegistry(state);
    process.env.ELANOUS_DISCORD_BOT_TOKEN = 'tok';
    const spec = createChannelBotTabSpec({ platform: 'discord' });
    registry.register(spec);
    const meta: LockMeta = { pid: 44444, host: 'h', startedAt: new Date().toISOString(), label: 'dc' };
    const result = detectExternalChannelBot({
      state, registry, tabId: spec.id,
      readLockOverride: () => meta,
      isAliveOverride: () => true,
    });
    expect(result.outcome).toBe('external');
    expect(registry.get(spec.id)!.status).toBe('external');
  });

  test('no lock → outcome=available', () => {
    const state = createNexusState({ nexusVersion: '0.8.0', phase: 'test' });
    const registry = new TabRegistry(state);
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = 'tok';
    const spec = createChannelBotTabSpec({ platform: 'telegram' });
    registry.register(spec);
    const result = detectExternalChannelBot({
      state, registry, tabId: spec.id,
      readLockOverride: () => null,
    });
    expect(result.outcome).toBe('available');
  });

  test('previously-external cleared when lock dies', () => {
    const state = createNexusState({ nexusVersion: '0.8.0', phase: 'test' });
    const registry = new TabRegistry(state);
    process.env.ELANOUS_TELEGRAM_BOT_TOKEN = 'tok';
    const spec = createChannelBotTabSpec({ platform: 'telegram' });
    registry.register(spec);
    registry.patch(spec.id, { status: 'external', pid: 99999 });
    const result = detectExternalChannelBot({
      state, registry, tabId: spec.id,
      readLockOverride: () => null,
    });
    expect(result.outcome).toBe('reclaimed');
    expect(registry.get(spec.id)!.status).toBe('idle');
  });

  test('no-tab when id not registered', () => {
    const state = createNexusState({ nexusVersion: '0.8.0', phase: 'test' });
    const registry = new TabRegistry(state);
    const result = detectExternalChannelBot({
      state, registry, tabId: 'missing',
      readLockOverride: () => null,
    });
    expect(result.outcome).toBe('no-tab');
  });
});

describe('runNexus integration · channel-bot opt-in', () => {
  test('default off (no enableChannelBots) → no telegram tab', async () => {
    const handle = await bootNexus({ detachForTesting: true });
    expect(handle!.registry.has('telegram:1')).toBe(false);
    expect(handle!.registry.has('discord:1')).toBe(false);
    handle!.release();
  });

  test('enableChannelBots=[telegram] registers telegram tab', async () => {
    const handle = await bootNexus({
      detachForTesting: true,
      enableChannelBots: ['telegram'],
      autoStartChannelBots: false,
    });
    expect(handle!.registry.has('telegram:1')).toBe(true);
    expect(handle!.registry.has('discord:1')).toBe(false);
    handle!.release();
  });

  test('enableChannelBots=[telegram, discord] registers both', async () => {
    const handle = await bootNexus({
      detachForTesting: true,
      enableChannelBots: ['telegram', 'discord'],
      autoStartChannelBots: false,
    });
    expect(handle!.registry.has('telegram:1')).toBe(true);
    expect(handle!.registry.has('discord:1')).toBe(true);
    handle!.release();
  });
});
