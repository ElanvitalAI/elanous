// 전환 원장 시험 — append 1줄(누가·무엇·이전→이후·사유·시각) · 최근 20줄 · 모양 거부(fail-closed 쓰기).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendSpendTransition, readRecentSpendTransitions } from './ledger.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmSpendLedgerEntry } from './types.js';

let dir: string;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'llm-spend-ledger-test-')), 'ledger');
});

afterEach(async () => {
  const { rmSync } = await import('node:fs');
  rmSync(dir, { recursive: true, force: true });
});

function entry(over: Partial<LlmSpendLedgerEntry> = {}): LlmSpendLedgerEntry {
  return {
    at: '2026-11-20T03:00:00.000Z',
    actor: 'seat:HAND-ELN-ELS-API',
    action: 'switch',
    what: 'codex-team',
    from: 'codex-default',
    to: 'codex-team',
    reason: 'switch(fallbackOrder 걷기)',
    ...over,
  };
}

describe('appendSpendTransition — 원장 1줄', () => {
  test('결정·전환·되돌아오기 줄을 각각 한 줄로 남긴다', async () => {
    await appendSpendTransition(entry({ action: 'decision', what: 'codex-default', from: null, to: 'codex-default', reason: 'decision(fallbackOrder 걷기)' }), dir);
    await appendSpendTransition(entry(), dir);
    await appendSpendTransition(entry({ action: 'return', what: 'codex-default', from: 'openrouter', to: 'codex-default', reason: 'return-on-reset(구독 창 리셋 실측)' }), dir);
    const recent = await readRecentSpendTransitions(20, dir);
    expect(recent.length).toBe(3);
    expect(recent[0]!.action).toBe('return'); // 최신순
    expect(recent[1]!.action).toBe('switch');
    expect(recent[2]!.action).toBe('decision');
    expect(recent[1]!.from).toBe('codex-default');
    expect(recent[1]!.to).toBe('codex-team');
    expect(recent[1]!.actor).toBe('seat:HAND-ELN-ELS-API');
  });
  test('모양이 틀린 줄(사유 없음·시각 불가)은 쓰기를 거부한다(fail-closed)', async () => {
    const broken = entry() as unknown as Record<string, unknown>;
    delete broken.reason;
    await expect(appendSpendTransition(broken as unknown as LlmSpendLedgerEntry, dir)).rejects.toThrow('invalid ledger entry');
    const noTime = entry() as unknown as Record<string, unknown>;
    noTime.at = 'not-a-date';
    await expect(appendSpendTransition(noTime as unknown as LlmSpendLedgerEntry, dir)).rejects.toThrow('invalid ledger entry');
    const recent = await readRecentSpendTransitions(20, dir);
    expect(recent.length).toBe(0); // 거부한 줄은 원장에 없다
  });
  test('원장 줄에 비밀 값 모양 필드가 없다(이름·사유만)', async () => {
    await appendSpendTransition(entry(), dir);
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(`${dir}/transitions.jsonl`, 'utf8');
    expect(raw).not.toMatch(/sk-|ghp_|eyJ|ems_|emt_/);
  });
});

describe('appendSpendTransition — 화이트리스트 · 오류 메시지 무유출', () => {
  test('추가 필드(비밀 모양 값)는 원장에 기록되지 않는다', async () => {
    const secret = 'sk-1234567890abcdefSECRET';
    const withExtra = { ...entry(), token: secret, nested: { key: secret } } as unknown as LlmSpendLedgerEntry;
    const written = await appendSpendTransition(withExtra, dir);
    expect(Object.keys(written).sort()).toEqual(['action', 'actor', 'at', 'from', 'reason', 'to', 'what']);
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(`${dir}/transitions.jsonl`, 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('token');
  });
  test('잘못된 입력의 오류 메시지에는 값이 없고 필드 이름만 있다', async () => {
    const secret = 'sk-1234567890abcdefSECRET';
    const bad = { ...entry(), reason: '', actor: secret.length, leak: secret } as unknown as LlmSpendLedgerEntry;
    let message = '';
    try { await appendSpendTransition(bad, dir); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain('invalid ledger entry');
    expect(message).toContain('reason');
    expect(message).toContain('actor');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('codex-team');
  });
});

describe('readRecentSpendTransitions — 최근 20줄', () => {
  test('손상 행이 섞여도 건너뛰고 정상 N개를 채운다', async () => {
    const { appendFileSync } = await import('node:fs');
    for (let i = 0; i < 5; i++) {
      await appendSpendTransition(entry({ what: `row-${i}` }), dir);
      appendFileSync(`${dir}/transitions.jsonl`, '{"broken": tru\n', 'utf8');
    }
    const recent = await readRecentSpendTransitions(3, dir);
    expect(recent.map((e) => e.what)).toEqual(['row-4', 'row-3', 'row-2']);
  });
  test('25줄을 남기면 최근 20줄만(최신순) 돌아온다', async () => {
    for (let i = 0; i < 25; i++) {
      await appendSpendTransition(entry({ at: new Date(Date.parse('2026-11-20T03:00:00Z') + i * 1000).toISOString(), what: `row-${i}` }), dir);
    }
    const recent = await readRecentSpendTransitions(20, dir);
    expect(recent.length).toBe(20);
    expect(recent[0]!.what).toBe('row-24');
    expect(recent[19]!.what).toBe('row-5');
  });
  test('원장이 없으면 빈 목록', async () => {
    expect(await readRecentSpendTransitions(20, dir)).toEqual([]);
  });
  test('끊긴 줄은 조용히 건너뛴다(fail-soft 읽기)', async () => {
    await appendSpendTransition(entry(), dir);
    const { appendFileSync } = await import('node:fs');
    appendFileSync(`${dir}/transitions.jsonl`, '{"broken": tru\n', 'utf8');
    const recent = await readRecentSpendTransitions(20, dir);
    expect(recent.length).toBe(1);
    expect(recent[0]!.what).toBe('codex-team');
  });
});
