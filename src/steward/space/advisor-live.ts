// SPACE-ADVISOR live wiring — the steward port = the landed writer-check resolver (#40173 · writer-resolver.ts), and one
// advise run (learn · steward → advisor · digest) shared by `eln msg hand advise` and the trigger-registry graph node.
import type { MsgStore } from '../../msg/msg-store.js';
import { applyHandOutcome, type HandLadderDeps, type OpenHand } from '../../msg/hand-raise-ladder.js';
import {
  adviseTick, advisorDigest, advisorPaths, ensureSeeded, learnFromCoordinator, type AdvisorStep, type StewardResolver,
} from './advisor.js';
import { RESOLVER_DEADLINE_MS, resolveWriterCheck, type WriterCheckPorts } from './writer-resolver.js';

/**
 * The steward resolver for the advisor: the writer-check verdict for this ✋. `resolve` → the ladder outcome (actor = the
 * receiver · owner = the blocked seat · deadline +30 min) and the ✋ never reaches the advisor. `escalate` / not this
 * family → unresolved (the advisor takes it). Ports fail open (the resolver treats a failed lookup as unknown).
 */
export function writerCheckSteward(store: MsgStore, deps: HandLadderDeps & { readonly ports: WriterCheckPorts; readonly live: boolean }): StewardResolver {
  return (hand: OpenHand) => {
    const verdict = resolveWriterCheck(hand, deps.ports);
    if (!verdict || verdict.kind !== 'resolve') return { resolved: false };
    if (deps.live) {
      applyHandOutcome(store, { msgId: hand.id, action: 'resolve', actor: hand.receiver, owner: hand.blockedSeat,
        deadline: new Date(deps.now() + RESOLVER_DEADLINE_MS).toISOString(), text: `[writer-check · ${verdict.cause}] ${verdict.answer}` }, deps);
    }
    return { resolved: true };
  };
}

export interface AdviseRun { readonly learned: readonly string[]; readonly steps: readonly AdvisorStep[]; readonly digest: { body: string; mailId: number | null } }

/** One live advise run for `coordinator` (default advisor `<coordinator>-ADV`). `ports` absent = no steward step. */
export function runAdvise(store: MsgStore, input: HandLadderDeps & { readonly coordinator: string; readonly advisor?: string; readonly live: boolean; readonly ports?: WriterCheckPorts; readonly base?: string }): AdviseRun {
  const coordinator = input.coordinator.toUpperCase();
  const advisor = (input.advisor ?? `${coordinator}-ADV`).toUpperCase();
  const paths = advisorPaths(advisor, ...(input.base ? [input.base] : []));
  const steward = input.ports ? writerCheckSteward(store, { ...input, ports: input.ports }) : undefined;
  const deps = { ...input, advisor, coordinator, ...paths, ...(steward ? { steward } : {}) };
  if (input.live) ensureSeeded(paths.precedentsPath);
  const learned = input.live ? learnFromCoordinator(store, deps, input.now() - 24 * 60 * 60_000).map((p) => p.id) : [];
  const steps = adviseTick(store, deps);
  return { learned, steps, digest: advisorDigest(store, deps) };
}

/** Live writer-check ports over the declared seats (same seat list as the HQ steward tick). */
export function liveAdvisorPorts(): WriterCheckPorts | undefined {
  try {
    const ladderModule = require('../../msg/hand-raise-ladder.js') as typeof import('../../msg/hand-raise-ladder.js');
    const liveModule = require('./writer-resolver-live.js') as typeof import('./writer-resolver-live.js');
    const roles = (() => { try { return ladderModule.loadDeclaredSeatRoles(); } catch { return {}; } })();
    return liveModule.liveWriterCheckPorts([...new Set([...Object.keys(roles), ...liveModule.BASE_SEATS])]);
  } catch { return undefined; }
}
