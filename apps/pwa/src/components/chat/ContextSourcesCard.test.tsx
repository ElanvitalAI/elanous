import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextSourcesCard } from './ContextSourcesCard';
import { ChatMessageView } from './ChatMessage';
import { contextSources } from './context-sources';

const sources = [{ label: 'CTO 자리 루프 · 출처 카드 구현', ago: '5분 전', source: 'elanous://seat-loop/TC/2026-10-03#3' },
  { label: '결정 대기 D-1', ago: null, source: 'elanous://decisions/D-1' }];

test('card shows labelled list with each provenance URI in its title and age only when present', () => {
  const html = renderToStaticMarkup(<ContextSourcesCard sources={sources} />);
  expect(html).toContain('<ul aria-label="출처"');
  expect(html).toContain('title="elanous://seat-loop/TC/2026-10-03#3"');
  expect(html).toContain('CTO 자리 루프 · 출처 카드 구현 · 5분 전');
  expect(html).toContain('title="elanous://decisions/D-1"');
  expect(html).toContain('결정 대기 D-1</li>');
});

test('unsafe daemon source does not become a title attribute', () => {
  const projected = contextSources({
    at: '2026-10-03T05:30:00Z', topic: null, guide: [], events: [],
    facts: [
      { kind: 'seat', seat: 'TC', at: '2026-10-03T05:25:00Z', status: 'now', id: null, title: '작업', source: '/home/ubuntu/private' },
      { kind: 'decision', id: 'D-1', title: '결정', status: 'open', dueAt: null, source: 'elanous://decisions/D-1' },
    ],
  }, Date.parse('2026-10-03T05:30:00Z'));
  const html = renderToStaticMarkup(<ContextSourcesCard sources={projected ?? []} />);
  expect(html).toContain('title="elanous://decisions/D-1"');
  expect(html).not.toContain('/home/ubuntu/private');
});

test('no sources or empty sources render no card', () => {
  expect(renderToStaticMarkup(<ContextSourcesCard />)).toBe('');
  expect(renderToStaticMarkup(<ContextSourcesCard sources={[]} />)).toBe('');
});

test('chat tool pill immediately precedes the source card, absent on another tool', () => {
  const message = { id: 'm', role: 'assistant' as const, text: '', timestamp: 0,
    blocks: [{ kind: 'tool_use' as const, id: 'c1', name: 'context_now', status: 'done' as const, sources }] };
  const html = renderToStaticMarkup(<ChatMessageView message={message} />);
  expect(html).toMatch(/data-elanous-block-kind="tool_use"[\s\S]*?<\/button><\/div><ul aria-label="출처"/);
  expect(html).toContain('title="elanous://decisions/D-1"');
  const noSources = renderToStaticMarkup(<ChatMessageView message={{ ...message,
    blocks: [{ kind: 'tool_use', id: 'c1', name: 'Read', status: 'done' }],
  }} />);
  expect(noSources).not.toContain('aria-label="출처"');
});
