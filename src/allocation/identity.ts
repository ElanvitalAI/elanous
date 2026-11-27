// ALLOCATION-BUDGET metering — who (verified identity ⊕ parent chain) and why (purpose), resolved from the caller's own
// process context, never from a label the caller types (CEO 11-27 11:1x «신원, 목적, 기간 등 미터링이 잘되게»).
//   seat        ELANOUS_TRACK · ELANOUS_SEAT · cwd …/seats/<SEAT> · COORD_ID (the same order currentSeat / detectSeat use)
//   loop-agent  ELANOUS_LOOP_ID (els loop voice) · ELANOUS_LOOP_NAME (graph-runner launch stamp)
//   graph-run   ELANOUS_GRAPH_RUN_ID
//   capsule     ELANOUS_PARENT_RUN_ID (a child run spawned by a parent run — subagent · harness child · Pod child)
//   ta-card     ELANOUS_TASK_CARD_ID
// The principal is the innermost link. Nothing resolvable → «unattributed»: metered and flagged in reports, never blocked.
import type { AllocConsumer, AllocIdentity, AllocIdentityLink, AllocPurpose, AllocPurposeKind } from './alloc-events.js';
import { validAllocId } from './alloc-events.js';

const SEAT_ID = /^[A-Z][A-Z0-9_-]{0,63}$/;
const SEAT_IN_PATH = /(?:^|\/)seats\/([A-Za-z][A-Za-z0-9_-]{0,63})(?=\/|$)/g;
const clean = (v: string | undefined) => (v ?? '').trim();

/** The process environment as identity reads it (process.env fits; tests pass a plain object). */
export type AllocEnv = Readonly<Record<string, string | undefined>>;

export const UNATTRIBUTED: AllocIdentity = { kind: 'unattributed', id: 'unattributed', source: 'none', chain: [] };

function seatLink(env: AllocEnv, cwd: string): AllocIdentityLink | null {
  const pick = (id: string, source: AllocIdentityLink['source']): AllocIdentityLink | null => {
    const up = id.toUpperCase();
    return SEAT_ID.test(up) ? { kind: 'seat', id: up, source } : null;
  };
  // A pane opened as another pane's worker child shares the folder but is not that seat (detectSeat rule).
  const childPane = !!clean(env.ELANOUS_ELS_PARENT_PANE);
  return (clean(env.ELANOUS_TRACK) ? pick(clean(env.ELANOUS_TRACK), 'env:ELANOUS_TRACK') : null)
    ?? (clean(env.ELANOUS_SEAT) ? pick(clean(env.ELANOUS_SEAT), 'env:ELANOUS_SEAT') : null)
    ?? (() => { if (childPane) return null; const m = [...cwd.matchAll(SEAT_IN_PATH)].at(-1)?.[1]; return m ? pick(m, 'cwd:seats') : null; })()
    ?? (clean(env.COORD_ID) ? pick(clean(env.COORD_ID), 'env:COORD_ID') : null);
}

function link(kind: AllocIdentityLink['kind'], raw: string | undefined, source: AllocIdentityLink['source']): AllocIdentityLink | null {
  const id = clean(raw);
  return id && validAllocId(id) ? { kind, id, source } : null;
}

/** Resolve the caller from its process context. Pure over (env, cwd). */
export function resolveCallerIdentity(env: AllocEnv = process.env, cwd: string = process.cwd()): AllocIdentity {
  const chain = [
    seatLink(env, cwd),
    link('loop-agent', env.ELANOUS_LOOP_ID, 'env:ELANOUS_LOOP_ID') ?? link('loop-agent', env.ELANOUS_LOOP_NAME, 'env:ELANOUS_LOOP_NAME'),
    link('graph-run', env.ELANOUS_GRAPH_RUN_ID, 'env:ELANOUS_GRAPH_RUN_ID'),
    link('capsule', env.ELANOUS_PARENT_RUN_ID, 'env:ELANOUS_PARENT_RUN_ID'),
    link('ta-card', env.ELANOUS_TASK_CARD_ID, 'env:ELANOUS_TASK_CARD_ID'),
  ].filter((l): l is AllocIdentityLink => l !== null);
  const principal = chain.at(-1);
  return principal ? { ...principal, chain } : UNATTRIBUTED;
}

/** An identity from a proxy that already authenticated the seat (llm proxy · pane identity). Invalid id → unattributed. */
export function proxySeatIdentity(seat: string): AllocIdentity {
  const up = clean(seat).toUpperCase();
  if (!SEAT_ID.test(up) || up === 'LOCAL') return UNATTRIBUTED;
  const l: AllocIdentityLink = { kind: 'seat', id: up, source: 'proxy:seat' };
  return { ...l, chain: [l] };
}

/** Stable key for reports: kind:id (seat:OP · ta-card:X · unattributed). */
export const identityKey = (who: AllocIdentity): string => who.kind === 'unattributed' ? 'unattributed' : `${who.kind}:${who.id}`;
/** The chain as one line: seat:OP → capsule:run-1 → ta-card:X */
export const chainLine = (who: AllocIdentity): string => who.chain.length ? who.chain.map(l => `${l.kind}:${l.id}`).join(' → ') : 'unattributed';

const CONSUMER_PURPOSE: Partial<Record<AllocConsumer, AllocPurposeKind>> = { pregate: 'gate', test: 'gate', 'ta-launch': 'work', hand: 'work' };

/** Purpose: explicit wins; else inferred from the caller context (TA card → work on that card · consumer default);
 *  nothing → «unspecified» (flagged in reports, never blocked). */
export function resolvePurpose(input: { explicit?: AllocPurpose; consumer: AllocConsumer; who: AllocIdentity; ref?: string }): AllocPurpose {
  if (input.explicit && input.explicit.kind !== 'unspecified') return input.explicit;
  const card = input.who.chain.find(l => l.kind === 'ta-card')?.id;
  const ref = input.explicit?.ref ?? input.ref ?? card;
  const byConsumer = CONSUMER_PURPOSE[input.consumer];
  if (byConsumer) return { kind: byConsumer, ...(ref ? { ref } : {}), inferred: true };
  if (card) return { kind: 'work', ref: card, inferred: true };
  return { kind: 'unspecified', ...(ref ? { ref } : {}) };
}
