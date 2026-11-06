/**
 * NEXUS T3 endpoint contract test for TaskApi (`/v1/tasks`).
 *
 * fetch mock 으로 list + detail (path-segment encoding) 검증.
 */

import { describe, expect, it } from 'bun:test';

import { DaemonClient } from './daemon-client';
import { TaskApi } from './task-api';
import { withFakeFetchDevice } from '../test-devices/fake-fetch';

function makeClient(): DaemonClient {
  return new DaemonClient({
    baseUrl: 'http://localhost:31415',
    token: '',
    provider: 'anthropic',
  });
}

describe('TaskApi.list — GET /v1/tasks', () => {
  it('returns the daemon summary + tasks shape verbatim', async () => {
    await withFakeFetchDevice([{ url: '/v1/tasks', response: Response.json({
        summary: {
          total: 5,
          open: 3,
          terminal: 2,
          linkedScheduler: 1,
          byStatus: { ready: 2, done: 2, blocked: 1 },
          byPriority: { medium: 4, high: 1 },
        },
        tasks: [
          {
            id: 'task-1',
            title: 'milk',
            dryRun: false,
            status: 'ready',
            priority: 'medium',
            surfaceKind: 'pwa',
            createdAt: 0,
            updatedAt: 0,
            attempt: 0,
            maxRetries: 0,
            notesTail: [],
            acceptanceCount: 0,
          },
        ],
      }),
    }], async (device) => {
      const api = new TaskApi(makeClient());
      const result = await api.list();
      expect(device.calls()[0]!.url).toBe('http://localhost:31415/v1/tasks');
      expect(result.summary.total).toBe(5);
      expect(result.tasks[0]?.id).toBe('task-1');
    });
  });

  it('throws on 503 not-wired', async () => {
    await withFakeFetchDevice([{ url: '/v1/tasks', response: Response.json({ error: 'meta-api-runtime-not-wired' }, { status: 503 }) }], async () => {
      const api = new TaskApi(makeClient());
      await expect(api.list()).rejects.toThrow(/meta-api-runtime-not-wired/);
    });
  });
});

describe('TaskApi.detail — GET /v1/tasks/:taskId', () => {
  it('encodes the taskId path segment for slashes', async () => {
    await withFakeFetchDevice([{ url: '/v1/tasks/a%2Fb', response: Response.json({
        task: {
          id: 'a/b',
          createdAt: 0,
          updatedAt: 0,
          version: 1,
          title: 't',
          description: '',
          surface: { kind: 'pwa' },
          dependsOn: [],
          priority: 'medium',
          isolation: 'process',
          maxRetries: 0,
          attempt: 0,
          status: 'ready',
          notes: [],
        },
        executions: [],
        events: [],
      }),
    }], async (device) => {
      const api = new TaskApi(makeClient());
      await api.detail('a/b');
      expect(device.calls()[0]!.url).toBe('http://localhost:31415/v1/tasks/a%2Fb');
    });
  });
});
