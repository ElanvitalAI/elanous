import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProvenanceBadge } from './ProvenanceBadge';

describe('ProvenanceBadge', () => {
  test('renders each RFC source badge and keeps real sources unbadged', () => {
    for (const [source, label] of [['sim', '🧪 시뮬'], ['replay', '🎞 재생'], ['injected', '💉 주입'], ['shadow', '👻 그림자']] as const) {
      expect(renderToStaticMarkup(<ProvenanceBadge source={source} />)).toContain(label);
    }
    expect(renderToStaticMarkup(<ProvenanceBadge source="real" />)).toBe('');
    expect(renderToStaticMarkup(<ProvenanceBadge source="synthetic-probe" />)).toBe('');
  });

  test('does not expose provenance metadata in a badge', () => {
    const html = renderToStaticMarkup(<ProvenanceBadge source="injected" />);
    expect(html).not.toContain('secret-host');
    expect(html).not.toContain('lease-1');
  });

  test('renders missing tags as unknown', () => {
    expect(renderToStaticMarkup(<ProvenanceBadge source={undefined} />)).toContain('출처 미상');
  });
});
