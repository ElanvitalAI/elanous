// ListDir 광역 반복 차단이 «관측»에 남는지 — TUI-OPS-TURN-GUARD 관측 공백 ① (2026-10-17).
//
// 종전엔 ListDir 차단(list-dir.ts «RUNTIME BLOCKED»)이 throw 만 해서, Grep(grep.ts) 과 달리
// `tools.search/broad-search-blocked` 조회에 «0» 으로 나왔다 — 그 0 은 「안 막혔다」가 아니라 「안 쟀다」.
// ⛔ 임계는 단언하지 않는다(가드 수치는 search-loop-guard 의 몫) — 막힐 때까지 돌리고 관측만 본다.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchListDir } from './list-dir.js';
import { resetSearchLoopGuardForTest } from './search-loop-guard.js';
import { debug } from '../../debug/log.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'listdir-block-obs-')));
writeFileSync(join(root, 'a.txt'), 'secret-content-marker\n');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => resetSearchLoopGuardForTest());

type Seen = { category: string; event: string; data?: unknown };

async function runUntilBlocked(seen: Seen[]): Promise<{ blocked: boolean; message: string; okCallsBefore: number; eventsBeforeBlock: number }> {
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
    seen.push({ category, event, data });
  }) as typeof debug.log;
  let blocked = false;
  let message = '';
  let okCallsBefore = 0;
  let eventsBeforeBlock = 0;
  try {
    for (let i = 0; i < 12 && !blocked; i++) {
      try {
        await dispatchListDir({ path: root });
        okCallsBefore++;
        eventsBeforeBlock = seen.filter(e => e.event === 'broad-search-blocked').length;
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
        if (message.includes('RUNTIME BLOCKED')) blocked = true;
        else throw err;
      }
    }
  } finally {
    (debug as { log: typeof debug.log }).log = original;
  }
  return { blocked, message, okCallsBefore, eventsBeforeBlock };
}

describe('ListDir 차단은 «관측»에 남는다 (동작·문구 불변)', () => {
  test('막힐 때까지 돌리면 tools.search/broad-search-blocked 가 «정확히 한 번» 찍힌다', async () => {
    const seen: Seen[] = [];
    const { blocked, okCallsBefore, eventsBeforeBlock } = await runUntilBlocked(seen);

    // 반증: 막히지 않았다면 이 시험은 아무것도 증명하지 못한다.
    expect(blocked).toBe(true);
    expect(okCallsBefore).toBeGreaterThan(0);
    // 차단 «전» 정상 호출에서는 찍지 않는다.
    expect(eventsBeforeBlock).toBe(0);

    const blocks = seen.filter(e => e.category === 'tools.search' && e.event === 'broad-search-blocked');
    expect(blocks.length).toBe(1);

    const payload = blocks[0]?.data as Record<string, unknown>;
    expect(payload.tool).toBe('ListDir');
    expect(typeof payload.consecutive).toBe('number');
    expect(typeof payload.pathDepth).toBe('number');
    expect(payload.pathDepth as number).toBeGreaterThan(0);
    expect(payload.showHidden).toBe(false);
    expect(payload.sort).toBe('name');
    // 경로 원문·내용은 싣지 않는다.
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain(root);
    expect(raw).not.toContain('a.txt');
    expect(raw).not.toContain('secret-content-marker');
  });

  test('차단 문구는 그대로다', async () => {
    const seen: Seen[] = [];
    const { blocked, message } = await runUntilBlocked(seen);
    expect(blocked).toBe(true);
    const consecutive = (seen.find(e => e.event === 'broad-search-blocked')?.data as { consecutive: number }).consecutive;
    expect(message).toBe(
      `RUNTIME BLOCKED — repeated broad search loop detected (${consecutive} consecutive broad-search calls). ` +
      `You already listed ${root}. Stop re-listing the same tree. Pick concrete files or directories from prior results ` +
      `and continue with Read, Grep(content), Glob, or Lsp.`,
    );
  });
});
