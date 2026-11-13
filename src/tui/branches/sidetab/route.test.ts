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
  expect(status).toContain('결과 미확인');
  expect(status).toContain('확인하기 전 재시도 금지');
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
  expect(calls).toContain('help:3');
  expect(calls).toContain('bind');
  expect(calls).toContain('sidechat:question');
  expect(calls).toContain('terminal:go');
  expect(calls).toContain('broadcast:a,b:go');
});
