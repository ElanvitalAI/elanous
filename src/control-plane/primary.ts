import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { CONTROL_HOSTNAME, DEFAULT_CONTROL_PORT, type ControlScope } from './server.js';
import { debug } from '../debug/log.js';

export interface PrimaryJoin {
  url: string;
  tokens: Partial<Record<ControlScope, string>>;
  machine?: string;
}

export interface PrimaryConfig {
  url?: string;
  tokens?: Partial<Record<ControlScope, string>>;
  primaryCandidates?: Array<{ machine: string; url: string; tokens?: Partial<Record<ControlScope, string>> }>;
}

export interface PrimaryAddress {
  url: string;
  token: string | undefined;
  source: 'config' | 'join' | 'local' | 'lease';
  machine?: string;
}

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function address(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') throw new Error('invalid primary URL');
  return url.origin;
}

function scopedTokens(value: unknown): Partial<Record<ControlScope, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid primary tokens');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['admin', 'member', 'query'].includes(key))) throw new Error('invalid primary tokens');
  for (const token of Object.values(row)) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new Error('invalid primary tokens');
  }
  return row as Partial<Record<ControlScope, string>>;
}

/** Publish only explicitly supplied credentials; never generate or widen scopes. */
export function writePrimaryJoin(joinFile: PrimaryJoin, root: string = effectiveInstanceRoot()): void {
  const value = { url: address(joinFile.url), tokens: scopedTokens(joinFile.tokens) };
  const path = join(root, 'control', 'join.json');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** A missing or damaged join file is not a source of authority. */
export function readPrimaryJoin(root: string = effectiveInstanceRoot()): PrimaryJoin | undefined {
  try {
    const path = join(root, 'control', 'join.json');
    if ((statSync(path).mode & 0o077) !== 0) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>;
    if (typeof row.url !== 'string') return undefined;
    const url = address(row.url);
    if (row.machine !== undefined || row.token !== undefined) {
      if (typeof row.machine !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(row.machine) ||
          ['__proto__', 'constructor', 'prototype'].includes(row.machine) ||
          typeof row.token !== 'string' || !TOKEN_PATTERN.test(row.token)) return undefined;
      return { url, machine: row.machine, tokens: { member: row.token } };
    }
    return { url, tokens: scopedTokens(row.tokens) };
  } catch {
    return undefined;
  }
}

function localToken(root: string, role: ControlScope): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(root, 'control', 'tokens.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const token = (value as Record<string, unknown>)[role];
    return typeof token === 'string' && TOKEN_PATTERN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export interface ResolvePrimaryOptions {
  root?: string;
  config?: PrimaryConfig;
  role: ControlScope;
  port?: number;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** URL precedence is independent of credentials: never send a token to a different address. */
export function resolvePrimary(opts: ResolvePrimaryOptions & { config?: PrimaryConfig & { primaryCandidates?: never } }): PrimaryAddress;
export function resolvePrimary(opts: ResolvePrimaryOptions & { config: PrimaryConfig & { primaryCandidates: NonNullable<PrimaryConfig['primaryCandidates']> } }): Promise<PrimaryAddress>;
export function resolvePrimary(opts: ResolvePrimaryOptions): PrimaryAddress | Promise<PrimaryAddress>;
export function resolvePrimary(opts: ResolvePrimaryOptions): PrimaryAddress | Promise<PrimaryAddress> {
  const candidates = opts.config?.primaryCandidates;
  if (candidates?.length) return resolveLeasePrimary(opts, candidates);
  return resolveStaticPrimary(opts);
}

async function resolveLeasePrimary(opts: ResolvePrimaryOptions, candidates: NonNullable<PrimaryConfig['primaryCandidates']>): Promise<PrimaryAddress> {
  const normalized = candidates.map(candidate => {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(candidate.machine)) throw new Error('invalid primary candidate machine');
    return { machine: candidate.machine, url: address(candidate.url),
      tokens: candidate.tokens === undefined ? undefined : scopedTokens(candidate.tokens) };
  });
  let winner: (typeof normalized)[number] & { generation: number } | undefined;
  if (new Set(normalized.map(candidate => candidate.machine)).size !== normalized.length) throw new Error('duplicate primary candidate machine');
  for (const candidate of normalized) {
    try {
      const response = await (opts.fetch ?? globalThis.fetch)(`${candidate.url}/v1/primary`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) continue;
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
      const value = body as Record<string, unknown>;
      if (value.known !== true || typeof value.holder !== 'string' ||
          !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) continue;
      const holder = normalized.find(item => item.machine === value.holder);
      if (holder && (!winner || (value.generation as number) > winner.generation)) {
        winner = { ...holder, generation: value.generation as number };
      }
    } catch { /* Unreachable candidate: try the next one. */ }
  }
  const selected = winner ?? normalized[0]!;
  debug.log('control.primary', 'resolved', { source: 'lease', holder: winner?.machine ?? null, generation: winner?.generation ?? null });
  const root = opts.root ?? effectiveInstanceRoot();
  const joinFile = readPrimaryJoin(root);
  const role = opts.role;
  const configured = selected.tokens?.[role]
    ?? (opts.config?.url && address(opts.config.url) === selected.url ? opts.config.tokens?.[role] : undefined);
  if (configured !== undefined && !TOKEN_PATTERN.test(configured)) throw new Error('invalid primary token');
  const joinToken = joinFile?.url === selected.url
    ? (joinFile.tokens[role] ?? (role === 'query' ? joinFile.tokens.member : undefined)) : undefined;
  const token = configured ?? joinToken
    ?? (selected.url === `http://${CONTROL_HOSTNAME}:${opts.port ?? DEFAULT_CONTROL_PORT}` && joinFile?.url !== selected.url
      ? localToken(root, role) : undefined);
  return { url: selected.url, token, source: 'lease',
    ...(joinFile?.url === selected.url && token !== undefined && token === joinToken && joinFile.machine ? { machine: joinFile.machine } : {}) };
}

function resolveStaticPrimary(opts: ResolvePrimaryOptions): PrimaryAddress {
  const root = opts.root ?? effectiveInstanceRoot();
  const joinFile = readPrimaryJoin(root);
  const configUrl = opts.config?.url ? address(opts.config.url) : undefined;
  const port = opts.port ?? DEFAULT_CONTROL_PORT;
  const localUrl = `http://${CONTROL_HOSTNAME}:${port}`;
  const url = configUrl ?? joinFile?.url ?? localUrl;
  const source = configUrl ? 'config' : joinFile ? 'join' : 'local';
  if (source === 'local' && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('invalid control port');
  const configToken = opts.config?.tokens?.[opts.role];
  if (configToken !== undefined && !TOKEN_PATTERN.test(configToken)) throw new Error('invalid primary token');
  const joinToken = joinFile?.url === url
    ? (joinFile.tokens[opts.role] ?? (opts.role === 'query' ? joinFile.tokens.member : undefined))
    : undefined;
  const token = configToken ?? joinToken
    ?? (url === localUrl && joinFile?.url !== url ? localToken(root, opts.role) : undefined);
  return { url, token, source, ...(joinFile?.url === url && token !== undefined && token === joinToken && joinFile.machine ? { machine: joinFile.machine } : {}) };
}
