/**
 * TUI-TYPING-LAG 후속(#30304 r5 should-fix) — 덩어리 drain 의 «등록 배선»을 잠근다.
 * surface 판정 함수만이 아니라 registerLogStoreSink 가 실제로 만드는 StoreSink 의 덩어리 크기를 본다:
 * 'tui' = 64 · 그 밖(cli·nexus·autopilot·outbound) = 무제한(옛 동작) · 명시 값이 이긴다.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogSink } from './sink.js';
import {
  _resetDefaultLogStoreForTest,
  registerLogStoreSink,
  StoreSink,
  TUI_LOG_STORE_DRAIN_CHUNK_ROWS,
} from './log-store.js';

function chunkFor(surface: string, opts: { drainChunkSize?: number } = {}): number {
  const nodeEnv = process.env.NODE_ENV;
  const stateDir = process.env.ELANOUS_STATE_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'elanous-logstore-chunk-'));
  process.env.NODE_ENV = 'production';
  process.env.ELANOUS_STATE_DIR = dir;
  _resetDefaultLogStoreForTest();
  let captured: LogSink | undefined;
  try {
    const off = registerLogStoreSink((s) => { captured = s; return () => {}; }, surface, undefined, opts);
    expect(off).not.toBeNull();
    off?.();
    expect(captured).toBeInstanceOf(StoreSink);
    return (captured as StoreSink).drainChunkSize;
  } finally {
    _resetDefaultLogStoreForTest();
    rmSync(dir, { recursive: true, force: true });
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
    if (stateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = stateDir;
  }
}

describe('registerLogStoreSink — 덩어리 drain 배선', () => {
  test("'tui' 로 등록한 싱크는 64행/틱 덩어리 drain 이다(호출자가 크기를 안 넘겨도)", () => {
    expect(TUI_LOG_STORE_DRAIN_CHUNK_ROWS).toBe(64);
    expect(chunkFor('tui')).toBe(64);
  });

  test("'cli'·데몬 surface 는 무제한(한 틱에 전부 · 옛 동작)", () => {
    for (const surface of ['cli', 'nexus', 'autopilot', 'outbound']) expect(chunkFor(surface)).toBe(Number.POSITIVE_INFINITY);
  });

  test('명시 drainChunkSize 가 surface 기본값을 이긴다', () => {
    expect(chunkFor('cli', { drainChunkSize: 8 })).toBe(8);
    expect(chunkFor('tui', { drainChunkSize: 16 })).toBe(16);
  });
});
