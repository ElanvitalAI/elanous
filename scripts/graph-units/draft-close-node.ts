import { readFileSync } from 'node:fs';
import { PROTECTED_LABELS, decideDraft, type DraftTriagePr } from '../../src/self-dev/draft-triage-rules.js';

type Json = Record<string, unknown>;
type DraftCloseKind = 'harvest' | 'close-candidate' | 'hold';
type DraftCloseOutcome = DraftCloseKind | 'failed';
const DRAFT_CLOSE_PROTECTED_LABELS = new Set([...PROTECTED_LABELS, 'elanous:running', 'elanous:claim', 'elanous:harvest-claimed']);

interface DraftCloseRow extends Json {
  mapRunId: string | null;
  snapshotTime: string | null;
  inventoryComplete: boolean;
  pr: number | null;
  headOid: string | null;
  kind: DraftCloseKind;
  classification: string;
  reason: string;
  replacement: number | null;
  protectedReason: string | null;
  evidence: string[];
  writes: readonly [];
}

interface DraftCloseDecision {
  outcome: DraftCloseOutcome;
  result: DraftCloseRow;
  evidence: Json;
}

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : undefined;
}

function row(input: {
  mapRunId?: string;
  snapshotTime?: string;
  inventoryComplete: boolean;
  pr?: number;
  headOid?: string;
  kind: DraftCloseKind;
  classification: string;
  reason: string;
  replacement?: number;
  protectedReason?: string;
  evidence: string[];
  extra?: Json;
}): DraftCloseRow {
  return {
    mapRunId: input.mapRunId ?? null,
    snapshotTime: input.snapshotTime ?? null,
    inventoryComplete: input.inventoryComplete,
    pr: input.pr ?? null,
    headOid: input.headOid ?? null,
    kind: input.kind,
    classification: input.classification,
    reason: input.reason,
    replacement: input.replacement ?? null,
    protectedReason: input.protectedReason ?? null,
    evidence: input.evidence,
    writes: [],
    ...input.extra,
  };
}

function failClosed(mapRunId: string | undefined, snapshotTime: string | undefined, reason: string): DraftCloseDecision {
  const result = row({ mapRunId, snapshotTime, inventoryComplete: false, kind: 'hold', classification: 'inventory-incomplete',
    reason, evidence: [reason], extra: { rowsSuppressed: true } });
  return { outcome: 'hold', result, evidence: { rowsSuppressed: true } };
}

function holdItem(input: { mapRunId?: string; snapshotTime?: string; pr?: number; headOid?: string; reason: string }): DraftCloseDecision {
  const result = row({ mapRunId: input.mapRunId, snapshotTime: input.snapshotTime, inventoryComplete: true, pr: input.pr,
    headOid: input.headOid, kind: 'hold', classification: 'human', reason: input.reason, evidence: [input.reason] });
  return { outcome: 'hold', result, evidence: { reason: input.reason } };
}

/** Pure, deterministic item classifier used by the draft-close graph's observe node. */
export function decideDraftClose(raw: unknown): DraftCloseDecision {
  const envelope = record(raw);
  const context = Object.keys(record(envelope.context)).length > 0 ? record(envelope.context) : envelope;
  const inventory = record(context.inventory);
  const item = record(context.item);
  const mapRunId = string(context.mapRunId);
  const snapshotTime = string(context.snapshotTime) ?? string(inventory.snapshotTime);
  const completenessClaims = [context.inventoryComplete, inventory.complete].filter((value): value is boolean => typeof value === 'boolean');
  const inventoryComplete = completenessClaims.length > 0 && completenessClaims.every(Boolean);
  const completenessConflict = completenessClaims.some((value) => value !== completenessClaims[0]);
  const truncated = context.truncated === true || inventory.truncated === true;
  const inventoryError = string(context.inventoryError) ?? string(inventory.error);
  if (!inventoryComplete || completenessConflict || truncated || inventoryError) {
    return failClosed(mapRunId, snapshotTime, inventoryError ?? (truncated ? 'inventory truncated/page limit'
      : completenessConflict ? 'conflicting inventory completeness claims' : 'inventory completeness not proven'));
  }

  const prValue = item.pr ?? item.number;
  const pr = typeof prValue === 'number' && Number.isSafeInteger(prValue) && prValue > 0 ? prValue
    : typeof prValue === 'string' && /^\d+$/.test(prValue) ? Number(prValue) : undefined;
  const headOid = string(item.headOid) ?? string(item.headSha);
  const mainSha = string(context.mainSha) ?? string(inventory.mainSha);
  const repository = string(item.repository);
  const state = string(item.state)?.toLowerCase();
  const labels = strings(item.labels);
  const branch = string(item.branch);
  const title = string(item.title);
  const body = typeof item.body === 'string' ? item.body : undefined;
  const createdAt = string(item.createdAt);
  const changedFiles = strings(item.changedFiles);
  const latestFileChanges = record(item.latestFileChanges) as Record<string, string>;
  const snapshotMs = Date.parse(snapshotTime ?? '');
  if (!pr || !headOid || !repository || !mainSha || !snapshotTime || !Number.isFinite(snapshotMs)
    || state !== 'open' || item.isDraft !== true || !labels || !branch || !title || body === undefined || !createdAt
    || !changedFiles || item.changedFilesComplete !== true) {
    return holdItem({ mapRunId, snapshotTime, pr, headOid,
      reason: 'PR snapshot lacks required id/head/repo/state/labels/body/files or main/snapshot proof' });
  }

  const protectedLabel = labels.find((label) => DRAFT_CLOSE_PROTECTED_LABELS.has(label));
  if (protectedLabel) {
    const result = row({ mapRunId, snapshotTime, inventoryComplete: true, pr, headOid, kind: 'hold', classification: 'protected',
      reason: `protected label ${protectedLabel}`, protectedReason: protectedLabel, evidence: [`label=${protectedLabel}`, `head=${headOid}`] });
    return { outcome: 'hold', result, evidence: { protectedReason: protectedLabel } };
  }

  const reviewGate = record(item.reviewGate);
  const reviewHead = string(reviewGate.headOid);
  const gateHead = string(reviewGate.gateHeadOid);
  const review = string(reviewGate.review)?.toLowerCase();
  const gate = string(reviewGate.gate)?.toLowerCase();
  const mustFix = reviewGate.mustFix;
  const reviewPass = reviewHead === headOid && ['pass', 'warn'].includes(review ?? '')
    && Array.isArray(mustFix) && mustFix.length === 0;
  const gatePass = gateHead === headOid && gate === 'pass' && reviewGate.introduced === 0;
  if (reviewPass && gatePass) {
    const reason = 'same-head GLM mustFix=0 and changed gate introduced=0';
    const result = row({ mapRunId, snapshotTime, inventoryComplete: true, pr, headOid, kind: 'harvest', classification: 'harvest', reason,
      evidence: [reason, `repository=${repository}`, `mainSha=${mainSha}`, `head=${headOid}`], extra: {
        handoff: ['merge-origin-main-into-branch', 'resolve-conflicts-on-same-branch', 'changed-gate-introduced-0',
          'GLM-review-same-head-mustFix-0', 'land-enqueue-without-gate-summary'],
      } });
    return { outcome: 'harvest', result, evidence: { headOid, mainSha, handoff: result.handoff } };
  }

  if (item.openDraftsComplete !== true || item.mergedTwinsComplete !== true) {
    const reason = 'open/merged peer inventory incomplete; close decision suppressed';
    return holdItem({ mapRunId, snapshotTime, pr, headOid, reason: `${reason}; mainSha=${mainSha}` });
  }

  const latestCommitAt = string(item.lastCommitAt) ?? string(item.latestCommitAt);
  const latestCommitMs = Date.parse(latestCommitAt ?? '');
  const ageHours = Number.isFinite(latestCommitMs) ? (snapshotMs - latestCommitMs) / 3_600_000 : Number.NaN;
  if (!latestCommitAt || !Number.isFinite(latestCommitMs)) {
    return holdItem({ mapRunId, snapshotTime, pr, headOid, reason: 'last commit time unavailable; 48h/stale decision suppressed' });
  }
  const openDrafts = Array.isArray(item.openDrafts) ? item.openDrafts as DraftTriagePr[] : [];
  const mergedTwins = Array.isArray(item.mergedTwins) ? item.mergedTwins as DraftTriagePr[] : [];
  const liveBranches = new Set(strings(item.liveBranches) ?? []);
  const runStatus = string(item.runStatus);
  const decision = decideDraft({
    draft: { number: pr, title, branch, labels, body, createdAt, changedFiles, latestFileChanges, latestCommitAt },
    runStatus,
    mergedTwins,
    openDrafts,
    ageHours,
    liveBranches,
    ...(typeof item.finalRunResult === 'boolean' ? { finalRunResult: item.finalRunResult } : {}),
  });
  if (decision.action === 'keep') {
    const result = row({ mapRunId, snapshotTime, inventoryComplete: true, pr, headOid, kind: 'hold', classification: 'keep',
      reason: decision.reason, evidence: [`decideDraft=${decision.action}:${decision.reason}`, `head=${headOid}`, `mainSha=${mainSha}`] });
    return { outcome: 'hold', result, evidence: { decision } };
  }

  // Keep item-level completeness guards beside the close decision even though the envelope guard above also checks them.
  if (decision.reason.startsWith('duplicate-of-open') && item.openDraftsComplete !== true) {
    return failClosed(mapRunId, snapshotTime, 'complete open-draft inventory required for duplicate close proposal');
  }
  if ((decision.reason.includes('all-files-landed') || decision.reason.startsWith('superseded-by'))
    && (item.mergedTwinsComplete !== true || item.changedFilesComplete !== true)) {
    return failClosed(mapRunId, snapshotTime, 'complete changed-file and merged-peer evidence required for superseded close proposal');
  }

  const match = /#(\d+)/.exec(decision.reason);
  const replacement = match ? Number(match[1]) : undefined;
  const classification = decision.reason.includes('all-files-landed') ? 'all-files-landed'
    : decision.reason.startsWith('duplicate-of-open') ? 'duplicate-of-open'
      : decision.reason.startsWith('superseded-by') ? 'superseded' : 'stale';
  const result = row({ mapRunId, snapshotTime, inventoryComplete: true, pr, headOid, kind: 'close-candidate', classification,
    reason: decision.reason, replacement, evidence: [`decideDraft=close:${decision.reason}`, `lastCommitAt=${latestCommitAt}`,
      `ageHours=${ageHours}`, `repository=${repository}`, `mainSha=${mainSha}`, `head=${headOid}`], extra: { writeBoundary: 'reduce-only' } });
  return { outcome: 'close-candidate', result, evidence: { decision, latestCommitAt, ageHours, mainSha, headOid } };
}

function graphContext(): Json {
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path) throw new Error('ELANOUS_GRAPH_CONTEXT is required');
  return JSON.parse(readFileSync(path, 'utf8')) as Json;
}

if (import.meta.main) {
  const context = graphContext();
  const mode = process.argv[2];
  if (mode === 'decide') {
    const decision = decideDraftClose(context.input);
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  } else if (mode === 'emit') {
    const branch = process.argv[3] as DraftCloseKind | undefined;
    const decided = record(record(context.outputs).decide);
    const result = record(decided.result);
    if (!branch || result.kind !== branch) throw new Error(`decision row kind does not match branch ${branch ?? '<missing>'}`);
    process.stdout.write(`${JSON.stringify({ outcome: 'done', result, evidence: decided.evidence ?? {} })}\n`);
  } else {
    throw new Error(`unknown draft-close mode: ${mode ?? '<missing>'}`);
  }
}
