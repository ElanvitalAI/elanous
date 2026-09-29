import { describe, expect, test } from 'bun:test';
import { handleSchedulesActionPost } from './schedules-action.js';

const request = (body: unknown) => new Request('http://localhost/v1/schedules/action', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('POST /v1/schedules/action confirmation', () => {
  for (const action of ['delete', 'migrate', 'adopt', 'release']) {
    test(`${action} does not dispatch without confirm:true; confirmation applies exactly once`, async () => {
      const calls: Record<string, unknown>[] = [];
      const dispatch = async (args: Record<string, unknown>): Promise<unknown> => {
        calls.push(args);
        return { applied: action };
      };
      const preview = await handleSchedulesActionPost(request({ action, id: 'job' }), dispatch);
      expect(await preview.json()).toMatchObject({ dryRun: true, action, id: 'job', plan: expect.any(String) });
      expect(calls).toHaveLength(0);
      const stringConfirmation = await handleSchedulesActionPost(request({ action, id: 'job', confirm: 'true' }), dispatch);
      expect((await stringConfirmation.json()).dryRun).toBe(true);
      expect(calls).toHaveLength(0);
      const applied = await handleSchedulesActionPost(request({ action, id: 'job', confirm: true }), dispatch);
      expect(await applied.json()).toEqual({ applied: action });
      expect(calls).toEqual([{ action, id: 'job' }]);
    });
  }

  test('other actions retain the original dispatch payload and result', async () => {
    const calls: Record<string, unknown>[] = [];
    const result = await handleSchedulesActionPost(request({ action: 'update', id: 'job', cron: '0 8 * * *' }), async args => {
      calls.push(args);
      return { updated: 'job' };
    });
    expect(await result.json()).toEqual({ updated: 'job' });
    expect(calls).toEqual([{ action: 'update', id: 'job', cron: '0 8 * * *' }]);
  });
});
