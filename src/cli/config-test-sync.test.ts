/**
 * config sync-test — 운영→테스트 물질화 동기화 계약 (ISO-1 · 2026-07-13).
 *
 * 전부 temp 디렉토리 — 실 ~/.elanous 미접촉. 핵심 계약:
 *   1. raw 변환이 buildTestSafeDaemonConfig(overlay 정책 원전)와 의미론 동일
 *   2. 미지 필드 보존 (정규화 저장이 필드를 떨어뜨리는 사고 클래스 회피)
 *   3. 부속 복사는 허용 목록만 — 무장류/푸시 자격은 목록에 없어야 한다
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';

import {
  buildPromotedProdConfig,
  buildTestSafeRawConfig,
  isPromotable,
  isTestConfigStale,
  syncTestConfig,
  TEST_SYNC_AUX_FILES,
  TEST_SYNC_EXCLUDED,
  testSyncExcludedSecretIds,
} from './config-test-sync.js';
import { resolveChannelBotToken } from '../channel-bot-token.js';

const PROD_RAW = {
  telegram: {
    enabled: true,
    botToken: '8799226199:MAIN',
    allowedUsers: [111],
    homeChannel: 111,
    reportChannel: { chatId: 111, botToken: '8755824181:REPORT' },
    testChannel: { botToken: '8724930076:TEST', allowedUsers: [222] },
    chatIdLegacyUnknownField: 999, // 미지 필드 — 보존돼야 함
  },
  discord: { enabled: true, botToken: 'D' },
  llm: { provider: 'anthropic' },
  customTopLevel: { keep: true }, // 미지 top-level — 보존
};

describe('buildTestSafeRawConfig — overlay 정책의 raw 물질화', () => {
  it('testChannel 있음 → 토큰 스왑 + 운영 아웃바운드 제거 + discord off', () => {
    const out = buildTestSafeRawConfig(structuredClone(PROD_RAW));
    const tg = out.telegram as Record<string, unknown>;
    expect(tg.botToken).toBe('8724930076:TEST');
    expect(tg.allowedUsers).toEqual([222]);
    expect(tg.reportChannel).toBeUndefined();
    expect(tg.homeChannel).toBeUndefined();
    expect((out.discord as Record<string, unknown>).enabled).toBe(false);
  });

  it('testChannel 없음 → telegram off (그래도 아웃바운드 제거)', () => {
    const raw = structuredClone(PROD_RAW) as Record<string, any>;
    delete raw.telegram.testChannel;
    const out = buildTestSafeRawConfig(raw);
    const tg = out.telegram as Record<string, unknown>;
    expect(tg.enabled).toBe(false);
    expect(tg.reportChannel).toBeUndefined();
  });

  it('JSON 의 `__proto__` 키도 자기 필드로 보존하고 프로토타입을 바꾸지 않는다', () => {
    const raw = JSON.parse('{"telegram":{"enabled":false},"plugin":{"__proto__":{"keep":1},"apiKey":"sk-x"}}');
    const out = buildTestSafeRawConfig(raw);
    const plugin = out.plugin as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(plugin, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(plugin)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(plugin))).toEqual(JSON.parse('{"__proto__":{"keep":1}}'));
    expect(plugin.apiKey).toBeUndefined();
  });

  it('미지 필드 보존 — telegram 내부·top-level 모두', () => {
    const out = buildTestSafeRawConfig(structuredClone(PROD_RAW));
    expect((out.telegram as Record<string, unknown>).chatIdLegacyUnknownField).toBe(999);
    expect(out.customTopLevel).toEqual({ keep: true });
    expect(out.llm).toEqual({ provider: 'anthropic' });
  });

  it('재귀 평문 비밀 제거 · 참조 보존 · 값 없는 경로 로그 · 원본 불변', () => {
    const raw = {
      ...structuredClone(PROD_RAW),
      llm: { apiKey: 'PROD-LLM-KEY', rotation: [{ apiKey: 'PROD-ROTATION-KEY' }],
        password: 'secret://llm/password', clientSecretRef: 'secret://llm/client' },
      tabs: { 'discord:1': { tokenRef: 'secret://discord/bot', token: 'secret://discord/token' } },
      customTopLevel: { keep: true, nested: [{ accessToken: 'PROD-ACCESS-TOKEN', refreshToken: 'PROD-REFRESH-TOKEN', secretRef: 'reference' }] },
    };
    const original = structuredClone(raw);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const out = buildTestSafeRawConfig(raw);
      const json = JSON.stringify(out);
      for (const value of ['PROD-LLM-KEY', 'PROD-ROTATION-KEY', 'D', 'PROD-ACCESS-TOKEN', 'PROD-REFRESH-TOKEN', '8799226199:MAIN']) {
        expect(json).not.toContain(`"${value}"`);
      }
      expect(out.llm).toEqual({ rotation: [{}], password: 'secret://llm/password', clientSecretRef: 'secret://llm/client' });
      // 채널 탭의 봇 토큰 참조는 뺀다(격리 우주에 운영 봇이 가지 않게) — 다른 참조 칸은 그대로
      expect(out.tabs).toEqual({ 'discord:1': { token: 'secret://discord/token' } });
      expect(out.customTopLevel).toEqual({ keep: true, nested: [{ secretRef: 'reference' }] });
      expect((out.telegram as any).botToken).toBe('8724930076:TEST');
      expect((out.telegram as any).testChannel.botToken).toBeUndefined();
      expect((out.discord as any).enabled).toBe(false);
      expect(out._testSecretsStripped).toBe(6);
      expect(log).toHaveBeenCalledWith('config.test-sync', 'secrets-stripped', {
        count: 6,
        paths: ['tabs.discord:1.tokenRef', 'discord.botToken', 'llm.apiKey', 'llm.rotation[0].apiKey', 'customTopLevel.nested[0].accessToken', 'customTopLevel.nested[0].refreshToken'],
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain('PROD-LLM-KEY');
      expect(JSON.stringify(log.mock.calls)).not.toContain('PROD-ROTATION-KEY');
      expect(raw).toEqual(original);
    } finally {
      log.mockRestore();
    }
  });

  it('문자열 비밀만 지우며 비문자열·참조 칸과 모든 비밀 키 이름의 참조 값을 보존한다', () => {
    const refs = { tokenRef: 'secret://token', secretRef: 'opaque', apiKeyRef: 'secret://api',
      token: 'secret://token', secret: 'secret://secret', webhookSecret: 'secret://webhook',
      clientSecret: 'secret://client', refreshToken: 'secret://refresh', apiKey: 'secret://api',
      password: 'secret://password', accessToken: 'secret://access', botToken: 'secret://bot' };
    const out = buildTestSafeRawConfig({ nested: [refs, { token: 42, secret: null, apiKey: true }] });
    expect(out.nested).toEqual([refs, { token: 42, secret: null, apiKey: true }]);
    expect(out._testSecretsStripped).toBe(0);
  });

  it('비밀 칸 없는 사본은 기존 채널 정책·미지 필드 유지, 계수 0', () => {
    const out = buildTestSafeRawConfig({ telegram: { enabled: false, channels: [1], testChannel: { tokenRef: 'secret://test/bot' } },
      discord: { enabled: true }, llm: { provider: 'anthropic' }, extra: { keep: true } });
    expect(out).toEqual({ telegram: { enabled: false, testChannel: { tokenRef: 'secret://test/bot' } },
      discord: { enabled: false }, llm: { provider: 'anthropic' }, extra: { keep: true }, _testSecretsStripped: 0 });
  });

  it('시험 토큰 없으면 운영 telegram.botToken 평문도 제거한다', () => {
    const raw = structuredClone(PROD_RAW) as Record<string, any>;
    delete raw.telegram.testChannel;
    const out = buildTestSafeRawConfig(raw);
    expect((out.telegram as any).botToken).toBeUndefined();
    expect(out._testSecretsStripped).toBe(2); // telegram + discord
  });

  it('원본 불변 (순수 함수)', () => {
    const raw = structuredClone(PROD_RAW);
    buildTestSafeRawConfig(raw);
    expect(raw.telegram.botToken).toBe('8799226199:MAIN');
  });
});

describe('syncTestConfig — 파일 물질화 + 부속 복사', () => {
  function setup(): { dir: string; src: string; testDir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-cfgsync-'));
    const src = join(dir, 'prod');
    const testDir = join(dir, 'repo', '.elanous-test');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'config.json'), JSON.stringify(PROD_RAW));
    writeFileSync(join(src, 'secrets.json'), '{"k":"v"}');
    writeFileSync(join(src, 'apns.p8'), 'PUSH-CRED'); // 제외 대상
    writeFileSync(join(src, 'autopilot.json'), '{"armed":true}'); // 제외 대상
    return { dir, src, testDir };
  }

  it('변환본 저장 + 스탬프 + 허용 부속만 복사 (무장류/푸시 자격 미복사)', () => {
    const { dir, src, testDir } = setup();
    const r = syncTestConfig(testDir, src);
    const saved = JSON.parse(readFileSync(r.testConfigPath, 'utf-8')) as Record<string, any>;
    expect(saved.telegram.botToken).toBe('8724930076:TEST');
    expect(saved.telegram.testChannel.botToken).toBeUndefined();
    expect(saved.discord.botToken).toBeUndefined();
    expect(saved._testSecretsStripped).toBe(1);
    expect(r.testSecretsStripped).toBe(1);
    expect(typeof saved._testSyncedAt).toBe('string');
    expect(r.copied).toEqual(['secrets.json']); // 존재하는 허용 파일만
    expect(r.telegramMode).toBe('test-token');
    // 제외 파일은 test dir 에 절대 없음
    expect(() => readFileSync(join(testDir, 'apns.p8'))).toThrow();
    expect(() => readFileSync(join(testDir, 'autopilot.json'))).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('CLI 사람용 한 줄에 실제 제거 건수를 알리고 비밀 값은 출력하지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-cfgsync-cli-'));
    try {
      mkdirSync(join(dir, '.elanous'), { recursive: true });
      writeFileSync(join(dir, '.elanous', 'config.json'), JSON.stringify({
        ...PROD_RAW, llm: { apiKey: 'PROD-LLM-KEY', rotation: [{ apiKey: 'PROD-ROTATION-KEY' }] },
        tabs: { 'discord:1': { tokenRef: 'secret://discord/bot' } },
      }));
      const testDir = join(dir, 'test');
      const modulePath = join(import.meta.dir, 'config-test-sync.ts');
      const child = Bun.spawnSync(['bun', '-e', `import { runConfigSyncTest } from ${JSON.stringify(modulePath)}; process.exitCode = runConfigSyncTest({ stateDir: ${JSON.stringify(testDir)} });`], {
        env: { ...process.env, HOME: dir }, stdout: 'pipe', stderr: 'pipe',
      });
      expect(child.exitCode).toBe(0);
      const output = child.stdout.toString();
      expect(output).toContain('  discord: off · 비밀 칸 4개 뺌');
      expect(output).not.toContain('PROD-LLM-KEY');
      const saved = JSON.parse(readFileSync(join(testDir, 'config.json'), 'utf-8'));
      expect(saved._testSecretsStripped).toBe(4);
      expect(saved.tabs['discord:1'].tokenRef).toBeUndefined(); // 채널 탭 봇 토큰 참조는 격리 사본에 없다
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 🆕 2026-09-24 — 읽기 전용(0444) 대상이 같은 바이트면 건너뛰고, 목록 뒤 파일(auth.json)까지 복사가 이어진다.
  it('an identical read-only destination is skipped and the files after it are still copied', () => {
    const { dir, src, testDir } = setup();
    writeFileSync(join(src, 'llm-fallback.json'), '{"same":true}');
    writeFileSync(join(src, 'auth.json'), '{"a":1}');
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'llm-fallback.json'), '{"same":true}');
    chmodSync(join(testDir, 'llm-fallback.json'), 0o444);
    const r = syncTestConfig(testDir, src);
    expect(r.skippedIdentical).toEqual(['llm-fallback.json']);
    expect(r.copied).toContain('auth.json');
    expect(readFileSync(join(testDir, 'auth.json'), 'utf-8')).toBe('{"a":1}');
    chmodSync(join(testDir, 'llm-fallback.json'), 0o644);
    rmSync(dir, { recursive: true, force: true });
  });

  it('0444 source creates 0600 ancillary copy, identical sync stays 0600, widened copy is repaired', () => {
    const { dir, src, testDir } = setup();
    try {
      const source = join(src, 'llm-fallback.json');
      const dest = join(testDir, 'llm-fallback.json');
      writeFileSync(source, '{"apiKey":"PRIVATE"}');
      chmodSync(source, 0o444);
      const permission = () => lstatSync(dest).mode & 0o777;
      expect(syncTestConfig(testDir, src).copied).toContain('llm-fallback.json');
      expect(permission()).toBe(0o600);
      expect(syncTestConfig(testDir, src).skippedIdentical).toContain('llm-fallback.json');
      expect(permission()).toBe(0o600);
      chmodSync(dest, 0o644);
      expect(syncTestConfig(testDir, src).skippedIdentical).toContain('llm-fallback.json');
      expect(permission()).toBe(0o600);
      expect(lstatSync(source).mode & 0o777).toBe(0o444);
      const secret = join(testDir, 'secrets.json');
      chmodSync(secret, 0o644);
      expect(syncTestConfig(testDir, src).skippedIdentical).toContain('secrets.json');
      expect(lstatSync(secret).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('허용/제외 목록이 겹치지 않는다 (정책 자기모순 가드)', () => {
    const excluded = new Set(TEST_SYNC_EXCLUDED.map((e) => e.file));
    for (const f of TEST_SYNC_AUX_FILES) expect(excluded.has(f)).toBe(false);
  });

  it('isTestConfigStale — 운영이 sync 후 갱신되면 drift', async () => {
    const { dir, src, testDir } = setup();
    syncTestConfig(testDir, src);
    expect(isTestConfigStale(testDir, src)).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(src, 'config.json'), JSON.stringify({ ...PROD_RAW, llm: { provider: 'x' } }));
    expect(isTestConfigStale(testDir, src)).toBe(true);
    // 재sync 로 해소
    syncTestConfig(testDir, src);
    expect(isTestConfigStale(testDir, src)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('테스트 사본 부재 = drift 아님 (최초 sync 는 호출측 소관)', () => {
    const { dir, src, testDir } = setup();
    expect(isTestConfigStale(testDir, src)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('채널 탭 봇 토큰 — 격리 우주에 운영 봇이 가지 않는다 (2026-09-27)', () => {
  const RAW_WITH_TABS = {
    telegram: { enabled: true, testChannel: { botToken: '8724930076:TEST' } },
    discord: { enabled: true },
    tabs: {
      'telegram:1': { tokenRef: 'ref:secret:telegram_1__tokenRef', keep: 1 },
      'discord:1': { tokenRef: 'ref:secret:discord_1__tokenRef' },
      'chat:1': { tokenRef: 'ref:secret:other' },
    },
  };

  it('telegram·discord 탭의 tokenRef 를 빼고 다른 탭은 그대로 둔다', () => {
    const out = buildTestSafeRawConfig(structuredClone(RAW_WITH_TABS));
    const tabs = out.tabs as Record<string, Record<string, unknown>>;
    expect(tabs['telegram:1']!.tokenRef).toBeUndefined();
    expect(tabs['telegram:1']!.keep).toBe(1);
    expect(tabs['discord:1']!.tokenRef).toBeUndefined();
    expect(tabs['chat:1']!.tokenRef).toBe('ref:secret:other');
    // 탭 ref 가 빠지면 봇 토큰 해석은 스왑된 시험 토큰으로 떨어진다
    expect(resolveChannelBotToken('telegram', out as never)?.token).toBe('8724930076:TEST');
  });

  it('secrets.json 사본은 채널 탭 봇 토큰과 VAPID 를 빼고 나머지는 남긴다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elanous-cfgsync-tabs-'));
    const src = join(dir, 'prod');
    const testDir = join(dir, 'repo', '.elanous-test');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'config.json'), JSON.stringify(RAW_WITH_TABS));
    writeFileSync(join(src, 'secrets.json'), JSON.stringify({ version: 1, secrets: {
      telegram_1__tokenRef: 'PROD-BOT', discord_1__tokenRef: 'PROD-DISCORD',
      'pwa-push-vapid-public': 'PUB', 'pwa-push-vapid-private': 'PRIV', other: 'KEEP', llmKey: 'KEEP2',
    } }));
    try {
      const r = syncTestConfig(testDir, src);
      const copy = JSON.parse(readFileSync(join(testDir, 'secrets.json'), 'utf-8')) as { version: number; secrets: Record<string, string> };
      expect(Object.keys(copy.secrets).sort()).toEqual(['llmKey', 'other']);
      expect(copy.version).toBe(1);
      expect(JSON.stringify(copy)).not.toContain('PROD-BOT');
      expect(r.copied).toEqual(['secrets.json(아웃바운드 자격 4개 뺌)']);
      // 두 번째 판은 같은 내용이라 건너뛴다(멱등)
      expect(syncTestConfig(testDir, src).skippedIdentical).toContain('secrets.json');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('testSyncExcludedSecretIds — 탭이 참조하는 id 는 이름 규칙 밖이어도 뺀다', () => {
    const raw = { tabs: { 'telegram:2': { tokenRef: 'ref:secret:custom-bot' } } };
    expect(testSyncExcludedSecretIds(raw, ['custom-bot', 'llm'])).toEqual(['custom-bot']);
  });
});

describe('overlay(buildTestSafeDaemonConfig) 파리티 — 정책 원전과 결과 동일', () => {
  it('토큰/아웃바운드/discord 처리 결과가 정규화 경로와 일치', async () => {
    const { buildTestSafeDaemonConfig, getUserConfig } = await import('../user-config.js');
    // 정규화 config 위에 overlay 적용 결과와, raw 변환 후 필드 비교(핵심 필드만 —
    // 정규화는 기본값을 채우므로 전체 동등이 아니라 정책 필드 파리티를 본다).
    const normalized = getUserConfig();
    const viaOverlay = buildTestSafeDaemonConfig({
      ...normalized,
      telegram: {
        ...normalized.telegram,
        enabled: true,
        botToken: '8799226199:MAIN',
        testChannel: { botToken: '8724930076:TEST', allowedUsers: [222] },
        reportChannel: { chatId: 111, botToken: '8755824181:REPORT' },
        homeChannel: 111 as unknown as undefined,
      },
    } as ReturnType<typeof getUserConfig>);
    const viaRaw = buildTestSafeRawConfig(structuredClone(PROD_RAW));
    const rawTg = viaRaw.telegram as Record<string, unknown>;
    expect(viaOverlay.telegram.botToken).toBe(rawTg.botToken as string);
    expect(viaOverlay.telegram.reportChannel).toBeUndefined();
    expect(rawTg.reportChannel).toBeUndefined();
    expect(viaOverlay.discord.enabled).toBe(false);
    expect((viaRaw.discord as Record<string, unknown>).enabled).toBe(false);
  });
});

describe('config promote — 테스트→운영 필드 단위 전파 (ISO-4)', () => {
  it('buildPromotedProdConfig — 지정 필드만 patch·나머지 불변', () => {
    const prod = { llm: { provider: 'anthropic' }, voice: { tts: { voiceId: 'old' } }, telegram: { botToken: 'MAIN' } };
    const test = { llm: { provider: 'anthropic' }, voice: { tts: { voiceId: 'tuned' } }, telegram: { botToken: 'TEST' } };
    const { next, before, after } = buildPromotedProdConfig(prod as any, test as any, 'voice.tts.voiceId');
    expect(before).toBe('old');
    expect(after).toBe('tuned');
    expect((next.voice as any).tts.voiceId).toBe('tuned');
    expect((next.telegram as any).botToken).toBe('MAIN'); // 다른 필드 불변
    expect((prod.voice as any).tts.voiceId).toBe('old'); // 원본 불변
  });

  it('테스트 config 에 없는 경로는 에러', () => {
    expect(() => buildPromotedProdConfig({}, {}, 'nope.x')).toThrow('없음');
  });

  it('denylist — telegram/discord/스탬프는 전파 불가', () => {
    expect(isPromotable('telegram.botToken')).toBe(false);
    expect(isPromotable('discord.enabled')).toBe(false);
    expect(isPromotable('_testSyncedAt')).toBe(false);
    expect(isPromotable('voice.tts.voiceId')).toBe(true);
    expect(isPromotable('logs.retention.maxAgeDays')).toBe(true);
  });
});
