import { expect, test } from 'bun:test';
import { TURN_INTERRUPTED_MARKER } from '../../chat/interjection.js';
import type { SerializedMessage } from '../../session/index.js';
import { nextTuiPublicHistory } from './public-history.js';

test('basic Next chat keeps saved indexes but shows only the final projected answer per turn', () => {
  const messages: SerializedMessage[] = [
    { role: 'user', content: '질문', ts: '1' },
    { role: 'assistant', content: '중간 내부 초안', ts: '2', goalInterim: true },
    { role: 'tool', content: 'SECRET', toolName: 'Bash SECRET', toolResult: 'stdout SECRET', ts: '3' },
    { role: 'assistant', content: '첫 시도', ts: '4' },
    { role: 'assistant', content: '최종 답', ts: '5', replyFinal: true },
    { role: 'user', content: '다음 질문', ts: '6' },
    { role: 'tool', content: 'PRIVATE', toolName: 'Read PRIVATE', ts: '7' },
    { role: 'assistant', content: '두 번째 답', ts: '8', replyFinal: true },
  ];
  const projected = nextTuiPublicHistory(messages);
  expect(projected).toHaveLength(messages.length);
  expect(projected.map((m) => m.role)).toEqual([
    'user', 'system', 'system', 'system', 'assistant', 'user', 'system', 'assistant',
  ]);
  expect(projected[4]?.content).toBe('최종 답');
  expect(projected[7]?.content).toBe('두 번째 답');
  expect(JSON.stringify(projected)).not.toContain('SECRET');
  expect(JSON.stringify(projected)).not.toContain('PRIVATE');
  expect(messages[2]?.role).toBe('tool');
  const stillRunning = nextTuiPublicHistory(messages, true);
  expect(stillRunning[4]?.content).toBe('최종 답');
  expect(stillRunning[7]?.role).toBe('system');
});

test('basic Next chat renders explicit final actions in order', () => {
  const messages: SerializedMessage[] = [
    { role: 'user', content: '정리해줘', ts: '1' },
    { role: 'assistant', content: '정리했습니다.\n\n할 일:\n- 검토하세요.\n- 공유하세요.', ts: '2', replyFinal: true },
  ];
  expect(nextTuiPublicHistory(messages)[1]?.content).toBe('정리했습니다.\n\n할 일: 검토하세요.\n할 일: 공유하세요.');
});

test('trailing actions keep the original blank line before the action block', () => {
  const messages: SerializedMessage[] = [
    { role: 'user', content: '계획', ts: '1' },
    { role: 'assistant', content: '첫 문단\n둘째 문단\n\n할 일:\n- 확인', ts: '2', replyFinal: true },
  ];
  expect(nextTuiPublicHistory(messages)[1]?.content).toBe('첫 문단\n둘째 문단\n\n할 일: 확인');
});

test('basic Next history hides uncommitted drafts after tool failure or cancellation', () => {
  const messages: SerializedMessage[] = [
    { role: 'user', content: '실행해줘', ts: '1' },
    { role: 'assistant', content: '내부 초안', ts: '2' },
    { role: 'tool', content: '실패한 도구 원문', ts: '3' },
    { role: 'assistant', content: '중단된 부분 답', ts: '4', replyFinal: false },
    { role: 'user', content: '[Request interrupted by user]', ts: '5' },
    { role: 'user', content: '다시 해줘', ts: '6' },
    { role: 'assistant', content: '완료 답', ts: '7', replyFinal: true },
  ];
  const visible = nextTuiPublicHistory(messages);
  expect(visible[1]?.role).toBe('system');
  expect(visible[3]?.role).toBe('system');
  expect(visible[6]?.content).toBe('완료 답');
  expect(JSON.stringify(visible)).not.toContain('내부 초안');
  expect(JSON.stringify(visible)).not.toContain('중단된 부분 답');
  expect(JSON.stringify(visible)).not.toContain('실패한 도구 원문');
});


test('a later user turn does not certify an unmarked legacy partial reply', () => {
  const messages: SerializedMessage[] = [
    { role: 'user', content: '첫 질문', ts: '1' },
    { role: 'assistant', content: '첫 완료 답', ts: '2' },
    { role: 'user', content: '두 번째 질문', ts: '3' },
    { role: 'assistant', content: '두 번째 완료 답', ts: '4' },
  ];
  const projected = nextTuiPublicHistory(messages);
  expect(projected[1]?.role).toBe('system');
  expect(projected[3]?.content).toBe('이전 버전 기록 · 완료 여부 확인 안 됨\n\n두 번째 완료 답');
  expect(nextTuiPublicHistory(messages, true)[3]?.role).toBe('system');
});

test('legacy interrupted partial and tool drafts stay hidden while the terminal answer is restored', () => {
  const messages: SerializedMessage[] = [
    { role: 'user', content: '실행해줘', ts: '1' },
    { role: 'assistant', content: '중단된 부분 답', ts: '2' },
    { role: 'user', content: TURN_INTERRUPTED_MARKER, ts: '3' },
    { role: 'user', content: '다시 실행해줘', ts: '4' },
    { role: 'assistant', content: '도구 전 내부 초안', ts: '5' },
    { role: 'tool', content: '비밀 도구 결과', ts: '6' },
    { role: 'assistant', content: '정상 완료 답', ts: '7' },
  ];
  const projected = nextTuiPublicHistory(messages);
  expect(projected[1]?.role).toBe('system');
  expect(projected[4]?.role).toBe('system');
  expect(projected[6]?.content).toBe('이전 버전 기록 · 완료 여부 확인 안 됨\n\n정상 완료 답');
  expect(JSON.stringify(projected)).not.toContain('중단된 부분 답');
  expect(JSON.stringify(projected)).not.toContain('도구 전 내부 초안');
  expect(JSON.stringify(projected)).not.toContain('비밀 도구 결과');
});

test('a terminal legacy partial left before an interruption marker was saved is explicitly unverified', () => {
  const messages: SerializedMessage[] = [
    { role: 'user', content: '긴 요청', ts: '1' },
    { role: 'assistant', content: '중단 직전 부분 텍스트', ts: '2' },
  ];
  expect(nextTuiPublicHistory(messages)[1]?.content)
    .toBe('이전 버전 기록 · 완료 여부 확인 안 됨\n\n중단 직전 부분 텍스트');
});


test('Next basic chat preserves a long final code answer without cutting its body', () => {
  const code = '코드 설명\n' + 'const answer = 42;\n'.repeat(90);
  const messages: SerializedMessage[] = [
    { role: 'user', content: '코드 작성', ts: '1' },
    { role: 'assistant', content: code, ts: '2', replyFinal: true },
  ];
  expect(nextTuiPublicHistory(messages)[1]?.content).toContain('const answer = 42;');
  expect(nextTuiPublicHistory(messages)[1]?.content).toBe(code);
});

test('Next final projection preserves code indentation, tabs and surrounding whitespace', () => {
  const code = '\n```ts\nfunction answer() {\n\treturn 42;\n    return 43;\n}\n```\n';
  const messages: SerializedMessage[] = [
    { role: 'user', content: '코드', ts: '1' },
    { role: 'assistant', content: code, ts: '2', replyFinal: true },
  ];
  expect(nextTuiPublicHistory(messages)[1]?.content).toBe(code);
});

test('an indented action list inside final code remains answer text', () => {
  const answer = '코드\n\n```text\n    할 일:\n    - 첫 항목\n    - 둘째 항목\n```';
  const messages: SerializedMessage[] = [
    { role: 'user', content: '코드', ts: '1' },
    { role: 'assistant', content: answer, ts: '2', replyFinal: true },
  ];
  expect(nextTuiPublicHistory(messages)[1]?.content).toBe(answer);
});

test('a failed turn keeps a fixed public failure after resume while cancellation stays hidden', () => {
  const messages: SerializedMessage[] = [
    { role: 'user', content: '실행', ts: '1' },
    { role: 'assistant', content: 'PRIVATE partial', ts: '2', replyFinal: false },
    { role: 'assistant', content: 'PRIVATE raw error', ts: '3', replyFinal: false, replyFailure: true },
    { role: 'user', content: '취소 뒤 재시도', ts: '4' },
    { role: 'assistant', content: 'PRIVATE cancelled', ts: '5', replyFinal: false },
  ];
  const visible = nextTuiPublicHistory(messages);
  expect(visible[2]?.content).toBe('요청을 처리하지 못했습니다.');
  expect(visible[4]?.role).toBe('system');
  expect(JSON.stringify(visible)).not.toContain('PRIVATE');
});

test('known Codex auth failure stays actionable after resume without exposing arbitrary errors', () => {
  const messages: SerializedMessage[] = [
    { role: 'user', content: '질문', ts: '1' },
    { role: 'assistant', content: 'Codex 인증이 준비되지 않았습니다. 주인 호스트에서 접근 미러를 갱신하세요.', ts: '2', replyFinal: false, replyFailure: true, replyFailureKind: 'codex-auth-missing' },
  ];
  expect(nextTuiPublicHistory(messages)[1]?.content).toContain('접근 미러를 갱신하세요');
  messages[1]!.content = 'PRIVATE unrelated provider error: Codex 인증이 준비되지 않았습니다. 주인 호스트에서 접근 미러를 갱신하세요.';
  delete messages[1]!.replyFailureKind;
  expect(nextTuiPublicHistory(messages)[1]?.content).toBe('요청을 처리하지 못했습니다.');
});

test('unclosed tilde and indented backtick fences never turn code lists into actions', () => {
  for (const fence of ['~~~text', '    ```text']) {
    const answer = `설명\n\n${fence}\n코드\n\n할 일:\n- 비밀 목록`;
    const messages: SerializedMessage[] = [
      { role: 'user', content: '코드', ts: '1' },
      { role: 'assistant', content: answer, ts: '2', replyFinal: true },
    ];
    expect(nextTuiPublicHistory(messages)[1]?.content).toBe(answer);
  }
  const closed = '설명\n\n~~~text\n코드\n~~~\n\n할 일:\n- 검토';
  const messages: SerializedMessage[] = [
    { role: 'user', content: '요약', ts: '1' },
    { role: 'assistant', content: closed, ts: '2', replyFinal: true },
  ];
  expect(nextTuiPublicHistory(messages)[1]?.content).toContain('할 일: 검토');
});
