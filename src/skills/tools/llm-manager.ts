import type { LLMToolSpec } from '../../llm/tool-spec.js';
// H6 P2 Bundle 1 · Local LLM Manager LLM tools.
//
// 2 read-only T1 tools for surfacing the Tailscale fleet inventory:
//   - LlmListNodes — which elanous hosts are reachable + which runtimes
//     they expose (Bundle 1 = LM Studio only)
//   - LlmListAvailableModels — which LLM weights are on each node
//
// Install/boot/Intel tools live in Bundle 2 (see PLAN §3.A.1).
// Output contract matches the rest of the H6 family:
//   `{ output: string; metadata: object; isError?: true }`.


import {
  getInventory,
  refreshInventory,
  type ManagerDeps,
} from '../../llm/local-manager/manager.js';
import type {
  LlmModel,
  LlmNode,
} from '../../llm/local-manager/types.js';

// ─── LlmListNodes ───────────────────────────────────────────────────

export interface LlmListNodesMetadata {
  nodes: LlmNode[];
  reachableCount: number;
  totalCount: number;
  cached: boolean;
  at: number;
  warnings: readonly string[];
}

export interface LlmListNodesResult {
  output: string;
  metadata: LlmListNodesMetadata;
  isError?: true;
}

export interface LlmListNodesArgs {
  /** Force refresh · bypass 5 min staleness cache. */
  refresh?: boolean;
}

export function buildLlmListNodesTool(): LLMToolSpec {
  return {
    name: 'LlmListNodes',
    description:
      'Enumerate known local-LLM nodes in the Tailscale fleet (elanous host + ssh-configured peers). ' +
      'Returns reachability + which runtimes are available per node (Bundle 1 = LM Studio only). ' +
      'Read-only · safe to call repeatedly · results cached for 5 minutes; pass `refresh:true` to force a probe.',
    parameters: {
      type: 'object',
      properties: {
        refresh: {
          type: 'boolean',
          description: 'Force a fresh probe (bypass 5 min staleness cache). Default false.',
        },
      },
      additionalProperties: false,
    },
  };
}

export async function dispatchLlmListNodes(
  rawArgs: Record<string, unknown>,
  deps: ManagerDeps = {},
): Promise<LlmListNodesResult> {
  const refresh = rawArgs.refresh === true;
  const inv = refresh ? await refreshInventory(deps) : await getInventory(deps);
  const reachable = inv.nodes.filter((n) => n.reachable).length;
  const lines: string[] = [];
  lines.push(
    `LlmListNodes: ${inv.nodes.length} node(s) · ${reachable} reachable · ${inv.cached ? 'cached' : 'fresh'}`,
  );
  for (const n of inv.nodes) {
    const status = n.reachable === undefined
      ? '(not probed)'
      : n.reachable ? 'reachable' : 'offline';
    const runtimes = n.runtimes.length > 0 ? n.runtimes.join(',') : '—';
    const url = n.lmstudioBaseUrl ? ` · ${n.lmstudioBaseUrl}` : '';
    const host = n.isLocal ? '' : ` · ssh ${n.sshHost ?? n.id}`;
    lines.push(`  ${n.id} · ${status} · runtimes=${runtimes}${url}${host}`);
  }
  if (inv.warnings.length > 0) {
    lines.push(`  warnings: ${inv.warnings.slice(0, 6).join(', ')}${inv.warnings.length > 6 ? '…' : ''}`);
  }
  return {
    output: lines.join('\n'),
    metadata: {
      nodes: inv.nodes.map((n) => ({ ...n })),
      reachableCount: reachable,
      totalCount: inv.nodes.length,
      cached: inv.cached,
      at: inv.at,
      warnings: [...inv.warnings],
    },
  };
}

// ─── LlmListAvailableModels ─────────────────────────────────────────

export interface LlmListAvailableModelsMetadata {
  models: LlmModel[];
  countByNode: Readonly<Record<string, number>>;
  at: number;
  cached: boolean;
  filteredBy?: { node?: string };
  warnings: readonly string[];
}

export interface LlmListAvailableModelsResult {
  output: string;
  metadata: LlmListAvailableModelsMetadata;
  isError?: true;
}

export interface LlmListAvailableModelsArgs {
  /** Optional node filter · `'local'` · `'mbp'` · etc. */
  node?: string;
  /** Force refresh · bypass 5 min staleness cache. */
  refresh?: boolean;
}

export function buildLlmListAvailableModelsTool(): LLMToolSpec {
  return {
    name: 'LlmListAvailableModels',
    description:
      'List LLM model weights discoverable on the Tailscale fleet (Bundle 1 = LM Studio only). ' +
      'Returns `{id, nodeId, runtime, label, sizeBytes?, format?, loaded?}` per model. Use the `id` as the ' +
      'model arg when calling a local LLM: pass `local-llm:<nodeId>:<modelId>` to `streamLLM` / elanous tool. ' +
      'Optional `node` filter narrows to a single host. Read-only · cached 5 minutes.',
    parameters: {
      type: 'object',
      properties: {
        node: {
          type: 'string',
          description: 'Restrict output to a single node id (from LlmListNodes). Optional.',
        },
        refresh: {
          type: 'boolean',
          description: 'Force a fresh probe. Default false.',
        },
      },
      additionalProperties: false,
    },
  };
}

export async function dispatchLlmListAvailableModels(
  rawArgs: Record<string, unknown>,
  deps: ManagerDeps = {},
): Promise<LlmListAvailableModelsResult> {
  const refresh = rawArgs.refresh === true;
  const nodeFilterRaw = typeof rawArgs.node === 'string' ? rawArgs.node.trim() : '';
  const nodeFilter = nodeFilterRaw.length > 0 ? nodeFilterRaw : undefined;
  const inv = refresh ? await refreshInventory(deps) : await getInventory(deps);
  const filtered = nodeFilter
    ? inv.models.filter((m) => m.nodeId.toLowerCase() === nodeFilter.toLowerCase())
    : [...inv.models];
  const countByNode: Record<string, number> = {};
  for (const m of filtered) {
    countByNode[m.nodeId] = (countByNode[m.nodeId] ?? 0) + 1;
  }

  const lines: string[] = [];
  const header = nodeFilter
    ? `LlmListAvailableModels: ${filtered.length} model(s) on node '${nodeFilter}'`
    : `LlmListAvailableModels: ${filtered.length} model(s) across ${Object.keys(countByNode).length} node(s)`;
  lines.push(header);
  if (filtered.length === 0) {
    lines.push('  (empty · run /llm refresh or check node reachability)');
  } else {
    for (const m of filtered) {
      const size = m.sizeBytes !== undefined
        ? ` · ${formatBytes(m.sizeBytes)}`
        : '';
      const loaded = m.loaded ? ' · loaded' : '';
      const format = m.format ? ` · ${m.format}` : '';
      lines.push(`  local-llm:${m.nodeId}:${m.id}${size}${loaded}${format}`);
    }
  }
  if (inv.warnings.length > 0) {
    lines.push(`  warnings: ${inv.warnings.slice(0, 6).join(', ')}${inv.warnings.length > 6 ? '…' : ''}`);
  }

  return {
    output: lines.join('\n'),
    metadata: {
      models: filtered.map((m) => ({ ...m })),
      countByNode,
      at: inv.at,
      cached: inv.cached,
      ...(nodeFilter ? { filteredBy: { node: nodeFilter } } : {}),
      warnings: [...inv.warnings],
    },
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

// ─── Bootstrap ──────────────────────────────────────────────────────

/** Parity with other H6 init calls · lazy: manager is instantiated
 *  on first dispatch. No explicit warm-up so dashboard boot stays
 *  fast; users can `/llm refresh` when they need up-to-date data. */
export function initLlmManagerTools(): void {
  // Intentionally empty · see parity comment above.
}
