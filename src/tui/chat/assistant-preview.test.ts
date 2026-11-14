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
