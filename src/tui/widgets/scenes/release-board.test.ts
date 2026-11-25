// RELEASE-BOARD — pure render + key reducer. Expectations are hand-written literals (rule 11), never built from the product.
import { describe, expect, test } from 'bun:test';
import { renderReleaseBoard, renderReleaseBoardNoData, type BoardStep, type ReleaseBoardSnapshot } from './release-board.js';
import { boardKey, initialUi, parseKeys, type KeyState } from './release-board-keys.js';

const step = (over: Partial<BoardStep> & { id: string; phase: string }): BoardStep => ({
  label: over.id, status: 'pending', critical: false, host: 'none', hard: false, cmd: `echo ${over.id}`, logPath: `/tmp/rb/logs/${over.id}.log`, warnings: [], ...over,
});

const snap = (over: Partial<ReleaseBoardSnapshot> = {}): ReleaseBoardSnapshot => ({
  version: '0.3.36', profile: 'normal', mode: 'live', universe: 'operating',
  now: '2026-11-25T19:30:00.000Z', cutAt: '2026-11-25T19:00:00.000Z', publishAt: '2026-11-25T21:00:00.000Z',
  hardStop: null, done: false, criticalMinutes: 31, events: [{ at: '04:22', text: 'hard stop pregate' }], freshEvent: false,
  hosts: [{ name: 'hstc', busy: null }, { name: 'hosta1', busy: 'pregate' }], traffic: { phase: 'reserve', releaseHost: 'hstb', slots: { hstb: 1, hstd: 5 } },
  tick: 0, run: '0.3.36', instances: ['0.3.36'], following: true,
  steps: [
    step({ id: 'cut', phase: 'L-1', status: 'done', critical: true, host: 'hstc', startedAt: '2026-11-25T19:00:00.000Z', endedAt: '2026-11-25T19:02:00.000Z', exit: 0 }),
    step({ id: 'pregate', phase: 'L-2', status: 'running', host: 'hosta1', startedAt: '2026-11-25T19:02:00.000Z' }),
    step({ id: 'prebuild', phase: 'L-2', status: 'warn', host: 'hstb', startedAt: '2026-11-25T19:02:00.000Z', endedAt: '2026-11-25T19:12:00.000Z', warnings: ['exit 1 waived'] }),
    step({ id: 'publish', phase: 'L-5', critical: true, host: 'publish', earliestAt: '2026-11-25T21:00:00.000Z' }),
  ],
  ...over,
});
const ui = (over: Partial<KeyState> = {}): KeyState => ({ ...initialUi, ...over });

describe('release board render', () => {
  test('80×24 frame — literal', () => {
    expect(renderReleaseBoard(snap(), ui(), 80, 24)).toEqual([
      '● Release 0.3.36 · normal · LIVE · now 04:30 KST',
      'cut 04:00 (30m ago) · publish 06:00 (in 1h30m) · critical path 31m',
      'Critical path: cut → publish',
      'Progress ████████████░░░░░░░░░░░░ 2/4 steps',
      '────────────────────────────────────────────────────────────────────────────────',
      'L-1 │›[✓ cut 2m]',
      'L-2 │ ◐ pregate 28m                        ! prebuild 10m',
      'L-5 │ [○ publish @06:00]',
      '› L-1 cut · done · @hstc · 04:00→04:02 · (2m) · exit 0',
      '', '', '', '', '', '', '', '', '', '',
      '────────────────────────────────────────────────────────────────────────────────',
      'Events 04:22 hard stop pregate',
      'Hosts  hstc ·   hosta1 ▪ pregate',
      'Traffic reserve · release host hstb reserved · pregate slots hstb 1 · hstd 5',
      '↑↓ step · Enter details · Tab run · m mark · s skip · r resume · p preview · ?…',
    ]);
  });

  test('hard-stop banner and quick-surgery hint', () => {
    const lines = renderReleaseBoard(snap({ hardStop: { step: 'pregate', reason: 'pregate exited 1', noncritical: true } }), ui(), 120, 36);
    expect(lines[2]).toBe('■ HARD STOP at pregate: pregate exited 1 — quick-surgery at T−60m (05:00)');
  });

  test('spinner turns only with the snapshot tick', () => {
    const at = (tick: number) => renderReleaseBoard(snap({ tick }), ui(), 80, 24)[6]!.slice(5, 7);
    expect([at(0), at(1), at(2), at(3), at(4)]).toEqual([' ◐', ' ◓', ' ◑', ' ◒', ' ◐']);
  });

  test('details: command, receipt path, warnings', () => {
    const lines = renderReleaseBoard(snap(), ui({ selected: 2, detail: true }), 80, 24);
    expect(lines.slice(5, 12)).toEqual([
      '› L-2 prebuild · warn · @hstb · 04:02→04:12 · (10m) · 1 warning',
      '┌ prebuild — prebuild',
      '│ Command: echo prebuild',
      '│ Receipt: /tmp/rb/logs/prebuild.log',
      '│ ! exit 1 waived',
      '└ Enter or Esc closes',
      '',
    ]);
  });

  test('instances header + preview label', () => {
    const lines = renderReleaseBoard(snap({ instances: ['0.3.36', '0.3.36-rehearsal'], run: '0.3.36-rehearsal', following: false }), ui({ preview: true }), 120, 36);
    expect(lines[0]).toBe('● Release 0.3.36 · normal (preview) · LIVE · run 0.3.36-rehearsal (2/2 · pinned) · now 04:30 KST');
  });

  test('no data', () => {
    expect(renderReleaseBoardNoData('0.3.36', 'state for 0.3.36 is partial (version/clock/steps missing)', 60, 20)).toEqual([
      '○ Release 0.3.36 · no data',
      'state for 0.3.36 is partial (version/clock/steps missing)',
      '────────────────────────────────────────────────────────────',
      'The board shows a run once the release graph writes its sta…',
      '',
      'q quit · refreshes every 2s',
    ]);
  });

  const long = 'x'.repeat(300);
  const many = Array.from({ length: 64 }, (_, i) => step({ id: `step-${i}-${'long'.repeat(i % 5)}`, phase: `L-${i % 10}`, status: (['pending', 'running', 'done', 'warn', 'soft-fail', 'stop', 'skipped'] as const)[i % 7], critical: i % 3 === 0 }));
  const cases: Array<[string, ReleaseBoardSnapshot, KeyState]> = [
    ['base', snap(), ui()],
    ['detail', snap(), ui({ detail: true, selected: 1 })],
    ['help', snap(), ui({ help: true })],
    ['0 steps', snap({ steps: [], events: [] }), ui()],
    ['64 steps', snap({ steps: many }), ui({ selected: 63 })],
    ['long names', snap({ steps: [step({ id: long, phase: 'L-0', warnings: [long, long], label: long, cmd: long })], hardStop: { step: long, reason: long }, events: [{ at: '04:00', text: long }] }), ui({ detail: true })],
    ['prompt', snap(), ui({ prompt: `Skip cut — reason: ${long}` })],
    ['past publish', snap({ now: '2026-11-26T03:00:00.000Z', done: true, traffic: null }), ui()],
  ];
  for (const [name, s, u] of cases) {
    for (const [w, h] of [[120, 36], [100, 30], [80, 24], [60, 20]] as const) {
      test(`no overflow: ${name} at ${w}×${h}`, () => {
        const lines = renderReleaseBoard(s, u, w, h);
        expect(lines.length).toBeLessThanOrEqual(h);
        for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(w);
      });
    }
  }
});

describe('release board keys', () => {
  const ctx = (role: string | null) => ({ steps: ['cut', 'pregate', 'publish'], role });
  test('↑↓ wrap, Enter toggles details, ? help, p preview, q quits, unknown ignored', () => {
    expect(boardKey(ui(), 'up', ctx(null)).ui.selected).toBe(2);
    expect(boardKey(ui({ selected: 2 }), 'down', ctx(null)).ui.selected).toBe(0);
    expect(boardKey(ui(), 'enter', ctx(null)).ui.detail).toBe(true);
    expect(boardKey(ui(), { char: '?' }, ctx(null)).ui.help).toBe(true);
    expect(boardKey(ui(), { char: 'p' }, ctx(null)).ui.preview).toBe(true);
    expect(boardKey(ui(), { char: 'q' }, ctx(null)).quit).toBe(true);
    expect(boardKey(ui(), { char: 'z' }, ctx(null))).toEqual({ ui: { ...initialUi, flash: undefined } });
  });
  test('m/s/r refused for a non-OP/REL seat', () => {
    expect(boardKey(ui(), { char: 'm' }, ctx('TC')).ui.flash).toBe('Read-only: mark is for OP or REL (you are TC)');
    expect(boardKey(ui(), { char: 's' }, ctx(null)).ui.flash).toBe('Read-only: skip is for OP or REL (you are unknown)');
    expect(boardKey(ui(), { char: 'r' }, ctx('UX')).action).toBeUndefined();
  });
  test('mark needs y; anything else cancels', () => {
    const asked = boardKey(ui({ selected: 1 }), { char: 'm' }, ctx('OP'));
    expect(asked.ui.prompt).toBe('Mark pregate? y confirm · any other key cancels');
    expect(boardKey(asked.ui, { char: 'n' }, ctx('OP'))).toEqual({ ui: { ...asked.ui, pending: undefined, prompt: undefined, flash: 'Mark pregate cancelled' } });
    expect(boardKey(asked.ui, { char: 'y' }, ctx('OP')).action).toEqual({ kind: 'mark', step: 'pregate' });
  });
  test('skip asks a reason, then confirms', () => {
    let s = boardKey(ui({ selected: 2 }), { char: 's' }, ctx('REL')).ui;
    expect(boardKey(s, 'enter', ctx('REL')).ui.prompt).toBe('Skip publish — a reason is required: ');
    for (const c of 'docsx') s = boardKey(s, { char: c }, ctx('REL')).ui;
    s = boardKey(s, 'backspace', ctx('REL')).ui;
    s = boardKey(s, 'enter', ctx('REL')).ui;
    expect(s.prompt).toBe('Skip publish (reason: docs)? y confirm · any other key cancels');
    expect(boardKey(s, { char: 'y' }, ctx('REL')).action).toEqual({ kind: 'skip', step: 'publish', reason: 'docs' });
  });
  test('writes refused while previewing', () => {
    expect(boardKey(ui({ preview: true }), { char: 'r' }, ctx('OP')).ui.flash).toBe('Leave the preview (p) before changing the run');
  });
  test('parseKeys: arrows, Enter, Esc, Tab, Backspace, chars, rapid bursts, unknown CSI dropped', () => {
    expect(parseKeys('\x1b[A\x1b[B\r\t\x7fmq\x1b[15~\x1b')).toEqual(['up', 'down', 'enter', 'tab', 'backspace', { char: 'm' }, { char: 'q' }, 'esc']);
    expect(parseKeys('\x1b[B'.repeat(50)).length).toBe(50);
  });
});
