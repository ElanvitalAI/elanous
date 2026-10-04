import { describe, expect, it } from 'bun:test';
import { remainingLines, statusText, type UsageBody } from './chat-status';

const usage: UsageBody = {
  ok: true,
  rows: [
    { provider: 'codex', account: '계정 1', subscription: { status: 'available', remainingPercent: 72, resetsInMs: 3 * 60 * 60_000 } },
    { provider: 'grok', account: '계정 2', subscription: { status: 'unavailable', reason: 'not-a-subscription' }, credits: { status: 'ok', usedPercent: 41 } },
    { provider: 'other', account: '계정 3', subscription: { status: 'unavailable', reason: 'query-does-not-supply' }, credits: { status: 'unavailable' } },
  ],
};

describe('PWA chat usage formatting', () => {
  it('shows subscription remaining and reset, credit use, and capped unavailable reason per account', () => {
    expect(remainingLines(usage)).toEqual([
      'codex 계정 1 · 남은 72% · 3시간 뒤 초기화',
      'grok 계정 2 · 사용 41%',
      'other 계정 3 · 못 읽음(query-does-not-supply)',
    ]);
    const long = 'a'.repeat(50);
    expect(remainingLines({ ok: true, rows: [{ provider: 'x', account: '계정', subscription: { status: 'unavailable', reason: long } }] })[0])
      .toBe(`x 계정 · 못 읽음(${'a'.repeat(40)})`);
  });

  it('keeps each account on one line when a reason or display label contains controls', () => {
    const rows = [
      { provider: 'code\r\nx', account: '계정\t1', subscription: { status: 'unavailable', reason: `오류\n\r\t\u0000상세\u2028${'a'.repeat(50)}` } },
      { provider: 'grok', account: '계정 2', credits: { status: 'unavailable', reason: '읽기\u007f불가' } },
    ];
    const lines = remainingLines({ ok: true, rows });
    expect(lines).toEqual([
      `code x 계정 1 · 못 읽음(오류 상세 ${'a'.repeat(34)})`,
      'grok 계정 2 · 못 읽음(읽기 불가)',
    ]);
    expect(lines).toHaveLength(rows.length);
    expect(lines.every((line) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(line))).toBe(true);
  });

  it('formats 45 minutes and two days without making up an account identifier', () => {
    expect(remainingLines({ ok: true, rows: [
      { provider: 'x', account: '계정', subscription: { status: 'available', remainingPercent: 20, resetsInMs: 45 * 60_000 } },
      { provider: 'y', account: '계정 2', subscription: { status: 'available', remainingPercent: 5, resetsInMs: 2 * 24 * 60 * 60_000 } },
    ] })).toEqual([
      'x 계정 · 남은 20% · 45분 뒤 초기화',
      'y 계정 2 · 남은 5% · 2일 뒤 초기화',
    ]);
  });

  it('distinguishes a successful empty usage list from an unread response', () => {
    expect(remainingLines({ ok: true, rows: [] })).toEqual([]);
    expect(statusText({ sessionId: 'abcdefgh-123', provider: 'codex', usage: { ok: true, rows: [] } }))
      .toContain('남은 양: 등록된 계정이 없습니다');
    expect(statusText({ sessionId: 'abcdefgh-123', provider: 'codex', usage: { ok: false, rows: [] } }))
      .toContain('남은 양: 남은 양을 읽지 못했습니다');
  });

  it('status shows short conversation id, model, daemon version, and the least remaining account', () => {
    expect(statusText({ sessionId: 'abcdefgh-123', provider: 'codex', model: 'terra', version: '0.2.12', usage: {
      ok: true, rows: [
        usage.rows![0]!,
        { provider: 'codex', account: '계정 2', subscription: { status: 'available', remainingPercent: 12, resetsInMs: 45 * 60_000 } },
      ],
    } })).toBe('대화: abcdefgh\n모델: codex/terra\n데몬 판: 0.2.12\n남은 양: codex 계정 2 · 남은 12% · 45분 뒤 초기화');
    expect(statusText({ sessionId: 'abcdefgh-123', provider: 'codex', usage: { ok: true, rows: [
      { provider: 'codex', account: '계정 1', subscription: { status: 'available', remainingPercent: 72 } },
      { provider: 'grok', account: '계정 2', credits: { status: 'ok', usedPercent: 95 } },
    ] } })).toContain('남은 양: grok 계정 2 · 사용 95%');
    expect(statusText({ sessionId: 'abcdefgh-123', provider: 'codex' })).toContain('남은 양을 읽지 못했습니다');
    expect(statusText({ sessionId: 'abcdefgh-123', provider: 'codex' })).toContain('모델: codex/미확인');
    expect(statusText({ sessionId: 'abcdefgh-123', provider: 'codex', model: '' })).toContain('모델: codex/미확인');
  });
});

it('statusText picks the least remaining by the raw value, not the rounded one (review must-fix)', () => {
  const row = (account: string, remainingPercent: number) => ({ provider: 'codex', account, subscription: { status: 'available', remainingPercent, resetsInMs: null } });
  const text = statusText({ sessionId: 'abcdefgh-1', provider: 'codex', usage: { ok: true, rows: [row('계정 1', 8.4), row('계정 2', 8.1)] } });
  expect(text).toContain('계정 2');
  expect(text).not.toContain('계정 1');
});
