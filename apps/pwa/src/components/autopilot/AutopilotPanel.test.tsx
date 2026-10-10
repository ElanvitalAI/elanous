import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { DaemonContext } from '@/components/providers/DaemonProvider';
import type { DaemonClient } from '@/lib/daemon-client';
import { AutopilotPanel } from './AutopilotPanel';

// fetchJson never settles: the static render must not depend on any daemon reply.
const pendingClient = { fetchJson: () => new Promise(() => {}) } as unknown as DaemonClient;

function renderPanel(): string {
  return renderToStaticMarkup(
    <DaemonContext.Provider value={{
      client: pendingClient,
      config: { baseUrl: '', token: '', provider: '' },
      sessionId: '',
      setConfig: () => {},
      setSessionId: () => {},
    }}>
      <AutopilotPanel />
    </DaemonContext.Provider>,
  );
}

describe('AutopilotPanel static render', () => {
  test('shows only Missions and 자율행동 tabs, defaults to Missions, and has exactly one h1', () => {
    const html = renderPanel();
    const tabBar = html.match(/<div class="flex gap-1 border-b border-border">([\s\S]*?)<\/div>/)?.[1];

    expect(tabBar).toBeDefined();
    expect([...tabBar!.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map((match) => match[1])).toEqual([
      'Missions', '자율행동',
    ]);
    expect(html).toContain('Missions');
    expect(html).toContain('자율행동');
    expect(html).not.toContain('Repo Watch');
    expect(html).not.toContain('루프 오케스트라');
    expect(html).not.toContain('투자 루프 오케스트라');
    // default tab = Missions (inline goal composer is rendered)
    expect(html).toContain('골 던지기');
    expect(html).toContain('<textarea');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  test('Missions empty state points up to the composer, not down', () => {
    const src = readFileSync(join(import.meta.dir, 'AutopilotMissions.tsx'), 'utf8');
    expect(src).not.toContain('아래 &ldquo;골 던지기&rdquo;');
    expect(src).toContain('위 &ldquo;골 던지기&rdquo;');
    // composer is placed before the empty-state text in the source order
    expect(src.indexOf('골 던지기 <span')).toBeLessThan(src.indexOf('위 &ldquo;골 던지기&rdquo;'));
  });
});
