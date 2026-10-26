import { join } from 'node:path';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { resolveConfiguredAgentRoleLlm } from '../../user-config.js';
import type { RoleLlmSpec } from '../../user-config.js';
import { loadAgentRolePack } from '../agent-reply.js';
import type { MsgStore } from '../../msg/msg-store.js';
import { runAskOpContextInbox, runCoordinatorAgentInbox, type CoordinatorInboxResult } from './inbox.js';
import type { AskOpContextBundle } from '../../context-bus/context-now.js';

export interface InboxOnceOptions {
  root?: string;
  store?: MsgStore;
  role?: RoleLlmSpec | null;
  limit?: number;
  context?: (question: string, options: { audience?: string; limit?: number }) => Promise<AskOpContextBundle>;
}

/** One scan of the same durable inbox as the orchestrator tick, without running its graph. */
export async function runCoordinatorInboxOnce(options: InboxOnceOptions = {}): Promise<CoordinatorInboxResult> {
  const root = options.root ?? effectiveInstanceRoot();
  const path = join(root, 'msg', 'messages.db');
  const role = options.role === undefined ? resolveConfiguredAgentRoleLlm('coordinator') : options.role;
  if (role) return runCoordinatorAgentInbox({ role, pack: loadAgentRolePack('coordinator'), root, path,
    limit: options.limit ?? 100, ...(options.store ? { store: options.store } : {}) });
  return runAskOpContextInbox({ path, limit: options.limit ?? 100,
    ...(options.store ? { store: options.store } : {}),
    ...(options.context ? { context: options.context } : {}) });
}
