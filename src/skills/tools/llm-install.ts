import type { LLMToolSpec } from '../../llm/tool-spec.js';
// H6 P2 Bundle 2 B · LlmRequestInstall LLM tool.
//
// Single T2 mutating tool that downloads a model to a target node
// behind a HITL gate. Supports LM Studio (`lms get`) and Ollama
// (`ollama pull`). Booter/shutdown tools are intentionally not
// included — `lms chat` and `ollama run` auto-load, and PTY dispose
// handles shutdown (see PLAN D24).
//
// Output contract matches the rest of the H6 family:
//   `{ output: string; metadata: object; isError?: true }`.


import {
  requestInstall,
  type InstallerDeps,
  type InstallResult,
} from '../../llm/local-manager/installer.js';
import type { LlmRuntime } from '../../llm/local-manager/types.js';

export interface LlmRequestInstallArgs {
  nodeId: string;
  runtime: LlmRuntime;
  modelName: string;
  /** Optional · when provided, triggers the disk precheck (D26). */
  estimatedSizeBytes?: number;
  confirmTimeoutMs?: number;
  installTimeoutMs?: number;
}

export interface LlmRequestInstallResult {
  output: string;
  metadata: {
    ok: boolean;
    nodeId: string;
    runtime: LlmRuntime;
    modelName: string;
    elapsedMs: number;
    reason?: string;
    diskFreeBytesBefore?: number | undefined;
  };
  isError?: true;
}

export function buildLlmRequestInstallTool(): LLMToolSpec {
  return {
    name: 'LlmRequestInstall',
    description:
      'Download a local LLM model onto a node (LM Studio via `lms get` · Ollama via `ollama pull`). ' +
      'T2 mutating · blocks behind a HITL confirmation (Telegram/Discord/Pushcut/terminal race) ' +
      'and a disk-space precheck when `estimatedSizeBytes` is provided (reject if free < size × 1.5). ' +
      'On success, manager inventory is refreshed so the new model surfaces in `/llm models` and ' +
      '`local-llm:<node>:<model>` outer-LLM routing + `/acp-vw lll <spec>` embodied sessions. ' +
      'Typical install takes 5–30 minutes depending on size and network — default timeout 30 min.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description:
            "Target node id (e.g. 'local', 'mbp', 'node-b'). Must be in the fleet and currently reachable; run /llm nodes to list.",
        },
        runtime: {
          type: 'string',
          enum: ['lmstudio', 'ollama'],
          description:
            "Which runtime will host the model. 'lmstudio' → `lms get <model>` · 'ollama' → `ollama pull <model>`.",
        },
        modelName: {
          type: 'string',
          description:
            "Model identifier in the runtime's registry. Examples: 'lmstudio-community/qwen2.5-32b-instruct-mlx' · 'llama3.1:8b'.",
        },
        estimatedSizeBytes: {
          type: 'number',
          description:
            'Optional · expected download size in bytes. Triggers a `df` precheck requiring free × 1.5 headroom. Omit to skip precheck (warning-only).',
        },
        confirmTimeoutMs: {
          type: 'number',
          description: 'HITL confirmation timeout in ms (default 120_000).',
        },
        installTimeoutMs: {
          type: 'number',
          description: 'Download command timeout in ms (default 1_800_000 = 30 min).',
        },
      },
      required: ['nodeId', 'runtime', 'modelName'],
      additionalProperties: false,
    },
  };
}

export async function dispatchLlmRequestInstall(
  rawArgs: Record<string, unknown>,
  deps: InstallerDeps = {},
): Promise<LlmRequestInstallResult> {
  const nodeId = typeof rawArgs.nodeId === 'string' ? rawArgs.nodeId.trim() : '';
  const runtime = typeof rawArgs.runtime === 'string' ? rawArgs.runtime.trim() : '';
  const modelName = typeof rawArgs.modelName === 'string' ? rawArgs.modelName.trim() : '';
  if (!nodeId || !runtime || !modelName) {
    return errorResult(
      nodeId || '(unset)',
      (runtime as LlmRuntime) || 'lmstudio',
      modelName || '(unset)',
      'bad-args',
      "missing required arg(s): 'nodeId', 'runtime', 'modelName'",
    );
  }
  if (runtime !== 'lmstudio' && runtime !== 'ollama') {
    return errorResult(
      nodeId,
      runtime as LlmRuntime,
      modelName,
      'unsupported-runtime',
      `runtime '${runtime}' not supported · use 'lmstudio' or 'ollama' (Bundle 2 B)`,
    );
  }

  const result = await requestInstall(
    {
      nodeId,
      runtime,
      modelName,
      ...(typeof rawArgs.estimatedSizeBytes === 'number'
        ? { estimatedSizeBytes: rawArgs.estimatedSizeBytes }
        : {}),
      ...(typeof rawArgs.confirmTimeoutMs === 'number'
        ? { confirmTimeoutMs: rawArgs.confirmTimeoutMs }
        : {}),
      ...(typeof rawArgs.installTimeoutMs === 'number'
        ? { installTimeoutMs: rawArgs.installTimeoutMs }
        : {}),
    },
    deps,
  );

  return formatResult(result);
}

function formatResult(r: InstallResult): LlmRequestInstallResult {
  if (r.ok) {
    const lines: string[] = [];
    lines.push(
      `LlmRequestInstall ✓ installed '${r.modelName}' via ${r.runtime} on ${r.nodeId} · ${formatDuration(r.elapsedMs)}`,
    );
    if (typeof r.diskFreeBytesBefore === 'number') {
      lines.push(`  • free before: ${formatGb(r.diskFreeBytesBefore)} GB`);
    }
    lines.push(`  • manager cache refreshed · /llm models to verify`);
    return {
      output: lines.join('\n'),
      metadata: {
        ok: true,
        nodeId: r.nodeId,
        runtime: r.runtime,
        modelName: r.modelName,
        elapsedMs: r.elapsedMs,
        ...(typeof r.diskFreeBytesBefore === 'number'
          ? { diskFreeBytesBefore: r.diskFreeBytesBefore }
          : {}),
      },
    };
  }
  const message = `LlmRequestInstall ✗ ${r.reason} · ${r.message}`;
  return {
    output: message,
    metadata: {
      ok: false,
      nodeId: r.nodeId,
      runtime: r.runtime,
      modelName: r.modelName,
      elapsedMs: r.elapsedMs,
      reason: r.reason,
    },
    isError: true,
  };
}

function errorResult(
  nodeId: string,
  runtime: LlmRuntime,
  modelName: string,
  reason: string,
  message: string,
): LlmRequestInstallResult {
  return {
    output: `LlmRequestInstall ✗ ${reason} · ${message}`,
    metadata: {
      ok: false,
      nodeId,
      runtime,
      modelName,
      elapsedMs: 0,
      reason,
    },
    isError: true,
  };
}

function formatGb(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m${rem}s`;
}
