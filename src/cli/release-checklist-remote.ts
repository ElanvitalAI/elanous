import { readFileSync, statSync } from 'node:fs';
import { spawnElanousSync } from '../instance/spawn-elanous.js';
import type { Checklist } from '../release-loop/checklist.js';
import { canonicalSeatId } from '../msg/msg-store.js';

export interface RemoteChecklistConfig {
  url?: string;
  tokenFile?: string;
  fetch?: (input: URL, init: RequestInit) => Promise<Response>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(row: Record<string, unknown>, key: string): boolean {
  return row[key] === undefined || typeof row[key] === 'string';
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === 'string' && choices.includes(value);
}

function validItem(value: unknown): boolean {
  if (!record(value)) return false;
  if (typeof value.id !== 'string' || !value.id.trim() || typeof value.title !== 'string' || !value.title.trim()
    || !oneOf(value.status, ['yellow', 'red', 'green', 'done'])
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || typeof value.updatedBy !== 'string' || !value.updatedBy.trim()) return false;
  for (const key of ['owner', 'deadlineVersion', 'ceoDate', 'evidence', 'knownIssue'] as const)
    if (!optionalString(value, key)) return false;
  if (value.owner !== undefined && !(value.owner as string).trim()) return false;
  if (value.priority !== undefined && !oneOf(value.priority, ['P0', 'P1', 'P2'])) return false;
  if (value.disposition !== undefined && !oneOf(value.disposition, ['move', 'known-issue', 'block'])) return false;
  if (value.kind !== undefined && !oneOf(value.kind, ['screen', 'postpub'])) return false;
  if (value.dispatchKind !== undefined && !oneOf(value.dispatchKind, ['code', 'ops', 'measure', 'decision', 'umbrella'])) return false;
  if (value.predecessors !== undefined && !stringList(value.predecessors)) return false;
  if (value.refs !== undefined && !stringList(value.refs)) return false;
  if (value.ceoMinutes !== undefined && (typeof value.ceoMinutes !== 'number' || !Number.isFinite(value.ceoMinutes))) return false;
  if (value.accelerator !== undefined && value.accelerator !== true) return false;
  if (value.must !== undefined && (!record(value.must) ||
    !['version', 'reason', 'setBy', 'setAt', 'effect'].every(key => typeof (value.must as Record<string, unknown>)[key] === 'string'))) return false;
  return true;
}

function validHistory(value: unknown): boolean {
  if (!record(value)) return false;
  if (!['at', 'by', 'id', 'field', 'released', 'dev'].every(key => typeof value[key] === 'string')) return false;
  if (!Number.isFinite(Date.parse(value.at as string)) || !('from' in value) || !('to' in value)) return false;
  if (value.force !== undefined && value.force !== true) return false;
  if (!optionalString(value, 'reason')) return false;
  if (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0)) return false;
  return true;
}

export function validChecklistSnapshot(value: unknown, version: string): value is Checklist {
  return record(value) && value.version === version && typeof value.released === 'string' && typeof value.dev === 'string'
    && Array.isArray(value.items) && value.items.every(validItem)
    && Array.isArray(value.history) && value.history.every(validHistory);
}

/** Explicit Nexus URL selects HQ's ledger. Failed remote reads never masquerade as an empty local board. */
export async function readRemoteChecklist(version: string, config: RemoteChecklistConfig = {}): Promise<Checklist | null> {
  const base = config.url ?? process.env.ELANOUS_NEXUS_URL?.trim();
  if (!base) return null;
  const tokenFile = config.tokenFile ?? process.env.ELANOUS_NEXUS_TOKEN_FILE?.trim();
  if (!tokenFile) throw new Error('Nexus checklist token file is required (ELANOUS_NEXUS_TOKEN_FILE)');
  let endpoint: URL;
  try {
    endpoint = new URL('/v1/release/checklist', base);
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)))
      throw new Error('insecure');
  } catch { throw new Error('Nexus checklist URL must use HTTPS or loopback HTTP'); }
  endpoint.searchParams.set('version', version);
  let token: string;
  try {
    const stat = statSync(tokenFile);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('permissions');
    token = readFileSync(tokenFile, 'utf8').trim();
  } catch { throw new Error('Nexus checklist token file is missing or not private (0600)'); }
  if (!token) throw new Error('Nexus checklist token file is empty');
  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(endpoint, {
      method: 'GET', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
    });
  } catch { throw new Error('Nexus checklist unavailable'); }
  if (!response.ok) throw new Error(`Nexus checklist rejected (HTTP ${response.status})`);
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error('Nexus checklist returned invalid JSON'); }
  if (!validChecklistSnapshot(data, version))
    throw new Error('Nexus checklist returned an invalid snapshot');
  return data;
}

export function requestChecklistClaim(snapshot: Checklist, id: string, by: string,
  post: (from: string, body: string) => void = postClaimMail): void {
  const owner = canonicalSeatId(by);
  const item = snapshot.items.find(row => row.id === id);
  if (!item) throw new Error(`Checklist cell not found: ${id}`);
  if (item.owner || item.status !== 'yellow') throw new Error(`Checklist cell is not available: ${id}`);
  post(owner, `[CELL-CLAIM-REQ] ${snapshot.version} ${item.id} · ${item.title} — ${owner} 선점 요청 (원장 변경은 OP 확인 뒤)`);
}

function postClaimMail(from: string, body: string): void {
  const result = spawnElanousSync(['msg', 'post', '--from', from, '--to', 'OP', '--kind', 'question', '--body', body], {
    encoding: 'utf8', timeout: 10_000,
  });
  if (result.error || result.status !== 0) throw new Error(`Checklist claim mail failed (rc=${result.status ?? 'spawn'})`);
}
