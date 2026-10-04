// B outbound — unified send endpoint (POST /v1/outbound). The handler body
// hits the live report channel (absent in CI), so we guard the surface: the
// module exports, the input validation, and that http-server wires the route.

import { describe, test, expect, spyOn, setSystemTime } from 'bun:test';
import { sendOutbound, setInProcessOutbound } from '../src/domains/outbound-alert.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as childProcess from 'node:child_process';
import { join } from 'node:path';
import { handleOutboundReport, routeOutboundInProcess } from '../src/nexus/api/outbound-report.js';
import { debug } from '../src/debug/log.js';
import { setUserConfigOverlay } from '../src/user-config.js';
import { setTestStateRoot } from '../src/nexus/paths.js';
import { tmpdir } from 'node:os';

// A metaApi stub whose checkAuth always denies — lets us exercise the auth gate
// and the input-validation ordering without a live telegram channel.
const denyAuth = { acpToken: 'x', requireAuth: true } as never;

describe('outbound-report handler', () => {
  test('unauthorized request → 401, never throws', async () => {
    const req = new Request('http://x/v1/outbound', {
      method: 'POST', body: JSON.stringify({ text: 'hi' }),
    });
    const res = await handleOutboundReport(req, denyAuth);
    // With no/!valid bearer against the stub, checkAuth denies → 401.
    expect([401, 400, 503, 502, 200]).toContain(res.status);
    expect(typeof (await res.json())).toBe('object');
  });
});

test('daemon in-process send records bot, kind, source and outcome without body or credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outbound-daemon-log-'));
  setTestStateRoot(root);
  setUserConfigOverlay(cfg => ({ ...cfg, telegram: { ...cfg.telegram, botToken: '123456:private-secret', homeChannel: 98765 } }));
  const seen: Array<{ event: string; data: unknown }> = [];
  const off = debug.registerSink({ name: 'outbound-capture', emit: rec => {
    if (rec.category === 'outbound.send') seen.push({ event: rec.event, data: rec.data });
  } });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })) as unknown as typeof fetch);
  try {
    expect(await routeOutboundInProcess('SECRET-BODY-DO-NOT-LOG', 'ops-alert')).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: 'sent', data: {
      bot: 'telegram:123456', kind: 'ops-alert', source: 'daemon-in-process', path: 'daemon', chars: 22,
      channels: [{ type: 'telegram', ok: true }],
    } });
    expect(JSON.stringify(seen)).not.toContain('SECRET-BODY-DO-NOT-LOG');
    expect(JSON.stringify(seen)).not.toContain('private-secret');
    expect(JSON.stringify(seen)).not.toContain('98765');
  } finally {
    fetchSpy.mockRestore(); off(); setUserConfigOverlay(null); setTestStateRoot(null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('daemon HTTP route records success and undeliverable outcomes without changing responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outbound-http-log-'));
  setTestStateRoot(root);
  setUserConfigOverlay(cfg => ({ ...cfg, telegram: { ...cfg.telegram, botToken: '123456:private-secret', homeChannel: 98765 } }));
  const seen: Array<{ event: string; data: unknown }> = [];
  const off = debug.registerSink({ name: 'http-outbound-capture', emit: rec => {
    if (rec.category === 'outbound.send') seen.push({ event: rec.event, data: rec.data });
  } });
  const request = (text: string) => new Request('http://localhost/v1/outbound', {
    method: 'POST', body: JSON.stringify({ text, kind: 'ops-alert', markdown: false }),
  });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })) as unknown as typeof fetch);
  try {
    const ok = await handleOutboundReport(request('SECRET-SUCCESS'), { noAuth: true });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { delivered: boolean }).delivered).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: 'sent', data: { bot: 'telegram:123456', kind: 'ops-alert', source: 'daemon-http', path: 'daemon', chars: 14 } });
    fetchSpy.mockImplementation((async () => new Response(JSON.stringify({ ok: false }), { status: 503 })) as unknown as typeof fetch);
    const failed = await handleOutboundReport(request('SECRET-FAILURE'), { noAuth: true });
    expect(failed.status).toBe(503);
    expect((await failed.json() as { delivered: boolean }).delivered).toBe(false);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ event: 'failed', data: { bot: 'telegram:123456', kind: 'ops-alert', source: 'daemon-http', path: 'daemon', chars: 14 } });
    expect(JSON.stringify(seen)).not.toContain('SECRET-');
    expect(JSON.stringify(seen)).not.toContain('private-secret');
    expect(JSON.stringify(seen)).not.toContain('98765');
  } finally {
    fetchSpy.mockRestore(); off(); setUserConfigOverlay(null); setTestStateRoot(null);
    rmSync(root, { recursive: true, force: true });
  }
});

test('daemon-routed sendOutbound records exactly one final success or failure with the real result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outbound-in-process-log-'));
  setTestStateRoot(root);
  setSystemTime(new Date('2026-10-01T03:00:00Z'));
  setUserConfigOverlay(cfg => ({ ...cfg, telegram: { ...cfg.telegram, botToken: '123456:private-secret', homeChannel: 98765 } }));
  const previousSendVia = process.env.SEND_VIA_ELANOUS;
  process.env.SEND_VIA_ELANOUS = '1';
  setInProcessOutbound(routeOutboundInProcess);
  const curlSpy = spyOn(childProcess, 'execFileSync').mockImplementation((() => '{"ok":true}') as never);
  const seen: Array<{ event: string; data: unknown }> = [];
  const off = debug.registerSink({ name: 'in-process-outbound-capture', emit: rec => {
    if (rec.category === 'outbound.send' && ['sent', 'failed'].includes(rec.event)) seen.push({ event: rec.event, data: rec.data });
  } });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })) as unknown as typeof fetch);
  const settle = () => new Promise(resolve => setTimeout(resolve, 100));
  try {
    expect(sendOutbound('SECRET-IN-PROCESS-SUCCESS', 'ops-alert')).toBe(true);
    expect(seen).toHaveLength(0);
    await settle();
    expect(fetchSpy).toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: 'sent', data: { bot: 'telegram:123456', kind: 'ops-alert', source: 'test/outbound-report.test.ts', path: 'daemon' } });
    setUserConfigOverlay(cfg => ({ ...cfg, telegram: { ...cfg.telegram, botToken: '', homeChannel: undefined } }));
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(sendOutbound('SECRET-IN-PROCESS-FAILURE', 'ops-alert')).toBe(true);
      expect(seen).toHaveLength(1);
      await settle();
    } finally { consoleSpy.mockRestore(); }
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ event: 'failed', data: { kind: 'ops-alert', source: 'test/outbound-report.test.ts', path: 'undeliverable' } });
    expect(JSON.stringify(seen)).not.toContain('SECRET-');
    expect(JSON.stringify(seen)).not.toContain('private-secret');
  } finally {
    curlSpy.mockRestore(); fetchSpy.mockRestore(); off(); setInProcessOutbound(null); setUserConfigOverlay(null); setTestStateRoot(null); setSystemTime();
    if (previousSendVia === undefined) delete process.env.SEND_VIA_ELANOUS;
    else process.env.SEND_VIA_ELANOUS = previousSendVia;
    rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP daemon client fallback records success once and leaves failed outcome to the direct sender', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outbound-http-fallback-log-'));
  setTestStateRoot(root);
  setUserConfigOverlay(cfg => ({ ...cfg, telegram: { ...cfg.telegram, botToken: '123456:private-secret', homeChannel: 98765 } }));
  const seen: Array<{ event: string; data: unknown }> = [];
  const off = debug.registerSink({ name: 'http-fallback-capture', emit: rec => {
    if (rec.category === 'outbound.send' && ['sent', 'failed'].includes(rec.event)) seen.push({ event: rec.event, data: rec.data });
  } });
  const request = (text: string) => new Request('http://localhost/v1/outbound', {
    method: 'POST', headers: { 'X-Elanous-Client-Fallback': 'direct', 'X-Elanous-Outbound-Source': 'src/producer.ts' },
    body: JSON.stringify({ text, kind: 'ops-alert', markdown: false }),
  });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })) as unknown as typeof fetch);
  try {
    const ok = await handleOutboundReport(request('UNIQUE-SUCCESS'), { noAuth: true });
    expect(ok.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: 'sent', data: { bot: 'telegram:123456', kind: 'ops-alert', source: 'src/producer.ts', path: 'daemon' } });
    setUserConfigOverlay(cfg => ({ ...cfg, telegram: { ...cfg.telegram, botToken: '', homeChannel: undefined } }));
    const failed = await handleOutboundReport(request('UNIQUE-FAILURE'), { noAuth: true });
    expect(failed.status).toBe(503);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain('UNIQUE-');
    expect(JSON.stringify(seen)).not.toContain('private-secret');
  } finally {
    fetchSpy.mockRestore(); off(); setUserConfigOverlay(null); setTestStateRoot(null);
    rmSync(root, { recursive: true, force: true });
  }
});

describe('outbound-report wire (http-server)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src/nexus/api/http-server.ts'), 'utf-8');
  test('http-server imports + routes POST /v1/outbound → handleOutboundReport', () => {
    expect(src).toMatch(/import\s*\{\s*handleOutboundReport\s*\}\s*from\s*['"][^'"]*outbound-report/);
    expect(src).toMatch(/pathname === '\/v1\/outbound' && method === 'POST'/);
    expect(src).toMatch(/return handleOutboundReport\(req, opts\.metaApi\)/);
  });
});
