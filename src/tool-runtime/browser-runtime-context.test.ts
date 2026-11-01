import { afterEach, expect, test } from 'bun:test';
import type { CdpClient } from '../browser-cdp/client.js';
import {
  _resetBrowserRuntimeDepsForTest,
  browserReadRuntime,
  setBrowserRuntimeDeps,
} from './browser-runtime.js';

afterEach(() => _resetBrowserRuntimeDepsForTest());

test('BrowserRead attributes an MCP-returned action to the explicit parent runId', async () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const client = {
    isAlive: true,
    evaluate: async () => 'Release page is ready',
  } as unknown as CdpClient;
  setBrowserRuntimeDeps({
    getClient: async () => client,
    observe: (event, data) => events.push({ event, data }),
  });

  const result = await browserReadRuntime.run(
    { mode: 'text' },
    { surface: 'mcp', runId: 'run-aside-same-run' },
  );

  expect(result.output).toContain('Release page is ready');
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event: 'executed', data: { runId: 'run-aside-same-run', action: 'read', ok: true } });
});
