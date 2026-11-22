import { expect, test } from 'bun:test';
import { simWorldDevices, simWorldScenarios } from './scenarios.js';
import type { SimWorldDeviceContext, SimWorldScenarioContext } from '../types.js';

test('signed recipe scenario accepts the grant and rejects each attack for the intended reason', async () => {
  const scenario = simWorldScenarios.find(item => item.id === 'RUNSHELL-RECIPE-SIGNED')!;
  const device = simWorldDevices.find(item => item.id === 'RUNSHELL-FAKE-JUD')!;
  const keys = await device.create({} as SimWorldDeviceContext);
  const events: unknown[] = [];
  const ctx = {
    device: (id: string) => { expect(id).toBe('RUNSHELL-FAKE-JUD'); return keys; },
    recorder: { event: (kind: string, data: unknown) => events.push({ kind, data }) },
  } as unknown as SimWorldScenarioContext;
  expect(await scenario.run(ctx)).toEqual({ ok: true });
  expect(events).toEqual([{ kind: 'recipe-signature-foundation', data: {
    denied: true, valid: true,
    reasons: ['missing-trust-key', 'invalid-signature', 'recipe-mismatch', 'not-grant'],
  } }]);
});
