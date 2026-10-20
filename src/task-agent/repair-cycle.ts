/** HQ same-PR repair launch and result collection; the reviewed head is the sole source of truth. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { readBudgetInputsLive, type BudgetInputs } from '../self-implement/budget-gate.js';
import { mintRunId } from '../harness/harness-space.js';
import { spawnElanousSync } from '../instance/spawn-elanous.js';
import { passJourneyNode } from '../self-dev/graph-journey-nodes.js';
import { recordJourneyEdge } from '../self-dev/graph-journey-route.js';
import { checklistHistory, listChecklist, parseOwner } from '../release-loop/checklist.js';
import { applyRepairBundle, type RepairCasOutcome, type RepairCasRequest } from './repair-branch-cas.js';
import { repairNextMove } from './repair-next-move.js';
import { parseRepairWorkerResult } from './repair-worker.js';
import { TASK_SEATS, readTaskCard, updateTaskCard, type TaskCard, type TaskChildLlm, type TaskSeat } from './task-hand.js';

const WAIT_MS = 90 * 60_000;
const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, '_');

export interface RepairLaunchRequest {
  card: string; pr: number; head: string; repo: string; resultPath: string;
  goalFile: string; runId: string; model: TaskChildLlm; seat?: string;
}

export interface RepairCycleInput {
  card: TaskCard; statePath: string; repo: string; pr: number; head: string; branch: string;
  mustFix: readonly string[]; liveMoves: ReadonlySet<string>; now: Date;
  readFile?: (path: string) => string;
  request?: (input: RepairLaunchRequest) => Promise<void>;
  apply?: (input: RepairCasRequest) => RepairCasOutcome;
  notify?: (seat: string, body: string) => void;
  observeLaunch?: (move: string, runId: string) => void;
  resolveOwner?: (card: TaskCard) => RepairOwner;
  /** Shared only by one `tasks rejudge --all` invocation; a single-card rejudge has no cap. */
  repairBudget?: RepairTickBudget;
  /** Test seam; production reads the existing subscription quota signals. */
  modelAvailability?: RepairModelAvailability;
  /** Test seam for the same live quota reader used when availability is not injected. */
  readBudgetInputs?: () => Promise<Pick<BudgetInputs, 'codexCandidates' | 'grokUsedPercent' | 'maxUsedPercent'>>;
}

export interface RepairTickBudget { max: number; requested: number; capped: number }

export type RepairCycleOutcome = { decision: 'would-repair' | 'repair-requested' | 'repair-pending' | 'repair-applied' | 'repair-failed' | 'repair-stopped'; reason: string;
  /** Present only when this tick actually consumed a bound worker result. */
  repairRunId?: string; repairHead?: string };
export type RepairOwner = { seat?: TaskSeat; source: string; reason?: string };

/** A missing card seat may use only a uniquely identified checklist cell's valid seat. */
export function resolveRepairOwner(card: TaskCard, deps: {
  history?: (id: string) => readonly { version: string }[];
  checklist?: (version: string) => { items: readonly { id: string; owner?: string }[] };
} = {}): RepairOwner {
  if (card.seat) return { seat: card.seat, source: 'card' };
  if (!card.checklistId) return { source: 'none', reason: 'checklist id missing' };
  const history = deps.history ?? checklistHistory;
  const checklist = deps.checklist ?? listChecklist;
  let versions: string[];
  try {
    versions = card.checklistVersion ? [card.checklistVersion]
      : [...new Set(history(card.checklistId).map((entry) => entry.version))];
  } catch (error) { return { source: 'none', reason: `checklist history unavailable: ${String(error).slice(0, 160)}` }; }
  if (!versions.length) return { source: 'none', reason: 'checklist version unavailable' };
  let cells: Array<{ version: string; owner?: string }>;
  try {
    cells = versions.flatMap((version) => checklist(version).items
      .filter((row) => row.id === card.checklistId)
      .map((item) => ({ version, owner: item.owner })));
  } catch (error) { return { source: 'none', reason: `checklist lookup unavailable: ${String(error).slice(0, 160)}` }; }
  if (cells.length !== 1) return { source: 'none', reason: cells.length ? `checklist cell ambiguous: ${cells.length} matches` : 'checklist cell absent' };
  const cell = cells[0]!;
  if (!cell.owner) return { source: 'none', reason: `checklist owner missing: ${cell.version}/${card.checklistId}` };
  try {
    const seat = parseOwner(cell.owner).seat;
    if (!(TASK_SEATS as readonly string[]).includes(seat)) return { source: 'none', reason: `checklist owner seat unknown: ${cell.version}/${card.checklistId}` };
    return { seat: seat as TaskSeat, source: `checklist ${cell.version}/${card.checklistId}` };
  } catch { return { source: 'none', reason: `checklist owner invalid: ${cell.version}/${card.checklistId}` }; }
}

export interface RepairModelAvailability { codexSubscription: boolean; grokSubscription: boolean }

export async function repairModelAvailability(readInputs: () => Promise<Pick<BudgetInputs, 'codexCandidates' | 'grokUsedPercent' | 'maxUsedPercent'>> = readBudgetInputsLive): Promise<RepairModelAvailability> {
  try {
    const input = await readInputs();
    const codexCap = input.maxUsedPercent['openai-codex'] ?? 95;
    const grokCap = input.maxUsedPercent.grok ?? 100;
    return {
      codexSubscription: input.codexCandidates.some((candidate) => candidate.reached !== true
        && typeof candidate.usedPercent === 'number' && candidate.usedPercent < codexCap),
      grokSubscription: typeof input.grokUsedPercent === 'number' && input.grokUsedPercent < grokCap,
    };
  } catch { return { codexSubscription: false, grokSubscription: false }; }
}

/** Repair stays inside the dispatch tier. A missing legacy tier is mid ('중'); Sol is reserved for the 특 tier and measured-subscription 상 repairs. */
export function alternateRepairModel(card: TaskCard, availability: RepairModelAvailability = { codexSubscription: false, grokSubscription: false }): { from: string; to: TaskChildLlm } {
  const last = card.repairs?.at(-1);
  const from = last?.toModel ?? (card.childLlm ? `${card.childLlm.provider}/${card.childLlm.model}` : 'unknown');
  const glm: TaskChildLlm = { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3' };
  const sol: TaskChildLlm = { provider: 'openai-codex', model: 'gpt-6-sol' };
  const grok: TaskChildLlm = { provider: 'grok', model: 'grok-4.6' };
  const luna: TaskChildLlm = { provider: 'openai-codex', model: 'gpt-6-luna' };
  const tier = card.tier ?? '중';
  const pr = typeof card.pr === 'number' ? card.pr : card.pr?.number;
  const mixEven = ((pr ?? [...card.id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)) % 2) === 0;
  let to: TaskChildLlm;
  if (tier === '특') to = sol;
  else if (tier === '상' && availability.codexSubscription && mixEven && !from.includes('gpt-6-sol')) to = sol;
  else if (tier === '상') to = availability.grokSubscription && from.includes('glm') ? grok
    : from.includes('glm-5.3-flash') ? glm
    : from.includes('glm-5.3') ? { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3-flash' } : glm;
  else if (tier === '하') to = from.includes('glm-5.3-flash') ? luna : from.includes('glm-5.3')
    ? { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3-flash' } : glm;
  else to = from.includes('glm-5.3-flash') ? glm : from.includes('glm-5.3')
    ? { provider: 'openrouter', model: 'openrouter/z-ai/glm-5.3-flash' } : glm;
  return { from, to };
}

export function repairResultPath(statePath: string, card: string, pr: number, head: string, number: number, runId: string): string {
  return join(dirname(statePath), 'repair-results', `${safe(card)}-${pr}-${safe(head.slice(0, 12))}-${number}-${safe(runId)}.json`);
}

/** Spawn the same installed CLI in the same config universe; its hidden worker writes an atomic result file. */
export async function defaultRequestRepair(input: RepairLaunchRequest): Promise<void> {
  const { spawnDetachedConfirmed, ELANOUS_CLI_ENTRY } = await import('../cli/tasks-cli.js');
  const { getElanousConfigDirOverride } = await import('../elanous-config-dir.js');
  const { effectiveInstanceRoot } = await import('../instance/resolve.js');
  const configDir = getElanousConfigDirOverride() ?? effectiveInstanceRoot();
  const args = [ELANOUS_CLI_ENTRY, '--config-dir', configDir, 'tasks', 'repair-run',
    '--card', input.card, '--pr', String(input.pr), '--head', input.head, '--repo', input.repo,
    '--out', input.resultPath, '--goal-file', input.goalFile, '--run-id', input.runId,
    '--model-provider', input.model.provider, '--model-id', input.model.model,
    ...(input.seat ? ['--seat', input.seat] : [])];
  await spawnDetachedConfirmed(spawn as never, process.execPath, args, undefined, input.repo);
}

function defaultNotify(seat: string, body: string): void {
  const result = spawnElanousSync(['msg', 'post', '--from', 'TA', '--to', seat, '--kind', 'incident', '--body', body],
    { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) throw new Error(`owner message failed: ${String(result.stderr || result.stdout).slice(-200)}`);
}

export async function runRepairCycle(input: RepairCycleInput): Promise<RepairCycleOutcome> {
  const { card, statePath, pr, head, branch, repo, now } = input;
  const read = input.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const boundPr = card.repairs?.[0]?.pr ?? (typeof card.pr === 'number' ? card.pr : card.pr?.number);
  if (boundPr !== undefined && boundPr !== pr) {
    const reason = `repair source PR changed: card ${card.id} bound to #${boundPr}, received #${pr}; launch refused`;
    updateTaskCard(statePath, card.id, (current) => current && current.status === 'launched'
      ? { ...current, status: 'failed', history: [...(current.history ?? []), { at: now.toISOString(), event: 'repair-source-pr-changed', pr, head, detail: reason }] } : undefined);
    return { decision: 'repair-stopped', reason };
  }
  const attempts = card.repairs ?? [];
  const latest = attempts.at(-1);
  if (latest?.status === 'unconfirmed') {
    if (!latest.commit || !latest.bundleSha256 || !latest.bundlePath)
      return { decision: 'repair-pending', reason: `repair run ${latest.runId} confirmation evidence missing; no repush` };
    const applied = (input.apply ?? applyRepairBundle)({ repo, pr, expectedHead: latest.head,
      bundlePath: latest.bundlePath, result: { pr, baseHead: latest.head, runId: latest.runId,
        commit: latest.commit, bundleSha256: latest.bundleSha256 }, confirmationOnly: true, branch: latest.branch });
    if (!applied.ok && applied.unconfirmed) return { decision: 'repair-pending', reason: applied.reason };
    const status = applied.ok ? 'applied' : 'failed';
    try {
      updateTaskCard(statePath, card.id, (current) => current?.repairs?.some((entry) => entry.runId === latest.runId && entry.status === 'unconfirmed' && entry.commit === latest.commit)
        ? { ...current, repairs: current.repairs.map((entry) => entry.runId === latest.runId
          ? { ...entry, status, detail: applied.ok ? `same PR #${pr} fast-forward ${latest.head.slice(0, 12)} → ${applied.toHead.slice(0, 12)}` : applied.reason } : entry),
          history: [...(current.history ?? []), { at: now.toISOString(), event: 'repair-result', pr, head: latest.head,
            runId: latest.runId, effect: status, detail: applied.ok ? applied.toHead : applied.reason }] } : undefined);
    } catch (error) { return { decision: 'repair-pending', reason: `repair confirmation card write failed: ${String(error).slice(-200)}` }; }
    const recorded = readTaskCard(card.id, statePath)?.repairs?.find((entry) => entry.runId === latest.runId)?.status === status;
    // This confirms a result already claimed by another tick; it did not consume the worker result.
    return recorded ? { decision: applied.ok ? 'repair-applied' : 'repair-failed', reason: applied.ok ? `same PR #${pr} fast-forward ${latest.head.slice(0, 12)} → ${applied.toHead.slice(0, 12)}` : applied.reason }
      : { decision: 'repair-pending', reason: 'repair confirmation card changed concurrently' };
  }
  if (latest?.status === 'requested') {
    let text: string | null = null;
    try { text = read(latest.resultPath); } catch { /* worker still running */ }
    const result = text === null ? null : parseRepairWorkerResult(text, pr, latest.head, latest.runId);
    if (!result && now.getTime() - Date.parse(latest.at) < WAIT_MS)
      return { decision: 'repair-pending', reason: `repair run ${latest.runId} pending` };
    let detail = result?.reason ?? 'repair worker produced no valid result before timeout';
    let applied: RepairCasOutcome | null = null;
    let claimedThisCycle = false;
    if (result?.ok && result.artifactDir && result.result) {
      const expectedRoot = resolve(dirname(statePath), 'pod-artifacts');
      const artifactDir = resolve(result.artifactDir);
      const inside = artifactDir === join(expectedRoot, result.job ?? '', 'repair') && artifactDir.startsWith(`${expectedRoot}${sep}`);
      let artifact: unknown = null;
      if (inside) try { artifact = JSON.parse(read(join(artifactDir, 'result.json'))); } catch { /* unreadable */ }
      const a = artifact && typeof artifact === 'object' && !Array.isArray(artifact) ? artifact as Record<string, unknown> : null;
      if (!inside) detail = 'repair artifact outside the HQ instance root';
      else if (!a || a.runId !== latest.runId || a.runId !== result.result.runId || a.pr !== result.result.pr || a.baseHead !== result.result.baseHead
        || a.commit !== result.result.commit || a.bundleSha256 !== result.result.bundleSha256) detail = 'repair result artifact differs from stdout marker';
      else {
        const bundlePath = join(artifactDir, 'commit.bundle');
        let pushClaimed = false;
        applied = (input.apply ?? applyRepairBundle)({ repo, pr, expectedHead: latest.head,
          bundlePath, result: result.result, branch: latest.branch,
          claimBeforePush: () => {
            let claimed = false;
            updateTaskCard(statePath, card.id, (current) => current?.repairs?.some((entry) => entry.runId === latest.runId && entry.status === 'requested')
              ? (claimed = true, { ...current, repairs: current.repairs.map((entry) => entry.runId === latest.runId
                ? { ...entry, status: 'unconfirmed' as const, commit: result.result!.commit,
                  bundleSha256: result.result!.bundleSha256, bundlePath, detail: 'verified repair push intent recorded' } : entry) }) : undefined);
            pushClaimed = claimed;
            return claimed;
          } });
        detail = applied.ok ? `same PR #${pr} fast-forward ${latest.head.slice(0, 12)} → ${applied.toHead.slice(0, 12)}` : applied.reason;
        if (!applied.ok && applied.reason.startsWith('repair push intent claim'))
          return { decision: 'repair-pending', reason: detail };
        if (!pushClaimed && readTaskCard(card.id, statePath)?.repairs?.some((entry) => entry.runId === latest.runId && entry.status === 'unconfirmed'))
          return { decision: 'repair-pending', reason: `repair run ${latest.runId} already has another collector's push intent` };
        claimedThisCycle = pushClaimed;
      }
    }
    const status = applied?.ok ? 'applied' : applied?.unconfirmed ? 'unconfirmed' : 'failed';
    try {
      updateTaskCard(statePath, card.id, (current) => current?.repairs?.some((entry) => entry.runId === latest.runId
        && (entry.status === 'requested' || (claimedThisCycle && entry.status === 'unconfirmed' && entry.commit === result?.result?.commit)))
        ? { ...current, repairs: current.repairs.map((entry) => entry.runId === latest.runId
          ? { ...entry, status, detail, ...(result?.result && status === 'unconfirmed' ? { commit: result.result.commit,
            bundleSha256: result.result.bundleSha256, bundlePath: join(resolve(result.artifactDir!), 'commit.bundle') } : {}),
            ...(applied?.ok ? { commit: applied.toHead } : {}) } : entry),
          history: [...(current.history ?? []), { at: now.toISOString(), event: 'repair-result', pr, head: latest.head,
            runId: latest.runId, effect: status, detail }] } : undefined);
    } catch (error) { return { decision: 'repair-pending', reason: `repair card write failed after CAS: ${String(error).slice(-200)}` }; }
    const recorded = readTaskCard(card.id, statePath)?.repairs?.find((entry) => entry.runId === latest.runId)?.status === status;
    return recorded ? { decision: applied?.ok ? 'repair-applied' : applied?.unconfirmed ? 'repair-pending' : 'repair-failed', reason: detail,
      repairRunId: latest.runId, repairHead: latest.head }
      : { decision: 'repair-pending', reason: 'repair result card changed concurrently' };
  }
  if (latest?.status === 'applied' && latest.head.toLowerCase() === head.toLowerCase())
    return { decision: 'repair-pending', reason: `repair pushed; await PR head ${latest.commit?.slice(0, 12) ?? '?'}` };
  const judged = repairNextMove({ pr, head, branch, mustFix: input.mustFix,
    priorNarrowAttempts: attempts.filter((entry) => entry.move === 'narrow-relaunch' || entry.move === 'salvage-relaunch').length,
    priorAlternativeAttempts: attempts.filter((entry) => entry.move === 'alternative').length });
  if (judged.kind === 'stop') {
    if (attempts.length >= 2) {
      const detail = `수리 수렴 실패: PR #${pr} head ${head.slice(0, 12)} · ${attempts.length}회 재발사 · ${judged.reason}`;
      updateTaskCard(statePath, card.id, (current) => {
        if (!current || current.status !== 'launched' || (current.repairs ?? []).filter((entry) => entry.pr === pr).length < 2) return undefined;
        return { ...current, status: 'failed', history: [...(current.history ?? []),
          { at: now.toISOString(), event: 'repair-convergence-failed', pr, head, detail }] };
      });
      const current = readTaskCard(card.id, statePath);
      const exhausted = current?.history?.some((entry) => entry.event === 'repair-convergence-failed' && entry.pr === pr);
      const notified = current?.history?.some((entry) => entry.event === 'repair-owner-notified' && entry.pr === pr);
      if (exhausted && !notified && current) {
        const owner = (input.resolveOwner ?? resolveRepairOwner)(current);
        if (!owner.seat) {
          const reason = `repair exhaustion owner unresolved: ${owner.reason ?? 'owner unresolved'}; notification refused`;
          updateTaskCard(statePath, card.id, (latestCard) => latestCard && !latestCard.history?.some((entry) => entry.event === 'repair-owner-missing' && entry.pr === pr)
            ? { ...latestCard, history: [...(latestCard.history ?? []), { at: now.toISOString(), event: 'repair-owner-missing', pr, head, detail: reason }] } : undefined);
          return { decision: 'repair-stopped', reason };
        }
        try {
          (input.notify ?? defaultNotify)(owner.seat, `${detail} · card ${card.id} · owner ${owner.seat} via ${owner.source}`);
          updateTaskCard(statePath, card.id, (latestCard) => latestCard && !latestCard.history?.some((entry) => entry.event === 'repair-owner-notified' && entry.pr === pr)
            ? { ...latestCard, history: [...(latestCard.history ?? []), { at: now.toISOString(), event: 'repair-owner-notified', pr, head, detail }] } : undefined);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          updateTaskCard(statePath, card.id, (latestCard) => latestCard
            ? { ...latestCard, history: [...(latestCard.history ?? []), { at: now.toISOString(), event: 'repair-owner-notify-failed', pr, head, detail: reason }] } : undefined);
        }
      }
    }
    return { decision: 'repair-stopped', reason: judged.reason };
  }
  if (!input.liveMoves.has(judged.judgement.move)) return { decision: 'would-repair', reason: `${judged.judgement.move} via graph next-move → dispatch (shadow)` };
  const owner = (input.resolveOwner ?? resolveRepairOwner)(card);
  if (!owner.seat) {
    const reason = `repair owner seat missing: card ${card.id}; ${owner.reason ?? 'owner unresolved'}; launch refused`;
    updateTaskCard(statePath, card.id, (current) => current && current.status === 'launched'
      ? { ...current, status: 'failed', history: [...(current.history ?? []), { at: now.toISOString(), event: 'repair-owner-missing', pr, head, detail: reason }] } : undefined);
    return { decision: 'repair-stopped', reason };
  }
  if (input.repairBudget && input.repairBudget.requested >= input.repairBudget.max) {
    input.repairBudget.capped++;
    const reason = `repairMaxPerTick 상한 ${input.repairBudget.max} · 다음 틱에 재판정`;
    try { debug.log('task-agent', 'repair-tick-cap', { card: card.id, pr, head, max: input.repairBudget.max,
      requested: input.repairBudget.requested, capped: input.repairBudget.capped, move: judged.judgement.move }); } catch { /* fail-soft */ }
    return { decision: 'would-repair', reason };
  }
  const next = attempts.length + 1;
  const runId = mintRunId();
  const availability = input.modelAvailability ?? (card.tier === '특' || card.tier === '중' || card.tier === '하'
    ? { codexSubscription: false, grokSubscription: false } : await repairModelAvailability(input.readBudgetInputs));
  const { from, to } = alternateRepairModel(card, availability);
  const resultPath = repairResultPath(statePath, card.id, pr, head, next, runId);
  const goalFile = resultPath.replace(/\.json$/, '.goal.txt');
  const goal = `기존 PR #${pr}의 리뷰 때 head ${head}를 같은 가지에서 수리한다. 새 PR을 열지 말고 아래 must-fix 원문만 고쳐 commit-only 결과를 반환한다.\n\n${input.mustFix.map((item, i) => `${i + 1}. ${item}`).join('\n')}`;
  mkdirSync(dirname(goalFile), { recursive: true });
  writeFileSync(goalFile, goal);
  let claimed = false;
  updateTaskCard(statePath, card.id, (current) => {
    if (!current || current.status !== 'launched' || (current.repairs ?? []).length !== (card.repairs ?? []).length) return undefined;
    claimed = true;
    return { ...current, repairs: [...(current.repairs ?? []), { pr, head, branch, at: now.toISOString(),
      move: judged.judgement.move, runId, resultPath, fromModel: from, toModel: `${to.provider}/${to.model}`, status: 'requested' }],
      history: [...(current.history ?? []), { at: now.toISOString(), event: 'repair-launched', pr, head, runId,
        effect: judged.judgement.move, detail: `source pr:${pr} · owner ${owner.seat} via ${owner.source} · must-fix ${input.mustFix.length} · childLlm ${from} → ${to.provider}/${to.model}` }] };
  });
  if (!claimed) return { decision: 'repair-pending', reason: 'another tick claimed repair launch' };
  try {
    await (input.request ?? defaultRequestRepair)({ card: card.id, pr, head, repo, resultPath, goalFile,
      runId, model: to, seat: owner.seat });
    if (input.repairBudget) input.repairBudget.requested++;
  } catch (error) {
    const reason = `repair launch failed: ${error instanceof Error ? error.message : String(error)}`;
    updateTaskCard(statePath, card.id, (current) => current?.repairs?.some((entry) => entry.runId === runId && entry.status === 'requested')
      ? { ...current, repairs: current.repairs.map((entry) => entry.runId === runId ? { ...entry, status: 'failed' as const, detail: reason } : entry) } : undefined);
    return { decision: 'repair-failed', reason };
  }
  // The request may throw before a worker exists. A post-launch observation
  // failure must not turn an accepted worker into a failed launch.
  try {
    updateTaskCard(statePath, card.id, (current) => current?.repairs?.some((entry) => entry.runId === runId)
      && !current.history.some((entry) => entry.event === 'harness.role-llm' && entry.runId === runId)
      ? { ...current, history: [...current.history, { at: now.toISOString(), event: 'harness.role-llm', pr, head, runId,
        detail: `repair child model ${to.provider}/${to.model}` }] } : undefined);
  } catch (error) {
    try { debug.log('task-agent', 'repair-role-llm-observation-failed', { card: card.id, pr, head, runId, error: String(error) }); } catch { /* fail-soft */ }
  }
  try {
    if (input.observeLaunch) input.observeLaunch(judged.judgement.move, runId);
    else {
      passJourneyNode('next-move', { provenance: 'task-agent-repair', outcome: judged.judgement.move, runId,
        data: { card: card.id, source: `pr:${pr}`, pr, head, branch, mustFix: input.mustFix } });
      recordJourneyEdge(judged.route, 'dispatch');
    }
  } catch (error) {
    const detail = `repair observation failed after worker launch: ${error instanceof Error ? error.message : String(error)}`;
    try { updateTaskCard(statePath, card.id, (current) => current
      ? { ...current, history: [...(current.history ?? []), { at: now.toISOString(), event: 'repair-observation-failed', pr, head, runId, detail }] } : undefined); }
    catch { /* launch remains requested even if its diagnostic cannot be persisted */ }
    return { decision: 'repair-requested', reason: `${judged.judgement.move} → dispatch · run ${runId} · ${detail}` };
  }
  return { decision: 'repair-requested', reason: `${judged.judgement.move} → dispatch · run ${runId} · ${from} → ${to.provider}/${to.model}` };
}
