/**
 * autopilot 스토어 격리 — ISO-3 계약 (2026-07-13).
 *
 * 사건 회귀 고정: 격리 테스트 데몬(ELANOUS_STATE_DIR 설정)이 (1) 운영 미션
 * 우주를 보지 못하고 (2) 무장류는 부재 → fail-closed 이며 (3) origin 이
 * 지정한 봇을 보장 못 하면 미션 알림을 발송하지 않는다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { elanousStateRoot } from './state-paths.js';
import { autopilotMissionsDbPath } from './mission-registry.js';
import { autopilotArmingPath, selfHealArmed } from './arming.js';
import { resolveTelegramBotToken } from './mission-notify.js';
import { setUserConfigOverlay, type UserConfig } from '../user-config.js';
import { resetEffectiveInstanceRoot, resolveInstance } from '../instance/resolve.js';

const savedStateDir = process.env.ELANOUS_STATE_DIR;

function restoreEnv(): void {
  if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = savedStateDir;
}

describe('elanousStateRoot — ELANOUS_STATE_DIR 존중 (lazy)', () => {
  beforeEach(() => resetEffectiveInstanceRoot());
  afterEach(() => { restoreEnv(); resetEffectiveInstanceRoot(); });

  it('미설정 = 해석된 테스트 우주 · 설정 = 그 루트 (미션 DB·무장 경로 동반 이동)', () => {
    delete process.env.ELANOUS_STATE_DIR;
    const root = resolveInstance().root;
    expect(elanousStateRoot()).toBe(root);
    expect(autopilotMissionsDbPath()).toBe(join(root, 'autopilot/autopilot_missions.db'));

    process.env.ELANOUS_STATE_DIR = '/x/repo/.elanous-test';
    expect(elanousStateRoot()).toBe('/x/repo/.elanous-test');
    expect(autopilotMissionsDbPath()).toBe('/x/repo/.elanous-test/autopilot/autopilot_missions.db');
    expect(autopilotArmingPath()).toBe('/x/repo/.elanous-test/autopilot.json');
  });

  it('격리 루트에 무장 파일 부재 → fail-closed(DISARMED)', () => {
    process.env.ELANOUS_STATE_DIR = '/nonexistent/isolated-root';
    expect(selfHealArmed()).toBe(false);
  });
});

describe('resolveTelegramBotToken — 사건 회귀 (2026-07-13 미션 오발송)', () => {
  afterEach(() => setUserConfigOverlay(null));

  function injectTestOnlyConfig(): void {
    // 격리 테스트 인스턴스의 config 형상 — main 봇 토큰이 테스트 봇으로
    // 스왑돼 있고 운영 아웃바운드는 없다(sync-test 물질화본 동형).
    setUserConfigOverlay((c: UserConfig) => ({
      ...c,
      telegram: {
        ...c.telegram,
        enabled: true,
        botToken: '8724930076:TEST',
        testChannel: { botToken: '8724930076:TEST' },
        reportChannel: undefined,
      },
    }));
  }

  it('origin botId 가 어느 후보와도 불일치 → null (엉뚱한 봇 폴백 발송 금지)', () => {
    injectTestOnlyConfig();
    // 사건 시나리오: 운영 미션 origin = 메인 봇(8799226199), 테스트 config 에는 없음.
    // 종전엔 main(=테스트 토큰) 폴백으로 테스트 채널 발송 — 이제 발송 포기.
    expect(resolveTelegramBotToken('8799226199')).toBeNull();
  });

  it('botId 매칭 시 그 토큰 · botId 미지정(legacy) 시 main', () => {
    injectTestOnlyConfig();
    expect(resolveTelegramBotToken('8724930076')).toBe('8724930076:TEST');
    expect(resolveTelegramBotToken()).toBe('8724930076:TEST');
  });
});
