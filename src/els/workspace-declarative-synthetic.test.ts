import { expect, test } from 'bun:test';
import { parseWorkspaceConfig } from './workspace-config.js';
import { workspaceUp } from './workspace-up.js';
import type { ElsResult } from './core.js';

const a = `version: 1
seats:
  OP: {}
  API: {}
  WORK: {}
spaces:
  HQ: { coordinator: OP, seats: [API] }
  LAB: { coordinator: WORK }
`;
const b = `version: 1
seats:
  OP: {}
  API: {}
  WORK: {}
  NEW: {}
spaces:
  HQ: { coordinator: API, seats: [OP, NEW] }
  LAB: { coordinator: WORK }
`;

test('two declarations converge with literal mutations and preserve an unlisted live seat', async () => {
  const extra = { tab: 'tab-extra', pane: 'pane-extra', title: 'EXTRA', seat: 'EXTRA', state: 'running', ptyId: 'pty-extra' };
  const state = {
    workspaces: [{ id: 'ws-extra', name: 'OTHER', coordinatorSeat: 'EXTRA' }] as { id: string; name: string; coordinatorSeat?: string }[],
    tabs: [{ id: 'tab-extra', workspaceId: 'ws-extra', label: 'EXTRA' }],
    panes: [extra] as typeof extra[],
  };
  const mutations: string[] = [];
  const plans: string[] = [];
  const deps = {
    print: (s: string) => { plans.push(s); },
    confirm: async (): Promise<'approve'> => 'approve',
    request: async (r: any): Promise<ElsResult> => {
      if (r.op === 'ls') return { exitCode: 0, message: JSON.stringify(state) };
      if (r.op !== 'coordinator') throw new Error(`unexpected event ${r.op}`);
      const ws = state.workspaces.find(w => w.id === r.ws);
      if (!ws) throw new Error(`unknown workspace ${r.ws}`);
      mutations.push(`coordinator:${ws.name}:${r.seat}`);
      ws.coordinatorSeat = r.seat;
      return { exitCode: 0, message: `coordinator ${ws.name}=${r.seat}` };
    },
    open: async (id: string, space: string): Promise<ElsResult> => {
      mutations.push(`open:${space}:${id}`);
      let ws = state.workspaces.find(w => w.name === space);
      if (!ws) { ws = { id: `ws-${space}`, name: space }; state.workspaces.push(ws); }
      state.tabs.push({ id: `tab-${id}`, workspaceId: ws.id, label: id });
      state.panes.push({ tab: `tab-${id}`, pane: `pane-${id}`, title: id, seat: id, state: 'running', ptyId: `pty-${id}` });
      return { exitCode: 0, message: JSON.stringify({ pane: `pane-${id}`, existing: false }) };
    },
  };
  const apply = async (name: string, text: string, expected: string[]) => {
    const parsed = parseWorkspaceConfig(text, '/tmp/synthetic/.elanous/workspace.yaml');
    expect(parsed.errors).toEqual([]);
    mutations.length = 0;
    plans.length = 0;
    const result = await workspaceUp(parsed.config!, deps);
    expect(result).toEqual({ exitCode: 0, message: 'els up: done' });
    expect(mutations).toEqual(expected);
    expect(plans.join('')).toContain('? unlisted EXTRA (pane-extra) — left open');
    expect(state.panes.find(p => p.seat === 'EXTRA')).toEqual({ tab: 'tab-extra', pane: 'pane-extra', title: 'EXTRA', seat: 'EXTRA', state: 'running', ptyId: 'pty-extra' });
    console.log(JSON.stringify({ phase: name, result, mutations, plans, snapshot: state }));
  };
  await apply('A', a, ['open:HQ:OP', 'open:HQ:API', 'coordinator:HQ:OP', 'open:LAB:WORK', 'coordinator:LAB:WORK']);
  const afterA = JSON.stringify(state);
  await apply('A again', a, []);
  expect(JSON.stringify(state)).toBe(afterA);
  await apply('B', b, ['open:HQ:NEW', 'coordinator:HQ:API']);
  expect(state.workspaces.map(w => [w.name, w.coordinatorSeat])).toEqual([['OTHER', 'EXTRA'], ['HQ', 'API'], ['LAB', 'WORK']]);
  expect(state.panes.map(p => [p.seat, p.state])).toEqual([['EXTRA', 'running'], ['OP', 'running'], ['API', 'running'], ['WORK', 'running'], ['NEW', 'running']]);
  const afterB = JSON.stringify(state);
  await apply('B again', b, []);
  expect(JSON.stringify(state)).toBe(afterB);
});
