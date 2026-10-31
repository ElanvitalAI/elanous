import { expect, test } from 'bun:test';
import { createCloudErrorReportPublisher, ErrorReportCloudError } from './error-report-cloud.js';
import type { ReceivedReport } from './error-report.js';

const item: ReceivedReport = {
  reportId: 'er_0123456789abcdefghjkmnpqrs',
  dedupe: '0123456789ab',
  receivedAt: '2026-10-30T02:00:00.000Z',
  report: {
    kind: 'error-report', v: 1, code: 'skill-index', message: 'safe message', stack: 'at load (skills/load.ts:9:3)',
    app: { version: '0.2.42', sha: 'abcdef12', surface: 'tui', os: 'darwin', arch: 'arm64' },
    nexus: { alive: true, instance: 'a1b2c3d4e5f6' }, who: { installId: '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b' },
    at: '2026-10-30T02:00:00.000Z', consent: true,
  },
};

test('cloud publisher stores an immutable date-partitioned object before publishing the receipt', async () => {
  const requests: Array<{ url: string; method: string; params?: Record<string, string | number>; data: unknown }> = [];
  const publish = createCloudErrorReportPublisher({
    projectId: 'test-project', bucket: 'private-reports', topic: 'error-reports',
    request: async (request) => { requests.push(request); return {}; },
  });

  await publish(item);

  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({
    url: 'https://storage.googleapis.com/upload/storage/v1/b/private-reports/o', method: 'POST',
    params: { uploadType: 'media', name: '2026/10/30/er_0123456789abcdefghjkmnpqrs.json', ifGenerationMatch: 0 },
    data: JSON.stringify(item),
  });
  const pubsub = requests[1]!.data as { messages: Array<{ data: string; attributes: Record<string, string> }> };
  expect(requests[1]!.url).toBe('https://pubsub.googleapis.com/v1/projects/test-project/topics/error-reports:publish');
  expect(JSON.parse(Buffer.from(pubsub.messages[0]!.data, 'base64').toString('utf8'))).toEqual(item);
  expect(pubsub.messages[0]!.attributes).toEqual({ reportId: item.reportId, dedupe: item.dedupe, schemaVersion: '1' });
});

test('an already-created object is reused after a lost upload response before publishing', async () => {
  const stages: string[] = [];
  const publish = createCloudErrorReportPublisher({ request: async (request) => {
    stages.push(request.url.includes('storage.googleapis.com') ? 'store' : 'publish');
    if (stages.length === 1) throw { response: { status: 412 } };
    return {};
  } });

  await publish(item);
  expect(stages).toEqual(['store', 'publish']);
});

test('cloud failures identify the failing stage without exposing request contents', async () => {
  const publish = createCloudErrorReportPublisher({ request: async (request) => {
    if (request.url.includes('storage.googleapis.com')) return {};
    throw new Error('private transport detail');
  } });

  try {
    await publish(item);
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(ErrorReportCloudError);
    expect((error as ErrorReportCloudError).stage).toBe('publish');
    expect((error as Error).message).not.toContain('private transport detail');
  }
});
