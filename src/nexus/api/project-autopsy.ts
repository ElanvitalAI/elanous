import { jsonResponse } from './json-response.js';
import { readReleaseRuns, type ReleaseRunView } from './ops-api.js';
import { listPendingApprovals, type PendingApprovalSummary } from './workflow-approvals.js';
import { getProject, type Project } from '../../project/project-store.js';
import { classifyMergeFailure, type MergeFailureKind } from '../../self-implement/regate-detail.js';

/** One failed node of a release run explicitly assigned to the project. */
export interface ProjectAutopsyFailure {
  runId: string;
  nodeId: string;
  summary: string;
  kind: MergeFailureKind;
  status: string;
  startedAt?: string;
  endedAt?: string;
  verdict?: string;
}

/** Failure-kind rollup across the project's failed rows (desc by count, kind asc). */
export interface ProjectAutopsyCause {
  kind: MergeFailureKind;
  count: number;
  runs: string[];
}

/** A project's autopsy: failed rows + causes + pending proposals, read-only over the existing ledgers. */
export interface ProjectAutopsyReport {
  project: { id: string; name: string; primaryFolder?: string };
  attribution: { status: 'measured' | 'partial' | 'unavailable'; reason?: 'ledger-project-id-missing' };
  coverage: { failuresTruncated: boolean; proposalsTruncated: boolean; causeCounts: 'returned-failures' };
  failures: ProjectAutopsyFailure[];
  causes: ProjectAutopsyCause[];
  proposals: PendingApprovalSummary[];
  pendingApprovals: number;
}

export interface ProjectAutopsyDeps {
  getProject?: (id: string) => Project | null;
  readRuns?: (version: string | null) => ReleaseRunView[] | 'unavailable';
  listApprovals?: () => PendingApprovalSummary[];
}

const FAILURE_LIMIT = 50;
const PROPOSAL_LIMIT = 20;
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const defaultReadRuns = (version: string | null): ReleaseRunView[] | 'unavailable' =>
  readReleaseRuns(version, undefined, { facts: true });

function projectViewOf(project: Project): ProjectAutopsyReport['project'] {
  return {
    id: project.id,
    name: project.name,
    ...(project.primaryFolder !== undefined ? { primaryFolder: project.primaryFolder } : {}),
  };
}

/** GET /v1/projects/:id/autopsy — 실패·원인·제안 rows for one project, fail-soft per the ops-route pattern. */
export function handleProjectAutopsy(req: Request, rawId: string, deps: ProjectAutopsyDeps = {}): Response {
  if (req.method !== 'GET') return jsonResponse({ error: 'method-not-allowed' }, 405);
  let projectId: string;
  try {
    projectId = decodeURIComponent(rawId);
  } catch {
    return jsonResponse({ error: 'bad_request', reason: 'invalid project id' }, 400);
  }
  if (!PROJECT_ID.test(projectId)) return jsonResponse({ error: 'bad_request', reason: 'invalid project id' }, 400);
  const project = (deps.getProject ?? getProject)(projectId);
  if (!project) return jsonResponse({ error: 'not-found' }, 404);
  const pending = deps.listApprovals ? deps.listApprovals() : listPendingApprovals();
  const runs = (deps.readRuns ?? defaultReadRuns)(null);
  if (runs === 'unavailable') return jsonResponse({ error: 'runs-unavailable' }, 500);
  if (!runs.some((run) => Boolean(run.projectId))) {
    return jsonResponse({ project: projectViewOf(project),
      attribution: { status: 'unavailable', reason: 'ledger-project-id-missing' },
      coverage: { failuresTruncated: false, proposalsTruncated: false, causeCounts: 'returned-failures' },
      failures: [], causes: [], proposals: [], pendingApprovals: 0 });
  }
  const unattributed = runs.some((run) => !run.projectId) || pending.some((approval) => !approval.projectId);
  const attributed = runs.some((run) => Boolean(run.projectId)) || pending.some((approval) => Boolean(approval.projectId));
  const attribution: ProjectAutopsyReport['attribution'] = unattributed || !attributed
    ? { status: attributed ? 'partial' : 'unavailable', reason: 'ledger-project-id-missing' }
    : { status: 'measured' };
  const failures: ProjectAutopsyFailure[] = [];
  for (const run of runs) {
    if (run.projectId !== project.id) continue;
    for (const node of run.nodes) {
      if (node.ok !== false) continue;
      failures.push({
        runId: run.runId,
        nodeId: node.nodeId,
        summary: node.summary,
        kind: classifyMergeFailure(node.summary),
        status: run.status,
        ...(node.startedAt !== undefined ? { startedAt: node.startedAt } : {}),
        ...(node.endedAt !== undefined ? { endedAt: node.endedAt } : {}),
        ...(node.facts?.verdict !== undefined ? { verdict: node.facts.verdict } : {}),
      });
      if (failures.length > FAILURE_LIMIT) break;
    }
    if (failures.length > FAILURE_LIMIT) break;
  }
  const failuresTruncated = failures.length > FAILURE_LIMIT;
  if (failuresTruncated) failures.length = FAILURE_LIMIT;
  const counts = new Map<MergeFailureKind, { count: number; runs: Set<string> }>();
  for (const failure of failures) {
    const entry = counts.get(failure.kind) ?? { count: 0, runs: new Set<string>() };
    entry.count += 1;
    entry.runs.add(failure.runId);
    counts.set(failure.kind, entry);
  }
  const causes: ProjectAutopsyCause[] = [...counts.entries()]
    .map(([kind, entry]) => ({ kind, count: entry.count, runs: [...entry.runs].sort() }))
    .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
  const projectApprovals = pending.filter((summary) => summary.projectId === project.id);
  const proposals = projectApprovals.slice(0, PROPOSAL_LIMIT);
  return jsonResponse({
    project: projectViewOf(project),
    attribution,
    coverage: { failuresTruncated, proposalsTruncated: projectApprovals.length > PROPOSAL_LIMIT,
      causeCounts: 'returned-failures' },
    failures,
    causes,
    proposals,
    pendingApprovals: projectApprovals.length,
  });
}
