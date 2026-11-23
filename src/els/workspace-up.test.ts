import { expect, test } from 'bun:test';
import { workspaceUp } from './workspace-up.js';
import { parseWorkspaceConfig } from './workspace-config.js';
import type { ElsResult } from './core.js';

const config = parseWorkspaceConfig(`version: 1
seats:
  OP: { role: lead, tags: [main] }
  API: {}
spaces:
  HQ: { coordinator: { role: lead, tag: main }, seats: [API] }
`, '/tmp/shop/.elanous/workspace.yaml').config!;

function fixture() {
  const state = { workspaces: [] as {id:string; name:string; coordinatorSeat?:string}[], tabs: [] as {id:string; workspaceId:string; label:string}[], panes: [{tab:'extra', pane:'other', title:'other', seat: null}] as {tab:string; pane:string; title:string; seat:string | null; state?:string; ptyId?:string}[] };
  const calls: string[] = []; const output: string[] = [];
  const deps = {
    print: (s:string) => { output.push(s); },
    confirm: async (_s:string): Promise<'approve'|'deny'|'timeout'> => 'approve',
    request: async (r:any): Promise<ElsResult> => {
      calls.push(r.op);
      if (r.op === 'ls') return { exitCode:0, message: JSON.stringify(state) };
      if (r.op === 'coordinator') { state.workspaces[0]!.coordinatorSeat = r.seat; return {exitCode:0,message:'coordinator set'}; }
      throw new Error('unexpected request');
    },
    open: async (id:string, space:string): Promise<ElsResult> => {
      calls.push(`open:${id}`);
      if (!state.workspaces.length) state.workspaces.push({id:'w',name:space});
      state.tabs.push({id,workspaceId:'w',label:id});
      state.panes.push({tab:id,pane:id,title:id,seat:id});
      return {exitCode:0,message:JSON.stringify({pane:id,existing:false})};
    },
  };
  return { state, calls, output, deps };
}

test('approval opens missing seats, sets selected coordinator, leaves unlisted and reruns idempotently', async () => {
  const f = fixture();
  expect((await workspaceUp(config, f.deps)).exitCode).toBe(0);
  expect(f.calls.filter(x => x !== 'ls')).toEqual(['open:OP','open:API','coordinator']);
  expect(f.output.join('')).toContain('? unlisted other');
  f.calls.length = 0;
  expect((await workspaceUp(config, f.deps)).exitCode).toBe(0);
  expect(f.calls.filter(x => x !== 'ls')).toEqual([]);
  expect(f.state.panes.find(p => p.pane === 'other')).toBeDefined();
});

test('a matching title without seat identity is unlisted, not adopted', async () => {
  const f = fixture();
  f.state.panes.push({tab:'shell', pane:'shell', title:'OP', seat:null});
  expect((await workspaceUp(config, f.deps)).exitCode).toBe(0);
  expect(f.calls).toContain('open:OP');
  expect(f.output.join('')).toContain('? unlisted OP');
});

test('deny and unavailable confirmation never mutate', async () => {
  for (const answer of ['deny','timeout'] as const) {
    const f = fixture(); f.deps.confirm = async () => answer;
    expect((await workspaceUp(config, f.deps)).exitCode).toBe(1);
    expect(f.calls).toEqual(['ls']);
  }
});

test('changed plan after approval and duplicate seat fail without writes', async () => {
  const f = fixture();
  f.deps.confirm = async () => { f.state.panes.push({tab:'op',pane:'op',title:'OP',seat:'OP'}); return 'approve'; };
  expect((await workspaceUp(config, f.deps)).message).toContain('state changed');
  expect(f.calls).toEqual(['ls','ls']);
  const g = fixture();
  g.state.panes.push({tab:'a',pane:'a',title:'OP',seat:'OP'}, {tab:'b',pane:'b',title:'OP',seat:'OP'});
  expect((await workspaceUp(config, g.deps)).message).toContain('duplicate');
  expect(g.calls).toEqual(['ls','ls']);
});

test('an exited declared seat blocks all changes before opening earlier missing seats', async () => {
  const f = fixture();
  f.state.workspaces.push({id:'w', name:'HQ', coordinatorSeat:'OP'});
  f.state.tabs.push({id:'api-tab', workspaceId:'w', label:'API'});
  f.state.panes.push({tab:'api-tab', pane:'api-pane', title:'API', seat:'API', state:'exited', ptyId:''});
  const result = await workspaceUp(config, f.deps);
  expect(f.output.join('')).toContain('! seat API has exited');
  expect(f.output.join('')).not.toContain('= ok API');
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain('exited');
  expect(f.calls).toEqual(['ls', 'ls']);
});

test('a seat exiting during confirmation changes the plan and blocks writes', async () => {
  const f = fixture();
  f.state.workspaces.push({id:'w', name:'HQ', coordinatorSeat:'OP'});
  f.state.tabs.push({id:'api-tab', workspaceId:'w', label:'API'});
  const pane = {tab:'api-tab', pane:'api-pane', title:'API', seat:'API', state:'running', ptyId:'pty'};
  f.state.panes.push(pane);
  f.deps.confirm = async () => { pane.state = 'exited'; pane.ptyId = ''; return 'approve'; };
  const result = await workspaceUp(config, f.deps);
  expect(result.exitCode).toBe(1);
  expect(result.message).toContain('state changed');
  expect(f.calls).toEqual(['ls', 'ls']);
});

test('failed open stops without coordinator, with partial changes reported', async () => {
  const f = fixture();
  const original = f.deps.open;
  f.deps.open = async (id, space) => id === 'API' ? {exitCode:1,message:'denied'} : original(id,space);
  expect((await workspaceUp(config, f.deps)).message).toContain('earlier changes remain');
  expect(f.calls).not.toContain('coordinator');
});
