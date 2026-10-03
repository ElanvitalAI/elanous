import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
import { ChatMessageView } from './ChatMessage';

type Message = ComponentProps<typeof ChatMessageView>['message'];

const fence = '```elanous-card\n{"kind":"coo-admin","items":[{"title":"Pay bill","due":"2026-10-01","daysLeft":-1,"state":"open","owner":"OP"}]}\n```';
const message = (role: Message['role'], text: string, blocks?: Message['blocks']): Message => ({
  id: 'card-message', role, text, timestamp: 0, blocks,
} as Message);

describe('ChatMessage card rendering', () => {
  test('renders a card below remaining text in an assistant flat message', () => {
    const html = renderToStaticMarkup(<ChatMessageView message={message('assistant', `Before\n${fence}\nAfter`)} />);
    expect(html).toContain('Before');
    expect(html).toContain('After');
    expect(html).toContain('data-elanous-card-kind="coo-admin"');
    expect(html).toContain('Pay bill');
    expect(html).not.toContain('```elanous-card');
    expect(html.indexOf('After')).toBeLessThan(html.indexOf('data-elanous-card-kind'));
  });

  test('renders a card from the text-block path', () => {
    const html = renderToStaticMarkup(<ChatMessageView message={message('assistant', '', [
      { kind: 'text', text: `Before\n${fence}` },
    ] as Message['blocks'])} />);
    expect(html).toContain('Before');
    expect(html).toContain('data-elanous-card-kind="coo-admin"');
    expect(html).not.toContain('```elanous-card');
  });

  test('preserves malformed and unknown-kind fences as markdown instead of rendering cards', () => {
    const text = '```elanous-card\n{broken\n```\n```elanous-card\n{"kind":"unknown","items":[]}\n```';
    const html = renderToStaticMarkup(<ChatMessageView message={message('assistant', text)} />);
    expect(html).toContain('{broken');
    expect(html).toContain('unknown');
    expect(html).not.toContain('data-elanous-card-kind');
  });

  test('shows a user message exactly as typed — no card, nothing dropped', () => {
    const html = renderToStaticMarkup(<ChatMessageView message={message('user', `Before\n${fence}\nAfter`)} />);
    expect(html).toContain('Before');
    expect(html).toContain('After');
    expect(html).toContain('Pay bill');
    expect(html).not.toContain('data-elanous-card-kind');
  });
});
