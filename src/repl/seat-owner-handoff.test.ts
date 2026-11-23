import { describe, expect, test } from 'bun:test';
import { buildTurnOwnerResult } from './index.js';
import { handoffForeignOwner } from './seat-owner-handoff.js';
import type { SeatOwnerReaders } from '../core-turn/seat-owner-lookup.js';

const readers: SeatOwnerReaders = {
  checklistVersion: () => '0.3.33',
  readChecklist: version => ({ version, items: [{ id: 'SYNTH-CELL', owner: 'TEST-1', title: 'x', status: 'yellow', updatedAt: '', updatedBy: 'TEST' }] }),
  readPullRequest: (_repo, number) => ({ number, body: '칸 닫음: SYNTH-CELL' }),
  readMail: () => null,
};
const cell = { kind: 'cell', id: 'SYNTH-CELL', version: '0.3.33' };
const pr = { kind: 'pr', repository: 'test/repo', number: 42 };

describe('structured owner handoff', () => {
  for (const reference of [cell, pr]) test(`${reference.kind} routes to the checklist owner without investigation`, async () => {
    const messages: unknown[] = [];
    let investigations = 0;
    const result = await handoffForeignOwner({ seat: 'TEST-2', workReferences: [reference], evidence: 'synthetic=true · observed failure',
      lookup: (seat, refs) => buildTurnOwnerResult(seat, refs, readers),
      post: async message => { messages.push(message); },
    });
    if (!result) investigations++;
    expect(investigations).toBe(0);
    expect(messages).toEqual([{ from: 'TEST-2', to: 'TEST-1', kind: 'evidence',
      body: `조사 전 인계 ${JSON.stringify([reference])} · synthetic=true · observed failure` }]);
  });
  test('own and unknown continue, failure to post remains blocked', async () => {
    const run = (seat: string, refs: unknown, fail = false) => handoffForeignOwner({ seat, workReferences: refs, evidence: 'x',
      lookup: (s, r) => buildTurnOwnerResult(s, r, readers), post: async () => { if (fail) throw Error('offline'); } });
    expect(await run('TEST-1', [cell])).toBeNull();
    expect(await run('TEST-2', [{ ...cell, id: 'MISSING' }])).toBeNull();
    expect(await run('TEST-2', undefined)).toBeNull();
    expect(await run('TEST-2', [])).toBeNull();
    expect(await run('TEST-2', [cell], true)).toContain('전달하지 못했습니다');
  });
});
