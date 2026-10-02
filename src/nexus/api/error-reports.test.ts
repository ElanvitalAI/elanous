import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newReportId } from '../../hooks/error-report.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir.js';
import { setTestStateRoot } from '../paths.js';
import { createNexusState } from '../state/state.js';
import { TabRegistry } from '../state/tab-registry.js';
import { NexusEventBus } from './event-bus.js';
import { errorReportAlertText, handleErrorReportIngest, pruneErrorReports } from './error-reports.js';
import { startNexusHttpServer } from './http-server.js';
import { issueIngestToken } from './ingest-token.js';

const NOW = Date.parse('2026-10-01T14:30:00Z');
const item = (code = 'skill-index', over: Record<string, unknown> = {}) => ({
  reportId: newReportId(NOW), dedupe: 'abcdef012345', receivedAt: new Date(NOW).toISOString(),
  report: {
    kind: 'error-report', v: 1, code, message: 'description.trim is not a function', stack: 'at indexSkill (skills/index.ts:42:7)',
    app: { version: '0.2.7', sha: 'eadd7c31', surface: 'tui', os: 'darwin', arch: 'arm64' },
    nexus: { alive: true }, who: { installId: '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b', email: 'person@example.com' },
    at: '2026-10-01T14:29:00Z', consent: true,
  },
  ...over,
});
const req = (body: unknown) => new Request('http://x/v1/reports/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('handleErrorReportIngest', () => {
  test('stores under YYYY/MM/DD, alerts once per hour per error, and the alert carries no message or identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'er2-primary-'));
    const alerts: string[] = [];
    const deps = { root: () => root, now: () => NOW, alert: async (text: string) => { alerts.push(text); return true; } };
    try {
      const first = item();
      const res = await handleErrorReportIngest(req(first), deps);
      expect(res.status).toBe(202);
      const path = join(root, 'error-reports', '2026', '10', '01', `${first.reportId}.json`);
      expect(JSON.parse(readFileSync(path, 'utf8')).report.code).toBe('skill-index');
      await handleErrorReportIngest(req(item()), deps);
      await Bun.sleep(10);
      expect(alerts).toEqual([errorReportAlertText(first as never, 1)]);
      expect(alerts[0]).toBe(`🧯 오류 보고 skill-index · v0.2.7 · tui · 같은 오류 24h 1회 · ${first.reportId}`);
      expect(alerts[0]).not.toContain('description.trim');
      expect(alerts[0]).not.toContain('person@example.com');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('day folders older than 30 days are removed on the next receipt; newer ones stay', async () => {
    const root = mkdtempSync(join(tmpdir(), 'er2-prune-'));
    try {
      mkdirSync(join(root, 'error-reports', '2026', '08', '20'), { recursive: true });
      mkdirSync(join(root, 'error-reports', '2026', '09', '15'), { recursive: true });
      expect(pruneErrorReports(root, NOW)).toBe(1);
      expect(existsSync(join(root, 'error-reports', '2026', '08', '20'))).toBe(false);
      expect(existsSync(join(root, 'error-reports', '2026', '09', '15'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a malformed forward is refused field by field', async () => {
    const deps = { root: () => mkdtempSync(join(tmpdir(), 'er2-bad-')), now: () => NOW, alert: async () => true };
    expect(await (await handleErrorReportIngest(req(item('skill-index', { reportId: 'x' })), deps)).json()).toEqual({ error: 'invalid', field: 'reportId' });
    expect(await (await handleErrorReportIngest(req(item('skill-index', { report: { ...item().report, consent: false } })), deps)).json()).toEqual({ error: 'invalid', field: 'report.consent' });
  });
});

describe('route on the real daemon server', () => {
  const dir = mkdtempSync(join(tmpdir(), 'er2-route-'));
  setElanousConfigDir(dir);
  setTestStateRoot(dir);
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const server = startNexusHttpServer({ state, registry: new TabRegistry(state), eventBus: new NexusEventBus(),
    startPort: 49000 + Math.floor(Math.random() * 900), portRange: 50, metaApi: { bearerToken: 'secret', noAuth: false } });
  afterAll(() => { server.stop(); resetElanousConfigDir(); setTestStateRoot(null); rmSync(dir, { recursive: true, force: true }); });

  test('the VM ingest token reaches /v1/reports/ingest; no token is 401', async () => {
    const token = issueIngestToken('bot-vm-reports').token;
    const send = (auth?: string) => fetch(`${server.url}/v1/reports/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(item()),
    });
    expect((await send()).status).toBe(401);
    expect((await send(token)).status).toBe(202);
  });
});
