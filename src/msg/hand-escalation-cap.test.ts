// HAND-FLOOD-CAP (11-25 22:5x) — tonight's 146 automated ✋ rows to OP in 30 min, replayed at the post layer.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from './msg-store.js';

const root = mkdtempSync(join(tmpdir(), 'hand-cap-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('146 tonight-shaped ✋ escalation rows to OP → at most 3 new rows; the rest fold', () => {
  const store = new MsgStore(join(root, 'a.db'));
  const rows: Array<[string, string, string]> = [];
  for (let i = 0; i < 64; i++) rows.push(['OP', `hand-told:${1000 + i}`, `[✋ auto-escalated] TC's ✋ #${1000 + i} had no outcome from you in 10m — it went to CLAUDE-OP.`]);
  for (let i = 0; i < 60; i++) rows.push(['TC', 'hand-escalation:auto', `[✋ ESCALATED · TC → OP · no outcome in 38m] TC gave no outcome #${2000 + i}`]);
  for (let i = 0; i < 16; i++) rows.push(['OP', `hand-told:${3000 + i}`, `[✋ auto-escalated] JUD's ✋ #${3000 + i} had no outcome from you in 10m`]);
  for (let i = 0; i < 6; i++) rows.push(['JUD', 'hand-escalation:auto', `[✋ ESCALATED · JUD → OP · no outcome in 12m] JUD gave no outcome #${4000 + i}`]);
  expect(rows.length).toBe(146);
  const ids = new Set<number>();
  rows.forEach(([from, tag, body], i) => ids.add(store.appendWithProvenance({ from, to: 'OP', kind: 'request', intent: 'decision', refs: [tag], body }, `k-${i}`).id));
  expect(ids.size).toBe(3);
  const stored = store.db.query("SELECT COUNT(*) AS n FROM msg_messages WHERE recipient = 'OP'").get() as { n: number };
  expect(stored.n).toBe(3);
  // exactly once per key: a re-run of the same sweep writes nothing new
  store.appendWithProvenance({ from: 'TC', to: 'OP', kind: 'request', intent: 'decision', refs: ['hand-escalation:auto'], body: 'again' }, 'k-70');
  expect((store.db.query("SELECT COUNT(*) AS n FROM msg_messages WHERE recipient = 'OP'").get() as { n: number }).n).toBe(3);
});

test('the beacon card (untagged) and ordinary mail are never folded', () => {
  const store = new MsgStore(join(root, 'b.db'));
  for (let i = 0; i < 5; i++) store.appendWithProvenance({ from: 'TC', to: 'OP', kind: 'request', intent: 'decision', refs: ['hand-escalation:auto'], body: `esc ${i}` }, `e-${i}`);
  const card = store.appendWithProvenance({ from: 'TC', to: 'OP', kind: 'request', intent: 'decision', refs: ['hand-beacon'], body: '[✋ BEACON · TC → OP] TC blocked' }, 'hand-beacon:1');
  const plain = store.appendWithProvenance({ from: 'TC', to: 'OP', kind: 'info', intent: 'info', body: 'plain note' }, 'p-1');
  expect(card.body.startsWith('[✋ BEACON')).toBe(true);
  expect(plain.body).toBe('plain note');
  expect((store.db.query("SELECT COUNT(*) AS n FROM msg_messages WHERE recipient = 'OP'").get() as { n: number }).n).toBe(5);
});
