// ELN-OP-CROWN-MEMORY — the pure halves of kit/crown-directive (the full path is the sim scene CROWN-DIRECTIVE-ASSIGN-GUARD).
// Expectations are independent literals (rule 11).
import { describe, expect, test } from 'bun:test';
import { cellMatches, crownCardName, directiveCardOf, directiveLine, directiveRefusal, parseCrownDirectivePolicy, parseDirectiveLine, seatBound } from './index.js';

const POLICY = { defaultExpiryH: 72, guardedActions: ['assign', 'handoff'] };
const T10 = '2026-11-28T10:00:00.000Z';
const T11 = '2026-11-28T11:00:00.000Z';
const T12 = '2026-11-28T12:00:00.000Z';
const D30 = '2026-11-30T00:00:00.000Z';
const D01 = '2026-12-01T10:00:00.000Z';

describe('crown directive cards', () => {
  test('directive line round trip · a line without seats is no directive', () => {
    const line = directiveLine({ seats: ['MK'], only: ['DOCS-*', 'HOME-1'], never: ['INFRA-*'], until: D30 });
    expect(line).toBe(`지시 seats=MK only=DOCS-*,HOME-1 never=INFRA-* until=${D30}`);
    expect(parseDirectiveLine(line)).toEqual({ seats: ['MK'], only: ['DOCS-*', 'HOME-1'], never: ['INFRA-*'], until: D30 });
    expect(parseDirectiveLine('지시 only=DOCS-*')).toBeNull();
    expect(parseDirectiveLine(undefined)).toBeNull();
  });
  test('card: id from the source · default expiry from the policy · seats bind their hands · patterns exact or prefix', () => {
    const c = directiveCardOf({ source: 'decision:D-20261128-09', quote: 'q', scope: 's', shape: { seats: ['MK'], only: ['DOCS-*'], never: [] }, recordedAt: T10 }, POLICY);
    expect(c.id).toBe(directiveCardOf({ source: 'decision:D-20261128-09', quote: 'other', scope: 'x', recordedAt: T11 }, POLICY).id);
    expect(c.expiresAt).toBe(D01);
    expect(c.actions).toEqual(['assign', 'handoff']);
    expect([seatBound('MK', 'MK'), seatBound('MK', 'mk-h-cc-1'), seatBound('MK', 'MKT')]).toEqual([true, true, false]);
    expect([cellMatches('DOCS-*', 'DOCS-ELS'), cellMatches('DOCS-*', 'INFRA-DOCS'), cellMatches('HOME-1', 'HOME-1'), cellMatches('HOME-1', 'HOME-12')]).toEqual([true, false, true, false]);
  });
  test('refusal: active · bound seat · outside only / inside never · other action, seat or expired → null', () => {
    const c = directiveCardOf({ source: 'decision:D-1', quote: 'MK 는 문서만', scope: 'MK 문서 전담', shape: { seats: ['MK'], only: ['DOCS-*'], never: [], until: T12 }, recordedAt: T10 }, POLICY);
    const n = directiveCardOf({ source: 'decision:D-2', quote: '발행은 TC 아님', scope: '발행 REL', shape: { seats: ['TC'], only: [], never: ['RELEASE-*'], actions: ['handoff'] }, recordedAt: T10 }, POLICY);
    const at = Date.parse(T11);
    expect(directiveRefusal([c, n], { seat: 'MK', cellId: 'INFRA-1', action: 'assign' }, at, () => 'MK = 문서 자리'))
      .toBe(`\u{1F451} 지시 ${c.id} «MK 는 문서만» (범위 MK 문서 전담 · 만료 ${T12}) — INFRA-1 는 MK 의 허용 칸(DOCS-*) 밖 · 자리 역할: MK = 문서 자리 · assign 거절 — 다른 자리로 · 지시가 끝나면(만료·새 지시) 다시`);
    expect(directiveRefusal([c, n], { seat: 'MK', cellId: 'DOCS-ELS', action: 'assign' }, at)).toBeNull();
    expect(directiveRefusal([c, n], { seat: 'TC', cellId: 'RELEASE-0340', action: 'assign' }, at)).toBeNull();
    expect(directiveRefusal([c, n], { seat: 'TC', cellId: 'RELEASE-0340', action: 'handoff' }, at)).toContain('RELEASE-0340 는 TC 에게 금지(RELEASE-*)');
    expect(directiveRefusal([c], { seat: 'MK', cellId: 'INFRA-1', action: 'assign' }, Date.parse(T12))).toBeNull();
  });
  test('card name carries the action words (seat recall scores name words) · memory-only cards are not crown-', () => {
    const c = directiveCardOf({ source: 'decision:D-1', quote: 'q', scope: 's', shape: { seats: ['MK'], only: ['DOCS-*'], never: [] }, recordedAt: T10 }, POLICY);
    expect(crownCardName(c)).toBe(`crown-1128-mk-docs-only-${c.id.slice(3, 9)}`);
    const n = directiveCardOf({ source: 'decision:D-2', quote: 'q', scope: 's', shape: { seats: ['TC'], only: [], never: ['RELEASE-*'] }, recordedAt: T10 }, POLICY);
    expect(crownCardName(n)).toBe(`crown-1128-tc-release-never-${n.id.slice(3, 9)}`);
    expect(crownCardName(directiveCardOf({ source: 'decision:D-20261128-03', quote: 'q', scope: 's', recordedAt: T10 }, POLICY))).toBe('ceo-decision-1128-decision-d-20261128-03');
  });
  test('policy: every value named · a missing one refused', () => {
    const ok = 'version: 1\ncard:\n  default_expiry_h: 72\n  guarded_actions: [assign, handoff]\nmemory:\n  seat: op\n  turn_max_cards: 6\n  turn_max_chars: 1500\n  update_max_chars: 1500\n  pinned: true\n  kind: 교정\n  scope: role\nroles:\n  file: ROLE.md\n  summary_chars: 160\n';
    expect(parseCrownDirectivePolicy(ok)).toEqual({ defaultExpiryH: 72, guardedActions: ['assign', 'handoff'], memoryPinned: true, memoryKind: '교정', memoryScope: 'role', memorySeat: 'OP', turnMaxCards: 6, turnMaxChars: 1500, updateMaxChars: 1500, roleFile: 'ROLE.md', roleSummaryChars: 160 });
    expect(() => parseCrownDirectivePolicy(ok.replace('  default_expiry_h: 72\n', ''))).toThrow('default_expiry_h');
  });
});
