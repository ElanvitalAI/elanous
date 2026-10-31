import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { debug } from '../debug/log.js';
import { EventLedger } from './event-ledger.js';
import type { ExternalTaskEvent, TaskConnector } from './types.js';

export function verifyLinearWebhook({ rawBody, signature, secret, now = Date.now(), toleranceMs = 60_000 }: {
  rawBody: string | Uint8Array; signature: string; secret: string; now?: number; toleranceMs?: number;
}): { ok: true } | { ok: false; reason: string } {
  const fail = (reason: string): { ok: false; reason: string } => {
    debug.log('connector.linear', 'verify-failed', { traceId: randomUUID(), reason });
    return { ok: false, reason };
  };
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature)) return fail('invalid-signature');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const supplied = Buffer.from(signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return fail('invalid-signature');
  }
  try {
    const body = JSON.parse(Buffer.from(rawBody).toString('utf8')) as { webhookTimestamp?: unknown };
    const timestamp = body.webhookTimestamp;
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || !Number.isFinite(now) || !Number.isFinite(toleranceMs) || toleranceMs < 0 || Math.abs(now - timestamp) > toleranceMs) {
      return fail('timestamp-outside-window');
    }
  } catch {
    return fail('invalid-body');
  }
  return { ok: true };
}

const PRIORITY_RANK: Record<NonNullable<ExternalTaskEvent['priority']> | 'none', number> = { urgent: 0, high: 1, medium: 2, none: 2, low: 3 };

function priorityOf(value: unknown): ExternalTaskEvent['priority'] {
  switch (value) {
    case 1: return 'urgent';
    case 2: return 'high';
    case 3: return 'medium';
    case 4: return 'low';
    default: return null;
  }
}

function asIssue(value: unknown): { id: string; identifier: string; title: string; description?: string | null; url?: string | null; priority: number; updatedAt: string } | null {
  if (!value || typeof value !== 'object') return null;
  const issue = value as Record<string, unknown>;
  if (typeof issue.id !== 'string' || typeof issue.identifier !== 'string' || typeof issue.title !== 'string' || typeof issue.updatedAt !== 'string') return null;
  if (issue.description != null && typeof issue.description !== 'string') return null;
  if (issue.url != null && typeof issue.url !== 'string') return null;
  if (typeof issue.priority !== 'number' || !Number.isInteger(issue.priority) || !Number.isFinite(Date.parse(issue.updatedAt))) return null;
  return issue as ReturnType<typeof asIssue>;
}

export function isLinearProjectionEcho(event: ExternalTaskEvent, ledger: EventLedger): boolean {
  return event.provider === 'linear' && ledger.seenOutgoingChange('linear', event.ref, event.occurredAt);
}

export function parseLinearWebhook(body: unknown, deliveryId: string, ledger?: EventLedger): ExternalTaskEvent | null {
  if (!deliveryId || !body || typeof body !== 'object') return null;
  const payload = body as Record<string, unknown>;
  if (payload.type !== 'Issue' || (payload.action !== 'create' && payload.action !== 'update')) return null;
  const issue = asIssue(payload.data);
  if (!issue) return null;
  const event: ExternalTaskEvent = {
    provider: 'linear', eventId: deliveryId, kind: payload.action === 'create' ? 'created' : 'updated',
    ref: issue.id, identifier: issue.identifier, title: issue.title, body: issue.description ?? '',
    url: issue.url ?? '', priority: priorityOf(issue.priority), occurredAt: issue.updatedAt,
  };
  return isLinearProjectionEcho(event, ledger ?? new EventLedger()) ? null : event;
}

export async function fetchLinearIssues({ apiKey, teamKey, labelOrPrefix, excludeLabel, since, fetch: fetchFn = fetch, ledger }: {
  apiKey: string; teamKey: string; labelOrPrefix?: string; excludeLabel?: string; since?: string; fetch?: typeof fetch; ledger?: EventLedger;
}): Promise<ExternalTaskEvent[]> {
  const query = `query ConnectorIssues($teamKey: String!, $after: String) {
    issues(filter: { team: { key: { eq: $teamKey } } }, first: 100, after: $after) {
      nodes { id identifier title description url priority updatedAt state { type } labels { nodes { name } } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const events: ExternalTaskEvent[] = [];
  const echoLedger = ledger ?? new EventLedger();
  let after: string | null = null;
  const cursors = new Set<string>();
  do {
    let response: Response;
    try {
      response = await fetchFn('https://api.linear.app/graphql', {
        method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { teamKey, after } }),
      });
    } catch {
      throw new Error('Linear GraphQL request failed');
    }
    if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}`);
    let result: {
      errors?: unknown[];
      data?: { issues?: { nodes?: Array<Record<string, unknown>>; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } };
    };
    try {
      result = await response.json() as typeof result;
    } catch {
      throw new Error('Linear GraphQL invalid JSON response');
    }
    if (result.errors?.length || !Array.isArray(result.data?.issues?.nodes)) throw new Error('Linear GraphQL returned errors or missing issues');
    for (const node of result.data.issues.nodes) {
      const issue = asIssue(node);
      if (!issue || (since && issue.updatedAt < since) ||
          ['completed', 'canceled', 'duplicate'].includes((node.state as { type?: string } | undefined)?.type ?? '')) continue;
      const labels = (node.labels as { nodes?: Array<{ name: string }> } | undefined)?.nodes;
      if (excludeLabel && labels?.some(label => label.name.toLowerCase() === excludeLabel.toLowerCase())) continue;
      if (labelOrPrefix && !issue.title.startsWith(labelOrPrefix) &&
          !labels?.some(label => label.name === labelOrPrefix)) continue;
      const event: ExternalTaskEvent = { provider: 'linear', eventId: `${issue.id}:${issue.updatedAt}`, kind: 'updated',
        ref: issue.id, identifier: issue.identifier, title: issue.title, body: issue.description ?? '',
        url: issue.url ?? '', priority: priorityOf(issue.priority), occurredAt: issue.updatedAt };
      if (!isLinearProjectionEcho(event, echoLedger)) events.push(event);
    }
    const page = result.data.issues.pageInfo;
    if (page?.hasNextPage && (!page.endCursor || cursors.has(page.endCursor))) throw new Error('Linear GraphQL pagination cursor missing or repeated');
    after = page?.hasNextPage ? page.endCursor : null;
    if (after) cursors.add(after);
  } while (after);
  // Tasks tie-break on creation order and Urgent maps to high, so an Urgent issue must be created before a High one.
  return events.sort((a, b) => PRIORITY_RANK[a.priority ?? 'none'] - PRIORITY_RANK[b.priority ?? 'none']);
}

export interface LinearProjectIssue {
  identifier: string;
  title: string;
  url: string;
  state: { name: string; type: string };
  dueDate: string | null;
  priority: number;
  assignee: { name: string } | null;
  updatedAt: string;
}

type LinearRequestOptions = { apiKey: string; fetch?: typeof fetch };

async function linearRequest<T>({ apiKey, fetch: fetchFn = fetch }: LinearRequestOptions, query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await fetchFn('https://api.linear.app/graphql', {
        method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw new Error(`Linear GraphQL request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}`);
    let body: { data?: T; errors?: Array<{ message?: string }> };
    try { body = await response.json() as typeof body; }
    catch { throw new Error('Linear GraphQL invalid JSON response'); }
    if (body.errors?.length) throw new Error(`Linear GraphQL: ${body.errors.map(e => e.message ?? 'unknown error').join('; ')}`);
    if (!body.data) throw new Error('Linear GraphQL missing data');
    return body.data;
}

/** Shared unique name → project id lookup for COO reads and decision writes. */
export async function resolveLinearProjectId({ apiKey, project, fetch: fetchFn = fetch }: LinearRequestOptions & { project: string }): Promise<string> {
  const cursors = new Set<string>();
  let projectId = project;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(project)) {
    const matches: string[] = [];
    let after: string | null = null;
    do {
      const data: { projects?: { nodes?: Array<{ id: string; name: string }>; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } } = await linearRequest({ apiKey, fetch: fetchFn },
        `query CooProjects($after: String) { projects(first: 100, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } }`, { after });
      if (!Array.isArray(data.projects?.nodes)) throw new Error('Linear GraphQL missing projects');
      for (const candidate of data.projects.nodes) if (candidate.name === project) matches.push(candidate.id);
      const page = data.projects.pageInfo;
      if (page?.hasNextPage && (!page.endCursor || cursors.has(page.endCursor))) throw new Error('Linear GraphQL pagination cursor missing or repeated');
      after = page?.hasNextPage ? page.endCursor : null;
      if (after) cursors.add(after);
    } while (after);
    if (matches.length > 1) throw new Error('프로젝트 이름이 여럿과 맞습니다');
    if (!matches.length) throw new Error('프로젝트 이름과 맞는 항목이 없습니다');
    projectId = matches[0]!;
  }
  return projectId;
}

export async function resolveLinearViewerId({ apiKey, fetch: fetchFn = fetch }: LinearRequestOptions): Promise<string> {
  const data = await linearRequest<{ viewer?: { id?: string } }>({ apiKey, fetch: fetchFn }, 'query LinearSecretaryViewer { viewer { id } }', {});
  if (!data.viewer?.id) throw new Error('Linear viewer id could not be resolved');
  return data.viewer.id;
}

/** Read-only project lookup. A name is resolved uniquely before querying its issues. */
export async function fetchLinearProjectIssues({ apiKey, project, includeDone = false, fetch: fetchFn = fetch }: {
  apiKey: string; project: string; includeDone?: boolean; fetch?: typeof fetch;
}): Promise<LinearProjectIssue[] & { truncated: boolean }> {
  const projectId = await resolveLinearProjectId({ apiKey, project, fetch: fetchFn });
  const issues: LinearProjectIssue[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  do {
    const stateFilter = includeDone ? '' : ', state: { type: { nin: ["completed", "canceled"] } }';
    const data: { issues?: { nodes?: LinearProjectIssue[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } } = await linearRequest({ apiKey, fetch: fetchFn },
      `query CooProjectIssues($projectId: ID!, $after: String, $first: Int!) {
        issues(filter: { project: { id: { eq: $projectId } }${stateFilter} }, first: $first, after: $after) {
          nodes { identifier title url state { name type } dueDate priority assignee { name } updatedAt }
          pageInfo { hasNextPage endCursor }
        }
      }`, { projectId, after, first: Math.min(100, 250 - issues.length) });
    if (!Array.isArray(data.issues?.nodes)) throw new Error('Linear GraphQL missing issues');
    for (const node of data.issues.nodes) {
      if (!includeDone && (node.state?.type === 'completed' || node.state?.type === 'canceled')) continue;
      if (issues.length < 250) issues.push(node);
    }
    const page = data.issues.pageInfo;
    if (page?.hasNextPage && (!page.endCursor || cursors.has(page.endCursor))) throw new Error('Linear GraphQL pagination cursor missing or repeated');
    after = page?.hasNextPage ? page.endCursor : null;
    if (after) cursors.add(after);
  } while (after && issues.length < 250);
  Object.defineProperty(issues, 'truncated', { value: after !== null, enumerable: false });
  return issues as LinearProjectIssue[] & { truncated: boolean };
}

/** Find a previously created decision issue after a crash between Linear creation and the local rename. */
export async function findLinearDecisionIssue({ apiKey, projectId, decisionId, fetch: fetchFn = fetch }: LinearRequestOptions & { projectId: string; decisionId: string }): Promise<string | null> {
  const cursors = new Set<string>();
  let after: string | null = null;
  let match: string | null = null;
  do {
    const data: { issues?: { nodes?: Array<{ id: string; description: string | null }>; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } } = await linearRequest({ apiKey, fetch: fetchFn },
      'query DecisionIssue($projectId: ID!, $decisionId: String!, $after: String) { issues(filter: { project: { id: { eq: $projectId } }, description: { contains: $decisionId } }, first: 100, after: $after) { nodes { id description } pageInfo { hasNextPage endCursor } } }',
      { projectId, decisionId, after });
    if (!Array.isArray(data.issues?.nodes)) throw new Error('Linear GraphQL missing issues');
    for (const node of data.issues.nodes) {
      if (!node.description?.split('\n').includes(`결정 id: ${decisionId}`)) continue;
      if (match) throw new Error('Linear decision issue duplicated');
      match = node.id;
    }
    const page = data.issues.pageInfo;
    if (page?.hasNextPage && (!page.endCursor || cursors.has(page.endCursor))) throw new Error('Linear GraphQL pagination cursor missing or repeated');
    after = page?.hasNextPage ? page.endCursor : null;
    if (after) cursors.add(after);
  } while (after);
  return match;
}

/** Create in a project or directly in an explicitly selected team. */
export async function createLinearIssue({ apiKey, projectId, teamKey, title, description, dueDate, parentId, assigneeId, stateType, fetch: fetchFn = fetch }: LinearRequestOptions & {
  projectId?: string; teamKey?: string; title: string; description: string; dueDate?: string; parentId?: string; assigneeId?: string;
  stateType?: 'started' | 'unstarted' | 'completed' | 'canceled';
}): Promise<string> {
  if (!apiKey.trim() || (!projectId?.trim() && !teamKey?.trim())) throw new Error('Linear project or team and API key are required');
  if (!projectId?.trim()) return createLinearTeamIssue({ apiKey, teamKey: teamKey!.trim(), title, description, dueDate, parentId, assigneeId, stateType, fetch: fetchFn });
  type Team = { id: string; states?: { nodes?: Array<{ id: string; type: string }> } };
  const data = await linearRequest<{ project?: { teams?: { nodes?: Team[] } } }>({ apiKey, fetch: fetchFn },
    'query DecisionProjectTeam($id: String!) { project(id: $id) { teams { nodes { id states { nodes { id type } } } } } }', { id: projectId });
  const teams = data.project?.teams?.nodes;
  if (!teams?.[0]?.id) throw new Error('Linear project has no team');
  const stateId = stateType ? teams[0].states?.nodes?.find(state => state.type === stateType)?.id : undefined;
  if (stateType && !stateId) throw new Error(`Linear team workflow state not found: ${stateType}`);
  const created = await linearRequest<{ issueCreate?: { success?: boolean; issue?: { id?: string } } }>({ apiKey, fetch: fetchFn },
    'mutation DecisionIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id } } }',
    { input: {
      teamId: teams[0].id, projectId, title, description,
      ...(dueDate ? { dueDate } : {}), ...(parentId ? { parentId } : {}), ...(assigneeId ? { assigneeId } : {}), ...(stateId ? { stateId } : {}),
    } });
  const id = created.issueCreate?.issue?.id;
  if (!created.issueCreate?.success || !id) throw new Error('Linear issueCreate did not return an issue id');
  return id;
}

/** Create an issue directly in a team, without requiring a project. */
export async function createLinearTeamIssue({ apiKey, teamKey, title, description, dueDate, parentId, assigneeId, stateType, fetch: fetchFn = fetch }: LinearRequestOptions & {
  teamKey: string; title: string; description?: string; dueDate?: string; parentId?: string; assigneeId?: string;
  stateType?: 'started' | 'unstarted' | 'completed' | 'canceled';
}): Promise<string> {
  if (!apiKey.trim() || !teamKey.trim() || !title.trim()) throw new Error('Linear team, title and API key are required');
  const data = await linearRequest<{ teams?: { nodes?: Array<{ id?: string; states?: { nodes?: Array<{ id: string; type: string }> } }> } }>({ apiKey, fetch: fetchFn },
    'query LinearTeamByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id states { nodes { id type } } } } }', { key: teamKey.trim() });
  const teams = data.teams?.nodes ?? [];
  if (teams.length !== 1 || !teams[0]?.id) throw new Error(teams.length ? 'Linear team key is ambiguous' : 'Linear team key was not found');
  const stateId = stateType ? teams[0].states?.nodes?.find(state => state.type === stateType)?.id : undefined;
  if (stateType && !stateId) throw new Error(`Linear team workflow state not found: ${stateType}`);
  const created = await linearRequest<{ issueCreate?: { success?: boolean; issue?: { id?: string } } }>({ apiKey, fetch: fetchFn },
    'mutation LinearTeamIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id } } }',
    { input: { teamId: teams[0].id, title: title.trim(), ...(description?.trim() ? { description: description.trim() } : {}),
      ...(dueDate ? { dueDate } : {}), ...(parentId ? { parentId } : {}), ...(assigneeId ? { assigneeId } : {}), ...(stateId ? { stateId } : {}) } });
  const id = created.issueCreate?.issue?.id;
  if (!created.issueCreate?.success || !id) throw new Error('Linear issueCreate did not return an issue id');
  return id;
}

export async function commentLinearIssue({ apiKey, issueId, body, fetch: fetchFn = fetch }: LinearRequestOptions & { issueId: string; body: string }): Promise<void> {
  const data = await linearRequest<{ commentCreate?: { success?: boolean; comment?: { id?: string } } }>({ apiKey, fetch: fetchFn },
    'mutation DecisionComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }',
    { input: { issueId, body } });
  if (!data.commentCreate?.success || !data.commentCreate.comment?.id) throw new Error('Linear commentCreate failed');
}

export async function createLinearAttachment({ apiKey, issueId, title, url, subtitle, fetch: fetchFn = fetch }: LinearRequestOptions & {
  issueId: string; title: string; url: string; subtitle?: string;
}): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Linear attachment URL must use HTTPS');
  const data = await linearRequest<{ attachmentCreate?: { success?: boolean; attachment?: { id?: string } } }>({ apiKey, fetch: fetchFn },
    'mutation LinearAttachmentCreate($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success attachment { id } } }',
    { input: { issueId, title, url: parsed.toString(), ...(subtitle ? { subtitle } : {}) } });
  const id = data.attachmentCreate?.attachment?.id;
  if (!data.attachmentCreate?.success || !id) throw new Error('Linear attachmentCreate did not return an attachment id');
  return id;
}

/** Request a signed Linear upload URL and stream a generated artifact from the server. */
export async function uploadLinearFile({ apiKey, filename, contentType, body, fetch: fetchFn = fetch }: LinearRequestOptions & {
  filename: string; contentType: string; body: Buffer;
}): Promise<string> {
  const data = await linearRequest<{ fileUpload?: { success?: boolean; uploadFile?: {
    uploadUrl?: string; assetUrl?: string; headers?: Array<{ key: string; value: string }>;
  } } }>({ apiKey, fetch: fetchFn },
    `mutation LinearFileUpload($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success uploadFile { uploadUrl assetUrl headers { key value } }
      }
    }`,
    { contentType, filename, size: body.byteLength });
  const upload = data.fileUpload?.uploadFile;
  if (!data.fileUpload?.success || !upload?.uploadUrl || !upload.assetUrl || !Array.isArray(upload.headers)) {
    throw new Error('Linear fileUpload did not return an upload URL');
  }
  const uploadUrl = new URL(upload.uploadUrl);
  const assetUrl = new URL(upload.assetUrl);
  if (uploadUrl.protocol !== 'https:' || assetUrl.protocol !== 'https:') throw new Error('Linear file upload URLs must use HTTPS');
  const headers = new Headers({ 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000' });
  for (const header of upload.headers) {
    if (!header || typeof header.key !== 'string' || typeof header.value !== 'string') throw new Error('Linear fileUpload returned invalid headers');
    headers.set(header.key, header.value);
  }
  let response: Response;
  try {
    const uploadBody = new Uint8Array(body.byteLength);
    uploadBody.set(body);
    response = await fetchFn(uploadUrl, { method: 'PUT', headers, body: uploadBody, redirect: 'error' });
  } catch {
    throw new Error('Linear file upload PUT failed');
  }
  if (!response.ok) throw new Error(`Linear file upload PUT HTTP ${response.status}`);
  return assetUrl.toString();
}

export async function updateLinearIssueDescription({ apiKey, issueId, description, fetch: fetchFn = fetch }: LinearRequestOptions & {
  issueId: string; description: string;
}): Promise<void> {
  const data = await linearRequest<{ issueUpdate?: { success?: boolean } }>({ apiKey, fetch: fetchFn },
    'mutation LinearIssueDescriptionUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
    { id: issueId, input: { description } });
  if (!data.issueUpdate?.success) throw new Error('Linear issue description update failed');
}

export async function fetchLinearIssueDescription({ apiKey, issueId, fetch: fetchFn = fetch }: LinearRequestOptions & { issueId: string }): Promise<string> {
  const data = await linearRequest<{ issue?: { description?: string | null } }>({ apiKey, fetch: fetchFn },
    'query LinearIssueDescription($id: String!) { issue(id: $id) { description } }', { id: issueId });
  if (typeof data.issue?.description !== 'string') throw new Error('Linear issue description is missing');
  return data.issue.description;
}

export async function moveLinearIssueToStateType({ apiKey, issueId, type, fetch: fetchFn = fetch }: LinearRequestOptions & {
  issueId: string; type: 'unstarted' | 'started' | 'completed' | 'canceled';
}): Promise<void> {
  const data = await linearRequest<{ issue?: { team?: { states?: { nodes?: Array<{ id: string; type: string }> } } } }>({ apiKey, fetch: fetchFn },
    'query DecisionIssueStates($id: String!) { issue(id: $id) { team { states { nodes { id type } } } } }', { id: issueId });
  const state = data.issue?.team?.states?.nodes?.find(node => node.type === type);
  if (!state?.id) throw new Error(`Linear team workflow state not found: ${type}`);
  const updated = await linearRequest<{ issueUpdate?: { success?: boolean } }>({ apiKey, fetch: fetchFn },
    'mutation DecisionIssueClose($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
    { id: issueId, input: { stateId: state.id } });
  if (!updated.issueUpdate?.success) throw new Error('Linear issueUpdate failed');
}

/** Check the issue's current workflow state and transition in one fresh read/write operation. */
export async function transitionLinearIssueStateType({ apiKey, issueId, type, fromTypes, fetch: fetchFn = fetch }: LinearRequestOptions & {
  issueId: string; type: 'unstarted' | 'started' | 'completed' | 'canceled'; fromTypes?: readonly string[];
}): Promise<boolean> {
  const data = await linearRequest<{ issue?: { state?: { type?: string } | null; team?: { states?: { nodes?: Array<{ id: string; type: string }> } } } }>({ apiKey, fetch: fetchFn },
    'query LinearIssueTransitionGuard($id: String!) { issue(id: $id) { state { type } team { states { nodes { id type } } } } }', { id: issueId });
  const currentType = data.issue?.state?.type;
  if (!currentType || currentType === 'completed' || currentType === 'canceled' || (fromTypes && !fromTypes.includes(currentType))) return false;
  const state = data.issue?.team?.states?.nodes?.find(node => node.type === type);
  if (!state?.id) throw new Error(`Linear team workflow state not found: ${type}`);
  const updated = await linearRequest<{ issueUpdate?: { success?: boolean } }>({ apiKey, fetch: fetchFn },
    'mutation LinearIssueTransition($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }',
    { id: issueId, input: { stateId: state.id } });
  if (!updated.issueUpdate?.success) throw new Error('Linear issueUpdate failed');
  return true;
}

export async function fetchLinearIssueStateType({ apiKey, issueId, fetch: fetchFn = fetch }: LinearRequestOptions & { issueId: string }): Promise<string> {
  const data = await linearRequest<{ issue?: { state?: { type?: string } | null } }>({ apiKey, fetch: fetchFn },
    'query LinearIssueStatus($id: String!) { issue(id: $id) { state { type } } }', { id: issueId });
  const type = data.issue?.state?.type;
  if (!type) throw new Error('Linear issue state type is missing');
  return type;
}

/** Read the immutable identity needed to bind a demo mission to a real child issue. */
export async function fetchLinearMissionIssueIdentity({ apiKey, issueId, fetch: fetchFn = fetch }: LinearRequestOptions & { issueId: string }): Promise<{ id: string; teamKey: string; parentId: string | null }> {
  const data = await linearRequest<{ issue?: { id?: string; team?: { key?: string } | null; parent?: { id?: string } | null } }>({ apiKey, fetch: fetchFn },
    'query LinearMissionIssueIdentity($id: String!) { issue(id: $id) { id team { key } parent { id } } }', { id: issueId });
  const issue = data.issue;
  if (!issue?.id || !issue.team?.key) throw new Error('Linear issue identity is incomplete');
  return { id: issue.id, teamKey: issue.team.key, parentId: issue.parent?.id ?? null };
}

export async function fetchLinearIssueUpdatedAt({ apiKey, issueId, fetch: fetchFn = fetch }: LinearRequestOptions & { issueId: string }): Promise<string> {
  const data = await linearRequest<{ issue?: { updatedAt?: string } }>({ apiKey, fetch: fetchFn },
    'query LinearIssueUpdatedAt($id: String!) { issue(id: $id) { updatedAt } }', { id: issueId });
  const updatedAt = data.issue?.updatedAt;
  if (!updatedAt || !Number.isFinite(Date.parse(updatedAt))) throw new Error('Linear issue updatedAt is missing');
  return updatedAt;
}

export function toTaskRequest(event: ExternalTaskEvent): {
  title: string; description: string; priority: 'high' | 'medium' | 'low';
  external: { provider: 'linear'; ref: string; url?: string; team?: string };
} {
  const fullTitle = `${event.identifier ? `${event.identifier} ` : ''}${event.title}`;
  const title = fullTitle.length > 80 ? `${fullTitle.slice(0, 79)}…` : fullTitle;
  const description = event.priority === 'urgent'
    ? `원래 우선순위: Urgent${event.body ? `\n\n${event.body}` : ''}`
    : event.body;
  const team = event.identifier?.includes('-') ? event.identifier.slice(0, event.identifier.lastIndexOf('-')) : undefined;
  return { title, description,
    priority: event.priority === 'urgent' ? 'high' : event.priority ?? 'medium',
    external: { provider: 'linear', ref: event.ref, ...(event.url ? { url: event.url } : {}), ...(team ? { team } : {}) } };
}

export const linearConnector: TaskConnector = {
  provider: 'linear', verify: verifyLinearWebhook, parse: parseLinearWebhook,
  idempotencyKey: event => event.eventId,
};
