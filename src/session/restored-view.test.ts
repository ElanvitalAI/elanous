// 재현 — TUI-RESUME-PICKER ①②③④ (OP 라이브 10-23 · 설치본 2e119dc · n8n 세션 elanous-session-c01bd3 · 379행):
// ① 목록 id 칸이 «elanous-» 만 보여 세션끼리 구별 불가 ② 시각이 UTC(01:24 KST 가 16:24)
// ③ 이어받은 대화가 화면에 안 나오고 새 턴만 ④ 이어받은 직후 ctx 0(첫 턴 뒤에야 실제 값).
// 고정은 합성 379행 세션(`seedLongSession` — 사용자·도구 일곱·답 순서, 실제 대화 복사 0).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { historyFromSession } from './index.js';
import { sessionListTime, uniqueIdPrefixes } from './id-prefix.js';
import { renderRestoredTranscriptLines } from '../dashboard/replay-preview.js';
import { getSessionMetrics, noteRestoredContext, recordTurn, resetSessionMetrics } from '../status/metrics.js';
import { seedLongSession } from '../ux-sim/session-id-seed.js';

let dir = '';
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'restored-view-'));
  saved = process.env.ELANOUS_SESSION_ROOT;
  process.env.ELANOUS_SESSION_ROOT = join(dir, 'sessions');
  resetSessionMetrics();
});
afterEach(() => {
  if (saved === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = saved;
  rmSync(dir, { recursive: true, force: true });
  resetSessionMetrics();
});

describe('① daemon ids share «elanous-session-» — the shown part must go past it', () => {
  test('prefixes grow past the 16-char stem until they differ', () => {
    const ids = ['elanous-session-c01bd3', 'elanous-session-c0x9aa', 'elanous-session-h7k2pq', 'elanous-session-0bmwu0'];
    const p = uniqueIdPrefixes(ids, ids);
    expect([...p.values()]).toEqual(['elanous-session-c01', 'elanous-session-c0x', 'elanous-session-h', 'elanous-session-0']);
    for (const prefix of p.values()) expect(prefix).not.toBe('elanous-');
  });
});

describe('② list times are local, not the stored UTC string', () => {
  test('MM-DD HH:mm from the local clock', () => {
    const iso = '2026-10-22T16:24:05.000Z';
    const d = new Date(iso);
    const two = (n: number) => String(n).padStart(2, '0');
    expect(sessionListTime(iso)).toBe(`${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`);
    if (d.getTimezoneOffset() !== 0) expect(sessionListTime(iso)).not.toBe('10-22 16:24');
  });

  test('an unparsable time falls back to the stored text instead of «NaN»', () => {
    expect(sessionListTime('garbage-time-value')).not.toContain('NaN');
  });
});

describe('③④ a restored 379-row session is shown in full and sized', () => {
  test('every user and assistant message is on screen — first to last, no «more lines» cut', () => {
    const seed = seedLongSession('elanous-session-l0ng79');
    expect(seed.rows).toBe(379);
    const history = historyFromSession(seed.id)!.history;
    const lines = renderRestoredTranscriptLines(history, { maxWidth: 100 }).map(stripVTControlCharacters);
    const text = lines.join('\n');
    expect(text).toContain(seed.firstUser);
    expect(text).toContain(seed.lastAssistant);
    for (let t = 1; t <= seed.userTurns; t++) expect(text).toContain(`턴 ${t} 질문`);
    expect(text).not.toContain('more line');
  });

  test('beyond the cap the tail is kept and the hidden count is said', () => {
    const history = Array.from({ length: 250 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `메시지 ${i}` }));
    const lines = renderRestoredTranscriptLines(history, { maxWidth: 80, maxMessages: 200 }).map(stripVTControlCharacters);
    expect(lines[0]).toContain('앞 50개 메시지 생략');
    expect(lines.join('\n')).toContain('메시지 249');
    expect(lines.some((l) => l.trim().endsWith('메시지 49'))).toBe(false);
  });

  test('ctx shows the restored size at once; the first real turn replaces it', () => {
    const seed = seedLongSession('elanous-session-l0ng80');
    expect(getSessionMetrics().lastContextUsed).toBe(0);
    const used = noteRestoredContext(historyFromSession(seed.id)!.history);
    expect(used).toBeGreaterThan(0);
    expect(getSessionMetrics().lastContextUsed).toBe(used);
    recordTurn({ model: 'test', usage: { inputTokens: 11_000, outputTokens: 50 }, seconds: 1 });
    expect(getSessionMetrics().lastContextUsed).toBe(11_050);
  });
});
