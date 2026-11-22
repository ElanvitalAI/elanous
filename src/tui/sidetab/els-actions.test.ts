import { expect, test } from 'bun:test';
import type { ElsResult } from '../../els/core.js';
import { elsAddressOfRow, readElsRow, sendToElsRow, type ElsRowActionDeps } from './els-actions.js';

const deps = (doAnswer: ElsResult | Error, readAnswer: ElsResult | Error = { exitCode: 0, message: 'SCREEN' }) => {
  const calls: string[] = [];
  const actions: ElsRowActionDeps = {
    from: 'HAND-CLAUDE-ELS2',
    do: async (address, text, from) => { calls.push(`do ${address} | ${text} | ${from}`); if (doAnswer instanceof Error) throw doAnswer; return doAnswer; },
    read: async (address) => { calls.push(`read ${address}`); if (readAnswer instanceof Error) throw readAnswer; return readAnswer; },
  };
  return { actions, calls };
};

test('only an els pane row has an address; a «down» host line, other kinds and an empty id have none', () => {
  expect(elsAddressOfRow({ id: 'els:Mac:w1/t2/p3', kind: 'els' })).toBe('Mac:w1/t2/p3');
  expect(elsAddressOfRow({ id: 'els:herdr:w1/t2/p2', kind: 'els' })).toBe('herdr:w1/t2/p2');
  expect(elsAddressOfRow({ id: 'els-host:node-b', kind: 'els' })).toBeUndefined();
  expect(elsAddressOfRow({ id: 'els:', kind: 'els' })).toBeUndefined();
  expect(elsAddressOfRow({ id: 'els:Mac:w1/t2/p3', kind: 'tui' })).toBeUndefined();
  expect(elsAddressOfRow(undefined)).toBeUndefined();
});

test('send: delivered and queued only when the owner said so; a missing answer is «unknown», a definite no is «refused»', async () => {
  const sent = deps({ exitCode: 0, message: 'els do: sent to pane (12 chars)' });
  expect(await sendToElsRow(sent.actions, 'Mac:w1/t2/p3', 'hello')).toEqual({ ok: true, outcome: 'delivered', message: 'els do: sent to pane (12 chars)' });
  expect(sent.calls).toEqual(['do Mac:w1/t2/p3 | hello | HAND-CLAUDE-ELS2']);
  const queued = deps({ exitCode: 0, message: 'els do: queued 2 for pTurn (turn running)' });
  expect(await sendToElsRow(queued.actions, 'Mac:w1/t2/p3', 'hi')).toEqual({ ok: true, outcome: 'queued', message: 'els do: queued 2 for pTurn (turn running)' });
  const slow = deps({ exitCode: 1, message: 'els: the els server did not answer within 2000 ms' });
  const unknown = await sendToElsRow(slow.actions, 'Mac:w1/t2/p3', 'hi');
  expect(unknown.ok).toBe(false);                                   // never shown as a success
  expect(unknown.outcome).toBe('unknown');
  expect(unknown.message).toBe('no answer in time — the line may or may not have reached the pane; check its screen before sending again');
  expect(unknown.message).not.toMatch(/queued|sent to/);            // and never worded as delivered or queued
  const refused = deps({ exitCode: 1, message: 'els do: herdr refused: herdr:w2/t1/p2 is working, not sent' });
  expect(await sendToElsRow(refused.actions, 'herdr:w2/t1/p2', 'hi')).toEqual({ ok: false, outcome: 'refused', message: 'els do: herdr refused: herdr:w2/t1/p2 is working, not sent' });
  const gone = deps({ exitCode: 1, message: 'els: no els server is running — start it with `els serve` (or `elanous side serve`)' });
  expect((await sendToElsRow(gone.actions, 'Mac:w1/t2/p3', 'hi')).outcome).toBe('refused');
  expect(await sendToElsRow(deps(new Error('socket closed')).actions, 'Mac:w1/t2/p3', 'hi')).toEqual({ ok: false, outcome: 'refused', message: 'els do: socket closed' });
});

test('read: the pane screen on success, and an explicit error on refusal or transport failure', async () => {
  const ok = deps({ exitCode: 0, message: '' });
  expect(await readElsRow(ok.actions, 'Mac:w1/t2/p3')).toBe('SCREEN');
  expect(ok.calls).toEqual(['read Mac:w1/t2/p3']);
  await expect(readElsRow(deps({ exitCode: 0, message: '' }, { exitCode: 1, message: 'unknown pane' }).actions, 'x'))
    .rejects.toThrow('unknown pane');
  await expect(readElsRow(deps({ exitCode: 0, message: '' }, new Error('down')).actions, 'x'))
    .rejects.toThrow('down');
});
