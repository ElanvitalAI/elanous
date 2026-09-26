import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { CONTROL_HOSTNAME, DEFAULT_CONTROL_PORT, type ControlScope } from './server.js';

export interface PrimaryJoin {
  url: string;
  tokens: Partial<Record<ControlScope, string>>;
}

export interface PrimaryConfig {
  url?: string;
  tokens?: Partial<Record<ControlScope, string>>;
}

export interface PrimaryAddress {
  url: string;
  token: string | undefined;
  source: 'config' | 'join' | 'local';
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
    return { url: address(row.url), tokens: scopedTokens(row.tokens) };
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
}

/** URL precedence is independent of credentials: never send a token to a different address. */
export function resolvePrimary(opts: ResolvePrimaryOptions): PrimaryAddress {
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
  const token = configToken ?? (joinFile?.url === url ? joinFile.tokens[opts.role] : undefined)
    ?? (url === localUrl && joinFile?.url !== url ? localToken(root, opts.role) : undefined);
  return { url, token, source };
}
