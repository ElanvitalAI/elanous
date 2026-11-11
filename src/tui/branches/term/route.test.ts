import { expect, test } from 'bun:test';
import { NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../../core/registry.js';
import { runNextTuiTermBranchRoute } from './route.js';

test('term aliases resolve to and load the registry branch module', async () => {
  for (const input of ['/term list', '/terminal list']) {
    const route = resolveNextTuiRoute(input, NEXT_TUI_INPUT_CONTEXT);
    expect(route?.branchHost).toBe('terminal');
    expect(route?.branchModule).toBe('./branches/term/route.js');
    const branch = await import(new URL(`../../${route!.branchModule!}`, import.meta.url).href);
    expect(branch.runNextTuiTermBranchRoute).toBe(runNextTuiTermBranchRoute);
  }
});

test('term branch keeps read-only list routing for both aliases', async () => {
  const chatLines: string[] = [];
  const host = { chatLines, setChatScrollOffset: () => {}, sessions: { list: () => [
    { id: 'pty_12345678', title: 'shell-a', kind: 'shell', status: 'running' as const },
  ] } };
  await runNextTuiTermBranchRoute('/term list', host);
  await runNextTuiTermBranchRoute('/terminal status', host);
  expect(chatLines.join('\n')).toContain('pty_12345678'.slice(-8));
  expect(chatLines.join('\n')).toContain('1 live · 0 exited');
});
