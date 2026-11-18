// One place to find the local Nexus the way the CLI does (#38260 REVIEW-2 ①): the address (ELANOUS_NEXUS_URL, else the
// runtime sidecar's own host and port — not a fixed 127.0.0.1) and the token file (the same config-dir path
// ensureAuthToken uses). Read-only: nothing here creates a token.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { readNexusRuntime, type NexusRuntimeMeta } from './runtime.js';

/** The base URL of the local Nexus, or undefined when there is none to talk to. */
export function localNexusBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  runtime: Pick<NexusRuntimeMeta, 'httpHost' | 'httpPort'> | null = readNexusRuntime(),
): string | undefined {
  const explicit = env.ELANOUS_NEXUS_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  if (!runtime?.httpPort) return undefined;
  // A wildcard bind (all interfaces) is reached on loopback; a named host is used as it is.
  const host = !runtime.httpHost || runtime.httpHost === '0.0.0.0' || runtime.httpHost === '::' ? '127.0.0.1' : runtime.httpHost;
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${bracketed}:${runtime.httpPort}`;
}

/** Where ensureAuthToken keeps the token (same config dir), so a reader and the CLI never look in different places. */
export function localNexusTokenPath(configDir: string = getElanousConfigDir()): string {
  return join(configDir, 'acp-token');
}

/** The token if it exists; never created here. */
export function readLocalNexusToken(configDir?: string): string | undefined {
  try { return readFileSync(localNexusTokenPath(configDir), 'utf-8').trim() || undefined; } catch { return undefined; }
}
