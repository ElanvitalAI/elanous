// DR14 focused gate: the real els wheel path (server · holder · attach client · full-screen app) over an eln pane, plus the
// wheel encoder's literal bytes for each herdr route. Expectations are literals, independent of the product constants.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createPaneViewMouse, wheelBytes } from '../../../els/attach-mouse.js';
import { runSimRegressionPack } from './pack.js';
import { clientIsStale } from '../../../els/attach-app.js';

const roots: string[] = [];
afterAll(() => { for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });

test('wheel encoder: SGR report at pane coordinates · X10 report · three ↑/↓ · null for the els scrollback', () => {
  expect(wheelBytes('mouse-sgr', 64, 70, 11)).toBe('\u001b[<64;70;11M');
  expect(wheelBytes('mouse-sgr', 65, 70, 11)).toBe('\u001b[<65;70;11M');
  expect(wheelBytes('mouse-x10', 64, 1, 1)).toBe('\u001b[M`!!');
  expect(wheelBytes('arrows', 64, 5, 5)).toBe('\u001b[A\u001b[A\u001b[A');
  expect(wheelBytes('arrows', 65, 5, 5)).toBe('\u001b[B\u001b[B\u001b[B');
  expect(wheelBytes('host', 64, 5, 5)).toBeNull();
  expect(wheelBytes('mouse-sgr', 0, 5, 5)).toBeNull();
});

test('pane view (els side attach): wheel → route bytes / els scroll; split report held; clicks only to a mouse-tracking pane; status row ignored', () => {
  const m = createPaneViewMouse();
  expect(m.feed('a\u001b[<64;10;5Mb', 'mouse-sgr', 40)).toEqual({ send: 'a\u001b[<64;10;5Mb', scroll: 0 });
  expect(m.feed('\u001b[<65;10;5M', 'arrows', 40)).toEqual({ send: '\u001b[B\u001b[B\u001b[B', scroll: 0 });
  expect(m.feed('\u001b[<64;10;5M\u001b[<64;10;5M', 'host', 40)).toEqual({ send: '', scroll: 6 });
  expect(m.feed('\u001b[<0;10;5M', 'host', 40)).toEqual({ send: '', scroll: 0 });
  expect(m.feed('\u001b[<0;10;5M', 'mouse-sgr', 40)).toEqual({ send: '\u001b[<0;10;5M', scroll: 0 });
  expect(m.feed('\u001b[<64;10;40M', 'mouse-sgr', 40)).toEqual({ send: '', scroll: 0 });
  expect(m.feed('x\u001b[<64;1', 'mouse-sgr', 40)).toEqual({ send: 'x', scroll: 0 });
  expect(m.feed('0;5M', 'mouse-sgr', 40)).toEqual({ send: '\u001b[<64;10;5M', scroll: 0 });
});

test('stale client: a server listing with a different, newer build marks the running client stale; same/older/unknown do not', () => {
  const own = { sha: 'aaaaaaa', builtAt: 1_000 };
  expect(clientIsStale(own, '{"panes":[],"serverBuild":{"sha":"bbbbbbb","builtAt":2000}}')).toBe(true);
  expect(clientIsStale(own, '{"panes":[],"serverBuild":{"sha":"aaaaaaa","builtAt":2000}}')).toBe(false);
  expect(clientIsStale(own, '{"panes":[],"serverBuild":{"sha":"bbbbbbb","builtAt":500}}')).toBe(false);
  expect(clientIsStale(own, '{"panes":[],"serverBuild":{"sha":"bbbbbbb"}}')).toBe(false);
  expect(clientIsStale(own, '{"panes":[]}')).toBe(false);
  expect(clientIsStale(own, 'not json')).toBe(false);
});

test('DR14 PASS · wheel-up over an eln pane in els reaches the chat history (real els attach client)', async () => {
  const root = mkdtempSync(join('/tmp', 'dr14-'));
  roots.push(root);
  const receipt = await runSimRegressionPack({ pack: 'daily-regression', stateRoot: root, only: 'DR14', runId: 'r1' });
  const row = receipt.rows[0]!;
  if (row.verdict !== 'PASS') console.error(`DR14 detail:\n${row.detail}`);
  expect([row.id, row.verdict]).toEqual(['DR14', 'PASS']);
}, 240_000);
