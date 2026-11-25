// TUI-WIDGET-KIT-DEMO — the two first consumers as literal text (rule 11: expectations are hand-written strings).
import { describe, expect, test } from 'bun:test';
import { renderFederationBoard } from './federation-board.js';
import { renderInvestResearchScene } from './invest-research.js';
import { FEDERATION_BOARD_FIXTURE, INVEST_RESEARCH_FIXTURE } from './fixtures.js';

const INVEST_80 = `Samsung Electronics (005930.KS) — 2027 outlook · Panel of 3
● OP · terra — 3 agents · 1 running · 1 done · 1 waiting
├─ ✓ News         terra              ██████████ 100%    42s  18 stories (sample)
├─ ● Sentiment    terra              ██████░░░░  60%    31s  240 posts (sample)
└─ ◌ Market data  terra · codex CLI  ░░░░░░░░░░    —     0s  queued behind News

✓ Plan · 3 angles
✓ Fan-out
▸ Collect · 1 of 3 back
○ Panel

╭─ 005930.KS · 2027 outlook ───────────────────────────────────────────────────╮
│ Hold, leaning buy (sample figures)                                           │
│                                                                              │
│ Why                                                                          │
│   HBM demand keeps memory prices firm into 2027 [1]                          │
│   Retail sentiment cooled this week [2]                                      │
│                                                                              │
│ Evidence                                                                     │
│   [1] Sample memory price series — example.com/dram                          │
│   [2] Sample sentiment set — example.com/sentiment                           │
│                                                                              │
│ Sample data for the demo. Not investment advice.                             │
╰──────────────────────────────────────────────────────────────────────────────╯`;

const INVEST_120_HEAD = `Samsung Electronics (005930.KS) — 2027 outlook · Panel of 3
● OP · terra — 3 agents · 1 running · 1 done · 1 waiting
├─ ✓ News         terra              ██████████ 100%    42s  18 stories (sample)
├─ ● Sentiment    terra              ██████░░░░  60%    31s  240 posts (sample)
└─ ◌ Market data  terra · codex CLI  ░░░░░░░░░░    —     0s  queued behind News`;

const FED_80 = `Federation Board · 0.3.37
Landed/h    Green/h     Seats                  Hands open
14 / 20 !   11 / 10 ✓   6 working · 2 idle !   2 !
Landings ███████████░░░░░│░░░░░░░ 14/30 /h · under 20
Load node-b ██████████████░│░░░░░░░░ 38/64 · under 40
✓ Rehearse · 14:00 hard rehearsal passed
▸ Cut · 16:00
○ Publish · 18:00`;

const FED_40 = `Federation Board · 0.3.37
Landed/h    Green/h
14 / 20 !   11 / 10 ✓
Seats                  Hands open
6 working · 2 idle !   2 !
Landings █████░░│░░░ 14/30 /h · under 20
Load node-b ████████│░░░░ 38/64 · under 40
✓ Rehearse · 14:00 hard rehearsal passed
▸ Cut · 16:00
○ Publish · 18:00`;

const fits = (lines: readonly string[], width: number) => {
  for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
};

describe('renderInvestResearchScene', () => {
  test('80 columns', () => {
    expect(renderInvestResearchScene(INVEST_RESEARCH_FIXTURE, 80).join('\n')).toBe(INVEST_80);
  });

  test('120 columns: last lines uncut, box capped at 100 cells', () => {
    const lines = renderInvestResearchScene(INVEST_RESEARCH_FIXTURE, 120);
    expect(lines.slice(0, 5).join('\n')).toBe(INVEST_120_HEAD);
    expect(lines.at(-1)).toBe(`╰${'─'.repeat(98)}╯`);
    fits(lines, 100);
  });

  test('40 columns: nothing overflows; the card wraps inside its box', () => {
    const lines = renderInvestResearchScene(INVEST_RESEARCH_FIXTURE, 40);
    fits(lines, 40);
    expect(lines[0]).toBe('Samsung Electronics (005930.KS) — 2027…');
    expect(lines[2]).toBe('├─ ✓ News         100%    42s  18 stori…');
    expect(lines).toContain('│   HBM demand keeps memory prices     │');
    expect(lines).toContain('│   firm into 2027 [1]                 │');
  });

  test('no result yet: no card', () => {
    const { result: _drop, ...rest } = INVEST_RESEARCH_FIXTURE;
    expect(renderInvestResearchScene(rest, 80).at(-1)).toBe('○ Panel');
  });
});

describe('renderFederationBoard', () => {
  test('80 columns', () => {
    expect(renderFederationBoard(FEDERATION_BOARD_FIXTURE, 80).join('\n')).toBe(FED_80);
  });

  test('120 columns equals 80 (everything already fits)', () => {
    expect(renderFederationBoard(FEDERATION_BOARD_FIXTURE, 120).join('\n')).toBe(FED_80);
  });

  test('40 columns: stat tiles wrap into two bands; gauges shrink', () => {
    const lines = renderFederationBoard(FEDERATION_BOARD_FIXTURE, 40);
    fits(lines, 40);
    expect(lines.join('\n')).toBe(FED_40);
  });
});
