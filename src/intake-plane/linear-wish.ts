import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { defaultArtifactBaseDir } from '../artifact/paths.js';
import { createArtifactStore } from '../artifact/store.js';
import { commentLinearIssue, createLinearAttachment, createLinearIssue, fetchLinearIssueDescription, fetchLinearIssueStateType, fetchLinearIssueUpdatedAt, fetchLinearIssues, moveLinearIssueToStateType, updateLinearIssueDescription, uploadLinearFile } from '../connectors/linear.js';
import { EventLedger } from '../connectors/event-ledger.js';
import { debug } from '../debug/log.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { CardStore } from '../task-cards/card-store.js';
import { createWishCard } from './wish-card.js';
import type { TaskCaptureArtifact } from '../task-orchestrator/types.js';

export const LINEAR_WISH_KEY_MISSING = 'Linear 키가 없습니다 — elanous connector linear 로 먼저 등록하세요';

type LinearWishDeps = {
  getApiKey?: () => Promise<string | undefined>;
  fetchIssues?: typeof fetchLinearIssues;
};

async function readLinearWishes(teamKey: string, options: { labelOrPrefix?: string; excludeLabel?: string }, deps: LinearWishDeps) {
  const apiKey = await (deps.getApiKey ?? (() => getSecretAsync('connector.linear.apiKey')))();
  if (!apiKey?.trim()) throw new Error(LINEAR_WISH_KEY_MISSING);
  try {
    return await (deps.fetchIssues ?? fetchLinearIssues)({ apiKey, teamKey, ...options });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll(apiKey, '[redacted]'));
  }
}

export interface LinearWishSuggestion { identifier: string; title: string; reason: string }

export interface LinearSecretaryTask {
  title: string;
  intent: string;
  refs: string[];
  assigneeId: string;
  dueDate: string;
  captureUrl?: string;
}

export interface LinearSecretaryPlan {
  title: string;
  rationale: string;
  assigneeId: string;
  dueDate: string;
  tasks: LinearSecretaryTask[];
}

export interface LinearSecretaryResult {
  parentIssueId: string;
  childIssueIds: string[];
  replyCard: string;
}

export interface LinearSecretaryProgressTask { issueId: string; title: string }

export interface LinearSecretaryCaptureInput extends TaskCaptureArtifact {}
export interface ApprovedLinearCapture { filename: string; mimeType: string; body: Buffer }

const LINEAR_CAPTURE_MAX_BYTES = 10 * 1024 * 1024;
const LINEAR_CAPTURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CAPTURE_MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/webp': ['.webp'], 'image/gif': ['.gif'],
};

/** Fail closed unless this is a fresh, explicitly approved, public browser capture for the current run. */
export function readApprovedLinearCapture({ path: artifactPath, mimeType, runId, linearIssueId, externalShare, sensitivity, createdAt,
  baseDir = defaultArtifactBaseDir(), now = Date.now() }: LinearSecretaryCaptureInput & { baseDir?: string; now?: number }): ApprovedLinearCapture {
  if (externalShare !== true || sensitivity !== 'public' || !linearIssueId.trim() || !Number.isFinite(createdAt)) {
    throw new Error('Linear capture does not have explicit public sharing approval');
  }
  const allowedExtensions = CAPTURE_MIME_EXTENSIONS[mimeType];
  if (!allowedExtensions || !runId.trim()) throw new Error('Linear capture is not an approved image artifact');
  const captureDir = realpathSync(path.resolve(baseDir, 'capture'));
  const resolvedArtifactPath = realpathSync(artifactPath);
  if (!resolvedArtifactPath.startsWith(`${captureDir}${path.sep}`)) throw new Error('Linear capture must be stored under the artifact capture directory');
  const filename = path.basename(resolvedArtifactPath);
  if (!allowedExtensions.includes(path.extname(filename).toLowerCase())) throw new Error('Linear capture MIME type does not match its file extension');
  const size = statSync(resolvedArtifactPath).size;
  if (size <= 0 || size > LINEAR_CAPTURE_MAX_BYTES) throw new Error('Linear capture size is outside the allowed range');
  const artifact = createArtifactStore({ baseDir }).get(resolvedArtifactPath);
  const { meta } = artifact;
  if (meta.kind !== 'capture' || meta.producer !== 'browser-runtime' || meta.extra?.runId !== runId ||
      meta.extra?.sharePolicy !== 'linear-approved' || meta.extra?.sensitivity !== 'public' ||
      meta.extra?.externalShare !== true || meta.extra?.linearIssueId !== linearIssueId ||
      meta.createdAt !== createdAt) {
    throw new Error('Linear capture sharing metadata is not approved');
  }
  if (!Number.isFinite(now) || !Number.isFinite(meta.createdAt) || meta.createdAt > now || now - meta.createdAt > LINEAR_CAPTURE_MAX_AGE_MS) {
    throw new Error('Linear capture is outside the seven-day sharing window');
  }
  if (!Buffer.isBuffer(artifact.body)) throw new Error('Linear capture artifact is not binary');
  const body = artifact.body;
  const signatureMatches = mimeType === 'image/png' ? body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === 'image/jpeg' ? body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
      : mimeType === 'image/gif' ? body.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/) !== null
        : body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!signatureMatches) throw new Error('Linear capture bytes do not match the declared image MIME type');
  return { filename, mimeType, body };
}

const CHECKLIST_START = '<!-- elanous-linear-secretary-checklist:start -->';
const CHECKLIST_END = '<!-- elanous-linear-secretary-checklist:end -->';
const MANIFEST_START = '<!-- elanous-linear-secretary-manifest:start -->';
const MANIFEST_END = '<!-- elanous-linear-secretary-manifest:end -->';

export interface LinearSecretaryManifest { parentIssueId: string; tasks: LinearSecretaryProgressTask[] }

export function parseLinearSecretaryManifest(description: string, currentIssueId: string): LinearSecretaryManifest | undefined {
  const start = description.indexOf(MANIFEST_START);
  const end = description.indexOf(MANIFEST_END);
  if (start < 0 || end <= start) return undefined;
  try {
    const manifest = JSON.parse(description.slice(start + MANIFEST_START.length, end).trim()) as Partial<LinearSecretaryManifest>;
    if (typeof manifest.parentIssueId !== 'string' || !manifest.parentIssueId.trim() || !Array.isArray(manifest.tasks) ||
        !manifest.tasks.length || !manifest.tasks.every(task => task && typeof task.issueId === 'string' && task.issueId.trim() && typeof task.title === 'string' && task.title.trim()) ||
        !manifest.tasks.some(task => task.issueId === currentIssueId)) return undefined;
    return { parentIssueId: manifest.parentIssueId, tasks: manifest.tasks };
  } catch { return undefined; }
}

type LinearSecretaryDeps = {
  createIssue?: typeof createLinearIssue;
  updateDescription?: typeof updateLinearIssueDescription;
};

type LinearSecretaryProgressDeps = {
  readCapture?: typeof readApprovedLinearCapture;
  uploadFile?: typeof uploadLinearFile;
  createAttachment?: typeof createLinearAttachment;
};

/** Create a grounded parent/child issue tree after a planner has supplied concrete evidence and ownership. */
export async function createLinearSecretaryBreakdown({ apiKey, projectId, teamKey, request, plan, deps = {}, fetch: fetchFn = fetch }: {
  apiKey: string;
  projectId?: string;
  teamKey?: string;
  request: string;
  plan: LinearSecretaryPlan;
  deps?: LinearSecretaryDeps;
  fetch?: typeof fetch;
}): Promise<LinearSecretaryResult> {
  if (!apiKey.trim() || (!projectId?.trim() && !teamKey?.trim())) throw new Error('Linear API key and project or team are required');
  if (!request.trim() || !plan.title.trim() || !plan.rationale.trim()) throw new Error('Linear secretary request, title and rationale are required');
  if (!plan.assigneeId.trim()) throw new Error('Linear secretary parent needs an assignee');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.dueDate) || new Date(`${plan.dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== plan.dueDate) {
    throw new Error('Linear secretary parent needs a valid YYYY-MM-DD due date');
  }
  if (plan.tasks.length < 3 || plan.tasks.length > 5) throw new Error('Linear secretary requires 3 to 5 subtasks');
  for (const [index, task] of plan.tasks.entries()) {
    if (!task.title.trim() || !task.intent.trim()) throw new Error(`Linear secretary subtask ${index + 1} needs a title and intent`);
    if (!task.assigneeId.trim()) throw new Error(`Linear secretary subtask ${index + 1} needs an assignee`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) || new Date(`${task.dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== task.dueDate) {
      throw new Error(`Linear secretary subtask ${index + 1} needs a YYYY-MM-DD due date`);
    }
    if (!task.refs.length || task.refs.some(ref => !ref.trim())) throw new Error(`Linear secretary subtask ${index + 1} needs evidence links`);
  }
  const createIssue = deps.createIssue ?? createLinearIssue;
  const refs = [...new Set(plan.tasks.flatMap(task => task.refs))];
  const parentIssueId = await createIssue({ apiKey, ...(projectId ? { projectId } : { teamKey }), title: plan.title, assigneeId: plan.assigneeId, dueDate: plan.dueDate, stateType: 'started', fetch: fetchFn,
    description: buildLinearSecretaryParentDescription({ request, rationale: plan.rationale, refs, tasks: plan.tasks }) });
  const childIssueIds: string[] = [];
  const childDescriptions: string[] = [];
  for (const task of plan.tasks) {
    const description = [`의도: ${task.intent.trim()}`, '근거:', ...task.refs.map(ref => `- ${ref}`)].join('\n');
    const issueId = await createIssue({ apiKey, ...(projectId ? { projectId } : { teamKey }), parentId: parentIssueId, title: task.title,
      description,
      assigneeId: task.assigneeId, dueDate: task.dueDate, fetch: fetchFn });
    childIssueIds.push(issueId);
    childDescriptions.push(description);
    if (task.captureUrl) await createLinearAttachment({ apiKey, issueId, title: '진행 캡처', url: task.captureUrl, fetch: fetchFn });
  }
  const manifest: LinearSecretaryManifest = { parentIssueId, tasks: plan.tasks.map((task, index) => ({ issueId: childIssueIds[index]!, title: task.title.trim() })) };
  const manifestBlock = [MANIFEST_START, JSON.stringify(manifest), MANIFEST_END].join('\n');
  for (const [index, issueId] of childIssueIds.entries()) {
    await (deps.updateDescription ?? updateLinearIssueDescription)({ apiKey, issueId, description: `${childDescriptions[index]!.trimEnd()}\n\n${manifestBlock}`, fetch: fetchFn });
  }
  return {
    parentIssueId,
    childIssueIds,
    replyCard: [`등록: 부모 1개 · 하위 ${childIssueIds.length}개`, `분해 이유: ${plan.rationale.trim()}`, `다음: ${plan.tasks[0]!.title}`].join('\n'),
  };
}

export function buildLinearSecretaryParentDescription({ request, rationale, refs, tasks, completedIssueIds = [] }: {
  request: string; rationale: string; refs: readonly string[]; tasks: readonly LinearSecretaryTask[]; completedIssueIds?: readonly string[];
}): string {
  const completed = new Set(completedIssueIds);
  return [
    `요청: ${request.trim()}`,
    `분해 이유: ${rationale.trim()}`,
    CHECKLIST_START,
    ...tasks.map((task, index) => `- [${completed.has(String(index)) ? 'x' : ' '}] ${task.title.trim()}`),
    CHECKLIST_END,
    '근거:',
    ...refs.map(ref => `- ${ref}`),
  ].join('\n');
}

/** Record one ordered subtask transition, comment and parent checklist update. */
export async function updateLinearSecretaryProgress({ apiKey, parentIssueId, taskIssueId, taskTitle, tasks, completedIssueIds, state, summary, workaround, captureUrl, captureArtifact, ledger, deps = {}, fetch: fetchFn = fetch }: {
  apiKey: string; parentIssueId: string; taskIssueId: string; taskTitle: string; tasks: readonly LinearSecretaryProgressTask[];
  completedIssueIds?: readonly string[]; state: 'started' | 'completed' | 'comment'; summary: string; workaround?: string; captureUrl?: string;
  captureArtifact?: LinearSecretaryCaptureInput; ledger?: EventLedger; deps?: LinearSecretaryProgressDeps; fetch?: typeof fetch;
}): Promise<void> {
  if (!summary.trim()) throw new Error('Linear secretary progress summary is required');
  const task = tasks.find(item => item.issueId === taskIssueId);
  if (!task || task.title !== taskTitle) throw new Error('Linear secretary progress task is not part of the parent checklist');
  if (captureUrl && captureArtifact) throw new Error('Linear progress accepts one capture source per update');
  if (captureArtifact && captureArtifact.linearIssueId !== parentIssueId) {
    throw new Error('Linear capture is not approved for this secretary parent issue');
  }
  const approvedCapture = captureArtifact ? (deps.readCapture ?? readApprovedLinearCapture)(captureArtifact) : undefined;
  const currentState = await fetchLinearIssueStateType({ apiKey, issueId: taskIssueId, fetch: fetchFn });
  // Team-only Linear issues may start in backlog even when the team also has an unstarted state.
  if (state === 'started' && currentState !== 'unstarted' && currentState !== 'backlog' && currentState !== 'started') throw new Error(`Linear secretary cannot move ${currentState} to started`);
  if (state === 'completed' && currentState !== 'started' && currentState !== 'completed') throw new Error(`Linear secretary cannot move ${currentState} to completed`);
  const captureAssetUrl = approvedCapture ? await (deps.uploadFile ?? uploadLinearFile)({ apiKey, filename: approvedCapture.filename,
    contentType: approvedCapture.mimeType, body: approvedCapture.body, fetch: fetchFn }) : undefined;
  const progressCaptureUrl = captureAssetUrl ?? captureUrl;
  if ((state === 'started' && (currentState === 'unstarted' || currentState === 'backlog')) || (state === 'completed' && currentState === 'started')) {
    await moveLinearIssueToStateType({ apiKey, issueId: taskIssueId, type: state === 'started' ? 'started' : 'completed', fetch: fetchFn });
  }
  await commentLinearIssue({ apiKey, issueId: taskIssueId,
    body: [`요약: ${summary.trim()}`, `우회: ${workaround?.trim() || '없음'}`, ...(progressCaptureUrl ? [`캡처: ${progressCaptureUrl}`] : [])].join('\n'), fetch: fetchFn });
  if (progressCaptureUrl) await (deps.createAttachment ?? createLinearAttachment)({ apiKey, issueId: parentIssueId, title: '진행 캡처', url: progressCaptureUrl, fetch: fetchFn });
  const parentDescription = await fetchLinearIssueDescription({ apiKey, issueId: parentIssueId, fetch: fetchFn });
  const start = parentDescription.indexOf(CHECKLIST_START);
  const end = parentDescription.indexOf(CHECKLIST_END);
  if (start < 0 || end < start) throw new Error('Linear secretary parent checklist is missing');
  const currentCompleted = completedIssueIds === undefined
    ? (await Promise.all(tasks.map(async item =>
      await fetchLinearIssueStateType({ apiKey, issueId: item.issueId, fetch: fetchFn }) === 'completed' ? item.issueId : undefined,
    ))).filter((id): id is string => id !== undefined)
    : state === 'completed' ? [...new Set([...completedIssueIds, taskIssueId])]
      : state === 'started' ? completedIssueIds.filter(id => id !== taskIssueId) : [...completedIssueIds];
  const completed = new Set(currentCompleted);
  const checklist = [CHECKLIST_START, ...tasks.map(task => `- [${completed.has(task.issueId) ? 'x' : ' '}] ${task.title}`), CHECKLIST_END].join('\n');
  const updatedDescription = `${parentDescription.slice(0, start)}${checklist}${parentDescription.slice(end + CHECKLIST_END.length)}`;
  await updateLinearIssueDescription({ apiKey, issueId: parentIssueId, description: updatedDescription, fetch: fetchFn });
  if (state !== 'comment' && completed.size === tasks.length) {
    await moveLinearIssueToStateType({ apiKey, issueId: parentIssueId, type: 'completed', fetch: fetchFn });
  }
  if (ledger) {
    for (const issueId of new Set([taskIssueId, parentIssueId])) {
      const updatedAt = await fetchLinearIssueUpdatedAt({ apiKey, issueId, fetch: fetchFn });
      ledger.record('linear', `outgoing:secretary:${issueId}:${updatedAt}`, { ref: issueId, occurredAt: updatedAt });
    }
  }
}

const WISH_PHRASES = [
  { pattern: /해\s*줘(?:요|라)?/, reason: '요청' },
  { pattern: /만들어(?:\s*줘(?:요)?)?/, reason: '제작' },
  { pattern: /원해(?:요)?/, reason: '희망' },
  { pattern: /있으면\s*좋겠다/, reason: '희망' },
];

export async function suggestLinearWishes({ teamKey, deps = {} }: {
  teamKey: string;
  deps?: LinearWishDeps;
}): Promise<LinearWishSuggestion[]> {
  const issues = await readLinearWishes(teamKey, { excludeLabel: 'wish' }, deps);
  return issues.flatMap(issue => {
    const match = WISH_PHRASES.find(({ pattern }) => pattern.test(`${issue.title}\n${issue.body}`));
    return match && issue.identifier
      ? [{ identifier: issue.identifier, title: Array.from(issue.title).slice(0, 40).join(''), reason: match.reason }]
      : [];
  });
}

export async function scanLinearWishes({ teamKey, label = 'wish', store, deps = {} }: {
  teamKey: string;
  label?: string;
  store: CardStore;
  deps?: LinearWishDeps;
}): Promise<{ added: number; duplicate: number; failed: number }> {
  const issues = await readLinearWishes(teamKey, { labelOrPrefix: label }, deps);
  let added = 0;
  let duplicate = 0;
  let failed = 0;
  for (const issue of issues) {
    try {
      const result = createWishCard({
        text: `${issue.title}\n\n${issue.body}\n\n${issue.url}`,
        source: 'linear', ref: issue.identifier ?? '',
        replyTo: { surface: 'linear', issueId: issue.ref },
      }, store);
      if (result.created) added++;
      else duplicate++;
    } catch {
      failed++;
    }
  }
  debug.log('intake.linear-wish', 'scanned', { teamKey, label, added, duplicate, failed });
  return { added, duplicate, failed };
}
