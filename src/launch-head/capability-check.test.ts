import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  PATH_CAPABILITY_RULES,
  POD_CAPABILITIES,
  TEXT_CAPABILITY_RULES,
  checkCapability,
  readTargetPaths,
} from './capability-check.js';

const IOS_GOAL = [
  '대상 경로: apps/ios/Elanous/App.swift',
  '',
  'iOS 앱 엔트리를 고친다.',
].join('\n');

const CLI_GOAL = [
  '대상 경로: src/cli/foo.ts',
  '',
  'CLI 한 줄을 고친다.',
].join('\n');

test('ios 대상 경로는 local-only 이고 required 에 xcode 가 있다', () => {
  const result = checkCapability({ goalText: IOS_GOAL });
  expect(result.outcome).toBe('local-only');
  expect(result.required).toContain('xcode');
  expect(result.reasons.some((reason) => reason.includes('xcode'))).toBe(true);
});

test('src/cli 만 있는 골은 any 다', () => {
  const result = checkCapability({ goalText: CLI_GOAL });
  expect(result.outcome).toBe('any');
  expect(result.required).toEqual([]);
});

test('«라이브 TUI 로 확인한다» 는 local-only 이고 reasons 가 그 표지를 이름으로 댄다', () => {
  const goalText = ['대상 경로: src/cli/foo.ts', '', '라이브 TUI 로 확인한다.'].join('\n');
  const result = checkCapability({ goalText });
  expect(result.outcome).toBe('local-only');
  expect(result.required).toContain('live-tui');
  expect(result.reasons.some((reason) => reason.includes('«라이브 TUI»'))).toBe(true);
});

test('pty snapshot 과 --hold 도 live-tui 다', () => {
  const snapshot = checkCapability({ goalText: '대상 경로: src/cli/foo.ts\npty snapshot 으로 본다' });
  const hold = checkCapability({ goalText: '대상 경로: src/cli/foo.ts\n--hold 로 붙잡는다' });
  expect(snapshot.outcome).toBe('local-only');
  expect(snapshot.required).toEqual(['live-tui']);
  expect(hold.required).toEqual(['live-tui']);
  expect(snapshot.reasons.some((reason) => reason.includes('«pty snapshot»'))).toBe(true);
  expect(hold.reasons.some((reason) => reason.includes('«--hold»'))).toBe(true);
});

test('운영 우주 와 ~/.elanous 쓰기는 host-universe, 키체인은 host-keychain', () => {
  const universe = checkCapability({ goalText: '대상 경로: src/cli/foo.ts\n운영 우주에 쓴다' });
  const home = checkCapability({ goalText: '대상 경로: src/cli/foo.ts\n~/.elanous 에 쓰기' });
  const keychain = checkCapability({ goalText: '대상 경로: src/cli/foo.ts\n키체인에서 읽는다' });
  expect(universe.required).toEqual(['host-universe']);
  expect(home.required).toEqual(['host-universe']);
  expect(keychain.required).toEqual(['host-keychain']);
  expect(universe.outcome).toBe('local-only');
  expect(keychain.outcome).toBe('local-only');
});

test('launchd 경로 둘은 host-launchd, apps/pwa 는 요구가 없다', () => {
  const install = checkCapability({ goalText: '대상 경로: src/install/launchd-plist.ts' });
  const nested = checkCapability({ goalText: '대상 경로: src/foo/launchd-agent.ts' });
  const pwa = checkCapability({ goalText: '대상 경로: apps/pwa/src/main.ts' });
  expect(install.required).toEqual(['host-launchd']);
  expect(install.outcome).toBe('local-only');
  expect(nested.required).toEqual(['host-launchd']);
  expect(pwa.required).toEqual([]);
  expect(pwa.outcome).toBe('any');
});

test('대상 경로 줄이 없으면 빈 목록이고 reasons 에 «대상 경로 없음»', () => {
  const goalText = '본문만 있다. 경로 표지 없음.';
  expect(readTargetPaths(goalText)).toEqual([]);
  const result = checkCapability({ goalText });
  expect(result.reasons).toContain('대상 경로 없음');
  expect(result.outcome).toBe('any');
  expect(result.required).toEqual([]);
});

test('대상 경로는 첫 줄만 읽고 · 로 가른다', () => {
  const goalText = '대상 경로: apps/ios/Elanous/App.swift · src/cli/foo.ts\n둘째 줄 대상 경로: apps/pwa/x.ts';
  expect(readTargetPaths(goalText)).toEqual(['apps/ios/Elanous/App.swift', 'src/cli/foo.ts']);
  const result = checkCapability({ goalText });
  expect(result.required).toEqual(['xcode']);
  expect(result.outcome).toBe('local-only');
});

test('호출자가 targetPaths 를 주면 그 목록을 쓰고, 비면 «대상 경로 없음»', () => {
  const given = checkCapability({ goalText: '본문에 경로 표지 없음', targetPaths: ['apps/ios/Elanous/App.swift'] });
  expect(given.required).toContain('xcode');
  expect(given.reasons).not.toContain('대상 경로 없음');
  const empty = checkCapability({ goalText: '대상 경로: src/cli/foo.ts', targetPaths: [] });
  expect(empty.reasons).toContain('대상 경로 없음');
  expect(empty.outcome).toBe('any');
});

test('요구가 POD_CAPABILITIES 밖이면 어떤 요구가 왜 막았는지 reasons 에 남긴다', () => {
  const result = checkCapability({ goalText: IOS_GOAL });
  expect(POD_CAPABILITIES).not.toContain('xcode');
  expect(result.reasons.some((reason) => reason.includes('xcode') && reason.includes('POD_CAPABILITIES'))).toBe(true);
});

test('규칙 표는 코드 상수 한 곳이고 원문 대응을 그대로 둔다', () => {
  expect(PATH_CAPABILITY_RULES).toEqual([
    { glob: 'apps/ios/**', capability: 'xcode' },
    { glob: 'src/install/launchd*', capability: 'host-launchd' },
    { glob: '**/launchd*.ts', capability: 'host-launchd' },
    { glob: 'apps/pwa/**', capability: null },
  ]);
  expect(TEXT_CAPABILITY_RULES.map((rule) => `${rule.marker}→${rule.capability}`)).toEqual([
    '라이브 TUI→live-tui',
    'pty snapshot→live-tui',
    '--hold→live-tui',
    '운영 우주→host-universe',
    '~/.elanous→host-universe',
    '키체인→host-keychain',
  ]);
  expect(Array.isArray(POD_CAPABILITIES)).toBe(true);
});

test('capability-check.ts 는 파일·네트워크·프로세스를 직접 부르지 않는다', () => {
  const source = readFileSync(new URL('./capability-check.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/from ['"]node:/);
  expect(source).not.toMatch(/\b(readFileSync|writeFileSync|Bun\.file|Bun\.spawn|fetch|child_process)\b/);
});

test('반환 형태는 outcome · required · reasons 다', () => {
  const result = checkCapability({ goalText: CLI_GOAL });
  expect(Object.keys(result).sort()).toEqual(['outcome', 'reasons', 'required']);
  expect(result.outcome === 'any' || result.outcome === 'local-only').toBe(true);
  expect(Array.isArray(result.required)).toBe(true);
  expect(Array.isArray(result.reasons)).toBe(true);
});
