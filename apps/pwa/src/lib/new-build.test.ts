import { describe, expect, test } from 'bun:test';
import { extractBuildId, isNewBuild } from './new-build';

describe('extractBuildId — 정적 export HTML 의 빌드 id', () => {
  test('RSC 머리의 이스케이프된 "b" 를 읽는다', () => {
    const html = String.raw`self.__next_f.push([1,"0:{\"P\":null,\"b\":\"LfmZ8Sk060p4y2_JAlrof\",\"p\":\"/app\"`;
    expect(extractBuildId(html)).toBe('LfmZ8Sk060p4y2_JAlrof');
  });
  test('이스케이프 없는 형태도 읽는다', () => {
    expect(extractBuildId('{"P":null,"b":"3qzfIl_AHYXXznNAn3IuO"}')).toBe('3qzfIl_AHYXXznNAn3IuO');
  });
  test('없으면 null', () => {
    expect(extractBuildId('<html></html>')).toBeNull();
  });
});

describe('isNewBuild', () => {
  test('둘 다 알고 다르면 새 판', () => {
    expect(isNewBuild('a1b2c3d4e5', 'z9y8x7w6v5')).toBe(true);
  });
  test('같거나 한쪽을 모르면 아니다 — 헛경보를 내지 않는다', () => {
    expect(isNewBuild('a1b2c3d4e5', 'a1b2c3d4e5')).toBe(false);
    expect(isNewBuild(null, 'z9y8x7w6v5')).toBe(false);
    expect(isNewBuild('a1b2c3d4e5', null)).toBe(false);
  });
});
