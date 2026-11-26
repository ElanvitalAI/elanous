// ELS-PANE-LABEL-MODEL-FIRST — the agents-panel entry: model first, runtime only when not eln, never the word «eln».
// Expectations are typed-out literals (OP rule 11). The sim world drives the real `els ls` parser and the real layout with
// mixed runtimes · models · remote hosts · lent hands, at 0/40/120 entries, at the sidebar width of 120×36 and 80×24.
import { expect, test } from 'bun:test';
import { ageLabel, agentEntry, commandModel, modelLabel, parseHandTitle, runtimeLabel, remoteMark } from './agent-entry.js';
import { parsePaneRows, sidebarWidthFor } from './attach-view.js';
import { layoutSpaceList, withCommands } from './space-tabs-view.js';

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

test('model family labels', () => {
  expect(modelLabel('gpt-6.1-terra')).toBe('terra');
  expect(modelLabel('gpt-6.1')).toBe('gpt-6.1');
  expect(modelLabel('gpt-6.1-codex')).toBe('gpt-6.1-codex');
  expect(modelLabel('grok-4.1-fast')).toBe('grok');
  expect(modelLabel('claude-opus-5-5')).toBe('opus');
  expect(modelLabel('claude-sonnet-4-6[1m]')).toBe('sonnet');
  expect(modelLabel('z-ai/glm-5.3')).toBe('glm-5.3');
  expect(modelLabel('')).toBeUndefined();
  expect(modelLabel(undefined)).toBeUndefined();
});

test('model from the live command line only; runtime word only when not eln', () => {
  expect(commandModel(['codex', '-m', 'gpt-6.1-terra'])).toBe('gpt-6.1-terra');
  expect(commandModel(['claude', '--model=opus'])).toBe('opus');
  expect(commandModel(['codex', '-p', 'seat'])).toBeUndefined();
  expect(commandModel(['claude', '--model'])).toBeUndefined();
  expect(runtimeLabel('eln')).toBeUndefined();
  expect(runtimeLabel(undefined)).toBeUndefined();
  expect(runtimeLabel('codex')).toBe('codex-cli');
  expect(runtimeLabel('claude')).toBe('claude-code');
});

test('hand title (#40117 format) read back; ages', () => {
  expect(parseHandTitle('TC-H-CX-1 · UX · ELS-PANE-LABEL-MOD… · terra')).toEqual({ seat: 'TC-H-CX-1', space: 'UX', cell: 'ELS-PANE-LABEL-MOD…' });
  expect(parseHandTitle('TC-H-POOL-3 · idle · grok')).toEqual({ seat: 'TC-H-POOL-3' });
  expect(parseHandTitle('OP')).toBeUndefined();
  expect(ageLabel(1_000_000, 1_005_000)).toBe('now');
  expect(ageLabel(1_000_000, 1_045_000)).toBe('45s');
  expect(ageLabel(1_000_000, 1_000_000 + 3 * 60_000 + 5_000)).toBe('3m');
  expect(ageLabel(1_000_000, 1_000_000 + 2 * 3_600_000)).toBe('2h');
  expect(ageLabel(undefined, 5)).toBeUndefined();
});

test('entry: eln seat = «SEAT model», lent codex hand on node-b = cell · @space · codex-cli · ⇄node-b · age; never «eln»', () => {
  expect(agentEntry({ name: 'OP', title: 'OP', agent: 'eln', model: 'gpt-6.1-terra', groupSpace: 'op' }, 0)).toEqual({ head: 'OP terra', detail: '', model: 'terra' });
  expect(agentEntry({ name: 'TC-H-CX-1', title: 'TC-H-CX-1 · UX · SIDETAB-INFO · terra', agent: 'codex', command: ['codex', '-m', 'gpt-6.1-terra'],
    groupSpace: 'hands', remote: 'node-b', lastEventAtMs: 1_000 }, 181_000)).toEqual({ head: 'TC-H-CX-1 🌐 terra', detail: '@UX · codex-cli · ⇄node-b · 3m · SIDETAB-INFO', model: 'terra' });
  expect(agentEntry({ name: 'UX', title: 'UX', agent: 'claude', groupSpace: 'ux' }, 0)).toEqual({ head: 'UX', detail: 'claude-code' });
  expect(agentEntry({ name: 'TC-H-CC-2', title: 'TC-H-CC-2 · TC · A-VERY-LONG-CELL-IDENTIFIER-99 · opus', agent: 'eln', model: 'claude-opus-5-5', groupSpace: 'TC' }, 0))
    .toEqual({ head: 'TC-H-CC-2 opus', detail: 'A-VERY-LONG-CELL-…', model: 'opus' });
});

// ── sim world ──
const SPACES = ['op', 'tc', 'ux', 'mk', 'jud', 'hands'];
const KINDS: readonly [string, readonly string[], string | undefined][] = [
  ['eln', ['eln'], 'gpt-6.1-terra'], ['codex', ['codex', '-m', 'gpt-6.1'], undefined], ['claude', ['claude', '--model', 'claude-sonnet-4-6'], undefined],
  ['eln', ['eln'], 'grok-4.1-fast'], ['eln', ['eln'], 'z-ai/glm-5.3'], ['codex', ['codex', '-p', 'seat'], undefined]];
const STATES = ['working', 'idle', 'blocked', 'idle', 'working'];
function world(n: number): string {
  const panes = Array.from({ length: n }, (_, i) => {
    const ws = SPACES[i % SPACES.length]!;
    const [kind, command, model] = KINDS[i % KINDS.length]!;
    const seat = ws === 'hands' ? `TC-H-P${i}` : `${ws.toUpperCase()}${i < SPACES.length ? '' : `-${i}`}`;
    const title = ws === 'hands' ? `${seat} · ${SPACES[(i + 1) % 5]!.toUpperCase()} · CELL-NUMBER-${i}-WITH-LONG-ID · x` : seat;
    return { address: `${ws}/t${i}/p${i}`, workspace: ws, tab: `t${i}`, pane: `p${i}`, title, seat, state: STATES[i % STATES.length], activityState: STATES[i % STATES.length],
      kind, command, fgCommand: command, ...(model ? { model } : {}), lastEventAtMs: Date.now() - i * 37_000 };
  });
  return JSON.stringify({ panes });
}

for (const [cols, rowsN] of [[120, 36], [80, 24]] as const) {
  for (const n of [0, 40, 120]) {
    test(`sim ${cols}×${rowsN} · ${n} entries: exact width, no «eln», model first, selected group open`, () => {
      const json = world(n);
      const rows = withCommands(parsePaneRows(json), json);
      const width = sidebarWidthFor(cols, true);
      const height = rowsN - 1;
      const layout = layoutSpaceList(rows, n ? 'p3' : undefined, width, height);
      expect(layout.lines).toHaveLength(height);
      expect(layout.lines.every((line) => Bun.stringWidth(plain(line)) === width)).toBe(true);
      const text = layout.lines.map(plain);
      expect(text.some((line) => /\beln\b/.test(line))).toBe(false);
      // stable truncation: the same world draws the same lines twice
      expect(layoutSpaceList(rows, n ? 'p3' : undefined, width, height).lines).toEqual(layout.lines);
      if (n > 0) {
        expect(text.some((line) => /› MK +\d/.test(line))).toBe(false);          // p3 lives in «mk»: its group is never folded (its head may scroll above)
        expect(layout.groupHeads?.filter((head) => head.ws === 'mk').every((head) => !head.folded) ?? true).toBe(true);
        expect(text.some((line) => line.includes('MK') && line.includes('grok'))).toBe(true);
      }
      if (n === 120) expect(layout.scroll).toBeDefined();   // the agents region scrolls (ELS-SIDE-SPLIT-SCROLL) with the selected group open
    });
  }
}


test('a remote seat carries «⇄» after its id, before the model', () => {
    expect(agentEntry({ name: 'TC-H-REMOTE-1', title: 'x', model: 'gpt-6.1-terra', groupSpace: 'TC', remote: 'node-b' }, 0).head).toBe('TC-H-REMOTE-1 🌐 terra');
  });
test('a local seat has no marker', () => {
    expect(agentEntry({ name: 'TC', title: 'x', model: 'gpt-6.1-terra', groupSpace: 'TC' }, 0).head).toBe('TC terra');
  });
test('marker: 🌐 two cells · ⇄ fallback under ELS_ASCII=1', () => {
    expect(remoteMark({})).toBe('🌐');
    expect(Bun.stringWidth('🌐')).toBe(2);
    expect(remoteMark({ ELS_ASCII: '1' })).toBe('⇄');
  });
