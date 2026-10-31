import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLockSync } from '../storage/file-lock.js';
import { resolveDaemonEndpoint } from '../nexus/daemon-endpoint.js';
import { debug } from '../debug/log.js';

export type MissionLineType = 'progress' | 'final' | 'ask' | 'answer' | 'correct';
export class MissionLineHttpError extends Error {
  constructor(readonly status: number) {
    super(`mission line rejected (${status})`);
    this.name = 'MissionLineHttpError';
  }
}
export interface MissionLineInput {
  lineId: string;
  missionId: string;
  attemptId: string;
  /** Bound PTY/run identity for parent-to-child answer/correction routing. */
  runId?: string;
  ptyId?: string;
  replyTo?: number;
  agent: 'codex' | 'claude';
  type: MissionLineType;
  source: string;
  text: string;
  state?: string;
  kind?: string;
  defaults?: string;
  deadline?: string;
  scope?: string;
  stop?: boolean;
  priority?: string;
}
export interface MissionLineEvent extends MissionLineInput {
  sequence: number;
  createdAt: string;
  done: boolean;
  graphEvents?: Array<{
    seq: number; ts: string; type: 'node-added'; node: string; kind: 'hand';
    decider: 'mission-line'; reason: string; who: string; what: string; missionId: string;
  }>;
}

interface MissionLineAuthority { missionId: string; attemptId: string; finalLineId: string; tokenHash: string; agent: 'codex' | 'claude'; who: string; what: string; runId?: string; ptyId?: string; revoked?: boolean }
const validId = (value: string): boolean => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const authPath = (root: string, id: string): string => join(root, 'agent-missions', `${id}.line-auth.json`);
const lockPath = (root: string, id: string): string => join(root, 'agent-missions', `${id}.line.lock`);
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const equalHash = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'hex'); const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
};

function safeMissionId(value: string): string {
  if (!validId(value)) throw new Error('missionId 형식이 올바르지 않습니다');
  return value.toLowerCase();
}
function readAuthority(root: string, missionId: string): MissionLineAuthority | null {
  try {
    const value: unknown = JSON.parse(readFileSync(authPath(root, safeMissionId(missionId)), 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const authority = value as MissionLineAuthority;
    return authority.missionId === missionId && typeof authority.attemptId === 'string'
      && typeof authority.tokenHash === 'string' && /^[0-9a-f]{64}$/i.test(authority.tokenHash)
      && validId(authority.finalLineId)
      && (authority.agent === 'codex' || authority.agent === 'claude')
      && typeof authority.who === 'string' && typeof authority.what === 'string' ? authority : null;
  } catch { return null; }
}

export function createMissionLineStore(root: string) {
  const issue = (input: { missionId: string; attemptId: string; agent: 'codex' | 'claude'; who: string; what: string; runId?: string; ptyId?: string }): { token: string; attemptId: string; finalLineId: string } => {
    const missionId = safeMissionId(input.missionId);
    if (!input.attemptId.trim() || !input.who.trim() || !input.what.trim()) throw new Error('attemptId, who, what 은 비어 있을 수 없습니다');
    const dir = join(root, 'agent-missions'); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('base64url');
    const finalLineId = randomUUID();
    const authority: MissionLineAuthority = { missionId, attemptId: input.attemptId, finalLineId, tokenHash: hashToken(token), agent: input.agent, who: input.who.trim(), what: input.what.trim(), ...(input.runId ? { runId: input.runId } : {}), ...(input.ptyId ? { ptyId: input.ptyId } : {}) };
    const release = acquireLockSync(lockPath(root, missionId));
    try { writeFileSync(authPath(root, missionId), `${JSON.stringify(authority)}\n`, { mode: 0o600 }); }
    finally { release(); }
    return { token, attemptId: input.attemptId, finalLineId };
  };

  const authorize = (input: MissionLineInput, token: string): MissionLineAuthority => {
    const missionId = safeMissionId(input.missionId);
    const authority = readAuthority(root, missionId);
    if (!authority || authority.revoked || authority.attemptId !== input.attemptId || authority.agent !== input.agent || !equalHash(authority.tokenHash, hashToken(token))) {
      throw new Error('mission line unauthorized');
    }
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.lineId)
      || !['progress', 'final', 'ask', 'answer', 'correct'].includes(input.type)
      || typeof input.text !== 'string' || !input.text.trim() || typeof input.source !== 'string' || !input.source.trim()
      || (input.replyTo !== undefined && (!Number.isInteger(input.replyTo) || input.replyTo < 1))) throw new Error('mission line payload invalid');
    if (input.type === 'ask' && !input.defaults?.trim()) throw new Error('mission line ask requires defaults');
    if (input.type === 'correct' && (!input.scope || input.stop === undefined || !input.priority)) throw new Error('mission line correct requires scope, stop, and priority');
    return authority;
  };
  const revoke = (missionId: string): void => {
    const id = safeMissionId(missionId); const authority = readAuthority(root, id); if (!authority || authority.revoked) return;
    const release = acquireLockSync(lockPath(root, id));
    try { writeFileSync(authPath(root, id), `${JSON.stringify({ ...authority, revoked: true })}\n`, { mode: 0o600 }); }
    finally { release(); }
  };
  return { issue, authorize, revoke };
}

/** Child/hook client: credentials are read only from the per-mission child environment. */
export async function postMissionLineEvent(input: MissionLineInput, deps: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; resolveUrl?: () => string | null } = {}): Promise<MissionLineEvent> {
  const env = deps.env ?? process.env;
  const token = env.ELANOUS_HAND_TOKEN?.trim();
  const base = env.ELANOUS_NEXUS_URL?.trim() || deps.resolveUrl?.() || resolveDaemonEndpoint()?.baseUrl;
  if (!token || !input.attemptId.trim() || !base) throw new Error('mission line credentials or NEXUS endpoint unavailable');
  const response = await (deps.fetch ?? fetch)(`${base.replace(/\/$/, '')}/v1/missions/${encodeURIComponent(input.missionId)}/line`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new MissionLineHttpError(response.status);
  return await response.json() as MissionLineEvent;
}

/** Single NEXUS ingress; eventBus feeds the existing /v1/events SSE subscribers. */
export async function handleMissionLineRequest(
  req: Request,
  root: string,
  append: (input: MissionLineInput, authority: { who: string; what: string }) => Promise<MissionLineEvent>,
  publish: (event: MissionLineEvent) => void,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const match = /^\/v1\/missions\/([^/]+)\/line$/.exec(url.pathname);
  if (!match) return undefined;
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { allow: 'POST', 'content-type': 'application/json' } });
  let missionId: string;
  try { missionId = safeMissionId(decodeURIComponent(match[1]!)); }
  catch { return new Response(JSON.stringify({ error: 'invalid_payload' }), { status: 400, headers: { 'content-type': 'application/json' } }); }
  const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!token) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
  let authorized = false;
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return new Response(JSON.stringify({ error: 'invalid_payload' }), { status: 400, headers: { 'content-type': 'application/json' } });
    const record = body as Record<string, unknown>;
    if (Object.keys(record).some((key) => !['lineId', 'missionId', 'attemptId', 'runId', 'ptyId', 'replyTo', 'agent', 'type', 'source', 'text', 'state', 'kind', 'defaults', 'deadline', 'scope', 'stop', 'priority'].includes(key))) return new Response(JSON.stringify({ error: 'invalid_payload' }), { status: 400, headers: { 'content-type': 'application/json' } });
    const input = record as unknown as MissionLineInput;
    if (typeof input.lineId !== 'string' || typeof input.missionId !== 'string' || safeMissionId(input.missionId) !== missionId || typeof input.attemptId !== 'string' || !['codex', 'claude'].includes(input.agent)
      || typeof input.type !== 'string' || typeof input.source !== 'string' || typeof input.text !== 'string'
      || (input.runId !== undefined && typeof input.runId !== 'string') || (input.ptyId !== undefined && typeof input.ptyId !== 'string')
      || (input.replyTo !== undefined && (typeof input.replyTo !== 'number' || !Number.isInteger(input.replyTo) || input.replyTo < 1))
      || input.text.length > 20_000 || (input.state !== undefined && typeof input.state !== 'string')
      || (input.kind !== undefined && typeof input.kind !== 'string')
      || (input.defaults !== undefined && typeof input.defaults !== 'string')
      || (input.deadline !== undefined && typeof input.deadline !== 'string')
      || (input.scope !== undefined && typeof input.scope !== 'string')
      || (input.stop !== undefined && typeof input.stop !== 'boolean')
      || (input.priority !== undefined && typeof input.priority !== 'string')) return new Response(JSON.stringify({ error: 'invalid_payload' }), { status: 400, headers: { 'content-type': 'application/json' } });
    const authority = createMissionLineStore(root).authorize(input, token);
    authorized = true;
    const correctIdentityMissing = input.type === 'correct' && (!authority.ptyId || !authority.runId || !input.ptyId || !input.runId);
    const correctIdentityMismatch = input.type === 'correct' && !correctIdentityMissing
      && (input.ptyId !== authority.ptyId || input.runId !== authority.runId || input.agent !== authority.agent);
    const event = await append(correctIdentityMissing || correctIdentityMismatch
      ? { ...input, state: correctIdentityMissing ? 'correct 미적용(ptyId/runId 없음)' : 'correct 미적용(PTY/runId 불일치)' }
      : input, { who: authority.who, what: authority.what });
    if (input.type === 'final') createMissionLineStore(root).revoke(missionId);
    try { publish(event); }
    catch (error) { debug.log('agent-mission', 'line-ingress-publish-failed', { missionId, error: String(error) }, { level: 'error' }); }
    return new Response(JSON.stringify(event), { status: 202, headers: { 'content-type': 'application/json' } });
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === 'mission line unauthorized';
    if (authorized) {
      if (error instanceof MissionLineHttpError && (error.status === 404 || error.status === 409)) {
        return new Response(JSON.stringify({ error: error.status === 404 ? 'mission_not_found' : 'mission_state_conflict' }), { status: error.status, headers: { 'content-type': 'application/json' } });
      }
      debug.log('agent-mission', 'line-ingress-append-failed', { missionId, error: String(error) }, { level: 'error' });
      return new Response(JSON.stringify({ error: 'mission_line_store_failed' }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: unauthorized ? 'unauthorized' : 'invalid_payload' }), { status: unauthorized ? 401 : 400, headers: { 'content-type': 'application/json' } });
  }
}
