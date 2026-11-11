import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sample = join(import.meta.dir, '../../../docs/samples/architecture-deliverables/cloud-sim');

test('documented version recheck cannot prevent an invalidation-before-cache-write race', () => {
  let dbVersion = 1;
  const cache = new Map<string, number>();
  const readVersion = dbVersion; // DB read returns v1.
  const checkedVersion = dbVersion; // Last non-atomic version check sees v1.
  expect(readVersion).toBe(checkedVersion);

  dbVersion = 2; // Admin commit happens after the check.
  cache.delete('catalog'); // Invalidation finishes before the pending fill.
  cache.set('catalog', readVersion);
  expect(cache.get('catalog')).toBe(1); // Stale v1 reappears after v2 commit.

  const html = readFileSync(join(sample, 'architecture.html'), 'utf8');
  const summary = html.match(/<div class="summary">([\s\S]*?)<\/div>/u)?.[1] ?? '';
  expect(summary).toContain('원자적으로 막지 못한다');
  expect(summary).not.toContain('구버전 결과의 캐시 재기록을 막고');
  expect(html).toContain('경합 예: v1 조회 → v1 재확인 → DB v2 확정·무효화 → v1 캐시 쓰기');
  expect(html).toContain('구버전 재캐시 0건은 현 설계로 보장하지 않는다');
  expect(html).toContain('조건부 추정');
  expect(html).not.toContain('구버전 캐시 쓰기 0건</td>');

  const pdfText = Bun.spawnSync(['pdftotext', join(sample, 'architecture.pdf'), '-'], { stdout: 'pipe', stderr: 'pipe' });
  expect(pdfText.exitCode, new TextDecoder().decode(pdfText.stderr)).toBe(0);
  const pdf = new TextDecoder().decode(pdfText.stdout).replace(/\s+/gu, ' ');
  expect(pdf).toContain('구버전 재캐시 0건은 현 설계로 보장하지 않는다');
  expect(pdf).toContain('원자적으로 막지 못한다');
});
