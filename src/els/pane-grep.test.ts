import { describe, expect, test } from 'bun:test';
import { createElsCore, type ElsPty } from './core.js';
import { grepScreens } from './pane-grep.js';
import { emptyJournal, type SpaceJournal } from './space.js';

// ELS-GREP-PANES (seat-state/OP/orders/ELS-OP-SMALLWINS-1119.md 칸5 · 0.3.30 P0) — the literals of `els grep`:
// the pure matcher (1) and the owner-side sweep (2·3): every pane in the `list` order, the journal never written.

describe('grepScreens — the pure matcher', () => {
  test('literal hits with 1-based line numbers, panes in the order given, case kept as written; an empty pattern matches nothing', () => {
    const hits = grepScreens('Turn', [
      { address: 'w1/t1/p1', screen: 'idle prompt\nTurn running now\nturn in lowercase is not a hit' },
      { address: 'w2/t2/p2', screen: 'nothing on the first line\nstill the Turn line' },
    ]);
    expect(hits).toEqual([
      { address: 'w1/t1/p1', line: 2, text: 'Turn running now' },
      { address: 'w2/t2/p2', line: 2, text: 'still the Turn line' },
    ]);
    expect(grepScreens('', [{ address: 'w1/t1/p1', screen: 'anything at all' }])).toEqual([]);
  });
});

describe('core.grep — the owner-side sweep', () => {
  const fakePty = (id: string, screen: string): ElsPty => ({
    id,
    isAlive: () => true,
    write: () => { /* nothing is typed in these tests */ },
    renderScreen: async () => screen,
    onExit: () => { /* a test PTY never exits */ },
    kill: () => { /* nothing to stop */ },
  });

  test('every pane of the journal in the list order, from the saved scrollback — and the journal is never written', async () => {
    let saved = 0;
    const journal: SpaceJournal = {
      ...emptyJournal(),
      workspaces: [
        { id: 'w1', name: 'alpha', rootCwd: '/tmp', purpose: '', host: 'local' },
        { id: 'w2', name: 'beta', rootCwd: '/tmp', purpose: '', host: 'local' },
      ],
      tabs: [
        { id: 't1', workspaceId: 'w1', label: 'first', focusPaneId: 'p1' },
        { id: 't2', workspaceId: 'w2', label: 'second', focusPaneId: 'p2' },
      ],
      panes: [
        { id: 'p1', tabId: 't1', kind: 'pty', title: 'first', cwd: '/tmp', command: ['sh'], state: 'exited', restore: 'cwd', ptyId: '', scrollback: 'needle on the first line\nplain second line' },
        { id: 'p2', tabId: 't2', kind: 'pty', title: 'second', cwd: '/tmp', command: ['sh'], state: 'exited', restore: 'cwd', ptyId: '', scrollback: 'nothing here\na needle on the last line' },
      ],
    };
    const core = createElsCore({ load: () => journal, save: () => { saved++; }, spawn: () => { throw new Error('no pane is opened in this test'); } });
    expect(core.start()).toBeUndefined();
    const answer = await core.grep('needle');
    expect(answer.exitCode).toBe(0);
    expect(JSON.parse(answer.message)).toEqual({
      hits: [
        { address: 'w1/t1/p1', line: 1, text: 'needle on the first line' },
        { address: 'w2/t2/p2', line: 2, text: 'a needle on the last line' },
      ],
      errors: [],
    });
    expect(saved).toBe(0); // a search is not a change: grep never saved
  });

  test('a live PTY is rendered plainly and left alone; a pane that cannot render is reported, never silently skipped', async () => {
    let saved = 0;
    const core = createElsCore({
      load: () => emptyJournal(),
      save: () => { saved++; },
      spawn: (_command, _cwd, title) =>
        title === 'broken'
          ? { ...fakePty(`pty-${title}`, ''), renderScreen: async () => { throw new Error('screen is gone'); } }
          : fakePty(`pty-${title}`, 'needle line'),
    });
    expect(core.start()).toBeUndefined();
    expect(await core.grep('')).toEqual({ exitCode: 2, message: 'els grep: needs a pattern' });
    const broken = JSON.parse(core.newPane({ ws: 'alpha', cwd: '/tmp', command: ['sh'], title: 'broken' }).message) as { pane: string };
    const healthy = JSON.parse(core.newPane({ ws: 'alpha', cwd: '/tmp', command: ['sh'], title: 'healthy' }).message) as { address: string; pane: string };
    const savedAfterNew = saved;
    const answer = await core.grep('needle');
    expect(answer.exitCode).toBe(0);
    expect(JSON.parse(answer.message)).toEqual({
      hits: [{ address: healthy.address, line: 1, text: 'needle line' }],
      errors: [`els grep: cannot render ${broken.pane}: screen is gone`],
    });
    expect(saved).toBe(savedAfterNew); // grep did not save the journal
    const listed = JSON.parse(core.list().message) as { panes: { pane: string; state: string }[] };
    expect(listed.panes.find((row) => row.pane === healthy.pane)?.state).toBe('working'); // `read` would have flipped it to idle
  });
});

// 완료선 «비밀 가림» (TC #102214 · JUD 0.3.30) — a fake token banner on a pane screen (실 자격 0) must never reach
// grep output as a raw value: the hit keeps the matched line, the value is redacted (mask markers only).
describe('비밀 가림 — a secret printed on a pane screen never reaches grep output', () => {
  const screens = [
    {
      address: 'w1/t1/p1',
      screen: [
        'deploy banner: build 1 done',
        'Authorization: Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyz0123456789',
        'notify hook: xoxb-0123456789abcdefghijklmnopqrstuvwxyz',
      ].join('\n'),
    },
  ];

  test('grepping for the secret itself still finds the line, but the output carries no raw value', () => {
    const hits = grepScreens('ghp_0123456789', screens);
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz0123456789'.slice(0, 20));
    expect(hits[0]!.text).toContain('Authorization: Bearer'); // the rest of the line survives
  });

  test('a second covered shape (slack token) is masked the same way; a plain line is untouched', () => {
    const hit = grepScreens('notify', screens)[0]!;
    expect(hit.text).not.toContain('xoxb-0123456789');
    expect(hit.text).toContain('xoxb-***');
    expect(grepScreens('build 1', screens)[0]!.text).toBe('deploy banner: build 1 done');
  });

  test('the owner-side sweep (core.grep) gets the same redaction — value 0 occurrences in the whole answer', async () => {
    const journal: SpaceJournal = {
      ...emptyJournal(),
      workspaces: [{ id: 'w1', name: 'alpha', rootCwd: '/tmp', purpose: '', host: 'local' }],
      tabs: [{ id: 't1', workspaceId: 'w1', label: 'first', focusPaneId: 'p1' }],
      panes: [
        {
          id: 'p1', tabId: 't1', kind: 'pty', title: 'first', cwd: '/tmp', command: ['sh'], state: 'exited',
          restore: 'cwd', ptyId: '', scrollback: 'banner: Authorization: Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyz0123456789',
        },
      ],
    };
    const core = createElsCore({ load: () => journal, save: () => { /* grep never saves */ }, spawn: () => { throw new Error('no pane is opened in this test'); } });
    expect(core.start()).toBeUndefined();
    const answer = await core.grep('banner');
    const raw = JSON.stringify(JSON.parse(answer.message));
    expect(raw).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz0123456789'.slice(0, 20));
    expect(raw).toContain('Authorization: Bearer');
  });
});
