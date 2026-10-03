// R5.7 — SessionsDeckPanel render contract + source-level wire pin.
// Polling + dispatch run in browser only; pin via grep so refactor
// can't silently strip the endpoint paths.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SessionsDeckPanel } from './SessionsDeckPanel';
import { DaemonContext } from '@/components/providers/DaemonProvider';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'SessionsDeckPanel.tsx'), 'utf8');

const STUB_DAEMON = {
  config: { baseUrl: '', token: '', provider: '' },
  setConfig: () => {},
  client: {} as never,
  sessionId: 'sess-test',
  setSessionId: () => {},
};

describe('SessionsDeckPanel · render contract', () => {
  test('renders heading + sweep view + footer', () => {
    const html = renderToStaticMarkup(
      <DaemonContext.Provider value={STUB_DAEMON}>
        <SessionsDeckPanel />
      </DaemonContext.Provider>,
    );
    expect(html).toContain('data-testid="sessions-deck-panel"');
    expect(html).toContain('대화 카드 데크');
    // CardSweepView 가 빈 상태로 렌더 (no sessions yet)
    expect(html).toContain('data-testid="card-sweep-empty"');
    expect(html).toContain('스와이프');
  });
});

describe('SessionsDeckPanel · source-level wiring', () => {
  test('polls GET /v1/sessions/active', () => {
    expect(SRC).toContain('/v1/sessions/active');
  });

  test('dispatches POST /v1/sessions/<id>/decision', () => {
    expect(SRC).toMatch(/\/v1\/sessions\/\$\{[^}]+\}\/decision/);
  });

  test('?stale=1 query when toggle enabled', () => {
    expect(SRC).toContain("?stale=1");
  });

  test('decision label table covers all 4 decisions in Korean', () => {
    expect(SRC).toContain("reject: '거절'");
    expect(SRC).toContain("approve: '승인'");
    expect(SRC).toContain("pause: '잠시 멈춤'");
    expect(SRC).toContain("expand: '펼치기'");
  });

  test('forwards decision body in POST', () => {
    expect(SRC).toMatch(/JSON\.stringify\(\{\s*decision\s*\}\)/);
  });
});
