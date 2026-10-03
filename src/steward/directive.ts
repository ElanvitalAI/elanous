import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { getSecretAsync } from '../nexus/config/secrets/index.js';
import { getUserConfig } from '../user-config.js';

export type DirectiveSource = 'telegram' | 'pwa' | 'tui' | 'cli';
export interface DirectiveIssue { id: string; identifier: string; title: string; description?: string | null }
export interface DirectiveOrigin { chatId: number; botId?: string; threadId?: number }
export interface DirectiveDeps {
  root?: string;
  fetch?: typeof fetch;
  getSecret?: (id: string) => Promise<string | undefined>;
  team?: string;
  now?: () => Date;
}

export function directiveHash(text: string): string {
  return createHash('sha256').update(text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()).digest('hex');
}

async function graphql<T>(key: string, query: string, variables: Record<string, unknown>, fetchFn: typeof fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn('https://api.linear.app/graphql', {
      method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
  } catch { throw new Error('Linear GraphQL request failed'); }
  if (!response.ok) throw new Error(`Linear GraphQL HTTP ${response.status}`);
  let payload: { data?: T; errors?: unknown[] };
  try { payload = await response.json() as typeof payload; }
  catch { throw new Error('Linear GraphQL invalid JSON response'); }
  if (payload.errors?.length || !payload.data) throw new Error('Linear GraphQL returned errors or missing data');
  return payload.data;
}

function originPath(root: string, identifier: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(identifier)) throw new Error('Invalid directive identifier');
  return join(root, 'steward', 'origins', `${identifier}.json`);
}

type TelegramOrigin = import('../autopilot/mission-origin.js').MissionOrigin & { channel: 'telegram'; chatId: number };

function validOrigin(value: unknown): value is TelegramOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const origin = value as Record<string, unknown>;
  return origin.channel === 'telegram' && Number.isSafeInteger(origin.chatId) &&
    (origin.botId === undefined || typeof origin.botId === 'string' && /^\d+$/.test(origin.botId)) &&
    (origin.threadId === undefined || Number.isSafeInteger(origin.threadId));
}

export function loadDirectiveOrigins(root: string, identifier: string): TelegramOrigin[] {
  try {
    const value: unknown = JSON.parse(readFileSync(originPath(root, identifier), 'utf8'));
    const origins = Array.isArray(value) ? value : [value];
    return origins.filter(validOrigin);
  } catch { return []; }
}

export function saveDirectiveOrigin(root: string, identifier: string, origin: DirectiveOrigin): void {
  if (!Number.isSafeInteger(origin.chatId) || origin.threadId !== undefined && !Number.isSafeInteger(origin.threadId)) throw new Error('Invalid directive origin');
  const path = originPath(root, identifier);
  const next: TelegramOrigin = { channel: 'telegram', chatId: origin.chatId,
    ...(origin.botId && /^\d+$/.test(origin.botId) ? { botId: origin.botId } : {}),
    ...(origin.threadId !== undefined ? { threadId: origin.threadId } : {}) };
  const origins = loadDirectiveOrigins(root, identifier);
  if (origins.some(item => JSON.stringify(item) === JSON.stringify(next))) return;
  origins.push(next);
  mkdirSync(join(root, 'steward', 'origins'), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(origins.length === 1 ? next : origins));
  renameSync(temp, path);
}

export function loadDirectiveOrigin(root: string, identifier: string): TelegramOrigin | null {
  return loadDirectiveOrigins(root, identifier)[0] ?? null;
}

/** The same entry point is used by the CLI and conversational surfaces. */
export async function addDirective(text: string, options: { source?: DirectiveSource; dryRun?: boolean; origin?: DirectiveOrigin } = {}, deps: DirectiveDeps = {}): Promise<{ status: 'created' | 'repeated' | 'dry-run'; issue?: string; hash: string }> {
  const original = text.trim();
  if (!original) throw new Error('directive text is required');
  const source = options.source ?? 'cli';
  if (!['telegram', 'pwa', 'tui', 'cli'].includes(source)) throw new Error('invalid directive source');
  const hash = directiveHash(original);
  if (options.dryRun) return { status: 'dry-run', hash };
  const key = await (deps.getSecret ?? getSecretAsync)('connector.linear.apiKey');
  if (!key) throw new Error('connector.linear.apiKey missing; run elanous connector linear set-key');
  const teamKey = deps.team ?? getUserConfig().loops?.steward?.linearTeam ?? 'ELA';
  const request = <T>(query: string, variables: Record<string, unknown>) => graphql<T>(key, query, variables, deps.fetch ?? fetch);
  const team = await request<{ teams: { nodes: Array<{ id: string }> } }>(
    'query($key:String!){teams(filter:{key:{eq:$key}}){nodes{id}}}', { key: teamKey });
  const teamId = team.teams?.nodes?.[0]?.id;
  if (!teamId) throw new Error('Linear team not found');
  let after: string | null = null;
  const seen = new Set<string>();
  let duplicate: DirectiveIssue | undefined;
  do {
    const data: { issues: { nodes: Array<DirectiveIssue & { state?: { type?: string } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await request<{ issues: { nodes: Array<DirectiveIssue & { state?: { type?: string } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
      'query($key:String!,$after:String){issues(filter:{team:{key:{eq:$key}}},first:100,after:$after){nodes{id identifier title description state{type}} pageInfo{hasNextPage endCursor}}}',
      { key: teamKey, after });
    if (!Array.isArray(data.issues?.nodes)) throw new Error('Linear issues missing');
    duplicate = data.issues.nodes.find(issue => {
      if (['completed', 'canceled', 'duplicate'].includes(issue.state?.type ?? '')) return false;
      if (issue.description?.includes(`[directive-hash:${hash}]`)) return true;
      const firstLine = issue.description?.split('\n')[0]?.trim();
      const candidate = firstLine && firstLine.length > 0 ? firstLine : issue.title;
      return directiveHash(candidate) === hash;
    });
    if (duplicate) break;
    const page = data.issues.pageInfo;
    if (page?.hasNextPage && (!page.endCursor || seen.has(page.endCursor))) throw new Error('Linear pagination cursor missing or repeated');
    after = page?.hasNextPage ? page.endCursor : null;
    if (after) seen.add(after);
  } while (after);
  const at = (deps.now ?? (() => new Date()))().toISOString();
  if (duplicate) {
    const result = await request<{ commentCreate: { success: boolean } }>(
      'mutation($input:CommentCreateInput!){commentCreate(input:$input){success}}',
      { input: { issueId: duplicate.id, body: `다시 말함 · ${source} · ${at}\n\n${original}` } });
    if (!result.commentCreate?.success) throw new Error('Linear comment creation failed');
    if (source === 'telegram' && options.origin) saveDirectiveOrigin(deps.root ?? effectiveInstanceRoot(), duplicate.identifier, options.origin);
    return { status: 'repeated', issue: duplicate.identifier, hash };
  }
  const labels = await request<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
    'query($name:String!){issueLabels(filter:{name:{eq:$name}}){nodes{id name}}}', { name: 'from-directive' });
  let labelId = labels.issueLabels?.nodes?.find(item => item.name === 'from-directive')?.id;
  if (!labelId) {
    const createdLabel = await request<{ issueLabelCreate: { success: boolean; issueLabel?: { id: string } } }>(
      'mutation($input:IssueLabelCreateInput!){issueLabelCreate(input:$input){success issueLabel{id}}}',
      { input: { teamId, name: 'from-directive' } });
    labelId = createdLabel.issueLabelCreate?.success ? createdLabel.issueLabelCreate.issueLabel?.id : undefined;
    if (!labelId) throw new Error('Linear label from-directive creation failed');
  }
  const created = await request<{ issueCreate: { success: boolean; issue?: DirectiveIssue } }>(
    'mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id identifier title}}}',
    { input: { teamId, title: original.slice(0, 240), description: `${original}\n\n출처: ${source}\n시각: ${at}\n[directive-hash:${hash}]`, labelIds: [labelId], priority: 0 } });
  if (!created.issueCreate?.success || !created.issueCreate.issue?.identifier) throw new Error('Linear issue creation failed');
  if (source === 'telegram' && options.origin) saveDirectiveOrigin(deps.root ?? effectiveInstanceRoot(), created.issueCreate.issue.identifier, options.origin);
  return { status: 'created', issue: created.issueCreate.issue.identifier, hash };
}

export async function runDirectiveCli(text: string, options: { source?: DirectiveSource; dryRun?: boolean }): Promise<void> {
  const result = await addDirective(text, options);
  console.log(`${result.status}\t${result.issue ?? '-'}\t${result.hash}`);
}
