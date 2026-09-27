// M3-2 (Phase 3) — EmbeddingVisionTierCard SSR mount tests.

import { describe, expect, test, mock } from 'bun:test';
import { restoreModuleMocksAfterAll } from '@/lib/testing/restore-module-mocks';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmbeddingVisionTierCard } from './EmbeddingVisionTierCard';

// Mock the DaemonProvider hook + sync helpers so the SSR pass doesn't
// try to hit a real fetch.
// R-TST23 — 아래 mock.module 은 프로세스 전역이다. 원본을 잡아 두고 파일 끝에 되돌린다(`@/lib/testing/restore-module-mocks`).
await restoreModuleMocksAfterAll([
  '@/components/providers/DaemonProvider',
], (specifier) => import(specifier));

mock.module('@/components/providers/DaemonProvider', () => ({
  useDaemon: () => ({ config: { baseUrl: '', token: '' }, setConfig: () => {}, client: null, sessionId: '' }),
}));

describe('M3-2 · EmbeddingVisionTierCard', () => {
  test('renders both rows with 5 ticks each', () => {
    const html = renderToStaticMarkup(<EmbeddingVisionTierCard />);
    expect(html).toContain('embedding-vision-card');
    expect(html).toContain('embedding-vision-row-embedding');
    expect(html).toContain('embedding-vision-row-vision');
    // 5 ticks × 2 surfaces = 10 buttons.
    for (const tier of ['budget', 'balanced', 'better', 'best', 'loaded'] as const) {
      expect(html).toContain(`embedding-vision-embedding-${tier}`);
      expect(html).toContain(`embedding-vision-vision-${tier}`);
    }
  });

  test('shows surface hints', () => {
    const html = renderToStaticMarkup(<EmbeddingVisionTierCard />);
    expect(html).toContain('RAG retrieval');
    expect(html).toContain('OCR');
  });

  test('shows Smart default badge when no explicit selection', () => {
    const html = renderToStaticMarkup(<EmbeddingVisionTierCard />);
    expect(html).toContain('Smart default');
  });
});
