export const ROLE_LEASE_OBJECT_PATH = 'lease/control-primary.json';

export interface RoleLeaseDoc {
  readonly holder: string;
  /** Document fencing token, distinct from the GCS object's server generation. */
  readonly generation: number;
  readonly state: 'held' | 'handing-off';
  readonly from?: string;
  readonly renewedAt: number;
}

export type RoleLeaseRead =
  | { readonly kind: 'present'; readonly doc: RoleLeaseDoc }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unmeasured'; readonly why: string };

export function parseRoleLease(text: string): RoleLeaseRead {
  if (text.trim() === '') return { kind: 'unmeasured', why: 'empty lease body' };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { kind: 'unmeasured', why: 'invalid lease JSON' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unmeasured', why: 'lease is not an object' };
  const o = value as Record<string, unknown>;
  if (typeof o.holder !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(o.holder)) return { kind: 'unmeasured', why: 'invalid holder' };
  if (!Number.isSafeInteger(o.generation) || (o.generation as number) < 1) return { kind: 'unmeasured', why: 'invalid generation' };
  if (typeof o.renewedAt !== 'number' || !Number.isFinite(o.renewedAt)) return { kind: 'unmeasured', why: 'invalid renewedAt' };
  if (o.state !== 'held' && o.state !== 'handing-off') return { kind: 'unmeasured', why: 'invalid state' };
  if (o.state === 'handing-off' && (typeof o.from !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(o.from) || o.from === o.holder)) {
    return { kind: 'unmeasured', why: 'invalid handoff origin' };
  }
  if (o.state === 'held' && 'from' in o) return { kind: 'unmeasured', why: 'held lease has handoff origin' };
  if ('expiresAt' in o) return { kind: 'unmeasured', why: 'client-side expiration is not supported' };
  return { kind: 'present', doc: {
    holder: o.holder, generation: o.generation as number, state: o.state,
    ...(o.state === 'handing-off' ? { from: o.from as string } : {}), renewedAt: o.renewedAt,
  } };
}

function checkedNext(generation: number): number {
  if (!Number.isSafeInteger(generation + 1)) throw new Error('lease generation exhausted');
  return generation + 1;
}

export function nextClaim(prev: RoleLeaseRead, me: string, now = Date.now()): RoleLeaseDoc {
  if (prev.kind === 'unmeasured') throw new Error(`lease unreadable: ${prev.why}`);
  if (prev.kind === 'present' && (prev.doc.state !== 'held' || prev.doc.holder !== me)) throw new Error('another machine holds the lease');
  return { holder: me, generation: checkedNext(prev.kind === 'present' ? prev.doc.generation : 0), state: 'held', renewedAt: now };
}

export function nextHandoff(prev: RoleLeaseDoc, me: string, to: string, now = Date.now()): RoleLeaseDoc {
  if (prev.state !== 'held' || prev.holder !== me) throw new Error('only the current holder can hand off');
  if (me === to) throw new Error('handoff target must differ from holder');
  return { holder: to, generation: checkedNext(prev.generation), state: 'handing-off', from: me, renewedAt: now };
}

export function nextAccept(prev: RoleLeaseDoc, me: string, now = Date.now()): RoleLeaseDoc {
  if (prev.state !== 'handing-off' || prev.holder !== me || !prev.from) throw new Error('no handoff addressed to this machine');
  return { holder: me, generation: checkedNext(prev.generation), state: 'held', renewedAt: now };
}

export function nextRevert(prev: RoleLeaseDoc, now = Date.now()): RoleLeaseDoc {
  if (prev.state !== 'handing-off' || !prev.from) throw new Error('no pending handoff to revert');
  return { holder: prev.from, generation: checkedNext(prev.generation), state: 'held', renewedAt: now };
}
