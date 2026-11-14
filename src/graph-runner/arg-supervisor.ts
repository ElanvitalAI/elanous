import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { claimIncident, createFileIncidentClaimStore, isIncidentClaimCurrent, withIncidentClaim, type IncidentClaimStore, type SupervisorLoopRef } from '../supervision/incident-claim.js';
import { MACROPHAGE_REPAIR_LADDER_LIMITS } from '../release-loop/macrophage-repair-ladder.js';
import { proposeOpenArg, recordOpenArgMemory, validateOpenArgProposal, type ArgOpenDecision, type ArgOpenProposal } from './arg-open-proposal.js';
import { ArgFeedbackDurabilityError, readArgFeedback, type ArgFeedbackLedgerPort, type ArgFeedbackSignature } from './arg-feedback-consumer.js';
import { readGraphRun, runGraph, type GraphRunState } from './runner.js';
import { assertReleaseKnownIssueWaiverApproval, T6_WAIVER_DOCUMENT_SHA, T6_WAIVER_TABLE_SHA } from './release-known-issue-waiver.js';

export type ArgVerb = 'observe' | 'propose' | 'validate' | 'apply' | 'verify' | 'rollback';
export type ArgOperation = 'reroute' | 'add-node' | 'repair' | 'hitl'
  | 'skip-node' | 'gate-waiver' | 'regression-response' | 'emergency-release';
export type ArgEffect =
  | { readonly kind: 'retry-edge'; readonly from: string; readonly to: string; readonly triggerEvent: string; readonly rationale: string }
  | { readonly kind: 'vocabulary'; readonly term: string }
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'repair'; readonly nodeId: string }
  | { readonly kind: 'hitl'; readonly decisionId: string }
  | { readonly kind: 'gate-waiver'; readonly from: 'gate-heal-decision'; readonly to: 'traffic-gate-passed';
      readonly evidence: { readonly documentSha256: string; readonly tableSha256: string } };
/** Stable identity for the complete, validated graph effect, independent of object key order. */
export const argEffectKey = (effect: ArgEffect): string => {
  const fields = Object.entries(effect).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `${effect.kind}:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`;
};
const effectOperation = (effect: ArgEffect): ArgSupervisorTickRequest['operation'] | undefined => {
  if (!effect || typeof effect !== 'object') return undefined;
  if (effect.kind === 'retry-edge' && typeof effect.from === 'string' && effect.from.trim() &&
      typeof effect.to === 'string' && effect.to.trim() && typeof effect.triggerEvent === 'string' &&
      effect.triggerEvent.trim() && typeof effect.rationale === 'string' && effect.rationale.trim()) return 'reroute';
  if (effect.kind === 'vocabulary' && typeof effect.term === 'string' && effect.term.trim()) return 'reroute';
  if (effect.kind === 'node' && typeof effect.nodeId === 'string' && effect.nodeId.trim()) return 'add-node';
  if (effect.kind === 'repair' && typeof effect.nodeId === 'string' && effect.nodeId.trim()) return 'repair';
  if (effect.kind === 'hitl' && typeof effect.decisionId === 'string' && effect.decisionId.trim()) return 'hitl';
  if (effect.kind === 'gate-waiver' && effect.from === 'gate-heal-decision' && effect.to === 'traffic-gate-passed' &&
      effect.evidence?.documentSha256 === T6_WAIVER_DOCUMENT_SHA && effect.evidence.tableSha256 === T6_WAIVER_TABLE_SHA)
    return 'gate-waiver';
  return undefined;
};
export interface ArgStepResult {
  readonly outcome: 'ok' | 'fail' | 'novel' | 'reuse' | 'input_required' | 'rollback_required';
  readonly evidence: string;
  /** Apply must advance exactly one revision; rollback must restore the prior revision. */
  readonly graphRevision?: number;
  /** Propose must disclose the exact effect before apply is allowed. */
  readonly effect?: ArgEffect;
}
export type ArgSupervisorPorts = Readonly<Record<'observe' | 'propose' | 'validate' | 'verify',
  (context: { readonly effect?: ArgEffect; readonly proposal?: ArgOpenProposal; readonly decision?: ArgOpenDecision }) => ArgStepResult | Promise<ArgStepResult>>> & {
  /** Only persistence is injected. The supervisor itself mutates a bounded state shape. */
  readonly persist?: () => void | Promise<void>;
};
export type ArgMutationState = Pick<GraphRunState, 'graphRevision' | 'adaptiveGraphEdges' | 'adaptiveGraphVocabulary'>;

export interface ArgSupervisorTickRequest {
  readonly loopPath: string;
  readonly root: string;
  readonly targetGraphId: string;
  readonly targetRunId: string;
  readonly gateEventId: string;
  readonly graphRevision: number;
  readonly operation: ArgOperation;
  readonly mutableState: ArgMutationState;
  readonly incidentClaim?: {
    readonly store?: IncidentClaimStore;
    readonly ownerOrder?: readonly SupervisorLoopRef[];
    readonly now?: () => number;
    readonly leaseMs?: number;
  };
  readonly vocabularyOverlay?: { readonly sourcePath: string; readonly path: string };
  readonly openProposal?: {
    readonly observation: Readonly<Record<string, unknown>>;
    readonly memory: readonly unknown[];
    readonly callLLM: (prompt: string) => Promise<string>;
  };
  readonly feedback?: { readonly ledger: ArgFeedbackLedgerPort; readonly signature: ArgFeedbackSignature;
    readonly at?: () => string;
    /** Called immediately after durable feedback is confirmed, before any diagnostic writes. */
    readonly onCommitted?: () => void;
    /** Must reload the exact run's durable outcome and effect independently of the writer's in-memory map. */
    readonly readCommitted: (runId: string, signature: ArgFeedbackSignature) =>
      { readonly outcome: 'verified' | 'rollback'; readonly effect: string } | 'absent' | 'unknown' |
      Promise<{ readonly outcome: 'verified' | 'rollback'; readonly effect: string } | 'absent' | 'unknown'> };
  readonly ports: ArgSupervisorPorts;
}

export interface ArgSupervisorTickResult {
  readonly resultType: 'complete' | 'input_required';
  readonly graphRun: GraphRunState;
  readonly graphRevision: number;
  readonly requestState?: Readonly<Record<string, string | number>>;
  readonly inputRequests?: readonly { readonly kind: 'approval'; readonly prompt: string }[];
}

/** Run one stateless supervisor tick through the declared graph. The caller supplies
 * effect ports; every verb and revision transition is journaled in shared state. */
export async function runArgSupervisorTick(request: ArgSupervisorTickRequest): Promise<ArgSupervisorTickResult> {
  const card = parseYaml(readFileSync(request.loopPath, 'utf8')) as Record<string, unknown>;
  const identity = card?.id;
  const graph = card?.graph;
  const cardBody = card?.card as Record<string, unknown> | undefined;
  const policy = card?.policy as Record<string, unknown> | undefined;
  const approval = policy?.approval as Record<string, unknown> | undefined;
  const memory = card?.templateMemory as Record<string, unknown> | undefined;
  const packs = card?.knowledgePacks;
  const authority = card?.authority;
  if (card?.apiVersion !== 'elanous.dev/loop/v1' || typeof identity !== 'string' ||
      !/^loop:[a-z][a-z0-9-]*@[1-9]\d*$/.test(identity) ||
      typeof graph !== 'string' || !/^\.\/[a-z][a-z0-9-]*\.yaml$/.test(graph) ||
      cardBody?.role !== 'primary' || !Array.isArray(cardBody?.supervises) || !cardBody.supervises.includes(request.targetGraphId) ||
      !Array.isArray(cardBody.extensions) || !cardBody.extensions.includes('elanous.dev/arg') ||
      !Array.isArray(authority) || !['reroute', 'add-node', 'repair', 'hitl'].every(verb => authority.includes(verb)) ||
      policy?.scope !== 'run' || approval?.resultType !== 'input_required' ||
      typeof memory?.graph !== 'string' || !Array.isArray(packs) || packs.length !== 2 ||
      packs.some(pack => typeof pack !== 'string'))
    throw new Error('supervisor loop card does not authorize the target graph');
  const [edgePack, healerPack] = packs.map(pack => parseYaml(readFileSync(resolve(dirname(request.loopPath), pack), 'utf8')));
  const healerNodes = healerPack && typeof healerPack === 'object' ? (healerPack as { nodes?: unknown }).nodes : undefined;
  if (!edgePack || typeof edgePack !== 'object' || !Object.hasOwn(edgePack, 'edges') ||
      !(edgePack as { edges?: Record<string, unknown> }).edges?.retry ||
      !Array.isArray(healerNodes) || !healerNodes.some(node => node && typeof node === 'object' &&
        Array.isArray((node as { subscribes?: unknown }).subscribes)))
    throw new Error('supervisor loop card lacks the release retry vocabulary or healer subscriber');
  const targetPath = resolve(dirname(request.loopPath), memory.graph);
  const target = parseGraphTemplateYaml(readFileSync(targetPath, 'utf8'), targetPath);
  const supervisor = target.template?.supervisors?.find(item => item.ref === identity);
  const authorized = () => supervisor?.role === 'primary' && supervisor.scope === 'run' &&
    supervisor.requires.includes('elanous.dev/arg') && supervisor.authority.includes(request.operation) &&
    authority.includes(request.operation) && policy.scope === supervisor.scope;
  const effectAuthorized = (effect: ArgEffect | undefined): boolean => {
    const operation = effect && effectOperation(effect);
    return operation !== undefined && operation === request.operation &&
      supervisor?.authority.includes(operation) === true && authority.includes(operation);
  };
  if (!target.template || target.errors.length || target.template.graphId !== request.targetGraphId || !authorized())
    throw new Error('target graph has no matching ARG supervisor declaration');
  const graphPath = resolve(dirname(request.loopPath), graph);
  const ledgerPath = resolve(request.root, 'graph-supervisors/actions.jsonl');
  let initialState = { graphRevision: request.graphRevision, adaptiveGraphEdges: [] as NonNullable<ArgMutationState['adaptiveGraphEdges']>,
    adaptiveGraphVocabulary: [] as NonNullable<ArgMutationState['adaptiveGraphVocabulary']> };
  let priorOverlay: string | undefined;
  const incidentId = `${request.targetGraphId}:${request.targetRunId}:${request.gateEventId}`;
  const claimStore = request.incidentClaim?.store ?? createFileIncidentClaimStore(request.root);
  const claimNow = request.incidentClaim?.now ?? Date.now;
  let incidentClaimScopeDepth = 0;
  const assertIncidentClaim = async (claimToken: string): Promise<void> => {
    if (incidentClaimScopeDepth > 0) return;
    if (!await isIncidentClaimCurrent(claimStore, { incidentId, claimToken, now: claimNow }))
      throw new Error('RLA incident claim expired or was fenced by an escalation');
  };
  const runWithIncidentClaim = async <T>(claimToken: string, action: () => T | Promise<T>,
    completeWhen?: (value: T) => boolean): Promise<T> => {
    if (incidentClaimScopeDepth > 0) return action();
    const result = await withIncidentClaim(claimStore, { incidentId, claimToken, now: claimNow }, async () => {
      incidentClaimScopeDepth += 1;
      try { return await action(); }
      finally { incidentClaimScopeDepth -= 1; }
    }, completeWhen);
    if (!result.current) throw new Error('RLA incident claim expired or was fenced by an escalation');
    return result.value;
  };
  const restoreOverlay = (): void => {
    const path = request.vocabularyOverlay?.path;
    if (!path) return;
    if (priorOverlay === undefined) { if (existsSync(path)) unlinkSync(path); }
    else { const temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, priorOverlay); renameSync(temporary, path); }
  };
  let revision = request.graphRevision;
  let plannedEffect: ArgEffect | undefined;
  let applied = false;
  let durabilityUnknown = false;
  let terminalFailure: Error | undefined;
  const restore = async (): Promise<ArgStepResult> => {
    return runWithIncidentClaim(activeClaim.claimToken, async () => {
      request.mutableState.graphRevision = initialState.graphRevision;
      request.mutableState.adaptiveGraphEdges = [...initialState.adaptiveGraphEdges];
      request.mutableState.adaptiveGraphVocabulary = [...initialState.adaptiveGraphVocabulary];
      restoreOverlay();
      try { await request.ports.persist?.(); }
      catch (error) {
        durabilityUnknown = true;
        throw new Error(`ARG rollback persistence failed; durable graphRevision is unknown: ${String(error)}`);
      }
      return { outcome: 'ok', evidence: 'prior ARG run-local graph restored', graphRevision: request.mutableState.graphRevision };
    });
  };
  const apply = async (effect: ArgEffect): Promise<ArgStepResult> => {
    return runWithIncidentClaim(activeClaim.claimToken, async () => {
      if (effect.kind === 'retry-edge') {
        const edges = request.mutableState.adaptiveGraphEdges ?? [];
        if (edges.some(edge => edge.eventId === request.gateEventId && edge.subscriberId === identity))
          return { outcome: 'fail', evidence: 'retry edge already installed' };
        request.mutableState.adaptiveGraphEdges = [...edges, { from: effect.from, to: effect.to,
          triggerEvent: effect.triggerEvent, rationale: effect.rationale,
          eventId: request.gateEventId, subscriberId: identity as string }];
        request.mutableState.adaptiveGraphVocabulary = [...new Set([...(request.mutableState.adaptiveGraphVocabulary ?? []), effect.triggerEvent])];
      } else if (effect.kind === 'vocabulary') {
        if (request.vocabularyOverlay) {
          const source = priorOverlay ?? readFileSync(request.vocabularyOverlay.sourcePath, 'utf8');
          const document = parseYaml(source) as Record<string, unknown>;
          if (!document || document.apiVersion !== 'elanous.dev/release-graph-edges/v1' ||
              !document.edges || typeof document.edges !== 'object' || Array.isArray(document.edges))
            return { outcome: 'fail', evidence: 'release edge vocabulary pack invalid' };
          const failureTypes = document.failureTypes;
          if (failureTypes !== undefined && (!failureTypes || typeof failureTypes !== 'object' || Array.isArray(failureTypes)))
            return { outcome: 'fail', evidence: 'failure vocabulary map invalid' };
          document.failureTypes = { ...(failureTypes as Record<string, unknown> | undefined),
            [effect.term]: { source: 'rla-open-proposal', eventId: request.gateEventId,
              graphRevision: (request.mutableState.graphRevision ?? request.graphRevision) + 1 } };
          const temporary = `${request.vocabularyOverlay.path}.${randomUUID()}.tmp`;
          writeFileSync(temporary, stringifyYaml(document));
          renameSync(temporary, request.vocabularyOverlay.path);
        }
        request.mutableState.adaptiveGraphVocabulary = [...new Set([...(request.mutableState.adaptiveGraphVocabulary ?? []), effect.term])];
      } else if (effect.kind === 'gate-waiver') {
        if (request.targetGraphId !== 'release-loop') return { outcome: 'fail', evidence: 'gate waiver requires release-loop' };
        assertReleaseKnownIssueWaiverApproval(readGraphRun(request.targetGraphId, request.targetRunId, request.root), request.root);
        const edges = request.mutableState.adaptiveGraphEdges ?? [];
        if (edges.some((edge) => edge.eventId === effect.evidence.documentSha256 && edge.subscriberId === 'arg-gate-waiver'))
          return { outcome: 'reuse', evidence: 'gate waiver edge already installed', graphRevision: request.mutableState.graphRevision };
        request.mutableState.adaptiveGraphEdges = [...edges, { from: effect.from, to: effect.to,
          triggerEvent: 'release.gate.waiver', rationale: `JUD:${effect.evidence.tableSha256}`,
          eventId: effect.evidence.documentSha256, subscriberId: 'arg-gate-waiver' }];
        request.mutableState.adaptiveGraphVocabulary = [...new Set([...(request.mutableState.adaptiveGraphVocabulary ?? []), 'release.gate.waiver'])];
      } else return { outcome: 'input_required', evidence: 'high-risk ARG effect requires MRTR approval' };
      request.mutableState.graphRevision = (request.mutableState.graphRevision ?? request.graphRevision) + 1;
      await request.ports.persist?.();
      return { outcome: 'ok', evidence: `${effect.kind} applied`, graphRevision: request.mutableState.graphRevision };
    });
  };
  let openProposal: ArgOpenProposal | undefined;
  let openDecision: ArgOpenDecision | undefined;
  const feedback = request.feedback ? await readArgFeedback(request.feedback.ledger, request.feedback.signature) : undefined;
  const proposalMemory = [...(request.openProposal?.memory ?? []), ...(feedback?.candidates ?? [])];
  const proposalPacks = [edgePack, healerPack, ...(feedback?.packs ?? [])];
  const writeDecision = (verb: ArgVerb, result: ArgStepResult, beforeRevision: number): Promise<void> =>
    runWithIncidentClaim(activeClaim.claimToken, () => {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendFileSync(ledgerPath, JSON.stringify({ supervisorId: identity, targetGraphId: request.targetGraphId,
        targetRunId: request.targetRunId, gateEventId: request.gateEventId, verb,
        outcome: result.outcome, evidence: result.evidence, beforeRevision,
        graphRevision: durabilityUnknown ? null : revision,
        ...(durabilityUnknown ? { durability: 'unknown' } : {}) }) + '\n');
    });
  // RLA claims before runGraph can invoke any observe/propose/apply port. The graph's supervisor order
  // is the escalation policy; the existing macrophage repair window bounds this owner lease.
  const ownerOrder = request.incidentClaim?.ownerOrder ??
    (target.template.supervisors ?? []).map((entry) => entry.ref as SupervisorLoopRef);
  const incidentClaim = await claimIncident(claimStore, {
    incidentId,
    ownerLoopRef: identity as SupervisorLoopRef,
    ownerOrder,
    now: claimNow,
    leaseMs: request.incidentClaim?.leaseMs ?? MACROPHAGE_REPAIR_LADDER_LIMITS.maxElapsedMs,
  });
  if (incidentClaim.disposition === 'denied')
    throw new Error(`RLA incident claim denied: ${incidentClaim.reason}`);
  const activeClaim = incidentClaim.claim;
  await assertIncidentClaim(activeClaim.claimToken);
  // Journal the ownership handoff (§2.6 상신 기록) as its own ledger record so lease acquisition
  // and escalation stay distinct from the effect records (§2.6 적용 기록) that advance graphRevision.
  await runWithIncidentClaim(activeClaim.claimToken, () => {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, JSON.stringify({ supervisorId: identity, targetGraphId: request.targetGraphId,
      targetRunId: request.targetRunId, gateEventId: request.gateEventId, verb: 'claim',
      outcome: incidentClaim.disposition, evidence: incidentClaim.disposition === 'escalated'
        ? 'incident claim escalated to this owner after the prior lease expired'
        : 'incident claim granted to the first owner in the incident order',
      beforeRevision: revision, graphRevision: revision }) + '\n');
  });
  const finalizeGraphRun = async (completedRun: GraphRunState): Promise<void> => {
    if (terminalFailure || durabilityUnknown) throw terminalFailure ??
      new Error('ARG rollback persistence failed; durable graphRevision is unknown');
    const feedbackPort = request.feedback;
    if (feedbackPort && applied && (completedRun.path.at(-1) === 'done' || completedRun.path.includes('rollback'))) {
      const outcome = completedRun.path.at(-1) === 'done' ? 'verified' : 'rollback';
      if (!plannedEffect) throw new Error('ARG feedback cannot record an effect that was not applied');
      const effectKey = argEffectKey(plannedEffect);
      let recordSucceeded = false;
      let recordError: unknown;
      try {
        await feedbackPort.ledger.record({ runId: request.targetRunId, signature: feedbackPort.signature,
          effect: effectKey, outcome, at: feedbackPort.at?.() ?? new Date().toISOString() });
        recordSucceeded = true;
      } catch (error) { recordError = error; }
      if (recordSucceeded) {
        try { feedbackPort.onCommitted?.(); }
        catch (error) { throw new ArgFeedbackDurabilityError(`ARG feedback committed but snapshot failed: ${String(error)}`); }
      } else {
        const error = recordError;
        let committed: { readonly outcome: 'verified' | 'rollback'; readonly effect: string } | 'absent' | 'unknown' = 'unknown';
        try { committed = await feedbackPort.readCommitted(request.targetRunId, feedbackPort.signature); }
        catch { /* A failed durable read cannot prove that the write was absent. */ }
        if (typeof committed === 'object' && committed?.outcome === outcome && committed.effect === effectKey) {
          try { feedbackPort.onCommitted?.(); }
          catch (snapshotError) { throw new ArgFeedbackDurabilityError(`ARG feedback committed but snapshot failed: ${String(snapshotError)}`); }
          appendFileSync(ledgerPath, JSON.stringify({ supervisorId: identity, targetGraphId: request.targetGraphId,
            targetRunId: request.targetRunId, gateEventId: request.gateEventId, verb: 'feedback-reconciled',
            outcome, evidence: `durable feedback found after writer error: ${String(error)}`,
            graphRevision: revision }) + '\n');
        } else if (committed !== 'absent') {
          throw new ArgFeedbackDurabilityError(`ARG feedback outcome durability is unknown; graph left at revision ${revision}: ${String(error)}`);
        } else {
          if (outcome === 'verified') {
            const beforeRevision = revision;
            let restored: ArgStepResult;
            try { restored = await restore(); }
            catch (restoreError) {
              throw new ArgFeedbackDurabilityError(`ARG feedback outcome failed and rollback durability is unknown: ${String(error)}; ${String(restoreError)}`);
            }
            if (restored.outcome !== 'ok' || restored.graphRevision !== request.graphRevision)
              throw new ArgFeedbackDurabilityError(`ARG feedback outcome failed and rollback did not restore the prior revision: ${String(error)}`);
            revision = restored.graphRevision;
            await writeDecision('rollback', { outcome: 'ok', evidence: `feedback persistence failed: ${String(error)}`,
              graphRevision: revision }, beforeRevision);
          }
          throw new Error(`ARG feedback outcome could not be recorded: ${String(error)}`);
        }
      }
    }
  };
  const graphRun = await runWithIncidentClaim(activeClaim.claimToken, async () => {
    // Snapshot mutable run state only after the incident lock is held. A successor must not
    // capture a predecessor's pre-commit state and later use it as its rollback target.
    initialState = { graphRevision: request.mutableState.graphRevision ?? request.graphRevision,
      adaptiveGraphEdges: [...(request.mutableState.adaptiveGraphEdges ?? [])],
      adaptiveGraphVocabulary: [...(request.mutableState.adaptiveGraphVocabulary ?? [])] };
    if (initialState.graphRevision !== request.graphRevision) throw new Error('ARG initial revision differs from mutable state');
    priorOverlay = request.vocabularyOverlay && existsSync(request.vocabularyOverlay.path)
      ? readFileSync(request.vocabularyOverlay.path, 'utf8') : undefined;
    revision = initialState.graphRevision;
    const completedRun = await runGraph(graphPath, { input: { targetGraphId: request.targetGraphId,
    targetRunId: request.targetRunId, gateEventId: request.gateEventId, graphRevision: revision,
    ...(request.openProposal ? { observation: request.openProposal.observation, knowledgePacks: proposalPacks,
      templateMemory: proposalMemory } : {}) },
    deps: { root: request.root,
      ...(request.openProposal ? { callLLM: async () => {
        await assertIncidentClaim(activeClaim.claimToken);
        const context = { graph: target.template!, observation: request.openProposal!.observation,
          memory: proposalMemory, knowledgePacks: proposalPacks, cardPath: request.loopPath };
        const proposal = await runWithIncidentClaim(activeClaim.claimToken,
          () => proposeOpenArg(context, request.openProposal!.callLLM));
        await assertIncidentClaim(activeClaim.claimToken);
        const decision = validateOpenArgProposal(proposal, context);
        await runWithIncidentClaim(activeClaim.claimToken, () => {
          mkdirSync(dirname(ledgerPath), { recursive: true });
          appendFileSync(ledgerPath, JSON.stringify({ supervisorId: identity, targetGraphId: request.targetGraphId,
            targetRunId: request.targetRunId, gateEventId: request.gateEventId, verb: 'reason',
            outcome: decision.disposition, evidence: decision.reason, impact: decision.impact,
            proposal, risk: decision.risk,
            beforeRevision: revision, graphRevision: revision }) + '\n');
        });
        if (!proposal || decision.disposition === 'rejected') throw new Error(decision.reason);
        openProposal = proposal;
        openDecision = decision;
        return JSON.stringify({ outcome: 'ok', proposal });
      } } : {}),
      runBash: async command => {
      await assertIncidentClaim(activeClaim.claimToken);
      const verb = command.startsWith('arg:') ? command.slice(4) as ArgVerb : undefined;
      if (!verb || (verb !== 'apply' && verb !== 'rollback' && !Object.hasOwn(request.ports, verb)))
        return { exitCode: 1, stdout: '', stderr: 'undeclared ARG verb' };
      // Recheck the target declaration and its granted operation before each
      // injected effect; a card cannot widen the graph's run-local authority.
      if (!authorized()) return { exitCode: 1, stdout: '', stderr: 'ARG authority revoked' };
      if (verb === 'apply' && !effectAuthorized(plannedEffect))
        return { exitCode: 1, stdout: '', stderr: 'ARG planned effect is outside granted authority' };
      const beforeRevision = request.mutableState.graphRevision ?? request.graphRevision;
      if (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)
        return { exitCode: 1, stdout: '', stderr: 'ARG revision unavailable' };
      revision = beforeRevision;
      let result: ArgStepResult;
      try {
        result = verb === 'validate' && openDecision?.disposition === 'input_required'
          ? { outcome: 'input_required', evidence: openDecision.reason }
          : verb === 'validate' && openDecision?.disposition === 'auto-apply' &&
              plannedEffect?.kind === 'vocabulary' &&
              request.mutableState.adaptiveGraphVocabulary?.includes(plannedEffect.term)
            ? { outcome: 'reuse', evidence: `existing run-local vocabulary reused: ${plannedEffect.term}` }
          : verb === 'apply' ? await apply(plannedEffect!)
            : verb === 'rollback' ? await restore()
            : await runWithIncidentClaim(activeClaim.claimToken, () => request.ports[verb]!({
            ...(plannedEffect ? { effect: plannedEffect } : {}),
            ...(openProposal ? { proposal: openProposal } : {}),
            ...(openDecision ? { decision: openDecision } : {}) }));
        await assertIncidentClaim(activeClaim.claimToken);
      }
      catch (error) {
        if (String(error).includes('RLA incident claim expired or was fenced')) throw error;
        result = { outcome: 'fail', evidence: String(error) };
      }
      const actualRevision = request.mutableState.graphRevision ?? request.graphRevision;
      if (!Number.isSafeInteger(actualRevision) || actualRevision < 1)
        return { exitCode: 1, stdout: '', stderr: 'ARG revision unavailable after effect' };
      revision = actualRevision;
      if (result.graphRevision !== undefined && result.graphRevision !== actualRevision)
        result = { outcome: 'fail', evidence: `reported revision differs from durable revision: ${result.evidence}`, graphRevision: actualRevision };
      if (verb === 'apply' && result.outcome === 'input_required' && actualRevision === beforeRevision) {
        // A validated high-risk effect may stop here without changing the graph.
      } else if (verb === 'apply' && (result.outcome !== 'ok' || actualRevision !== beforeRevision + 1))
        result = { outcome: actualRevision === beforeRevision ? 'fail' : 'rollback_required',
          evidence: `apply did not advance exactly one graphRevision: ${result.evidence}`, graphRevision: actualRevision };
      if (verb === 'rollback' && (result.outcome !== 'ok' || actualRevision !== request.graphRevision))
        result = { outcome: 'fail', evidence: `rollback did not restore graphRevision: ${result.evidence}`, graphRevision: actualRevision };
      if (verb !== 'apply' && verb !== 'rollback' && actualRevision !== beforeRevision)
        result = { outcome: 'rollback_required', evidence: `${verb} changed graphRevision: ${result.evidence}`, graphRevision: actualRevision };
      if (result.outcome === 'rollback_required' && actualRevision === request.graphRevision)
        result = { outcome: 'fail', evidence: `${verb} requested rollback without a graph change`, graphRevision: actualRevision };
      if (verb === 'propose' && result.outcome === 'ok') {
        const effect = result.effect;
        if (!effectAuthorized(effect) && openDecision?.disposition !== 'input_required')
          result = { outcome: 'fail', evidence: 'proposed effect is outside granted ARG authority' };
        else plannedEffect = effect;
      }
      try { await writeDecision(verb, result, beforeRevision); }
      catch (error) {
        const changed = request.mutableState.graphRevision !== initialState.graphRevision ||
          JSON.stringify(request.mutableState.adaptiveGraphEdges ?? []) !== JSON.stringify(initialState.adaptiveGraphEdges) ||
          JSON.stringify(request.mutableState.adaptiveGraphVocabulary ?? []) !== JSON.stringify(initialState.adaptiveGraphVocabulary);
        try { if (changed) await restore(); }
        catch (restoreError) {
          terminalFailure = new Error(`ARG ledger write failed and rollback durability is unknown: ${String(error)}; ${String(restoreError)}`);
          return { exitCode: 1, stdout: '', stderr: terminalFailure.message };
        }
        terminalFailure = new Error(`ARG ledger write failed; graph restored: ${String(error)}`);
        return { exitCode: 1, stdout: '', stderr: terminalFailure.message };
      }
      if (verb === 'apply' && result.outcome === 'ok') applied = true;
      return { exitCode: 0, stdout: JSON.stringify({ outcome: result.outcome, evidence: result.evidence }), stderr: '' };
    } }, quiet: true });
    await finalizeGraphRun(completedRun);
    return completedRun;
  }, (completedRun) => completedRun.path.at(-1) === 'done');
  const verifiedVocabularyTerm = plannedEffect?.kind === 'vocabulary' ? plannedEffect.term : undefined;
  if (graphRun.path.at(-1) === 'done' && openProposal && openDecision?.disposition === 'auto-apply' &&
      verifiedVocabularyTerm &&
      openProposal.changes.some(change => change.kind === 'vocabulary' && change.term === verifiedVocabularyTerm)) {
      await runWithIncidentClaim(activeClaim.claimToken, () => { try {
        recordOpenArgMemory(request.root, request.loopPath, request.targetRunId, verifiedVocabularyTerm,
          JSON.stringify(request.openProposal?.observation ?? {}), true);
      } catch (error) {
        appendFileSync(ledgerPath, JSON.stringify({ supervisorId: identity, targetGraphId: request.targetGraphId,
          targetRunId: request.targetRunId, gateEventId: request.gateEventId, verb: 'memory-candidate',
          outcome: 'fail', evidence: String(error), graphRevision: revision }) + '\n');
      } });
  }
  if (graphRun.path.at(-1) === 'needs-human') return { resultType: 'input_required', graphRun,
    graphRevision: revision, requestState: { supervisorId: identity as string, targetGraphId: request.targetGraphId,
      targetRunId: request.targetRunId, gateEventId: request.gateEventId, graphRevision: revision,
      ...(openProposal ? { proposal: JSON.stringify(openProposal) } : {}) },
    inputRequests: [{ kind: 'approval', prompt: openDecision?.reason ?? 'Approve the proposed release graph change' }] };
  return { resultType: 'complete', graphRun, graphRevision: revision };
}
