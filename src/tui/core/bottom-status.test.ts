// #38392 r2 (checklist 10): the bottom status line across screen height × panel × turn × layout.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keepBottomStatus } from './bottom-status.js';
import { compactFooterTurn, createNextTuiStatusline } from '../../statusline/next-tui.js';
import { nextTuiShortStatus } from '../chat/status-line.js';

const dir = mkdtempSync(join(tmpdir(), 'bottom-status-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const userPath = join(dir, 'statusline.yaml');
// A user layout that reads the turn and its elapsed time under its own ids, beside the folder.
writeFileSync(userPath, [
  'segments:',
  '  - { id: my_turn, source: session, field: turn, label: "Now" }',
  '  - { id: my_clock, source: session, field: elapsed, label: "Took" }',
  '  - { id: my_folder, source: session, field: cwd_leaf }',
  'layouts:',
  '  - { band: xs, lines: 1, segments: [my_turn, my_clock, my_folder] }',
  '  - { band: sm, lines: 1, segments: [my_turn, my_clock, my_folder] }',
  '  - { band: md, lines: 1, segments: [my_turn, my_clock, my_folder] }',
].join('\n'));
const BUILD = { version: '0.3.28-dev.0', sha: '9956d46f714fe577094b213c1c5b04d2509e983a', source: 'installed' as const };
const footers = {
  default: createNextTuiStatusline({ build: BUILD, cwd: () => '/home/me/app', color: false, userPath: join(dir, 'none.yaml') }),
  user: createNextTuiStatusline({ build: BUILD, cwd: () => '/home/me/app', color: false, userPath }),
};
// Rows each panel kind takes in the footer (as entry.ts draws them): none = the plain footer row, an open picker
// (title · up to six rows · hint), an approval (title · command page · position · help).
const PANEL_ROWS = { none: 0, picker: 8, approval: 6 } as const;
const HEADER_ROWS = 2;
const TURNS = {
  idle: { turnState: 'idle', children: 0 },
  running: { turnState: 'running', children: 0 },
  children: { turnState: 'running', children: 2 },
} as const;

/** The bottom line exactly as entry.ts builds it on a compact (≤ 24-row) or a tall screen. */
function bottomLine(layout: keyof typeof footers, turn: keyof typeof TURNS, rows: number) {
  const { turnState, children } = TURNS[turn];
  const busy = turnState !== 'idle';
  const input = { turnState, model: 'gpt-sim', queued: 0, backgroundTasks: 0, width: 100, ...(busy ? { elapsedMs: 200_000 } : {}) };
  const omitTurn = busy; // a plain phase at the bottom
  if (rows <= 24) {
    const replace = compactFooterTurn({ welcomePending: false, attachmentHint: null, shortTurn: omitTurn ? '' : nextTuiShortStatus(input).turn, activeChildren: children });
    return footers[layout].render(input, replace, omitTurn).plain;
  }
  return footers[layout].render(input, children > 0 ? `Children ${children}` : undefined, omitTurn).plain;
}

const table: string[] = ['| rows | panel | turn | layout | kept | bottom line |', '|---|---|---|---|---|---|'];
for (const rows of [24, 40]) {
  for (const panel of Object.keys(PANEL_ROWS) as (keyof typeof PANEL_ROWS)[]) {
    for (const turn of Object.keys(TURNS) as (keyof typeof TURNS)[]) {
      for (const layout of Object.keys(footers) as (keyof typeof footers)[]) {
        test(`${rows} rows · panel ${panel} · ${turn} · ${layout} layout`, () => {
          const kept = keepBottomStatus({ rows, headerRows: HEADER_ROWS, footerRows: PANEL_ROWS[panel] });
          const line = bottomLine(layout, turn, rows);
          table.push(`| ${rows} | ${panel} | ${turn} | ${layout} | ${kept} | ${line} |`);
          // A panel never removes it on a 24- or 40-row screen.
          expect(kept).toBe(true);
          expect(line).toContain('app');
          if (turn !== 'idle') {
            // No turn phase and no elapsed time under the progress row (the user's own label may carry a replacement:
            // «Now Children 2» — that is the children count, not the turn).
            expect(line).not.toMatch(/running|Turn |Took /);
            if (turn === 'running') expect(line).not.toContain('Now ');
          }
          if (turn === 'children') expect(line).toContain('Children 2');
        });
      }
    }
  }
}

test('only a screen too short for header · footer · input · status · one conversation row drops it', () => {
  expect(keepBottomStatus({ rows: 6, headerRows: 2, footerRows: PANEL_ROWS.approval })).toBe(false);
  expect(keepBottomStatus({ rows: 12, headerRows: 2, footerRows: PANEL_ROWS.picker })).toBe(false);
  expect(keepBottomStatus({ rows: 13, headerRows: 2, footerRows: PANEL_ROWS.picker })).toBe(true);
  if (process.env.BOTTOM_STATUS_TABLE) writeFileSync(process.env.BOTTOM_STATUS_TABLE, `${table.join('\n')}\n`);
});
