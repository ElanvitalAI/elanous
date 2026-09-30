import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { buildDashboardSlashRegistry } from './index.js';
import { unknownSlashReply } from './unknown-slash-reply.js';

const dashboardSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

test('unregistered dashboard slash uses reply lines after registry and plugin, retaining tone and input flow', async () => {
  const registry = buildDashboardSlashRegistry();
  expect((await registry.dispatch('implement', [], {} as never)).kind).toBe('unregistered');
  expect(unknownSlashReply('implement', registry.names())).toEqual([
    '/implement has moved; use /harness ask <무엇을 왜 고칠지 한 문장>',
  ]);

  const dispatch = dashboardSource.indexOf('dashboardSlashRegistry.dispatch(cmdLower, args, slashCtx)');
  const plugin = dashboardSource.indexOf('pluginHost.dispatchSlash(cmdLower, args)', dispatch);
  const reply = dashboardSource.indexOf('unknownSlashReply(cmdLower, dashboardSlashRegistry.names())', plugin);
  expect(dispatch).toBeGreaterThan(-1);
  expect(plugin).toBeGreaterThan(dispatch);
  expect(reply).toBeGreaterThan(plugin);
  expect(dashboardSource.slice(plugin, reply)).toContain('if (handled) { chatScrollOffset = -1; continue; }');
  expect(dashboardSource.slice(reply, reply + 400)).toMatch(
    /for \(const \[index, line\] of replyLines\.entries\(\)\) \{\s*chatLines\.push\(index === 0 \? C\.warning\(line\) : C\.muted\(line\)\);\s*\}\s*chatScrollOffset = -1;\s*continue; \/\/ stay in input mode/,
  );
});
