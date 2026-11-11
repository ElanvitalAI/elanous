import { expect, test } from 'bun:test';
import { dashboardCanUseTty, dashboardTtyRefusalMessage } from './tty-required.js';

test('TTY requirement checks the supplied stdin value exactly', () => {
  expect(dashboardCanUseTty({ isTTY: true })).toBe(true);
  expect(dashboardCanUseTty({ isTTY: false })).toBe(false);
  expect(dashboardCanUseTty({})).toBe(false);
});

test('TTY refusal text stays identical during the common-path migration', () => {
  expect(dashboardTtyRefusalMessage()).toBe([
    'elanous 대시보드는 stdin TTY가 있는 자리에서만 뜰 수 있다.',
    '  지금 stdin 이 TTY 가 아니다(파이프·리다이렉트·비대화형 실행).',
    '  ⛔ 그대로 띄우면 키를 못 읽고 화면만 초당 수백 번 다시 그린다.',
    '  ✅ 한 줄 물어보기 :  elanous ask "<질문>"',
    '  ✅ 이어서 대화하기:  elanous repl',
    '  ✅ 터미널에서 직접 :  elanous        (파이프 없이)',
  ].join('\n'));
});
