import { describe, expect, test } from 'bun:test';
import { BUNDLED_TOKEN_SCHEMA, DEFAULT_BASE_SYSTEM, readBundledSchema } from './system-schema.js';
import { defaultDesignSystemsDir } from './design-systems.js';

describe('BUNDLED_TOKEN_SCHEMA', () => {
  test('번들 시스템 폴더의 토큰 이름 교집합과 같고 순서가 같다', () => {
    const measured = readBundledSchema(defaultDesignSystemsDir());
    expect(measured).toEqual([...BUNDLED_TOKEN_SCHEMA]);
    expect(measured.length).toBe(BUNDLED_TOKEN_SCHEMA.length);
    expect(measured.length).toBeGreaterThan(50);
  });

  test('기본 base 는 minimal 이다', () => {
    expect(DEFAULT_BASE_SYSTEM).toBe('minimal');
  });
});
