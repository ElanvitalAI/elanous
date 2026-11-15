import { expect, test } from 'bun:test';
import { nextAssistantPreviewText } from './assistant-preview.js';
import { streamReplyLines } from './log-view.js';

test('split credentials and terminal sequences stay hidden in every intermediate paint', () => {
  let text = '';
  const frames: string[] = [];
  for (const chunk of ['공연 설계 중\nDEMO_API_KEY=pr', 'ivate-fixture-', 'value-123456', '\n안전한 답변 ',
    '\x1b]52;c;PRIVATE-', 'CLIPBOARD', '\x07\n다음 문장 ']) {
    text += chunk;
    frames.push(streamReplyLines(nextAssistantPreviewText(text), 100).join('\n'));
  }
  expect(frames.every((frame) => !frame.includes('DEMO_API_KEY=pr'))).toBe(true);
  expect(frames.every((frame) => !frame.includes('private-fixture'))).toBe(true);
  expect(frames.every((frame) => !frame.includes('PRIVATE-CLIPBOARD'))).toBe(true);
  expect(frames.at(-1)).toContain('안전한 답변');
  expect(frames.at(-1)).toContain('다음 문장');
});

test('an unfinished private-key block stays hidden until shared redaction can mask it', () => {
  const opening = '공연 설계\n-----BEGIN PRIVATE KEY-----\n';
  expect(nextAssistantPreviewText(`${opening}PRIVATE-KEY-BODY\n`)).toBe('공연 설계\n');
  const complete = `${opening}PRIVATE-KEY-BODY\n-----END PRIVATE KEY-----\n`;
  const frame = streamReplyLines(nextAssistantPreviewText(complete), 100).join('\n');
  expect(frame).toContain('<private-key redacted>');
  expect(frame).not.toContain('PRIVATE-KEY-BODY');
  const secondOpening = `${complete}\n${opening}SECOND-PRIVATE-BODY\n`;
  expect(nextAssistantPreviewText(secondOpening)).not.toContain('SECOND-PRIVATE-BODY');
});

test('space-free Korean prose can paint before the turn settles', () => {
  let text = '';
  for (const chunk of ['첫째조각도착시작', '둘째조각계속표시', '셋째조각종료완료']) {
    text += chunk;
    expect(nextAssistantPreviewText(text)).toBe(text);
  }
});

test.each(['설명DEMO_API_KEY=pr', '인증번호123456', '설명https://private.example'])(
  'mixed identifier and numeric tails remain withheld: %s', (tail) => {
    expect(nextAssistantPreviewText('공개 문장 ' + tail)).toBe('공개 문장 ');
  },
);

test('Unicode letter and punctuation tails include fullwidth marks and Japanese prolonged sound', () => {
  for (const text of ['你好，世界', '確認：完了。', 'スーパー', 'こんにちは、世界。']) {
    expect(nextAssistantPreviewText(text)).toBe(text);
  }
});

test('a previously painted CJK prefix does not release a later ASCII credential suffix', () => {
  let text = '';
  const frames: string[] = [];
  for (const delta of ['説明', 'DEMO_', 'API_KEY=pr', 'ivate-fixture-value-123456', '\n安全な回答 ']) {
    text += delta;
    frames.push(streamReplyLines(nextAssistantPreviewText(text), 100).join('\n'));
  }
  // Earlier CJK prose is visible; the projection cannot predict a future suffix.
  expect(frames[0]).toContain('説明');
  expect(frames.slice(0, -1).every(frame => !frame.includes('DEMO_'))).toBe(true);
  expect(frames.every(frame => !frame.includes('private-fixture'))).toBe(true);
  expect(frames.at(-1)).toContain('安全な回答');
});

test('ASCII punctuation-only unfinished tails stay buffered while Unicode prose paints', () => {
  for (const tail of ['---', '...', '?!', '::', '___']) {
    expect(nextAssistantPreviewText('공개 문장 ' + tail)).toBe('공개 문장 ');
    expect(nextAssistantPreviewText(tail)).toBe('');
  }
  for (const text of ['你好，世界', 'スーパー', '確認：完了。', '。']) {
    expect(nextAssistantPreviewText(text)).toBe(text);
  }
});
