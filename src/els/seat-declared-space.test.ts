import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSeat } from './seat-open.js';
import type { ElsRequest } from './server.js';

test('seat placement follows declaration, matching space, then HQ', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-declared-seat-'));
  try {
    const state = join(root, 'seat-state'); mkdirSync(state);
    mkdirSync(join(root, '.elanous'));
    const ids = ['OP', 'TC', 'TC-H-CX-4', 'JUD', 'JUD-2', 'REVIEW-1', 'OTHER', 'NOBODY'];
    for (const id of ids) mkdirSync(join(root, 'seats', id), { recursive: true });
    writeFileSync(join(root, '.elanous', 'federation.json'), JSON.stringify({ version: 1,
      seats: Object.fromEntries(ids.map(id => [id, {}])),
      spaces: { OP: { coordinator: 'OP' }, TC: { coordinator: 'TC', seats: ['TC-H-CX-4'] }, JUDGE: { coordinator: 'JUD', seats: ['JUD-2', 'REVIEW-1'] } } }));
    const cases = [['OP','OP'], ['TC-H-CX-4','TC'], ['JUD-2','JUDGE'], ['REVIEW-1','JUDGE'], ['OTHER','OTHER'], ['NOBODY','HQ']] as const;
    for (const [seat, expected] of cases) {
      const requests: ElsRequest[] = [];
      const result = await openSeat(seat, state, async r => {
        requests.push(r);
        return r.op === 'ls' ? { exitCode: 0, message: JSON.stringify({ panes: [], workspaces: [{ name: 'OP' }, { name: 'OTHER' }] }) } : { exitCode: 0, message: '{"pane":"p1"}' };
      });
      expect(result.exitCode).toBe(0);
      expect(requests[1]).toMatchObject({ op: 'new', ws: expected, title: seat, uniqueSeat: seat });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('invalid declaration stops creation and explicit workspace still works', async () => {
  const root = mkdtempSync(join(tmpdir(), 'els-declared-seat-'));
  try {
    const state = join(root, 'seat-state'); mkdirSync(state);
    mkdirSync(join(root, 'seats', 'TC'), { recursive: true }); mkdirSync(join(root, '.elanous'));
    writeFileSync(join(root, '.elanous', 'federation.json'), '{bad');
    const requests: ElsRequest[] = [];
    const request: Parameters<typeof openSeat>[2] = async (r) => { requests.push(r); return r.op === 'ls' ? { exitCode: 0, message: '{"panes":[],"workspaces":[]}' } : { exitCode: 0, message: '{"pane":"p1"}' }; };
    expect((await openSeat('TC', state, request)).exitCode).toBe(1);
    expect(requests).toEqual([{ op: 'ls' }]);
    expect((await openSeat('TC', state, request, { ws: 'EXPLICIT' })).exitCode).toBe(0);
    expect(requests.at(-1)).toMatchObject({ op: 'new', ws: 'EXPLICIT' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
