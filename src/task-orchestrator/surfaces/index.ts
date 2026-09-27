/**
 * Surface adapter registry helpers.
 *
 * `registerSurfaceAdapters` is the boot-time wire point: pass the
 * callables you have, get back the list of kinds that were registered.
 * Missing callables → the adapter is simply not registered (dispatcher
 * will emit `deferred: [{reason: 'no-adapter'}]` for those kinds).
 */
import type { SurfaceRegistry, SurfaceAdapter } from '../surface-registry.js';
import type { TaskSurfaceKind } from '../types.js';
import { TASK_SURFACE_KINDS } from '../types.js';

import {
  createLlmDirectAdapter,
  type LlmDirectCallable,
} from './llm-direct.js';
import { createSkillAdapter, type SkillCallable } from './skill.js';
import { createChatPromptAdapter, type ChatPromptCallable } from './chat-prompt.js';
import { createTerminalPaneAdapter, type TerminalPaneCallable } from './terminal-pane.js';
import { createSubagentAdapter, type SubagentCallable } from './subagent.js';
import { createCronAdapter, type CronCallable } from './cron.js';
import { createVwSlotAdapter, type VwSlotCallable } from './vw-slot.js';
import { createAcxSessionAdapter, type AcxSessionCallable } from './acx-session.js';
import { createShowroomAdapter, type ShowroomLaneCallable } from './showroom-surface.js';

export interface SurfaceAdapterDeps {
  llmDirect?: LlmDirectCallable;
  externalExec?: SurfaceAdapter;
  skill?: SkillCallable;
  chatPrompt?: ChatPromptCallable;
  terminalPane?: TerminalPaneCallable;
  subagent?: SubagentCallable;
  cron?: CronCallable;
  vwSlot?: VwSlotCallable;
  /** AXON P6 — ACP session callable (external agent or elanous-self).
   *  Production wires `src/acp/dual-role-manager.ts` → AcpAgent prompt
   *  + text-chunk buffering. */
  acxSession?: AcxSessionCallable;
  /** W4 Z3 — multi-model cascade lane runner. Production wires
   *  `src/llm.ts` per-lane streamLLM; tests inject a fake. */
  showroom?: ShowroomLaneCallable;
  /** When true, existing registrations are overwritten. Default: strict
   *  register (throws on duplicate). */
  overwrite?: boolean;
  now?: () => number;
}

/**
 * Register the adapters for which a callable was supplied.
 *
 * Returned kinds are in `TASK_SURFACE_KINDS` order so callers can log
 * a stable summary line. Missing deps are silently skipped — the
 * intended use is "register what this boot context can provide".
 */
export function registerSurfaceAdapters(
  registry: SurfaceRegistry,
  deps: SurfaceAdapterDeps,
): TaskSurfaceKind[] {
  const registered: TaskSurfaceKind[] = [];
  const commit = deps.overwrite
    ? (kind: TaskSurfaceKind, adapter: Parameters<SurfaceRegistry['register']>[1]) =>
        registry.override(kind, adapter)
    : (kind: TaskSurfaceKind, adapter: Parameters<SurfaceRegistry['register']>[1]) =>
        registry.register(kind, adapter);

  for (const kind of TASK_SURFACE_KINDS) {
    switch (kind) {
      case 'llm-direct':
        if (deps.externalExec ?? deps.llmDirect) {
          commit(kind, deps.externalExec ?? createLlmDirectAdapter({ callable: deps.llmDirect!, now: deps.now }));
          registered.push(kind);
        }
        break;
      case 'skill':
        if (deps.skill) {
          commit(kind, createSkillAdapter({ callable: deps.skill, now: deps.now }));
          registered.push(kind);
        }
        break;
      case 'chat-prompt':
        if (deps.chatPrompt) {
          commit(kind, createChatPromptAdapter({ callable: deps.chatPrompt, now: deps.now }));
          registered.push(kind);
        }
        break;
      case 'terminal-pane':
        if (deps.terminalPane) {
          commit(
            kind,
            createTerminalPaneAdapter({ callable: deps.terminalPane, now: deps.now }),
          );
          registered.push(kind);
        }
        break;
      case 'subagent':
        if (deps.subagent) {
          commit(kind, createSubagentAdapter({ callable: deps.subagent, now: deps.now }));
          registered.push(kind);
        }
        break;
      case 'cron':
        if (deps.cron) {
          commit(kind, createCronAdapter({ callable: deps.cron, now: deps.now }));
          registered.push(kind);
        }
        break;
      case 'vw-slot':
        if (deps.vwSlot) {
          commit(kind, createVwSlotAdapter({ callable: deps.vwSlot, now: deps.now }));
          registered.push(kind);
        }
        break;
      case 'acx-session':
        if (deps.acxSession) {
          commit(kind, createAcxSessionAdapter({ callable: deps.acxSession, now: deps.now }));
          registered.push(kind);
        }
        break;
      case 'showroom':
        if (deps.showroom) {
          commit(kind, createShowroomAdapter({ callable: deps.showroom, now: deps.now }));
          registered.push(kind);
        }
        break;
    }
  }
  return registered;
}

export * from './llm-direct.js';
export * from './skill.js';
export * from './chat-prompt.js';
export * from './terminal-pane.js';
export * from './subagent.js';
export * from './cron.js';
export * from './vw-slot.js';
export * from './acx-session.js';
export * from './showroom-surface.js';
export { createProductionAcxSessionCallable } from './acx-session-callable.js';
