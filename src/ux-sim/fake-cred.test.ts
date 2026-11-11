import { expect, test } from 'bun:test';
import { CREDENTIAL_SLOT_DEFINITIONS } from '../nexus/config/secrets/cred-slot-schema.js';
import { SERVICE_KEY_CATALOG } from '../setup/service-key-catalog.js';
import { createFakeCred } from './fake-cred.js';
import { withSimClock } from './fake-clock.js';
import { assembleWorld, parseSimWorld } from './world.js';

const SLOT = 'cred:openai.api_key';

test('fake credential slots use the canonical catalog and reject unknown names', () => {
  const cred = createFakeCred({ now: () => 1_000 });
  for (const definition of CREDENTIAL_SLOT_DEFINITIONS) {
    for (const field of definition.fields) {
      const slot = `cred:${definition.service}.${field}`;
      expect(cred.use({ slot, generation: 1 }, 'invoke')).toEqual({ ok: false, reason: 'missing' });
    }
  }
  for (const entry of SERVICE_KEY_CATALOG.filter((item) => item.kind === 'api-key')) {
    expect(cred.inspect(`cred:${entry.id}`)).toEqual({ present: false });
  }
  const exa = cred.install('cred:exa', { permissions: ['search'], expiresAt: 2_000 });
  expect(cred.use(exa, 'search')).toEqual({ ok: true, slot: 'cred:exa', generation: 1 });
  expect(() => cred.install('cred:made-up.api_key', { permissions: ['invoke'], expiresAt: 2_000 }))
    .toThrow('ELANOUS_CREDENTIAL_SLOT_UNSUPPORTED');
});

test('fake credential slot denies missing, expired, and insufficient permission without a secret', () => {
  let now = 1_000;
  const cred = createFakeCred({ now: () => now });
  expect(cred.use({ slot: SLOT, generation: 1 }, 'invoke')).toEqual({ ok: false, reason: 'missing' });
  const lease = cred.install(SLOT, { permissions: ['read'], expiresAt: 2_000 });
  expect(cred.use(lease, 'invoke')).toEqual({ ok: false, reason: 'permission-denied' });
  expect(cred.use(lease, 'read')).toEqual({ ok: true, slot: SLOT, generation: 1 });
  now = 2_000;
  expect(cred.use(lease, 'read')).toEqual({ ok: false, reason: 'expired' });
  expect(JSON.stringify(cred.inspect(SLOT))).not.toContain('secret');
});

test('rotation immediately invalidates the previous lease and permits the new generation', () => {
  const cred = createFakeCred({ now: () => 1_000 });
  const oldLease = cred.install(SLOT, { permissions: ['invoke'], expiresAt: 2_000 });
  const newLease = cred.rotate(SLOT, { permissions: ['invoke'], expiresAt: 3_000 });
  expect(cred.use(oldLease, 'invoke')).toEqual({ ok: false, reason: 'rotated' });
  expect(cred.use(newLease, 'invoke')).toEqual({ ok: true, slot: SLOT, generation: 2 });
  expect(cred.inspect(SLOT)).toEqual({ present: true, generation: 2, expiresAt: 3_000, permissions: ['invoke'] });
});

test('world catalog assembles an isolated fake-cred device', () => {
  const spec = parseSimWorld('world: fake-cred-world\nseed: 0\ndevices: [fake-cred]\nevents: []\n');
  const first = assembleWorld({ spec }).devices.get('fake-cred') as ReturnType<typeof createFakeCred>;
  const second = assembleWorld({ spec }).devices.get('fake-cred') as ReturnType<typeof createFakeCred>;
  first.install(SLOT, { permissions: ['invoke'], expiresAt: Date.now() + 60_000 });
  expect(first.inspect(SLOT).present).toBe(true);
  expect(second.inspect(SLOT)).toEqual({ present: false });
});

test('assembled world credential expiry follows its injected simulation clock', async () => {
  const spec = parseSimWorld('world: fake-cred-clock\nseed: 0\ndevices: [fake-cred]\nevents: []\n');
  await withSimClock(1_000, (clock) => {
    const cred = assembleWorld({ spec }, clock).devices.get('fake-cred') as ReturnType<typeof createFakeCred>;
    const lease = cred.install(SLOT, { permissions: ['invoke'], expiresAt: 2_000 });
    expect(cred.use(lease, 'invoke')).toEqual({ ok: true, slot: SLOT, generation: 1 });
    clock.tick(1_000);
    expect(cred.use(lease, 'invoke')).toEqual({ ok: false, reason: 'expired' });
  });
});
