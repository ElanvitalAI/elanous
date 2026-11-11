import { CREDENTIAL_SLOT_DEFINITIONS, parseCredentialSlotId } from '../nexus/config/secrets/cred-slot-schema.js';
import { SERVICE_KEY_CATALOG } from '../setup/service-key-catalog.js';

export type FakeCredSlotId = `cred:${string}`;

function assertFakeCredSlotId(slot: string): asserts slot is FakeCredSlotId {
  if (parseCredentialSlotId(slot)) return;
  const service = /^cred:([a-z0-9][a-z0-9-]*)$/.exec(slot)?.[1];
  if (service && (CREDENTIAL_SLOT_DEFINITIONS.some((entry) => entry.service === service)
    || SERVICE_KEY_CATALOG.some((entry) => entry.id === service && entry.kind === 'api-key'))) return;
  throw new Error('ELANOUS_CREDENTIAL_SLOT_UNSUPPORTED');
}

export interface FakeCredLease {
  readonly slot: FakeCredSlotId;
  readonly generation: number;
}

export interface FakeCredGrant {
  readonly permissions: readonly string[];
  readonly expiresAt: number;
}

export type FakeCredUse =
  | { readonly ok: true; readonly slot: FakeCredSlotId; readonly generation: number }
  | { readonly ok: false; readonly reason: 'missing' | 'expired' | 'permission-denied' | 'rotated' };

export interface FakeCred {
  install(slot: string, grant: FakeCredGrant): FakeCredLease;
  rotate(slot: string, grant: FakeCredGrant): FakeCredLease;
  use(lease: { readonly slot: string; readonly generation: number }, permission: string): FakeCredUse;
  inspect(slot: string): { readonly present: false } | { readonly present: true; readonly generation: number; readonly expiresAt: number; readonly permissions: readonly string[] };
}

interface SlotState { generation: number; expiresAt: number; permissions: readonly string[] }

/** In-memory metadata only: no real secret or credential backend is read. */
export function createFakeCred(options: { readonly now?: () => number } = {}): FakeCred {
  const slots = new Map<FakeCredSlotId, SlotState>();
  const now = options.now ?? Date.now;
  const validateGrant = (grant: FakeCredGrant): void => {
    if (!Number.isFinite(grant.expiresAt)) throw new Error('fake credential expiry must be finite');
    if (!grant.permissions.length || grant.permissions.some((permission) => !permission.trim())
      || new Set(grant.permissions).size !== grant.permissions.length) {
      throw new Error('fake credential permissions must be nonempty and unique');
    }
  };
  const write = (slot: string, grant: FakeCredGrant, rotate: boolean): FakeCredLease => {
    assertFakeCredSlotId(slot);
    validateGrant(grant);
    const previous = slots.get(slot);
    if (rotate && !previous) throw new Error('fake credential slot is missing');
    if (!rotate && previous) throw new Error('fake credential slot is already installed');
    const generation = (previous?.generation ?? 0) + 1;
    slots.set(slot, { generation, expiresAt: grant.expiresAt, permissions: [...grant.permissions] });
    return { slot, generation };
  };
  return {
    install(slot, grant) { return write(slot, grant, false); },
    rotate(slot, grant) { return write(slot, grant, true); },
    use(lease, permission) {
      assertFakeCredSlotId(lease.slot);
      if (!permission.trim()) throw new Error('fake credential permission must be nonempty');
      const state = slots.get(lease.slot);
      if (!state) return { ok: false, reason: 'missing' };
      if (lease.generation !== state.generation) return { ok: false, reason: 'rotated' };
      if (now() >= state.expiresAt) return { ok: false, reason: 'expired' };
      if (!state.permissions.includes(permission)) return { ok: false, reason: 'permission-denied' };
      return { ok: true, slot: lease.slot, generation: state.generation };
    },
    inspect(slot) {
      assertFakeCredSlotId(slot);
      const state = slots.get(slot);
      return state ? { present: true, generation: state.generation, expiresAt: state.expiresAt,
        permissions: [...state.permissions] } : { present: false };
    },
  };
}
