import type { WorkflowRunEvent } from '@/nexus/client';

export function latestNodeResult(
  events: ReadonlyArray<WorkflowRunEvent>,
  nodeId: string,
): { ok: boolean; error?: string; durationMs?: number; output?: unknown; pinned?: boolean } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'node_done' && event.nodeId === nodeId && event.result) {
      return event.result;
    }
  }
  return null;
}

export function formatOutput(output: unknown): { text: string; isJson: boolean; truncated: boolean } {
  let text: string;
  let isJson = false;
  if (typeof output === 'string') {
    try {
      text = JSON.stringify(JSON.parse(output), null, 2);
      isJson = true;
    } catch {
      text = output;
    }
  } else {
    try {
      const json = JSON.stringify(output, null, 2);
      text = json ?? String(output);
      isJson = json !== undefined;
    } catch {
      text = String(output);
    }
  }
  return { text: text.slice(0, 4_000), isJson, truncated: text.length > 4_000 };
}
