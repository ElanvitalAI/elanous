import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { proposeOpenArg, recordOpenArgMemory, validateOpenArgProposal, type ArgOpenDecision, type ArgOpenProposal } from './arg-open-proposal.js';
import { runGraph, type GraphRunState } from './runner.js';

export type ArgVerb = 'observe' | 'propose' | 'validate' | 'apply' | 'verify' | 'rollback';
export type ArgEffect =
  | { readonly kind: 'retry-edge'; readonly from: string; readonly to: string; readonly triggerEvent: string; readonly rationale: string }
  | { readonly kind: 'vocabulary'; readonly term: string }
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'repair'; readonly nodeId: string }
  | { readonly kind: 'hitl'; readonly decisionId: string };
const effectOperation = (effect: ArgEffect): ArgSupervisorTickRequest['operation'] | undefined => {
  if (!effect || typeof effect !== 'object') return undefined;
  if (effect.kind === 'retry-edge' && typeof effect.from === 'string' && effect.from.trim() &&
      typeof effect.to === 'string' && effect.to.trim() && typeof effect.triggerEvent === 'string' &&
      effect.triggerEvent.trim() && typeof effect.rationale === 'string' && effect.rationale.trim()) return 'reroute';
  if (effect.kind === 'vocabulary' && typeof effect.term === 'string' && effect.term.trim()) return 'reroute';
  if (effect.kind === 'node' && typeof effect.nodeId === 'string' && effect.nodeId.trim()) return 'add-node';
  if (effect.kind === 'repair' && typeof effect.nodeId === 'string' && effect.nodeId.trim()) return 'repair';
  if (effect.kind === 'hitl' && typeof effect.decisionId === 'string' && effect.decisionId.trim()) return 'hitl';
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
  readonly operation: 'reroute' | 'add-node' | 'repair' | 'hitl';
  readonly mutableState: ArgMutationState;
  readonly vocabularyOverlay?: { readonly sourcePath: string; readonly path: string };
  readonly openProposal?: {
    readonly observation: Readonly<Record<string, unknown>>;
    readonly memory: readonly unknown[];
    readonly callLLM: (prompt: string) => Promise<string>;
  };
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
  if (card?.apiVersion !== 'elanous.dev/loop/v1' || identity !== 'loop:rla@1' ||
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
  const initialState = { graphRevision: request.mutableState.graphRevision ?? request.graphRevision,
    adaptiveGraphEdges: [...(request.mutableState.adaptiveGraphEdges ?? [])],
    adaptiveGraphVocabulary: [...(request.mutableState.adaptiveGraphVocabulary ?? [])] };
  if (initialState.graphRevision !== request.graphRevision) throw new Error('ARG initial revision differs from mutable state');
  const priorOverlay = request.vocabularyOverlay && existsSync(request.vocabularyOverlay.path)
    ? readFileSync(request.vocabularyOverlay.path, 'utf8') : undefined;
  const restoreOverlay = (): void => {
    const path = request.vocabularyOverlay?.path;
    if (!path) return;
    if (priorOverlay === undefined) { if (existsSync(path)) unlinkSync(path); }
    else { const temporary = `${path}.${randomUUID()}.tmp`; writeFileSync(temporary, priorOverlay); renameSync(temporary, path); }
  };
  let revision = initialState.graphRevision;
  let plannedEffect: ArgEffect | undefined;
  let durabilityUnknown = false;
  let terminalFailure: Error | undefined;
  const restore = async (): Promise<ArgStepResult> => {
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
  };
  const apply = async (effect: ArgEffect): Promise<ArgStepResult> => {
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
    } else return { outcome: 'input_required', evidence: 'high-risk ARG effect requires MRTR approval' };
    request.mutableState.graphRevision = (request.mutableState.graphRevision ?? request.graphRevision) + 1;
    await request.ports.persist?.();
    return { outcome: 'ok', evidence: `${effect.kind} applied`, graphRevision: request.mutableState.graphRevision };
  };
  let openProposal: ArgOpenProposal | undefined;
  let openDecision: ArgOpenDecision | undefined;
  const writeDecision = (verb: ArgVerb, result: ArgStepResult, beforeRevision: number): void => {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, JSON.stringify({ supervisorId: identity, targetGraphId: request.targetGraphId,
      targetRunId: request.targetRunId, gateEventId: request.gateEventId, verb,
      outcome: result.outcome, evidence: result.evidence, beforeRevision,
      graphRevision: durabilityUnknown ? null : revision,
      ...(durabilityUnknown ? { durability: 'unknown' } : {}) }) + '\n');
  };
  const graphRun = await runGraph(graphPath, { input: { targetGraphId: request.targetGraphId,
    targetRunId: request.targetRunId, gateEventId: request.gateEventId, graphRevision: revision,
    ...(request.openProposal ? { observation: request.openProposal.observation, knowledgePacks: [edgePack, healerPack],
      templateMemory: request.openProposal.memory } : {}) },
    deps: { root: request.root,
      ...(request.openProposal ? { callLLM: async () => {
        const context = { graph: target.template!, observation: request.openProposal!.observation,
          memory: request.openProposal!.memory, knowledgePacks: [edgePack, healerPack], cardPath: request.loopPath };
        const proposal = await proposeOpenArg(context, request.openProposal!.callLLM);
        const decision = validateOpenArgProposal(proposal, context);
        mkdirSync(dirname(ledgerPath), { recursive: true });
        appendFileSync(ledgerPath, JSON.stringify({ supervisorId: identity, targetGraphId: request.targetGraphId,
          targetRunId: request.targetRunId, gateEventId: request.gateEventId, verb: 'reason',
          outcome: decision.disposition, evidence: decision.reason, impact: decision.impact,
          proposal, risk: decision.risk,
          beforeRevision: revision, graphRevision: revision }) + '\n');
        if (!proposal || decision.disposition === 'rejected') throw new Error(decision.reason);
        openProposal = proposal;
        openDecision = decision;
        return JSON.stringify({ outcome: 'ok', proposal });
      } } : {}),
      runBash: async command => {
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
            : await request.ports[verb]({ ...(plannedEffect ? { effect: plannedEffect } : {}),
            ...(openProposal ? { proposal: openProposal } : {}),
            ...(openDecision ? { decision: openDecision } : {}) });
      }
      catch (error) { result = { outcome: 'fail', evidence: String(error) }; }
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
      try { writeDecision(verb, result, beforeRevision); }
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
      if (verb === 'verify' && result.outcome === 'ok' && openProposal && openDecision?.disposition === 'auto-apply') {
        for (const change of openProposal.changes) if (change.kind === 'vocabulary')
          recordOpenArgMemory(request.root, request.loopPath, request.targetRunId, change.term,
            JSON.stringify(request.openProposal?.observation ?? {}), true);
      }
      return { exitCode: 0, stdout: JSON.stringify({ outcome: result.outcome, evidence: result.evidence }), stderr: '' };
    } }, quiet: true });
  if (terminalFailure || durabilityUnknown) throw terminalFailure ??
    new Error('ARG rollback persistence failed; durable graphRevision is unknown');
  if (graphRun.path.at(-1) === 'needs-human') return { resultType: 'input_required', graphRun,
    graphRevision: revision, requestState: { supervisorId: identity as string, targetGraphId: request.targetGraphId,
      targetRunId: request.targetRunId, gateEventId: request.gateEventId, graphRevision: revision,
      ...(openProposal ? { proposal: JSON.stringify(openProposal) } : {}) },
    inputRequests: [{ kind: 'approval', prompt: openDecision?.reason ?? 'Approve the proposed release graph change' }] };
  return { resultType: 'complete', graphRun, graphRevision: revision };
}
