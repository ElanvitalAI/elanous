import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { readNexusRuntime } from '../nexus/runtime.js';
import { getSecretAsync, setSecretAsync } from '../nexus/config/secrets/index.js';
import { debug } from '../debug/log.js';
import { EventLedger } from '../connectors/event-ledger.js';
import { fetchLinearIssues, linearConnector, toTaskRequest } from '../connectors/linear.js';
import type { ExternalTaskEvent } from '../connectors/types.js';

const SECRET_ID = 'connector.linear.apiKey';

export interface ConnectorSyncOptions {
  team: string;
  prefix?: string;
  dryRun?: boolean;
  json?: boolean;
}

export interface ConnectorCliDeps {
  getSecret?: (id: string) => Promise<string | undefined>;
  setSecret?: (id: string, value: string) => Promise<void>;
  fetch?: typeof fetch;
  ledger?: EventLedger;
  baseUrl?: string;
  output?: (line: string) => void;
  log?: typeof debug.log;
  bearerToken?: string;
  readKey?: () => Promise<string>;
}

async function setLinearSecret(id: string, deps: ConnectorCliDeps): Promise<number> {
  const readKey = deps.readKey ?? (async () => {
    // `set-key < file` gives Bun a file descriptor that the async iterator reads as empty;
    // a synchronous read of fd 0 works for files and pipes alike.
    try { return readFileSync(0, 'utf8'); } catch { /* fall back to the stream */ }
    let input = '';
    for await (const chunk of process.stdin) input += chunk.toString();
    return input;
  });
  const key = (await readKey()).trim();
  if (!key) {
    (deps.output ?? console.error)(`${id}: stdin is empty`);
    return 2;
  }
  await (deps.setSecret ?? setSecretAsync)(id, key);
  (deps.output ?? console.log)(`${id} saved`);
  return 0;
}

export async function runLinearSetKey(deps: ConnectorCliDeps = {}): Promise<number> {
  return setLinearSecret(SECRET_ID, deps);
}

export async function runLinearSetWebhookSecret(deps: ConnectorCliDeps = {}): Promise<number> {
  return setLinearSecret('connector.linear.webhookSecret', deps);
}

async function existingExternalTasks(url: string, fetchFn: typeof fetch, bearerToken?: string): Promise<Set<string> | null> {
  const headers: Record<string, string> = bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {};
  try {
    const response = await fetchFn(`${url}/v1/tasks`, { method: 'GET', headers });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !Array.isArray((body as { tasks?: unknown }).tasks)) return null;
    const keys = new Set<string>();
    for (const card of (body as { tasks: unknown[] }).tasks) {
      if (!card || typeof card !== 'object') return null;
      const item = card as { id?: unknown; generatedBy?: { provider?: unknown; ref?: unknown } };
      if (typeof item.id !== 'string') return null;
      // Task-board cards omit generatedBy; details carry the persisted origin.
      let origin = item.generatedBy;
      if (origin === undefined) {
        const detail = await fetchFn(`${url}/v1/tasks/${encodeURIComponent(item.id)}`, { method: 'GET', headers });
        if (!detail.ok) return null;
        const payload: unknown = await detail.json();
        const task = payload && typeof payload === 'object' ? (payload as { task?: unknown }).task : undefined;
        if (!task || typeof task !== 'object' || (task as { id?: unknown }).id !== item.id) return null;
        origin = (task as { generatedBy?: typeof origin }).generatedBy;
      }
      if (typeof origin?.provider === 'string' && typeof origin.ref === 'string') keys.add(JSON.stringify([origin.provider, origin.ref]));
    }
    return keys;
  } catch {
    return null;
  }
}

export async function applyLinearEvents(events: ExternalTaskEvent[], opts: Pick<ConnectorSyncOptions, 'dryRun' | 'json'> & { team?: string }, deps: ConnectorCliDeps = {}): Promise<number> {
  const out = deps.output ?? console.log;
  const fetchFn = deps.fetch ?? fetch;
  const ledger = deps.ledger ?? new EventLedger();
  const log = deps.log ?? debug.log.bind(debug);
  let bearerToken = deps.bearerToken;
  if (!bearerToken && !opts.dryRun) {
    try { bearerToken = readFileSync(join(getElanousConfigDir(), 'acp-token'), 'utf8').trim() || undefined; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const results: Array<{ issue: string; taskId: string | null; status: 'created' | 'recreated' | 'deduplicated' | 'skipped-seen' | 'dry-run' | 'failed'; reason?: string }> = [];
  let existing: Set<string> | null | undefined;
  for (const event of events) {
    const fields = { traceId: randomUUID(), ref: event.ref, identifier: event.identifier, eventId: event.eventId };
    log('connector.linear', 'fetched', fields);
    const seen = ledger.seen(event.provider, linearConnector.idempotencyKey(event)) || ledger.seenChange(event.provider, event.ref, event.occurredAt);
    if (seen && !opts.dryRun) {
      if (existing === undefined) {
        const runtime = deps.baseUrl ? undefined : readNexusRuntime();
        const url = deps.baseUrl ?? (runtime?.httpPort ? `http://127.0.0.1:${runtime.httpPort}` : undefined);
        existing = url ? await existingExternalTasks(url, fetchFn, bearerToken) : null;
      }
    }
    if (seen && (opts.dryRun || !existing || existing.has(JSON.stringify([event.provider, event.ref])))) {
      results.push({ issue: event.identifier ?? event.ref, taskId: null, status: 'skipped-seen' });
      log('connector.linear', 'skipped-seen', fields);
      continue;
    }
    if (opts.dryRun) {
      results.push({ issue: event.identifier ?? event.ref, taskId: null, status: 'dry-run' });
      continue;
    }
    const runtime = deps.baseUrl ? undefined : readNexusRuntime();
    const url = deps.baseUrl ?? (runtime?.httpPort ? `http://127.0.0.1:${runtime.httpPort}` : undefined);
    if (!url) throw new Error('Nexus runtime unavailable: start nexus before connector linear sync');
    const task = toTaskRequest(event);
    if (opts.team) task.external.team = opts.team;
    let response: Response;
    try {
      response = await fetchFn(`${url}/v1/tasks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-elanous-trace-id': fields.traceId, ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}) },
        body: JSON.stringify(task),
      });
    } catch {
      results.push({ issue: event.identifier ?? event.ref, taskId: null, status: 'failed', reason: 'Nexus POST /v1/tasks request failed' });
      log('connector.linear', 'failed', { ...fields, reason: 'Nexus POST /v1/tasks request failed' });
      continue;
    }
    let reason: string | undefined = !response.ok ? `Nexus POST /v1/tasks HTTP ${response.status}` : undefined;
    let body: { taskId?: string; task?: { id?: string }; id?: string; created?: boolean; deduplicated?: boolean } | undefined;
    if (!reason) {
      try { body = await response.json() as typeof body; }
      catch { reason = 'Nexus POST /v1/tasks invalid JSON response'; }
    }
    const taskId = body?.taskId ?? body?.task?.id ?? body?.id;
    if (!reason && !taskId) reason = 'Nexus POST /v1/tasks returned no taskId';
    if (reason) {
      results.push({ issue: event.identifier ?? event.ref, taskId: null, status: 'failed', reason });
      log('connector.linear', 'failed', { ...fields, reason });
      continue;
    }
    const status = body?.deduplicated || body?.created === false ? 'deduplicated' : seen ? 'recreated' : 'created';
    ledger.record(event.provider, linearConnector.idempotencyKey(event), { ref: event.ref, occurredAt: event.occurredAt });
    existing?.add(JSON.stringify([event.provider, event.ref]));
    results.push({ issue: event.identifier ?? event.ref, taskId: taskId!, status });
    log('connector.linear', 'posted', fields);
  }
  if (opts.json) out(JSON.stringify(results));
  else for (const row of results) out(`${row.issue}\t${row.taskId ?? '-'}\t${row.status}${row.reason ? `\t${row.reason}` : ''}`);
  return results.some(row => row.status === 'failed') ? 1 : 0;
}

export async function runLinearWebhook(input: { rawBody: string | Uint8Array; signature: string; deliveryId: string; now?: number }, deps: ConnectorCliDeps = {}): Promise<number> {
  const out = deps.output ?? console.log;
  const secret = await (deps.getSecret ?? getSecretAsync)('connector.linear.webhookSecret');
  if (!secret) {
    out('connector.linear.webhookSecret missing');
    return 2;
  }
  const verified = linearConnector.verify({ rawBody: input.rawBody, signature: input.signature, secret, now: input.now });
  if (!verified.ok) {
    out(`connector linear receive: ${verified.reason}`);
    return 2;
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.from(input.rawBody).toString('utf8')); }
  catch { out('connector linear receive: invalid-body'); return 2; }
  const event = linearConnector.parse(body, input.deliveryId);
  if (!event) {
    out('connector linear receive: ignored');
    return 0;
  }
  return applyLinearEvents([event], {}, deps);
}

export async function runLinearSync(opts: ConnectorSyncOptions, deps: ConnectorCliDeps = {}): Promise<number> {
  if (!opts.team?.trim()) {
    (deps.output ?? console.log)('connector linear sync: --team is required');
    return 2;
  }
  const key = await (deps.getSecret ?? getSecretAsync)(SECRET_ID);
  if (!key) {
    (deps.output ?? console.log)('connector.linear.apiKey missing; run elanous connector linear set-key');
    return 2;
  }
  const events = await fetchLinearIssues({ apiKey: key, teamKey: opts.team, labelOrPrefix: opts.prefix, fetch: deps.fetch ?? fetch });
  return applyLinearEvents(events, opts, deps);
}
