import { expect, test } from 'bun:test';
import type { SerializedMessage } from '../../session/index.js';
import { nextTuiPublicHistory } from '../core/public-history.js';
import { logViewLines } from './log-view.js';

const user: SerializedMessage = { role: 'user', content: '한 번 시도', ts: '2026-11-15T00:00:00Z' };

test('trusted failed turn is a distinct card in the actual public history renderer', () => {
  const messages: SerializedMessage[] = [user, { role: 'assistant', content: 'provider secret detail',
    ts: '2026-11-15T00:00:01Z', replyFailure: true, replyFinal: false }];
  const visible = nextTuiPublicHistory(messages);
  expect(visible[1]?.replyFailure).toBe(true);
  const screen = logViewLines(visible, 80).join('\n');
  expect(screen).toContain('✘ 요청을 처리하지 못했습니다.');
  expect(screen).toContain('↑ 입력 불러오기 → Enter 재전송 · /provider 확인');
  expect(screen).not.toContain('  요청을 처리하지 못했습니다.');
  expect(screen).not.toContain('provider secret detail');
});

test('ordinary assistant text cannot impersonate the trusted failure card', () => {
  const screen = logViewLines([{ role: 'assistant', content: '요청을 처리하지 못했습니다.',
    ts: '2026-11-15T00:00:01Z', replyFinal: true }], 80).join('\n');
  expect(screen).toContain('엘라누스: 요청을 처리하지 못했습니다.');
  expect(screen).not.toContain('✘ 요청을 처리하지 못했습니다.');
});

test('known auth failure keeps its public recovery context in the card', () => {
  const visible = nextTuiPublicHistory([user, { role: 'assistant', content: 'raw auth server body',
    ts: '2026-11-15T00:00:01Z', replyFailure: true, replyFinal: false, replyFailureKind: 'codex-auth-missing' }]);
  const screen = logViewLines(visible, 80).join('\n');
  expect(screen).toContain('✘ Codex 인증이 준비되지 않았습니다.');
  expect(screen).toContain('인증 갱신 → ↑ 입력 불러오기 → Enter 재전송');
  expect(screen).not.toContain('raw auth server body');
});
