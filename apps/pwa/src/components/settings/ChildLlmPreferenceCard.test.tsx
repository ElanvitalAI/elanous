import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChildLlmPreferenceCard, type ChildLlmDraft } from './ChildLlmPreferenceCard';

const providers = ['grok', 'openai-codex'];

function markup(draft: ChildLlmDraft): string {
  return renderToStaticMarkup(createElement(ChildLlmPreferenceCard as (props: {
    client?: unknown;
    initialDraft?: ChildLlmDraft;
  }) => ReturnType<typeof ChildLlmPreferenceCard>, {
    client: {
      getChildLlmPreference: async () => ({
        resolved: {
          mode: draft.mode,
          chain: draft.chain,
          budgetGate: {
            minHeadroomPercent: Number(draft.minHeadroomPercent),
            onShortfall: draft.onShortfall,
          },
          source: { mode: 'explicit' as const, chain: 'config' as const },
        },
        providers,
      }),
      setChildLlmPreference: async () => { throw new Error('unused'); },
    },
    initialDraft: draft,
  }));
}

test('chain 한 칸이면 순서 칸이 없다', () => {
  const html = markup({
    mode: 'auto',
    chain: [{ provider: 'grok' }],
    minHeadroomPercent: '15',
    onShortfall: 'next-provider',
  });
  expect(html).toContain('data-testid="child-llm-chain"');
  expect(html).not.toContain('data-testid="child-llm-order"');
});

test('chain 두 칸이면 순서 칸이 있다', () => {
  const html = markup({
    mode: 'auto',
    chain: [{ provider: 'grok' }, { provider: 'openai-codex' }],
    minHeadroomPercent: '15',
    onShortfall: 'next-provider',
  });
  expect(html).toContain('data-testid="child-llm-order"');
});
