import { describe, expect, test } from 'bun:test';
import { PWA_ROLE_KEY } from './pwa-role';
import { applyOperatorDefaultRole, readOperator, shouldDefaultToOwner } from './operator-role';

const answer = (status: number, body: unknown) => async (url: string) => {
  expect(url).toBe('http://d.test/v1/me');
  return { ok: status >= 200 && status < 300, json: async () => body };
};
const storage = (role: string | null) => ({ getItem: (k: string) => (k === PWA_ROLE_KEY ? role : null) });

describe('operator default role', () => {
  test('operator is true only for an exact operator:true answer', async () => {
    expect(await readOperator('http://d.test/', answer(200, { operator: true, operatorSource: 'op-proxy' }))).toBe(true);
    expect(await readOperator('http://d.test', answer(200, { operator: false }))).toBe(false);
    expect(await readOperator('http://d.test', answer(200, { operator: 'true' }))).toBe(false);
    expect(await readOperator('http://d.test', answer(200, {}))).toBe(false);
    expect(await readOperator('http://d.test', answer(404, { error: 'not-found' }))).toBe(false);
    expect(await readOperator('http://d.test', async () => { throw new Error('offline'); })).toBe(false);
  });

  test('an undecided device on an operator daemon becomes owner', async () => {
    const written: string[] = [];
    const applied = await applyOperatorDefaultRole({ baseUrl: 'http://d.test', fetchImpl: answer(200, { operator: true }), storage: storage(null), write: (r) => written.push(r) });
    expect(applied).toBe(true);
    expect(written).toEqual(['owner']);
  });

  test('a role the person already picked is never overwritten, and external installs stay general', async () => {
    for (const picked of ['general', 'contributor', 'owner']) {
      const written: string[] = [];
      expect(await applyOperatorDefaultRole({ baseUrl: 'http://d.test', fetchImpl: answer(200, { operator: true }), storage: storage(picked), write: (r) => written.push(r) })).toBe(false);
      expect(written).toEqual([]);
    }
    const written: string[] = [];
    expect(await applyOperatorDefaultRole({ baseUrl: 'http://d.test', fetchImpl: answer(200, { operator: false }), storage: storage(null), write: (r) => written.push(r) })).toBe(false);
    expect(written).toEqual([]);
    expect(shouldDefaultToOwner(null, false)).toBe(false);
    expect(shouldDefaultToOwner('general', true)).toBe(false);
  });
});
