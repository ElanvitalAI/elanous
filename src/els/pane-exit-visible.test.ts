// DEMO-PANE-EXIT-VISIBLE (demo audit 11-25): an exited pane carries its exit code, a reason and the last screen lines —
// the tail helper drops the screen header and blank lines; the ls `exit` field reaches the tab rows. Literals (rule 11).
import { expect, test } from 'bun:test';
import { paneExitTail } from './core.js';
import { withCommands } from './space-tabs-view.js';
import { parsePaneRows } from './attach-view.js';

test('exit tail: last ≤ 5 non-empty lines, screen header dropped, lines cut at 200', () => {
  expect(paneExitTail('[screen 80x24 cursor=(row 1, col 0, visible true)]\nstep-one\n\nboom: missing CONFIG\n   \n')).toEqual(['step-one', 'boom: missing CONFIG']);
  expect(paneExitTail('a\nb\nc\nd\ne\nf\ng')).toEqual(['c', 'd', 'e', 'f', 'g']);
  expect(paneExitTail('x'.repeat(250))[0]!.length).toBe(200);
  expect(paneExitTail('')).toEqual([]);
});

test('ls exit field → the row carries reason and last line; a malformed exit is ignored', () => {
  const ls = JSON.stringify({ panes: [
    { address: 'HQ/t1/p1', workspace: 'HQ', pane: 'p1', title: 'OP', state: 'exited', command: ['eln'],
      exit: { code: 127, reason: 'exit 127', tail: ['bash: /nonexistent/panel.sh: No such file or directory'] } },
    { address: 'HQ/t2/p2', workspace: 'HQ', pane: 'p2', title: 'x', state: 'exited', command: ['sh'], exit: { code: 1 } },
  ] });
  const rows = withCommands(parsePaneRows(ls), ls);
  expect(rows[0]!.exit).toEqual({ reason: 'exit 127', last: 'bash: /nonexistent/panel.sh: No such file or directory' });
  expect(rows[1]!.exit).toBeUndefined();
});
