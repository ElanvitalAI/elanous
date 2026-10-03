// R5.6 — CardSweepView render contract.
//
// Empty / non-empty rendering, source-level wiring guards. Gesture
// + keyboard dispatch run in browser only (jsdom-free env), so we
// pin the dispatch table via source grep — the runtime path is
// exercised by /sessions integration in a future arc.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CardSweepView } from './CardSweepView';
import type { CardSessionData } from './SessionCard';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'CardSweepView.tsx'), 'utf8');

const sample: CardSessionData[] = [
  { id: 's1', msgCount: 5, lastTurnAt: '2026-05-09T07:00Z', ageMs: 60_000, status: 'active', lastMsgPreview: 'first' },
  { id: 's2', msgCount: 3, lastTurnAt: '2026-05-09T06:55Z', ageMs: 5 * 60_000, status: 'active', lastMsgPreview: 'second' },
  { id: 's3', msgCount: 1, lastTurnAt: '2026-05-09T06:00Z', ageMs: 60 * 60_000, status: 'idle' },
  { id: 's4', msgCount: 9, lastTurnAt: '2026-05-09T05:00Z', ageMs: 2 * 60 * 60_000, status: 'idle' },
];

describe('CardSweepView · empty state', () => {
  test('no sessions → empty placeholder', () => {
    const html = renderToStaticMarkup(<CardSweepView sessions={[]} onDecision={() => {}} />);
    expect(html).toContain('data-testid="card-sweep-empty"');
    expect(html).toContain('진행 중인 대화 없음');
  });

  test('emptyText prop overrides default', () => {
    const html = renderToStaticMarkup(
      <CardSweepView sessions={[]} onDecision={() => {}} emptyText="custom hint" />,
    );
    expect(html).toContain('custom hint');
  });
});

describe('CardSweepView · stack rendering', () => {
  test('renders top 3 cards (4 sessions in props → 3 rendered)', () => {
    const html = renderToStaticMarkup(<CardSweepView sessions={sample} onDecision={() => {}} />);
    const matches = html.match(/data-testid="session-card"/g) || [];
    expect(matches.length).toBe(3);
    // s4 is the 4th — should NOT render at initial topIndex=0.
    expect(html).toContain('s1');
    expect(html).toContain('s2');
    expect(html).toContain('s3');
    expect(html).not.toContain('"s4"');
  });

  test('progress indicator + container testids', () => {
    const html = renderToStaticMarkup(<CardSweepView sessions={sample} onDecision={() => {}} />);
    expect(html).toContain('data-testid="card-sweep-view"');
    expect(html).toContain('data-top-index="0"');
    expect(html).toContain('data-testid="card-sweep-progress"');
    expect(html).toContain('1 / 4');
  });

  test('active card is the topmost', () => {
    const html = renderToStaticMarkup(<CardSweepView sessions={sample} onDecision={() => {}} />);
    // Top card has data-active="true"; behind have "false".
    const activeMatches = html.match(/data-active="true"/g) || [];
    const peekMatches = html.match(/data-active="false"/g) || [];
    expect(activeMatches.length).toBe(1);
    expect(peekMatches.length).toBe(2);
  });

  test('aria role + label declare the gesture model', () => {
    const html = renderToStaticMarkup(<CardSweepView sessions={sample} onDecision={() => {}} />);
    expect(html).toContain('role="region"');
    expect(html).toContain('거절');
    expect(html).toContain('승인');
    expect(html).toContain('잠시 멈춤');
    expect(html).toContain('펼치기');
  });
});

describe('CardSweepView · source-level wiring guards', () => {
  test('imports attachSwipe4 from the gesture lib', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*attachSwipe4[^}]*\}\s*from\s*['"]@\/lib\/swipe-gesture['"]/);
  });

  test('decision dispatch table covers all 4 directions', () => {
    expect(SRC).toContain("left: 'reject'");
    expect(SRC).toContain("right: 'approve'");
    expect(SRC).toContain("up: 'pause'");
    expect(SRC).toContain("down: 'expand'");
  });

  test('keyboard fallback covers arrow keys + space', () => {
    expect(SRC).toContain("ArrowLeft: 'reject'");
    expect(SRC).toContain("ArrowRight: 'approve'");
    expect(SRC).toContain("ArrowUp: 'pause'");
    expect(SRC).toContain("ArrowDown: 'expand'");
    expect(SRC).toMatch(/' ': 'approve'/);
  });

  test('tabIndex=0 + touch-none for gesture friendliness', () => {
    expect(SRC).toContain('tabIndex={0}');
    expect(SRC).toContain('touch-none');
  });
});
