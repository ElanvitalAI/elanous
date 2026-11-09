// P0b — ACP 서피스 채널(confirm/question via pushAsk) 검증(주입 fake pusher).
import { test, expect, describe } from 'bun:test';
import { createAcpConfirmChannel, createAcpQuestionChannel, type AcpAskPusher } from './acp-surface-channels.js';
import type { AskUserQuestionResult } from '../ask-user-question/types.js';

function pusher(result: AskUserQuestionResult | null, capture?: (payload: unknown) => void): AcpAskPusher {
  return async (_sid, payload) => { capture?.(payload); return result; };
}

describe('createAcpConfirmChannel — confirm→2옵션 ask', () => {
  test('답 === yesLabel → true', async () => {
    const ch = createAcpConfirmChannel('s1', pusher({ answers: { confirm: 'PR 열기' } }));
    expect(await ch.request({ prompt: 'PR?', yesLabel: 'PR 열기', noLabel: '보류' })).toBe(true);
  });
  test('답 === noLabel → false', async () => {
    const ch = createAcpConfirmChannel('s1', pusher({ answers: { confirm: '보류' } }));
    expect(await ch.request({ prompt: 'PR?', yesLabel: 'PR 열기', noLabel: '보류' })).toBe(false);
  });
  test('★ peer 없음(null) → null(drop·fail-closed)', async () => {
    const ch = createAcpConfirmChannel('s1', pusher(null));
    expect(await ch.request({ prompt: 'PR?' })).toBeNull();
  });
  test('cancelled → null(drop)', async () => {
    const ch = createAcpConfirmChannel('s1', pusher({ answers: {}, cancelled: true }));
    expect(await ch.request({ prompt: 'PR?' })).toBeNull();
  });
  test('agent-authored confirmation cannot approve a public deploy', async () => {
    const ch = createAcpConfirmChannel('s1', pusher({ answers: { confirm: 'y' }, answeredBy: 'agent' }));
    expect(await ch.request({ prompt: '배포?', header: '배포', yesLabel: 'y', noLabel: 'N' })).toBeNull();
  });
  test('2옵션 payload 형태(includeOther=false·prompt+detail)', async () => {
    let seen: any;
    const ch = createAcpConfirmChannel('s1', pusher({ answers: { confirm: 'Yes' } }, (p) => { seen = p; }));
    await ch.request({ prompt: '열까요?', detail: 'branch x', yesLabel: 'Yes', noLabel: 'No' });
    expect(seen.request.questions[0].options.map((o: any) => o.label)).toEqual(['Yes', 'No']);
    expect(seen.request.questions[0].includeOther).toBe(false);
    expect(seen.request.questions[0].question).toContain('branch x');
  });
});

describe('createAcpQuestionChannel — 구조화 질문 passthrough', () => {
  test('결과 그대로 반환', async () => {
    const ch = createAcpQuestionChannel('s1', pusher({ answers: { sel: 'b' } }));
    const r = await ch.ask({ questions: [{ id: 'sel', header: 'h', question: '?', options: [{ label: 'a', description: '' }, { label: 'b', description: '' }] }] });
    expect(r?.answers['sel']).toBe('b');
  });
  test('peer 없음 → null(drop)', async () => {
    const ch = createAcpQuestionChannel('s1', pusher(null));
    expect(await ch.ask({ questions: [{ id: 'h', header: 'h', question: '?', options: [] }] })).toBeNull();
  });
});
