import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
import { ChatMessageView } from './ChatMessage';

// DEMO-1121-WEBCHAT-CITATION — 답변 속 웹 근거 URL 인용이 폴드에서 눌러 열 수 있는 링크로 그려지는지.
type Message = ComponentProps<typeof ChatMessageView>['message'];
const assistant = (text: string): Message => ({ id: 'cite-1', role: 'assistant', text, timestamp: 0 } as Message);

describe('ChatMessage web citation rendering', () => {
  const urls = ['https://example.test/a', 'https://example.test/b', 'https://example.test/c'];
  const text = `삼성전자 실적 요약입니다.\n\n출처\n${urls.map((u, i) => `- [근거 ${i + 1}](${u})`).join('\n')}`;

  test('each cited url becomes an anchor that opens safely in a new tab', () => {
    const html = renderToStaticMarkup(<ChatMessageView message={assistant(text)} />);
    for (const url of urls) {
      expect(html).toContain(`href="${url}"`);
    }
    expect(html).toContain('근거 1');
    expect(html).toContain('근거 3');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test('a javascript: citation never becomes a clickable href', () => {
    const html = renderToStaticMarkup(<ChatMessageView message={assistant('[누르세요](javascript:alert(1))')} />);
    expect(html).not.toContain('href="javascript:');
  });
});
