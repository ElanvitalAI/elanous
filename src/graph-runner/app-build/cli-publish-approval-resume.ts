import { basename, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { GraphRunState } from '../runner.js';
import { APP_BUILD_REVIEW_PUBLISH_NODE } from '../capability-providers/app-build-rich-traversal.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/u;
const PRESENTATION_RETRY = /^APP_BUILD_APPROVAL_PRESENTATION_RETRYABLE:([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)$/u;
const APPROVAL_CONTRACT = 'app-build.publish-approval@1';
const UNTRUSTED_RESUME = /^APP_BUILD_APPROVAL_UNTRUSTED_RESUME(?::|$)/u;
const APPROVAL_PROVIDER = 'app-build-owner-publish-approval';
/** Pre-fix runs: dispatch masked the approval provider's own refusal as contract-exhausted. */
const LEGACY_MASKED_REASONS = new Set(['verified owner approval required', 'owner approval unavailable or refused']);
const MATERIALIZE_NODE = 'materialize';

type NodeRecord = GraphRunState['nodes'][number];

/** Only the approval provider's own refusal, recorded at the approval contract, qualifies. */
function legacyMaskedApprovalFailure(node: NodeRecord): boolean {
  if (node.error !== 'contract-exhausted' || typeof node.output !== 'string') return false;
  let value: unknown;
  try { value = JSON.parse(node.output); } catch { return false; }
  const evidence = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { evidence?: unknown }).evidence : undefined;
  const row = evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    ? evidence as { contractId?: unknown; attempts?: unknown } : undefined;
  return row?.contractId === APPROVAL_CONTRACT && Array.isArray(row.attempts) && row.attempts.length === 1
    && (row.attempts[0] as { provider?: unknown })?.provider === APPROVAL_PROVIDER
    && LEGACY_MASKED_REASONS.has((row.attempts[0] as { reason?: unknown }).reason as string);
}

function restartableApprovalFailure(node: NodeRecord): boolean {
  return node.ok === false && (UNTRUSTED_RESUME.test(node.error ?? '') || legacyMaskedApprovalFailure(node));
}

function savedOwnerInput(state: GraphRunState): Record<string, unknown> {
  const input = state.input;
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('app-build approval resume input missing');
  const row = input as Record<string, unknown>;
  const owner = row.context && typeof row.context === 'object' && !Array.isArray(row.context)
    ? (row.context as Record<string, unknown>).memberId : undefined;
  if (typeof row.appSlug !== 'string' || !SLUG.test(row.appSlug)
    || typeof owner !== 'string' || !owner.trim())
    throw new Error('app-build approval resume owner binding missing');
  return row;
}

/** The ordinary HITL decision remains bound to the saved run and its original input. */
export function savedAppBuildApprovalStartInput(state: GraphRunState, graphFile: string,
  readDecision: (path: string, encoding: 'utf8') => string = (path, encoding) => readFileSync(path, encoding)): Record<string, unknown> {
  if (state.graphId !== basename(graphFile, '.yaml') || state.status !== 'awaiting-approval'
    || !state.graphPath || resolve(state.graphPath) !== resolve(graphFile)
    || !state.graphSnapshot || state.pending?.nodeId !== APP_BUILD_REVIEW_PUBLISH_NODE
    || state.pending.decision !== 'approved' || state.path.at(-1) !== APP_BUILD_REVIEW_PUBLISH_NODE
    || state.path.filter(node => node === APP_BUILD_REVIEW_PUBLISH_NODE).length !== 1
    || state.nodes.some(node => !state.path.includes(node.nodeId)))
    throw new Error('app-build approval start requires the saved approved review visit');
  const input = savedOwnerInput(state);
  const inputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const claim = JSON.parse(readDecision(`${state.statePath}.${state.path.length}.decision.json`, 'utf8')) as
    { nodeId?: string; decision?: string; inputSha256?: string; decidedAt?: string };
  if (claim.nodeId !== state.pending.nodeId || claim.decision !== 'approved'
    || claim.inputSha256 !== inputSha256 || state.pending.inputSha256 !== inputSha256
    || claim.decidedAt !== state.pending.decidedAt)
    throw new Error('app-build approval decision claim changed');
  return input;
}

/** A failed presentation of an existing pending approval polls it again; an approval visit that
 * never reached the owner (untrusted registry, or the pre-fix masked refusal) starts a fresh one,
 * but only after the same run's materialize succeeded and its review visit was approved. */
export function savedAppBuildApprovalResumeInput(state: GraphRunState, graphFile: string,
  now = Date.now(), readSaved: (path: string, encoding: 'utf8') => string =
    (path, encoding) => readFileSync(path, encoding)):
  { input: Record<string, unknown>; pendingExpiresAt?: string; executionId: string } {
  const presentation = state.nodes.filter(node => node.ok === false && PRESENTATION_RETRY.test(node.error ?? ''));
  const restart = state.nodes.filter(restartableApprovalFailure);
  const failed = presentation.length ? presentation : restart;
  const approvalNodeId = failed[0]?.nodeId;
  if (state.graphId !== basename(graphFile, '.yaml') || state.status !== 'failed'
    || !state.graphPath || resolve(state.graphPath) !== resolve(graphFile)
    || !state.graphSnapshot || !approvalNodeId || state.path.filter(node => node === approvalNodeId).length !== 1
    || failed.length !== 1 || typeof failed[0]?.executionId !== 'string' || !failed[0].executionId
    || state.path.at(-2) !== approvalNodeId
    || state.nodes.some(node => !state.path.includes(node.nodeId))
    || state.nodes.some(node => node.nodeId === approvalNodeId && node.ok === true)
    || state.nodes.some(node => node.ok && node.executed && node.nodeId !== approvalNodeId
      && state.path.indexOf(node.nodeId) > state.path.indexOf(approvalNodeId))
    || state.pending || presentation.length && restart.length)
    throw new Error('app-build approval resume requires the same failed graph run');
  if (!presentation.length) assertApprovedReviewBeforeApproval(state, readSaved);
  const source = readSaved(`${state.statePath}.graph/graph.yaml`, 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== state.graphSnapshot.graphSha)
    throw new Error('app-build approval graph snapshot changed');
  const parsed: unknown = parseYaml(source);
  const graph = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as { graph?: { id?: unknown }; nodes?: unknown } : undefined;
  const approvalNodes = Array.isArray(graph?.nodes) ? graph.nodes.filter(node => node
    && typeof node === 'object' && !Array.isArray(node)
    && (node as { requires?: unknown }).requires === APPROVAL_CONTRACT) : [];
  if (graph?.graph?.id !== state.graphId || approvalNodes.length !== 1
    || (approvalNodes[0] as { id?: unknown; type?: unknown }).id !== approvalNodeId
    || (approvalNodes[0] as { type?: unknown }).type !== 'capability')
    throw new Error('app-build approval node is not uniquely pinned in the saved graph');
  if (!presentation.length) return { input: savedOwnerInput(state), executionId: failed[0].executionId };
  const expiry = PRESENTATION_RETRY.exec(failed[0].error ?? '')?.[1];
  if (!expiry || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= now)
    throw new Error('app-build approval resume has no live pending presentation');
  return { input: savedOwnerInput(state), pendingExpiresAt: expiry, executionId: failed[0].executionId };
}

/** The visit right before approval must be the run's single approved review, after a done materialize. */
function assertApprovedReviewBeforeApproval(state: GraphRunState,
  readDecision: (path: string, encoding: 'utf8') => string): void {
  const reviewIndex = state.path.length - 3;
  const review = state.nodes[reviewIndex];
  const materialize = state.path.lastIndexOf(MATERIALIZE_NODE);
  const refuse = () => { throw new Error('app-build approval restart requires the saved approved review visit'); };
  if (reviewIndex < 1 || state.path.length !== state.nodes.length
    || state.nodes.some((node, index) => node.nodeId !== state.path[index])
    || state.path[reviewIndex] !== APP_BUILD_REVIEW_PUBLISH_NODE || review?.ok !== true
    || typeof review.decidedAt !== 'string'
    || state.path.filter(node => node === APP_BUILD_REVIEW_PUBLISH_NODE).length !== 1
    || materialize < 0 || materialize > reviewIndex || state.nodes[materialize]?.ok !== true) refuse();
  const input = savedOwnerInput(state);
  const inputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  let claim: { nodeId?: string; decision?: string; inputSha256?: string; decidedAt?: string } = {};
  try { claim = JSON.parse(readDecision(`${state.statePath}.${reviewIndex + 1}.decision.json`, 'utf8')); }
  catch { refuse(); }
  if (claim.nodeId !== APP_BUILD_REVIEW_PUBLISH_NODE || claim.decision !== 'approved'
    || claim.inputSha256 !== inputSha256 || claim.decidedAt !== review!.decidedAt) refuse();
}

/** The generic `graph runs resume` binds no owner window. Only a restart that begins AT the saved
 * graph's owner-approval node is refused before any node runs, naming the trusted CLI command.
 * Earlier restarts (e.g. materialize) keep the generic path; if they reach approval at runtime the
 * untrusted provider records APP_BUILD_APPROVAL_UNTRUSTED_RESUME, which the trusted CLI accepts.
 * Later restarts (e.g. publish after an approved visit) are left alone. */
export function genericResumeApprovalRefusal(state: GraphRunState, startNodeId?: string,
  readSaved: (path: string, encoding: 'utf8') => string = (path, encoding) => readFileSync(path, encoding)): string | undefined {
  if (!state.graphSnapshot || !state.statePath) return undefined;
  let parsed: unknown;
  try { parsed = parseYaml(readSaved(`${state.statePath}.graph/graph.yaml`, 'utf8')); } catch { return undefined; }
  const nodes = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { nodes?: unknown }).nodes : undefined;
  const approvalIds = Array.isArray(nodes) ? nodes.flatMap(node => node && typeof node === 'object'
    && (node as { requires?: unknown }).requires === APPROVAL_CONTRACT
    && typeof (node as { id?: unknown }).id === 'string' ? [(node as { id: string }).id] : []) : [];
  if (!approvalIds.length) return undefined;
  const start = startNodeId ?? state.pending?.nodeId ?? state.path.at(-1);
  if (start === undefined || !approvalIds.includes(start)) return undefined;
  return `APP_BUILD_APPROVAL_UNTRUSTED_RESUME: 신뢰 경로로 재개 필요: eln graph run ${state.graphPath ?? '<graph.yaml>'}`
    + ` --resume ${state.runId}${start && state.status === 'failed' ? ` --from ${start}` : ''}`;
}
