/** Current single-root aliases. Address issuance and `loop:` aliases belong to a later slice. */
// `wake` = how a post reaches a body that is not already listening. The coordinator ticks on cron
// (08·12·18) until its SSE reply body is switched on; the guardian has no reply body to wake.
export const LOOP_MESSAGE_ROUTES = {
  orchestrator: { msgAddress: 'COORDINATOR', replyBody: 'rules', wake: 'cron' },
  guardian: { msgAddress: 'GUARDIAN', replyBody: 'none', wake: 'none' },
} as const;

/**
 * Seat addresses share the table. A seat has no fixed `wake`: `wakeFrom: 'host'` says the path is
 * resolved on this host from the seat folder or a pty named after the seat (`resolveWake` in msg-wake.ts).
 */
export const SEAT_MESSAGE_ROUTES = {
  OP: { msgAddress: 'OP', replyBody: 'agent', wakeFrom: 'host' },
  TC: { msgAddress: 'TC', replyBody: 'agent', wakeFrom: 'host' },
  MK: { msgAddress: 'MK', replyBody: 'agent', wakeFrom: 'host' },
  UX: { msgAddress: 'UX', replyBody: 'agent', wakeFrom: 'host' },
  OPC: { msgAddress: 'OPC', replyBody: 'agent', wakeFrom: 'host' },
  OPT: { msgAddress: 'OPT', replyBody: 'agent', wakeFrom: 'host' },
} as const;

export type LoopReplyBody = 'none' | 'rules' | 'agent';
export type MessageWake = 'sse' | 'pty-inject' | 'herdr' | 'cron' | 'none';

export function loopMessageRoute(id: string): { msgAddress: string | null; replyBody: LoopReplyBody; wake: MessageWake } {
  return Object.hasOwn(LOOP_MESSAGE_ROUTES, id)
    ? LOOP_MESSAGE_ROUTES[id as keyof typeof LOOP_MESSAGE_ROUTES]
    : { msgAddress: null, replyBody: 'none', wake: 'none' };
}

/** The declared table row for one canonical address — a loop body or a seat — or null when unlisted. */
export function messageRouteFor(address: string): { msgAddress: string; replyBody: LoopReplyBody; wake?: MessageWake; wakeFrom?: 'host' } | null {
  const name = address.trim().toUpperCase();
  const loop = Object.values(LOOP_MESSAGE_ROUTES).find(route => route.msgAddress === name);
  if (loop) return loop;
  return Object.hasOwn(SEAT_MESSAGE_ROUTES, name) ? SEAT_MESSAGE_ROUTES[name as keyof typeof SEAT_MESSAGE_ROUTES] : null;
}

/** A notice is advisory; durable posting to these valid names still succeeds. */
export function noReplyBodyNotice(address: string): string | null {
  const name = address.trim().toUpperCase();
  return name === LOOP_MESSAGE_ROUTES.guardian.msgAddress || name === 'ORCHESTRATOR' || name === 'STEWARD'
    ? '이 주소는 읽는 몸이 없다 — 지금은 OP'
    : null;
}

/** `loop:` is not yet a message address, so the normal address validator still rejects it. */
export function unsupportedLoopAddressNotice(address: string): string | null {
  if (!/^loop:/i.test(address.trim())) return null;
  const id = address.trim().slice(5).toLowerCase();
  const route = loopMessageRoute(id);
  return route.msgAddress && route.replyBody !== 'none'
    ? `${address.trim()} 는 아직 주소가 아니다 — 지금 읽는 주소는 ${route.msgAddress} (eln loop list --json 의 msgAddress)`
    : route.msgAddress
      ? `${address.trim()} 는 아직 주소가 아니다 — ${route.msgAddress}은 읽는 몸이 없다 — 지금은 OP (eln loop list --json 의 replyBody)`
    : `${address.trim()} 는 아직 주소가 아니다 — 읽는 몸이 없다. 지금은 OP (eln loop list --json 의 msgAddress)`;
}
