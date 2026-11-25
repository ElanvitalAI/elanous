// VISION-CATALOG-BUILTIN (11-25) — `--test` 우주는 모델 사실 캐시(발견 스냅숏·비전 캐시)를 config 처럼 가져간다.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncTestModelFactCaches } from './config-test-sync.js';

describe('syncTestModelFactCaches', () => {
  test('없으면 복사 · 같거나 새 사본이면 건너뜀 · 운영이 더 새로우면 다시 복사', () => {
    const src = mkdtempSync(join(tmpdir(), 'facts-src-'));
    const dst = mkdtempSync(join(tmpdir(), 'facts-dst-'));
    writeFileSync(join(src, 'discovery-snapshot.json'), '{"version":1,"models":[{"id":"anthropic/claude-opus-5.5"}]}');
    expect(syncTestModelFactCaches(dst, src)).toEqual(['discovery-snapshot.json']);
    expect(readFileSync(join(dst, 'discovery-snapshot.json'), 'utf-8')).toBe('{"version":1,"models":[{"id":"anthropic/claude-opus-5.5"}]}');
    expect(syncTestModelFactCaches(dst, src)).toEqual([]);
    writeFileSync(join(src, 'discovery-snapshot.json'), '{"version":1,"models":[]}');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(src, 'discovery-snapshot.json'), future, future);
    expect(syncTestModelFactCaches(dst, src)).toEqual(['discovery-snapshot.json']);
    expect(readFileSync(join(dst, 'discovery-snapshot.json'), 'utf-8')).toBe('{"version":1,"models":[]}');
  });
});
