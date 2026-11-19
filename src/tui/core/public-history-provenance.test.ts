import { expect, test } from 'bun:test';
import { buildTurnInterruptedMarker, TURN_INTERRUPTED_MARKER, TURN_STALLED_MARKER } from '../../chat/interjection.js';
import { nextTuiPublicHistory } from './public-history.js';
import type { SerializedMessage } from '../../session/index.js';

const user = (content: string): SerializedMessage => ({ role: 'user', content, ts: '3' });
const question = user('question');
for (const text of [TURN_INTERRUPTED_MARKER, TURN_STALLED_MARKER, '[Request interrupted by user]', buildTurnInterruptedMarker({reason:'stall',toolInFlight:true}), TURN_STALLED_MARKER + '를 설명해줘']) {
  test(`human text ${text} preserves final and auth failure`, () => {
    const final: SerializedMessage = {role:'assistant',content:'answer',ts:'2',replyFinal:true};
    const auth: SerializedMessage = {role:'assistant',content:'private',ts:'2',replyFinal:false,replyFailure:true,replyFailureKind:'codex-auth-missing'};
    expect(nextTuiPublicHistory([question,final,user(text)])[1]?.content).toBe('answer');
    expect(nextTuiPublicHistory([question,auth,user(text)])[1]?.content).toContain('접근 미러를 갱신하세요');
  });
}
for (const reason of ['interrupt','stall'] as const) {
  test(`proven ${reason} marker hides partial even if flagged final`, () => {
    const marker = {...user(buildTurnInterruptedMarker(reason === 'stall' ? {reason:'stall'} : undefined)), interruptionMarker: true} as SerializedMessage;
    expect(nextTuiPublicHistory([question,{role:'assistant',content:'partial',ts:'2',replyFinal:true},marker])[1]?.role).toBe('system');
  });
}
test('legacy unmarked interruption never exposes an unverified partial', () => {
  expect(nextTuiPublicHistory([question,{role:'assistant',content:'partial',ts:'2'},user(TURN_INTERRUPTED_MARKER)])[1]?.role).toBe('system');
});


test('flagged interruption row is hidden but its index remains', () => {
  const marker: SerializedMessage = { role: 'user', content: '[사용자가 이 턴을 중단했습니다]', ts: '3', interruptionMarker: true };
  const visible = nextTuiPublicHistory([question, marker]);
  expect(visible).toHaveLength(2);
  expect(visible[1]).toEqual({ role: 'system', content: '', ts: '3' });
});

test('same literal without provenance remains visible as human input', () => {
  const human: SerializedMessage = { role: 'user', content: '[사용자가 이 턴을 중단했습니다]', ts: '3' };
  expect(nextTuiPublicHistory([question, human])[1]).toEqual(human);
});
