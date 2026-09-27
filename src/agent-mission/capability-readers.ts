import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import type { CapabilityEntry } from './capability-types.js';
import type { CapabilityReaders } from './capability-matrix.js';

export type CapabilityRun = (command: string, args: readonly string[]) => { stdout?: string; stderr?: string; status?: number | null; error?: Error };

const defaultRun: CapabilityRun = (command, args) => spawnSync(command, [...args], {
  encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024,
});

function unknown(backend: CapabilityEntry['backend'], detail: string): CapabilityEntry[] {
  return [{ backend, service: '*', state: 'unknown', detail }];
}

function listed(backend: CapabilityEntry['backend'], entries: CapabilityEntry[]): CapabilityEntry[] {
  debug.log('agent-mission.capabilities', 'listed', { backend, entries: entries.length });
  return entries;
}

function probe(backend: 'codex' | 'claude', run: CapabilityRun, args: readonly string[] = ['mcp', 'list']): string | CapabilityEntry[] {
  let result: ReturnType<CapabilityRun>;
  try { result = run(backend, args); }
  catch (error) { return unknown(backend, String(error)); }
  if (result.error || result.status !== 0) return unknown(backend, result.error?.message ?? result.stderr ?? 'CLI unavailable');
  return result.stdout ?? '';
}

type CodexServer = { name?: unknown; enabled?: unknown; auth_status?: unknown; transport?: { type?: unknown } };

/**
 * `codex mcp list` prints one table per transport (stdio, then HTTP) with different columns,
 * so the second header parsed as a server row (2026-09-27 real output). `--json` is one array
 * with `enabled` and `auth_status` — read that. Env and headers are never copied into detail.
 */
export function listCodexCapabilities(run: CapabilityRun = defaultRun): CapabilityEntry[] {
  const result = probe('codex', run, ['mcp', 'list', '--json']);
  if (typeof result !== 'string') return listed('codex', result);
  if (/no mcp servers configured/i.test(result)) return listed('codex', []);
  let servers: unknown;
  try { servers = JSON.parse(result); } catch { return listed('codex', unknown('codex', 'unrecognized list output')); }
  if (!Array.isArray(servers)) return listed('codex', unknown('codex', 'unrecognized list output'));
  const entries: CapabilityEntry[] = (servers as CodexServer[]).map((server) => {
    const name = typeof server.name === 'string' ? server.name : '';
    const auth = typeof server.auth_status === 'string' ? server.auth_status : 'unknown';
    const transport = typeof server.transport?.type === 'string' ? server.transport.type : 'unknown';
    const state = server.enabled === false || auth === 'not_logged_in' ? 'unavailable'
      : server.enabled === true ? 'ready' : 'unknown';
    const why = server.enabled === false ? 'disabled' : auth === 'not_logged_in' ? 'not logged in' : `auth=${auth}`;
    return { backend: 'codex', service: name, state: name ? state : 'unknown', detail: `${transport} · ${why}` };
  });
  return listed('codex', entries);
}

export function listClaudeCapabilities(run: CapabilityRun = defaultRun): CapabilityEntry[] {
  const result = probe('claude', run);
  if (typeof result !== 'string') return listed('claude', result);
  if (/no mcp servers configured/i.test(result)) return listed('claude', []);
  const lines = result.trim().split(/\r?\n/).filter(line => line.trim() && !/^Checking MCP server health(?:\.\.\.|…)\s*$/i.test(line.trim()));
  if (!lines.length || lines.some(line => !/^\s*[^:]+:\s+.+\s+-\s+(?:[✓✔✗✘⚠]\s*)?(Connected|Failed to connect|Needs authentication)\s*$/i.test(line))) {
    return listed('claude', unknown('claude', 'unrecognized list output'));
  }
  return listed('claude', lines.map(line => ({
    backend: 'claude', service: line.split(':')[0]!.trim(),
    state: / - (?:[✓✔]\s*)?Connected\s*$/i.test(line) ? 'ready' : 'unavailable', detail: line,
  })));
}

export function listGrokCapabilities(): CapabilityEntry[] {
  return listed('grok', unknown('grok', 'managed connectors cannot be listed'));
}

export function createCapabilityReaders(run: CapabilityRun = defaultRun): CapabilityReaders {
  return {
    codex: () => listCodexCapabilities(run),
    claude: () => listClaudeCapabilities(run),
    grok: () => listGrokCapabilities(),
  };
}
