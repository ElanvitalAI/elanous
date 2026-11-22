import { expect, test } from 'bun:test';
import { NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../../core/registry.js';
import { runNextTuiBranchRoute, type SidetabRouteHost } from './route.js';
import { WorkspaceTerminalOutcomeUnknownError } from '../../sidetab/workspace-terminal-writer.js';

test('sidetab route is selected through the registry and loads its branch', async () => {
  const route = resolveNextTuiRoute('/side workspaces', NEXT_TUI_INPUT_CONTEXT);
  expect(route?.branchModule).toBe('./branches/sidetab/route.js');
  expect(route?.branchHost).toBe('sidetab');
  const branch = await import(new URL(`../../${route!.branchModule!}`, import.meta.url).href);
  expect(branch.runNextTuiBranchRoute).toBe(runNextTuiBranchRoute);
});

test('workspace terminal release uncertainty tells the operator to inspect before retry', async () => {
  let status = '';
  const host = {
    submitWorkspace: async () => { throw new WorkspaceTerminalOutcomeUnknownError(); },
    setStatus: (message: string) => { status = message; },
  } as unknown as SidetabRouteHost;
  await runNextTuiBranchRoute('/side terminal continue', host);
  expect(status).toContain('send unconfirmed');
  expect(status).toContain('do not retry before checking target screen and history');
});

test('sidetab branch handles state transitions, selection and help through host operations', async () => {
  const calls: string[] = [];
  let open = true;
  let enabled = true;
  let viewMode: 'current' | 'all' | 'workspaces' = 'current';
  let rememberedOpen = false;
  const host: SidetabRouteHost = {
    state: () => ({ open, viewMode, rememberedOpen }),
    setEnabled: (value) => { enabled = value; calls.push(`enabled:${value}`); },
    rememberOpen: () => { rememberedOpen = true; calls.push('remember'); },
    setViewMode: (mode) => { viewMode = mode; calls.push(`view:${mode}`); },
    setNewMode: () => calls.push('new'),
    clearExpandedWorkspaces: () => calls.push('clear'),
    toggle: async () => { open = !open; calls.push(`open:${open}`); },
    refreshRows: () => calls.push('refresh'),
    killSelected: async () => { calls.push('kill'); return true; },
    spawnSideAgent: async (agent) => { calls.push(`spawn:${agent}`); return `fake-${agent}`; },
    sendSelectedAgent: async (message) => { calls.push(`send:${message}`); return true; },
    readSelectedAgent: async () => { calls.push('read'); return 'fake screen'; },
    sendSelectedAgentKeys: async (names) => { calls.push(`keys:${names.join(',')}`); return true; },
    selectedAgentStatus: async () => { calls.push('status'); return 'idle'; },
    bindWorkspaceSelected: async () => { calls.push('bind'); return true; },
    submitWorkspace: async (mode, text) => { calls.push(`${mode}:${text}`); return { sent: true, reply: mode === 'sidechat' ? 'reply' : undefined }; },
    broadcastWorkspace: async (ids, text) => { calls.push(`broadcast:${ids.join(',')}:${text}`); return { sent: ids.length, total: ids.length, outcome: 'complete' }; },
    addHelp: (...lines) => calls.push(`help:${lines.length}`),
    setStatus: (message) => calls.push(`status:${message}`),
  };
  await runNextTuiBranchRoute('/side off', host);
  expect({ open, enabled, rememberedOpen }).toEqual({ open: false, enabled: false, rememberedOpen: true });
  await runNextTuiBranchRoute('/side on', host);
  expect({ open, enabled }).toEqual({ open: true, enabled: true });
  await runNextTuiBranchRoute('/side workspaces', host);
  expect(host.state().viewMode).toBe('workspaces');
  await runNextTuiBranchRoute('/side kill', host);
  await runNextTuiBranchRoute('/side new', host);
  await runNextTuiBranchRoute('/side help', host);
  await runNextTuiBranchRoute('/side bind', host);
  await runNextTuiBranchRoute('/side chat question', host);
  await runNextTuiBranchRoute('/side terminal go', host);
  await runNextTuiBranchRoute('/side broadcast a,b -- go', host);
  expect(calls).toContain('kill');
  expect(calls).toContain('new');
  expect(calls).toContain('help:4'); // /side keys has its own line (HERDR-REPLACE-C1)
  expect(calls).toContain('bind');
  expect(calls).toContain('sidechat:question');
  expect(calls).toContain('terminal:go');
  expect(calls).toContain('broadcast:a,b:go');
});

test('/side send words each els outcome as itself: delivered, queued, unknown (never sent/queued), refused; a PTY row keeps the two old lines', async () => {
  const statuses: string[] = [];
  const answers: (boolean | { ok: boolean; message: string; outcome?: 'delivered' | 'queued' | 'refused' | 'unknown' })[] = [
    { ok: true, outcome: 'delivered', message: 'els do: sent to p1 (5 chars)' },
    { ok: true, outcome: 'queued', message: 'els do: queued 2 for p1 (turn running)' },
    { ok: false, outcome: 'unknown', message: 'no answer in time — the line may or may not have reached the pane; check its screen before sending again' },
    { ok: false, outcome: 'refused', message: 'els do: herdr refused: herdr:w2/t1/p2 is working, not sent' },
    true, false];
  const host = {
    sendSelectedAgent: async () => answers.shift()!,
    setStatus: (message: string) => { statuses.push(message); },
  } as unknown as SidetabRouteHost;
  for (let i = 0; i < 6; i++) await runNextTuiBranchRoute('/side send hello', host);
  expect(statuses).toEqual([
    'Input sent to selected agent · els do: sent to p1 (5 chars)',
    'Input queued in the pane · els do: queued 2 for p1 (turn running)',
    'Input status unknown · no answer in time — the line may or may not have reached the pane; check its screen before sending again',
    'Input not sent · els do: herdr refused: herdr:w2/t1/p2 is working, not sent',
    'Input sent to selected agent',
    'Agent PTY input failed · check selection/run state',
  ]);
});

test('/side read reports a failed remote snapshot separately from no selected pane', async () => {
  const statuses: string[] = [];
  const host = {
    readSelectedAgent: async () => { throw new Error('els read: minim5 ? timeout'); },
    setStatus: (message: string) => { statuses.push(message); },
    addHelp: () => { throw new Error('a failed read must not paint a screen'); },
  } as unknown as SidetabRouteHost;
  await runNextTuiBranchRoute('/side read', host);
  expect(statuses).toEqual(['Selected agent PTY read failed · timeout']);
});

test('/side read never paints untrusted remote error text, credentials, paths or terminal controls', async () => {
  const statuses: string[] = [];
  const untrusted = 'els read: minim5 ? /Users/owner/.cache/secret XAI_API_KEY=private\u001b[31m' + 'x'.repeat(1000);
  const host = {
    readSelectedAgent: async () => { throw new Error(untrusted); },
    setStatus: (message: string) => { statuses.push(message); },
    addHelp: () => { throw new Error('failed read painted a screen'); },
  } as unknown as SidetabRouteHost;
  await runNextTuiBranchRoute('/side read', host);
  expect(statuses).toEqual(['Selected agent PTY read failed · unavailable']);
});
