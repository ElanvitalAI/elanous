import { expect, test } from 'bun:test';
import { dispatchGraphContract } from '../capabilities.js';
import { createAbsorbBriefMemberRegistry } from './absorb-member-registry.js';

test('default brief notification sends only the verified member briefing and fails closed on transport failure', async () => {
  const sent: string[] = [];
  let delivery = true;
  const registry = createAbsorbBriefMemberRegistry(message => {
    sent.push(message.refId ?? 'missing');
    return delivery;
  });
  const request = (verifiedOwnerId: string | undefined, memberId: string, refId: string) =>
    dispatchGraphContract('notify.channel@1', {
      graphId: 'absorb-brief', runId: 'run-1', nodeId: 'notify', verifiedOwnerId,
      input: { context: { memberId } }, graphInput: { context: { memberId } },
      nodeInput: { text: 'Brief ready', kind: 'notify', refId },
      outputs: { brief: { evidence: { briefing: { id: 'brief-a' } } } },
    }, registry);
  expect(await request(undefined, 'member-a', 'brief-a')).toMatchObject({ ok: false });
  expect(await request('member-a', 'member-b', 'brief-a')).toMatchObject({ ok: false });
  expect(await request('member-a', 'member-a', 'brief-b')).toMatchObject({ ok: false });
  expect(sent).toEqual([]);
  expect(await request('member-a', 'member-a', 'brief-a')).toMatchObject({ ok: true, result: { delivered: true } });
  expect(sent).toEqual(['brief-a']);
  delivery = false;
  expect(await request('member-a', 'member-a', 'brief-a')).toMatchObject({ ok: false });
});
