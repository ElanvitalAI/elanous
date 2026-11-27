/**
 * SIM — TURN-SHRINK (CEO 11-26 22:5x item 3). Today's two shapes: 21:41 a 47-mail bundle, 22:45 ten seat mails plus a
 * pulse digest of 1 039 overdue follow-ups — each turn alone over the allowance (cap 71 650 − prefix 23 650 = 48 000
 * tokens), so the turn failed whole. Seeds 1–5 build the 22:45 turn text with an uncapped digest of 1 039 rows and 10
 * mails (and the 47-mail bundle). Expect: the first shrink step that fits is taken; the digest goes before any mail; when
 * mails must be cut, the note names every held-back mail id — nothing is dropped silently.
 */
import { describe, expect, test } from 'bun:test';
import { estimateTokens } from '../tokens.js';
import { cutWithNote, dropOptionalSections, mailIdsIn, shrinkSteps } from './turn-shrink.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// 출처: 11-26 21:41 session.trim log — cap 71 650 · prefix 23 650 · used 96 157 with 7 recent human turns kept: after the
// prefix and the kept turns (~33k), about 15k tokens were left for the newest turn itself.
const TURN_ALLOWANCE = 15_000;

const digest = (rows: number) => [
  `[Pulse digest · done 0 · overdue ${rows} · needs action 1176 · scheduled wakes 1] Outcomes are pre-evaluated from facts — act on overdue and needs-action only; done needs no reply.`,
  `⏰ Overdue (${rows})`,
  ...Array.from({ length: rows }, (_, i) => `  - c-${18825332 + i} «Follow up on message #${138605 + i} to REL» · mail-reply:${138605 + i} · not met by 06:33`),
  'Close an overdue commitment as reassigned or blocked with a reason when its outcome will not come; «request sent» or a reply is not done.',
].join('\n');
const mails = (r: () => number, n: number, base: number) => Array.from({ length: n }, (_, i) => `[seat-mail #${base + i} TC→OP] ${'진행 보고 '.repeat(20 + Math.floor(r() * 200))}`).join('\n');
const fits = (text: string) => estimateTokens(text) <= TURN_ALLOWANCE;

describe('SIM turn shrink — seeds 1–5', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: 10 mails + a 1 039-row digest → the digest is dropped, every mail kept, the turn fits`, () => {
      const r = rng(seed);
      const text = `${digest(1039)}\n\n${mails(r, 10, 185400)}`;
      expect(fits(text)).toBe(false); // the shape under test: over the allowance as sent at 22:45
      const pick = shrinkSteps(text).find(s => fits(s.text))!;
      expect(pick.step).toBe('optional:pulse digest');
      expect(pick.text).toContain('[pulse digest omitted — over the turn budget · eln commitment list --seat OP]');
      for (let i = 0; i < 10; i++) expect(pick.text).toContain(`[seat-mail #${185400 + i} TC→OP]`);
      expect(pick.heldIds).toEqual([]);
    });
    test(`seed ${seed}: 47 long mails (21:41) → cut with a note that names every held-back mail id`, () => {
      const r = rng(seed + 100);
      const text = Array.from({ length: 47 }, (_, i) => `[seat-mail #${184209 + i} X→OP] ${'긴 본문 '.repeat(300 + Math.floor(r() * 300))}`).join('\n');
      expect(fits(text)).toBe(false);
      const pick = shrinkSteps(text).find(s => fits(s.text))!;
      expect(pick.step.startsWith('cut:')).toBe(true);
      const kept = mailIdsIn(pick.text.split('\n[… ')[0]!, 100);
      // Every mail is either in the kept text or named in the note — none vanishes.
      const all = Array.from({ length: 47 }, (_, i) => 184209 + i);
      expect(all.every(id => kept.includes(id) || pick.heldIds.includes(id))).toBe(true);
      expect(pick.text).toContain('read each with eln msg show <id>; they stay unacked until handled.');
    });
  }
  test('pieces: optional-section tags drop by name; no optional part → no step; a short text is not cut', () => {
    expect(dropOptionalSections('a\n<optional-section name="recall">x\ny</optional-section>\nb')).toEqual({ text: 'a\n[recall omitted — over the turn budget]\nb', dropped: ['recall'] });
    expect(dropOptionalSections('just mails #1234')).toBe(null);
    expect(cutWithNote('short', 100)).toEqual({ text: 'short', heldIds: [] });
    expect(shrinkSteps('no optional part').map(s => s.step)).toEqual(['cut:0.5', 'cut:0.25', 'cut:0.125', 'cut:0.0625']);
  });
});
