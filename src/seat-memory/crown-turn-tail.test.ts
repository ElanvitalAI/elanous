// ELN-OP-CROWN-MEMORY S1/S2 — the turn tail over a real seat store (temp dir). Expectations are independent literals (rule 11).
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSeatMemory } from './seat-memory.js';
import { crownTurnTail } from './seat-memory-layers.js';

const CAPS = { prefix: 'crown-', turnMaxCards: 2, turnMaxChars: 1500, updateMaxChars: 1500 };
const T = Date.parse('2026-11-28T12:00:00.000Z');
const card = (name: string, until: string, body: string) => ({ name, description: `범위 · 대상 MK · 만료 ${until}`, type: 'feedback', body });

describe('crown turn tail', () => {
  test('S2: live crown- cards every turn (newest expiry first · cap) · expired skipped · S1: lines after the snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crown-tail-'));
    try {
      saveSeatMemory({ name: 'old-fact', description: 'an old fact', type: 'project', body: 'old body' }, dir, 'OP');
      const snapshot = '- [old-fact](old-fact.md) — an old fact';
      saveSeatMemory(card('crown-1128-mk-docs-only-aaaaaa', '2026-11-28T14:00:00.000Z', 'A body'), dir, 'OP');
      saveSeatMemory(card('crown-1128-tc-release-never-bbbbbb', '2026-11-29T12:00:00.000Z', 'B body'), dir, 'OP');
      saveSeatMemory(card('crown-1127-ux-pwa-only-cccccc', '2026-11-28T11:00:00.000Z', 'C body'), dir, 'OP');
      saveSeatMemory({ name: 'new-fact', description: 'a new fact', type: 'project', body: 'new body' }, dir, 'OP');
      const tail = crownTurnTail({ seat: 'OP', dir, nowMs: T, snapshot }, CAPS)!;
      expect(tail.cards).toEqual(['crown-1128-tc-release-never-bbbbbb', 'crown-1128-mk-docs-only-aaaaaa']);
      expect(tail.text).toContain('### crown-1128-tc-release-never-bbbbbb\nB body');
      expect(tail.text).not.toContain('C body');
      expect(tail.text).toContain('- [new-fact](new-fact.md) — a new fact');
      expect(tail.text).not.toContain('- [old-fact]');
      expect(tail.text).not.toContain('- [crown-1128-mk-docs-only-aaaaaa]'); // already carried by S2
      expect(crownTurnTail({ seat: 'OP', dir, nowMs: Date.parse('2026-11-30T00:00:00.000Z'), snapshot: null }, CAPS)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
