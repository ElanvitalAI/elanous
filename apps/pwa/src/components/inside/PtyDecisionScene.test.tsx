import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { leaksInternal } from './public-text';
import { EMPTY_DECISIONS, parseDecision, reduceDecisions } from './pty-decisions';
import { PtyDecisionScene } from './PtyDecisionScene';

const now = Date.parse('2026-10-03T08:40:00Z');
const raw = {
  ts: '2026-10-03T08:39:00Z', missionId: 'one', seq: 1, sessionId: 'session',
  terminalId: 'terminal', agent: 'codex', step: 'read', text: '읽기',
};
const event = (patch: Record<string, unknown>) => parseDecision({ ...raw, ...patch })!;
const display = (state = EMPTY_DECISIONS) => renderToStaticMarkup(<PtyDecisionScene decisions={state} now={now} />);

describe('PTY decision public scene', () => {
  test('no decisions reports an explicit absence without opening terminal or other external connections', () => {
    const html = display();
    expect(html).toContain('지금 PTY 판단이 없습니다 — 마지막 판단 기록 없음');
    expect(html).not.toContain('<ol');
  });

  test('stale answer age ignores a newer read and does not display stale details', () => {
    const state = [
      event({ ts: '2026-10-03T08:27:00Z', step: 'answer', text: 'private command', detail: { question: 'approve?', answer: '승인' } }),
      event({ seq: 2, ts: '2026-10-03T08:39:00Z', step: 'read', text: 'new private command' }),
    ].reduce(reduceDecisions, EMPTY_DECISIONS);
    const html = display(state);
    expect(html).toContain('지금 PTY 판단이 없습니다 — 마지막 판단 13분 전');
    expect(html).not.toContain('0분 전');
    expect(html).not.toContain('private command');
    expect(html).not.toContain('승인');
    expect(html).not.toContain('<ol');
  });

  test('a read without a prior answer does not claim a decision was made', () => {
    const state = reduceDecisions(EMPTY_DECISIONS, event({ ts: '2026-10-03T08:39:00Z' }));
    expect(display(state)).toContain('지금 PTY 판단이 없습니다 — 마지막 판단 기록 없음');
  });

  test('unrecognized answer prose is not a public outcome, even when it contains a decision word later', () => {
    const state = reduceDecisions(EMPTY_DECISIONS, event({
      step: 'answer', detail: { question: 'private?', answer: 'run /home/ubuntu/private/command then 승인' },
    }));
    const html = display(state);
    expect(html).toContain('지금 PTY 판단이 없습니다 — 마지막 판단 1분 전');
    expect(html).not.toContain('<li');
    expect(html).not.toContain('private/command');
    expect(html).not.toContain('승인');
  });

  test('recent decisions across missions show at most three newest timestamps and outcome labels only, sanitized at the public boundary', () => {
    const state = [
      event({ seq: 1, step: 'answer', ts: '2026-10-03T08:36:00Z', text: 'obsolete command', detail: { question: 'old?', answer: 'old outcome' } }),
      event({ missionId: 'two', seq: 1, step: 'answer', ts: '2026-10-03T08:37:00Z', text: 'OP /home/ubuntu/private/command', detail: { question: 'approve?', answer: '거부' } }),
      event({ missionId: 'two', seq: 2, step: 'answer', ts: '2026-10-03T08:38:00Z', text: 'sk-abcdefghijklmnopqrstuvwxyz1234567890', detail: { question: 'token?', answer: '승인 OP /home/ubuntu/private/command' } }),
      event({ missionId: 'three', seq: 1, step: 'answer', ts: '2026-10-03T08:39:00Z', text: 'command raw', detail: { question: 'approve?', answer: '승인' } }),
      event({ missionId: 'three', seq: 2, step: 'done', ts: '2026-10-03T08:39:30Z', text: 'command raw', detail: { result: { kind: 'text', ref: 'secret result' } } }),
    ].reduce(reduceDecisions, EMPTY_DECISIONS);
    const html = display(state);
    expect(html.match(/<li /g)).toHaveLength(3);
    expect(html).toContain('08:39:00Z</time> · 승인');
    expect(html).toContain('08:38:00Z</time> · 승인</li>');
    expect(html).not.toContain('COO');
    expect(html).toContain('08:37:00Z</time> · 거부');
    expect(html).not.toContain('08:36:00Z');
    expect(html).not.toContain('08:39:30Z');
    for (const privateValue of ['obsolete command', 'private/command', 'token?', 'secret result', 'command raw', 'sk-']) expect(html).not.toContain(privateValue);
    expect(leaksInternal(html)).toEqual([]);
  });
});
