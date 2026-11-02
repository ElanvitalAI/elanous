import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleErrorReportIngest } from '../nexus/api/error-reports.js';
import { createCloudErrorReportPublisher, type GoogleRequestOptions } from './error-report-cloud.js';
import type { ReceivedReport } from './error-report.js';
import { startHookReceiver } from './receiver.js';

const NOW = Date.parse('2026-11-02T04:00:00.000Z');
const sourceReport = {
  kind: 'error-report' as const, v: 1 as const, code: 'skill-index', message: 'private test detail',
  stack: 'at indexSkill (skills/index.ts:42:7)',
  app: { version: '0.2.45', sha: 'abcdef12', surface: 'tui' as const, os: 'linux', arch: 'x64' },
  nexus: { alive: true }, who: { installId: '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b' },
  at: new Date(NOW - 1000).toISOString(), consent: true as const,
};

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await Bun.sleep(10); }
  throw new Error('timeout waiting for cloud publish');
}

test('hook intake stores and publishes one receipt; fake subscription retains it through Primary downtime', async () => {
  const vmRoot = mkdtempSync(join(tmpdir(), 'er-cloud-vm-'));
  const primaryRoot = mkdtempSync(join(tmpdir(), 'er-cloud-primary-'));
  const objects = new Map<string, string>();
  const calls: string[] = [];
  const subscription: Array<{ data: string; attributes: Record<string, string> }> = [];
  let fallbackCalls = 0;
  let acked = 0;
  let primaryAvailable = false;
  let primaryNextStatus: number | undefined;
  const request = async (options: GoogleRequestOptions): Promise<unknown> => {
    if (options.url.includes('storage.googleapis.com')) {
      calls.push('bucket');
      const name = String(options.params?.name);
      if (options.params?.ifGenerationMatch !== 0 || objects.has(name)) throw { response: { status: 412 } };
      objects.set(name, String(options.data));
      return {};
    }
    if (options.url.includes('pubsub.googleapis.com')) {
      calls.push('publish');
      const messages = (options.data as { messages: Array<{ data: string; attributes: Record<string, string> }> }).messages;
      subscription.push(...messages);
      return { messageIds: ['fake-message-1'] };
    }
    throw new Error(`unexpected fake Google endpoint: ${options.url}`);
  };
  const publish = createCloudErrorReportPublisher({
    projectId: 'test-project', bucket: 'private-reports', topic: 'error-reports', request,
  });
  const receiver = startHookReceiver({ port: 0, root: vmRoot, now: () => NOW, secrets: {},
    cloudReportsEnabled: true, publishCloudReport: publish,
    forwardReport: async () => { fallbackCalls++; return false; }, retryBaseMs: 10_000 });

  try {
    const intake = await fetch(new URL('/v1/reports', receiver.url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sourceReport),
    });
    expect(intake.status).toBe(202);
    await waitFor(() => subscription.length === 1 && calls.length === 2);
    expect(calls).toEqual(['bucket', 'publish']);
    expect(fallbackCalls).toBe(0);
    expect(await (await fetch(new URL('/hooks/health', receiver.url))).json()).toMatchObject({ reportsQueued: 0 });

    const message = subscription[0];
    expect(message).toBeDefined();
    const receipt = JSON.parse(Buffer.from(message!.data, 'base64').toString('utf8')) as ReceivedReport;
    expect(receipt.report).toEqual(sourceReport);
    expect(message!.attributes).toEqual({ reportId: receipt.reportId, dedupe: receipt.dedupe, schemaVersion: '1' });
    expect([...objects.keys()]).toEqual([`2026/11/02/${receipt.reportId}.json`]);
    expect(JSON.parse(objects.get(`2026/11/02/${receipt.reportId}.json`)!)).toEqual(receipt);

    // Process-internal fake subscription: Primary downtime must leave the Pub/Sub receipt pending.
    const deliverOne = async () => {
      if (!primaryAvailable) return false;
      const nextStatus = primaryNextStatus;
      primaryNextStatus = undefined;
      if (nextStatus !== undefined && nextStatus !== 202) return false;
      const response = await handleErrorReportIngest(new Request('http://primary/v1/reports/ingest', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(receipt),
      }), { root: () => primaryRoot, now: () => NOW, alert: async () => true });
      if (response.status !== 202) return false;
      subscription.shift();
      acked++;
      return true;
    };
    expect(await deliverOne()).toBe(false);
    expect(subscription).toHaveLength(1);
    expect(acked).toBe(0);
    expect(existsSync(join(primaryRoot, 'error-reports'))).toBe(false);
    primaryAvailable = true;
    // A reachable Primary can still reject a delivery; the subscription must retain it until a 202.
    primaryNextStatus = 503;
    expect(await deliverOne()).toBe(false);
    expect(subscription).toHaveLength(1);
    expect(acked).toBe(0);
    expect(existsSync(join(primaryRoot, 'error-reports'))).toBe(false);
    expect(await deliverOne()).toBe(true);
    expect(subscription).toHaveLength(0);
    expect(acked).toBe(1);
    const primaryPath = join(primaryRoot, 'error-reports', '2026', '11', '02', `${receipt.reportId}.json`);
    expect(existsSync(primaryPath)).toBe(true);
    const stored = JSON.parse(readFileSync(primaryPath, 'utf8')) as ReceivedReport;
    expect(stored).toEqual(receipt);
    expect(stored.report).toEqual(sourceReport);
  } finally {
    receiver.stop();
    rmSync(vmRoot, { recursive: true, force: true });
    rmSync(primaryRoot, { recursive: true, force: true });
  }
});
