import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';

// 공개본은 scripts/botlab/** · scripts/webclone/** 를 뺀다(release/public-export.yaml).
// src 가 그것을 «정적» import 하면 공개판이 모듈을 못 찾아 빌드·기동이 깨진다 — 📏 2026-09-27 0.2.3 prepare 가 role-cli.ts 에서 멈췄다.
// (문자열 경로로 프로세스를 띄우거나 동적 import 로 없을 때를 견디는 자리는 해당 없음.)
const EXCLUDED = /(?:^|\n)\s*import[^;'"]*from\s+['"](?:\.\.\/)+scripts\/(?:botlab|webclone)\//;

describe('공개 코어가 공개본에서 빠지는 scripts 를 정적 import 하지 않는다', () => {
  test('src/**/*.ts (시험 제외)', () => {
    const offenders: string[] = [];
    for (const file of new Glob('src/**/*.ts').scanSync('.')) {
      if (file.endsWith('.test.ts')) continue;
      if (EXCLUDED.test(readFileSync(file, 'utf8'))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
