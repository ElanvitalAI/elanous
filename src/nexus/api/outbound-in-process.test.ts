// OB8 — wiring: once the daemon HTTP server is up, sendOutbound from the same process must not curl its own
// /v1/outbound (a synchronous self-call that froze the daemon for ~25 s · CS1 · 10-01).
import { afterEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { openDeliveryDb, deliveryDedupKey } from '../outbound/delivery-ledger.js';
import { handleOutboundReport } from './outbound-report.js';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliver } from '../../domains/outbound-alert.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { setResolveDaemonEndpointForTest } from '../daemon-endpoint.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { resetUserConfig, setUserConfigOverlay } from '../../user-config.js';
import { NexusEventBus } from './event-bus.js';
import { startNexusHttpServer } from './http-server.js';

afterEach(() => {
  setUserConfigOverlay(null);
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

test('failed fanout retries; successful fanout suppresses with the prior messageId', async () => {
  const db = openDeliveryDb(':memory:');
  const text = 'PRIVATE-OUT-NONE-REPORT';
  const kind = 'out-none';
  const attempts: string[] = [];
  let sendClock = Date.now();
  const observations: Array<{ event: string; data: unknown }> = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'outbound.send') observations.push({ event, data });
  });
  const send = async () => {
    const res = await handleOutboundReport(new Request('http://localhost/v1/outbound', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, kind }),
    }), { noAuth: true }, {
      deliveryDb: db,
      now: () => new Date(sendClock++).toISOString(),
      spill: value => ({ text: value, spilled: false }),
      telegramSend: async () => { attempts.push(text); return attempts.length > 1; },
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  try {
    const first = await send();
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ delivered: false, channel: 'none', channels: [{ type: 'telegram', ok: false }] });
    const second = await send();
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ delivered: true, channel: 'telegram', channels: [{ type: 'telegram', ok: true }] });
    expect(attempts).toHaveLength(2);
    const success = db.prepare('SELECT message_id FROM deliveries WHERE dedup_key = ? AND channels LIKE ? ORDER BY ts DESC LIMIT 1')
      .get(deliveryDedupKey(kind, text), '%"ok":true%') as { message_id: string } | null;
    expect(success).not.toBeNull();
    const third = await send();
    expect(third.status).toBe(200);
    expect(third.body).toMatchObject({ delivered: true, channel: 'suppressed', channels: [], suppressed: true, suppressedBy: success!.message_id });
    expect(attempts).toHaveLength(2);
    expect(observations.filter(row => row.event === 'suppressed')).toEqual([
      { event: 'suppressed', data: { kind, suppressedBy: success!.message_id } },
    ]);
    expect(JSON.stringify(observations.filter(row => row.event === 'suppressed'))).not.toContain(text);
  } finally {
    log.mockRestore();
    db.close();
  }
});

test('an explicit empty route is not a delivery or a duplicate', async () => {
  const db = openDeliveryDb(':memory:');
  setUserConfigOverlay(cfg => ({
    ...cfg,
    raw: { ...cfg.raw, outbound: { channels: [{ type: 'telegram' }], routes: { 'out-none-empty': [] } } },
  }));
  try {
    const send = () => handleOutboundReport(new Request('http://localhost/v1/outbound', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'empty route', kind: 'out-none-empty' }),
    }), { noAuth: true }, { deliveryDb: db, spill: text => ({ text, spilled: false }) });
    for (let i = 0; i < 2; i++) {
      const res = await send();
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ delivered: false, channel: 'none', channels: [], reason: 'no-channel' });
    }
  } finally {
    setUserConfigOverlay(null);
    db.close();
  }
});
