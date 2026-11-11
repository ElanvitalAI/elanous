import type {
  DisplayMouseEvent,
  DisplayRenderRequest,
  DisplaySnapshot,
  DisplaySurface,
  SurfaceId,
} from './types.js';
import type { TerminalExposureSnapshot } from '../terminal/posture.js';
import type { TerminalInteractionPolicy } from '../terminal/tui-policy.js';

export type DisplayEvent =
  | {
      type: 'surface:mounted';
      surface: DisplaySurface;
    }
  | {
      type: 'surface:disposed';
      surface: DisplaySurface;
    }
  | {
      type: 'focus:change';
      previous: SurfaceId | null;
      next: SurfaceId;
      reason?: string;
    }
  | {
      type: 'render:before';
      request: DisplayRenderRequest;
      snapshot: DisplaySnapshot;
    }
  | {
      type: 'render:after';
      request: DisplayRenderRequest;
      snapshot: DisplaySnapshot;
    }
  | {
      type: 'view:change';
      previous: string | null;
      next: string;
      label?: string;
    }
  | {
      type: 'pane:visibility';
      pane: string;
      visible: boolean;
      reason?: string;
    }
  | {
      type: 'modal:open' | 'modal:close';
      id: string;
      widgetInstanceId?: string;
    }
  | {
      type: 'agent:update' | 'execution:update' | 'agent:tool-call';
      id: string;
      status?: string;
      payload?: unknown;
    }
  | {
      // Wave P4a-1 — workflow run lifecycle bridged from
      // WorkflowRunner.subscribe so chat-surface presentation
      // (typed background pill) refreshes in real time instead of
      // polling the runner's listRuns() at draw time.
      type: 'workflow:update';
      runId: string;
      workflowId: string;
      status: 'running' | 'done' | 'aborted' | 'error';
      payload?: unknown;
    }
  | {
      // Wave P4a-1 — scheduler store mutation lifecycle. Fires on
      // upsertJob / deleteJob / updateRun so the active count in the
      // background pill reflects active jobs without polling.
      type: 'scheduler:update';
      taskId: string;
      kind: 'job-upsert' | 'job-delete' | 'run-start' | 'run-end';
      status?: string;
      payload?: unknown;
    }
  | {
      type: 'terminal:mouse-intent';
      surfaceId: string;
      paneKind: 'terminal' | 'external-terminal' | 'preview-terminal';
      mouseType: DisplayMouseEvent['type'];
      row: number;
      col: number;
      transport: 'pty-forward' | 'host-only';
      exposure: TerminalExposureSnapshot;
      interactionPolicy: TerminalInteractionPolicy;
    };

export interface DisplayEventBus {
  emit(event: DisplayEvent): void;
  subscribe(
    type: DisplayEvent['type'] | '*',
    listener: (event: DisplayEvent) => void,
  ): { dispose(): void };
  /** Returns true when at least one listener is registered for this
   *  exact type (or the wildcard '*'). Callers use this to skip
   *  expensive payload construction when nobody cares. Hot-path cost
   *  is two Map.get calls + two nil-or-size checks — faster than
   *  building and emitting an unused event. */
  hasSubscribers(type: DisplayEvent['type']): boolean;
}

export function createDisplayEventBus(): DisplayEventBus {
  const listeners = new Map<string, Set<(event: DisplayEvent) => void>>();
  return {
    emit(event) {
      const exact = listeners.get(event.type);
      const all = listeners.get('*');
      if (!exact && !all) return;
      for (const listener of [...(exact ?? []), ...(all ?? [])]) {
        try { listener(event); } catch { /* display hooks must not break rendering */ }
      }
    },
    subscribe(type, listener) {
      const set = listeners.get(type) ?? new Set<(event: DisplayEvent) => void>();
      set.add(listener);
      listeners.set(type, set);
      return {
        dispose: () => {
          set.delete(listener);
          if (set.size === 0) listeners.delete(type);
        },
      };
    },
    hasSubscribers(type) {
      const exact = listeners.get(type);
      const all = listeners.get('*');
      return (exact?.size ?? 0) > 0 || (all?.size ?? 0) > 0;
    },
  };
}
