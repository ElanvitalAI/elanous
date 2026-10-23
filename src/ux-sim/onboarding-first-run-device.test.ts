import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  FIRST_RUN_MENU_ANSWERS,
  FIRST_RUN_MENU_CHOICES,
  FIRST_RUN_SETUP_HINT,
  driveFirstRunMenu,
  firstRunPtySupport,
} from './onboarding-first-run-device.js';
import { formatProviderMenu, orderProviderChoices } from '../onboarding/first-run.js';

const support = firstRunPtySupport();

// must-fix 2 인과 red: 부모 러너의 LANG 을 'C.UTF-8' 로 고정(저장·복원)해도 최종
// 문구 FIRST_RUN_SETUP_HINT(고정 한국어)가 잡혀야 한다 — 장치가 자식 env 에
// ELANOUS_LANG 을 고정하기 때문이다. 자식 env 을 고정하지 않는 제품(base)은
// LANG=C.UTF-8 로 영어 fallback 을 내 finalPhrase 가 한국어 힌트와 어긋나 실패한다.
// 부모 env 조작은 bun test 가 process.env 를 파일 간 공유하므로 반드시 복원한다.
const savedDeviceLang = process.env.LANG;
const savedDeviceLcAll = process.env.LC_ALL;
const savedDeviceLcMessages = process.env.LC_MESSAGES;
beforeAll(() => {
  process.env.LANG = 'C.UTF-8';
  delete process.env.LC_ALL;
  delete process.env.LC_MESSAGES;
});
afterAll(() => {
  if (savedDeviceLang === undefined) delete process.env.LANG;
  else process.env.LANG = savedDeviceLang;
  if (savedDeviceLcAll === undefined) delete process.env.LC_ALL;
  else process.env.LC_ALL = savedDeviceLcAll;
  if (savedDeviceLcMessages === undefined) delete process.env.LC_MESSAGES;
  else process.env.LC_MESSAGES = savedDeviceLcMessages;
});

describe('onboarding first-run menu device', () => {
  // 정해진 메뉴 문구 동결: 상수는 생산 렌더러에서 파생되므로, 생산 문면이 바뀌면 여기서 먼저 깨진다.
  // 이 리터럴은 «이 화면의 고정 문구» 라는 골의 판정 대상이라 의도적으로 남긴다 — 두 시험의 나머지 단언은
  // 모두 상수를 읽으므로, 문구 변경은 이 한 곳의 의도적 갱신 없이는 통과하지 못한다.
  test('pins the frozen menu wording the production renderer must keep printing', () => {
    expect(FIRST_RUN_MENU_CHOICES).toBe('1 Codex, 2 Grok, 3 Claude');
    expect(FIRST_RUN_MENU_CHOICES).toBe(formatProviderMenu(orderProviderChoices([])));
  });

  test('states whether a util-linux PTY stage exists on this host', () => {
    if (support.available) {
      expect(support.reason).toBeNull();
      expect(typeof support.scriptPath).toBe('string');
    } else {
      expect(typeof support.reason).toBe('string');
      expect((support.reason ?? '').length).toBeGreaterThan(0);
    }
  });

  // 실물: 격리 HOME/config 아래 생산 CLI(bin/elanous.mjs --test)를 util-linux `script -q -e -c` PTY 로 띄워
  // 4 → 1e0 → １ → 1 순서로 넣고, 메뉴 재질문 횟수·고정 문구·최종 문구·config 의 onboarding.ready 부재를 잰다.
  test.skipIf(!support.available)('drives the production CLI first-run menu and re-asks every miss', async () => {
    const observed = await driveFirstRunMenu();
    expect(observed.timedOut).toBe(false);
    expect(observed.status).toBe(0);
    expect(observed.menuRenderCount).toBe(4);
    expect(observed.answersSent).toEqual([...FIRST_RUN_MENU_ANSWERS]);
    expect(observed.stdout).toContain(FIRST_RUN_MENU_CHOICES);
    expect(observed.finalPhrase).toBe(FIRST_RUN_SETUP_HINT);
    expect(observed.readyRecorded).toBe(false);
    // PTY 는 fake-bin 의 util-linux `script -q -e -c` 심을 지나야 한다(무대 이름이 증거에 남는다).
    expect(observed.scriptCall?.name).toBe('script');
    expect(observed.scriptCall?.argv.slice(0, 3)).toEqual(['-q', '-e', '-c']);
  }, 120_000);
});
