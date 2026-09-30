import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEXUS_VERSION } from './index.js';

// 데몬 배너·`nexus status`·연결 라벨이 보이는 판은 제품 판이다 — 옛 내부 상수(`0.17.0`)가 0.2.x 옆에 떴다(🅞 M5 · M5c).
test('the NEXUS version shown on the daemon banner is the product version from package.json', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')) as { version: string };
  expect(NEXUS_VERSION).toBe(pkg.version);
});
