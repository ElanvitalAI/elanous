import { expect, test } from 'bun:test';
import { preflightNextTuiAuth } from './next-auth-preflight.js';
import type { UserConfig } from '../user-config/schema.js';

const config = { llm: { provider: 'openai-codex' } } as UserConfig;

test('one owner mirror request heals a missing mirror and resumes the same turn', async () => {
  let loads = 0;
  let requests = 0;
  const observed: Array<[string, boolean]> = [];
  await preflightNextTuiAuth(config, {
    load: async () => {
      loads++;
      if (loads === 1) throw new Error('owner mirror rejected (reason=missing-file)');
      return { accessOnly: true };
    },
    request: () => { requests++; return true; },
    observe: (reason, requested) => observed.push([reason, requested]),
  });
  expect(loads).toBe(2);
  expect(requests).toBe(1);
  expect(observed).toEqual([['missing-file', true]]);
});

test('failed owner mirror request ends with one safe recovery instruction', async () => {
  let requests = 0;
  await expect(preflightNextTuiAuth(config, {
    load: async () => { throw new Error('owner mirror rejected (reason=missing-file; secret=hidden)'); },
    request: () => { requests++; return false; },
  })).rejects.toThrow('주인 호스트에서 접근 미러를 갱신하세요');
  expect(requests).toBe(1);
});

test('an expired mirror also requests one owner refresh and resumes the same turn', async () => {
  let loads = 0;
  let requests = 0;
  await preflightNextTuiAuth(config, {
    load: async () => {
      loads++;
      if (loads === 1) throw new Error('owner mirror rejected (reason=expiry)');
      return { accessOnly: true };
    },
    request: () => { requests++; return true; },
  });
  expect(loads).toBe(2);
  expect(requests).toBe(1);
});
