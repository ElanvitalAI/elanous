import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchGraphContract } from '../capabilities.js';
import { createJsonlMemberEventStore } from '../../nexus/api/member-event-store.js';
import { createAbsorbBuildMemberRegistry } from './absorb-member-registry.js';

test('default build board event uses the shared Nexus journal only for the verified member', async () => {
  const root = mkdtempSync(join(tmpdir(), 'absorb-build-events-'));
  try {
    const store = createJsonlMemberEventStore(join(root, 'member-events'));
    const registry = createAbsorbBuildMemberRegistry(store);
    const event = { type: 'board.card', memberId: 'member-a', cardId: 'suggestion-a',
      state: 'building', title: 'Ticket app', summary: 'Starting', runId: 'trusted-run',
      at: '2026-11-14T00:00:00.000Z' };
    const append = (verifiedOwnerId: string | undefined, memberId: string, submitted = event) =>
      dispatchGraphContract('store.events@1', {
        graphId: 'absorb-build', runId: 'trusted-run', nodeId: 'board-building', verifiedOwnerId,
        input: { context: { memberId } }, graphInput: { context: { memberId } },
        nodeInput: { operation: 'append', memberId, event: submitted }, outputs: {},
      }, registry);
    expect(await append(undefined, 'member-a')).toMatchObject({ ok: false });
    expect(await append('member-a', 'member-b', { ...event, memberId: 'member-b' })).toMatchObject({ ok: false });
    expect(await append('member-a', 'member-a', { ...event, memberId: 'member-b' })).toMatchObject({ ok: false });
    expect(await store.query({ memberId: 'member-a', type: 'board.card' })).toEqual([]);
    expect(await append('member-a', 'member-a')).toMatchObject({ ok: true, result: { appended: true } });
    expect(await store.query({ memberId: 'member-a', type: 'board.card' })).toEqual([event]);
    expect(await store.query({ memberId: 'member-b', type: 'board.card' })).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
