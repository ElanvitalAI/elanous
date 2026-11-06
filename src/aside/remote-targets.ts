/** Aside remote target registry, deterministic selection, and MCP routing. */
import { redactSecretText, redactSecrets } from '../debug/log.js';

export type AsideCapability = 'browser' | 'repl' | 'selection';

export interface AsideRemoteTarget {
  id: string;
  host: string;
  command: string[];
  enabled?: boolean;
  capabilities: AsideCapability[];
}

export interface AsideTargetPreferences {
  defaultTargetId?: string;
  contextDefaults?: Record<string, string>;
}

export interface AsideTargetRequest {
  targetId?: string;
  context?: string;
  capability?: AsideCapability;
}

export interface AsideTargetHealth {
  online: boolean;
  authenticated: boolean;
}

export type AsideTargetResolution =
  | { ok: true; target: AsideRemoteTarget; source: 'explicit' | 'context' | 'global' | 'automatic' }
  | { ok: false; reason: 'unknown-target' | 'disabled' | 'offline' | 'authentication-failed' | 'no-capable-target' | 'ambiguous'; candidates?: string[] };

const TARGET_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const HOST_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

export function validateAsideTargets(value: unknown): AsideRemoteTarget[] {
  if (!Array.isArray(value)) throw new Error('aside.targets must be an array');
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`aside.targets[${index}] must be an object`);
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== 'string' || !TARGET_ID.test(row.id) || ids.has(row.id)) throw new Error(`aside.targets[${index}].id is invalid or duplicated`);
    if (typeof row.host !== 'string' || !HOST_ALIAS.test(row.host)) throw new Error(`aside.targets[${index}].host must be an SSH host alias`);
    if (!Array.isArray(row.command) || row.command.length === 0 || row.command.some(part => typeof part !== 'string' || part.length === 0 || /[\r\n\0]/.test(part))) {
      throw new Error(`aside.targets[${index}].command must be a non-empty argv array`);
    }
    if (row.enabled !== undefined && typeof row.enabled !== 'boolean') throw new Error(`aside.targets[${index}].enabled must be boolean`);
    if (!Array.isArray(row.capabilities) || row.capabilities.length === 0 || row.capabilities.some(cap => !['browser', 'repl', 'selection'].includes(String(cap)))) {
      throw new Error(`aside.targets[${index}].capabilities is invalid`);
    }
    ids.add(row.id);
    return { id: row.id, host: row.host, command: [...row.command] as string[], enabled: row.enabled as boolean | undefined, capabilities: [...new Set(row.capabilities as AsideCapability[])] };
  });
}

/** OpenSSH passes a single remote command string; quote every argv item for POSIX sh. */
export function asideTargetSshCommand(target: AsideRemoteTarget): string[] {
  const quote = (part: string) => `'${part.replaceAll("'", "'\\''")}'`;
  return ['ssh', '-T', target.host, target.command.map(quote).join(' ')];
}

function status(target: AsideRemoteTarget, health: ReadonlyMap<string, AsideTargetHealth>): 'ready' | 'offline' | 'authentication-failed' {
  const current = health.get(target.id);
  if (!current?.online) return 'offline';
  return current.authenticated ? 'ready' : 'authentication-failed';
}

/** Selection is pure and request-scoped; it never mutates shared defaults. */
export function resolveAsideTarget(
  targets: readonly AsideRemoteTarget[],
  request: AsideTargetRequest,
  preferences: AsideTargetPreferences,
  health: ReadonlyMap<string, AsideTargetHealth>,
): AsideTargetResolution {
  const capable = (target: AsideRemoteTarget) => !request.capability || target.capabilities.includes(request.capability);
  const requestedId = request.targetId
    ?? (request.context ? preferences.contextDefaults?.[request.context] : undefined)
    ?? preferences.defaultTargetId;
  const source: 'explicit' | 'context' | 'global' = request.targetId ? 'explicit'
    : request.context && preferences.contextDefaults?.[request.context] ? 'context' : 'global';
  if (requestedId) {
    const target = targets.find(item => item.id === requestedId);
    if (!target) return { ok: false, reason: 'unknown-target' };
    if (target.enabled === false) return { ok: false, reason: 'disabled' };
    if (!capable(target)) return { ok: false, reason: 'no-capable-target' };
    const state = status(target, health);
    if (state !== 'ready') return { ok: false, reason: state };
    return { ok: true, target, source };
  }
  const candidates = targets.filter(target => target.enabled !== false && capable(target) && status(target, health) === 'ready');
  if (candidates.length === 0) return { ok: false, reason: 'no-capable-target' };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous', candidates: candidates.map(item => item.id).sort() };
  return { ok: true, target: candidates[0]!, source: 'automatic' };
}

export interface AsideTargetClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface AsideRemoteRouter {
  call(name: string, args: Record<string, unknown>, request: AsideTargetRequest): Promise<unknown>;
}

let activeRemoteRouter: AsideRemoteRouter | undefined;
let remoteTargetsConfigured = false;
let remoteConfigOwner: object | undefined;
let activeRouterOwner: object | undefined;

/** Set before asynchronous MCP bootstrap so calls fail closed while targets initialize. */
export function setAsideRemoteTargetsConfigured(configured: boolean, owner?: object): void {
  if (configured) {
    beginAsideRemoteTargetsConfiguration(true, owner ?? {});
    return;
  }
  if (owner && remoteConfigOwner !== owner) return;
  remoteTargetsConfigured = configured;
  remoteConfigOwner = undefined;
  activeRemoteRouter = undefined;
  activeRouterOwner = undefined;
}

/** Start a new boot generation, including an explicit configuration with no remote targets. */
export function beginAsideRemoteTargetsConfiguration(configured: boolean, owner: object): void {
  remoteConfigOwner = owner;
  remoteTargetsConfigured = configured;
  // A previous generation must not serve calls during this boot transition.
  activeRemoteRouter = undefined;
  activeRouterOwner = undefined;
}

export function areAsideRemoteTargetsConfigured(): boolean {
  return remoteTargetsConfigured;
}

/** Installed by MCP bootstrap and removed with the owning client handle. */
export function setAsideRemoteRouter(router: AsideRemoteRouter | undefined, owner?: AsideRemoteRouter, generation?: object): void {
  if (generation && generation !== remoteConfigOwner) return;
  if (router === undefined && owner && activeRemoteRouter !== owner) return;
  if (router === undefined && generation && activeRouterOwner !== generation) return;
  activeRemoteRouter = router;
  activeRouterOwner = router ? generation : undefined;
}

export function getAsideRemoteRouter(): AsideRemoteRouter | undefined {
  return activeRemoteRouter;
}

/** Routes the selected tool name to exactly one target client. */
export function createAsideRemoteRouter(options: {
  targets: readonly AsideRemoteTarget[];
  preferences: AsideTargetPreferences;
  strictRedactMode?: boolean;
  health: () => ReadonlyMap<string, AsideTargetHealth>;
  clients: ReadonlyMap<string, AsideTargetClient>;
}): AsideRemoteRouter {
  return {
    async call(name, args, request) {
      const resolution = resolveAsideTarget(options.targets, request, options.preferences, options.health());
      if (!resolution.ok) {
        // Never include raw child-process/MCP errors here: they may contain remote environment details.
        throw new Error(`Aside target ${resolution.reason}${resolution.candidates ? `: ${resolution.candidates.join(', ')}` : ''}`);
      }
      const client = options.clients.get(resolution.target.id);
      if (!client) throw new Error(`Aside target ${resolution.target.id} offline`);
      const remoteName = name === 'aside.repl' ? 'exec' : name;
      try {
        // Default behavior masks known secret patterns only. The opt-in strict mode
        // also masks high-entropy strings in the returned body for callers who prefer it.
        const result = redactSecrets(await client.callTool(remoteName, args));
        return options.strictRedactMode ? redactAsideHighEntropyValue(result) : result;
      } catch {
        // SSH/MCP errors may contain remote stderr or environment details; surface only a safe class.
        throw new Error(`Aside target ${resolution.target.id} unavailable`);
      }
    },
  };
}

/** Scrub standard and bounded high-entropy candidates on observability paths. */
export function sanitizeAsideObservabilityText(input: string): string {
  let out = redactSecretText(input).replace(
    /\b(?:bearer\s+)?(?:token|secret|api[_-]?key)\b(?:\s*[:=]\s*|[-_ ]+)[A-Za-z0-9._~+\/-]{4,}/gi,
    '[REDACTED]',
  );
  // Selection URLs are never useful in logs; source identity is recorded as a hash separately.
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL_REDACTED]');
  return redactAsideHighEntropyText(out);
}

function redactAsideHighEntropyText(input: string): string {
  const redactCandidate = (candidate: string): string => {
    const entropyInput = candidate.replace(/=+$/, '');
    const counts = new Map<string, number>();
    for (const char of entropyInput) counts.set(char, (counts.get(char) ?? 0) + 1);
    const entropy = [...counts.values()].reduce((sum, count) => {
      const probability = count / entropyInput.length;
      return sum - probability * Math.log2(probability);
    }, 0);
    const classes = Number(/[a-z]/.test(entropyInput)) + Number(/[A-Z]/.test(entropyInput))
      + Number(/[0-9]/.test(entropyInput)) + Number(/[_+/-]/.test(entropyInput));
    return entropy >= 3.35 && (classes >= 2 || counts.size >= 11) ? '[REDACTED]' : candidate;
  };
  // Treat standard/URL-safe Base64 alphabet as one candidate so `/` and `+`
  // do not split a token into harmless-looking fragments.
  const base64Aware = input.replace(
    /(?<![A-Za-z0-9_+/-])([A-Za-z0-9_+/-]{12,}(?:={1,2})?)(?![A-Za-z0-9_+/-])/g,
    redactCandidate,
  );
  // A long low-entropy segment can lower the combined score of a secret after
  // `/`; scan ordinary opaque tokens again so the high-entropy suffix survives
  // that separator boundary as an independently redacted candidate.
  return base64Aware.replace(/(?<![A-Za-z0-9])([A-Za-z0-9_-]{12,})(?![A-Za-z0-9])/g, redactCandidate);
}

function redactAsideHighEntropyValue(value: unknown): unknown {
  if (typeof value === 'string') return redactAsideHighEntropyText(value);
  if (Array.isArray(value)) return value.map(item => redactAsideHighEntropyValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, redactAsideHighEntropyValue(child)]));
  }
  return value;
}

export function sanitizeAsideObservabilityValue(value: unknown, key = ''): unknown {
  if (/(?:^|[_-])(?:token|secret|password|authorization|api[_-]?key)(?:$|[_-])/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return sanitizeAsideObservabilityText(value);
  if (Array.isArray(value)) return value.map(item => sanitizeAsideObservabilityValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, sanitizeAsideObservabilityValue(child, childKey)]));
  }
  return value;
}
