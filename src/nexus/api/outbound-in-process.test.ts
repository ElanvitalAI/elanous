// OB8 — wiring: once the daemon HTTP server is up, sendOutbound from the same process must not curl its own
// /v1/outbound (a synchronous self-call that froze the daemon for ~25 s · CS1 · 10-01).
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliver } from '../../domains/outbound-alert.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { setResolveDaemonEndpointForTest } from '../daemon-endpoint.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { resetUserConfig } from '../../user-config.js';
import { NexusEventBus } from './event-bus.js';
import { startNexusHttpServer } from './http-server.js';

afterEach(() => {
  setResolveDaemonEndpointForTest(null);
  resetElanousConfigDir();
  resetUserConfig();
});

test('the daemon HTTP server registers the in-process sender while it runs, and removes it on stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob8-outbound-'));
  setElanousConfigDir(dir);
  resetUserConfig();
  const selfCalls: string[] = [];
  const curl = spyOn(childProcess, 'execFileSync').mockImplementation(((_cmd: string, args: readonly string[] | undefined) => {
    const url = String(args?.[args.length - 1] ?? '');
    if (url.includes('/v1/outbound')) { selfCalls.push(url); return '{"delivered":true}'; }
    return '{"ok":true}';
  }) as never);
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  const server = startNexusHttpServer({ state, eventBus, registry: new TabRegistry(state), startPort: 47000 + Math.floor(Math.random() * 2000), portRange: 50 });
  setResolveDaemonEndpointForTest(() => ({ baseUrl: server.url, healthUrl: `${server.url}/v1/health`, pwaUrl: `${server.url}/app/`, source: 'registry' }));
  try {
    expect(deliver('consult alert', 'alert')).toBe('daemon');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(selfCalls).toEqual([]);
  } finally {
    server.stop();
  }
  try {
    deliver('cron report', 'report');
    expect(selfCalls).toEqual([`${server.url}/v1/outbound`]);
  } finally {
    curl.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
