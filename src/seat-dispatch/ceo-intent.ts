import { runGh } from '../decisions/decision-cards.js';
import { openMsgStore } from '../msg/msg-store.js';
import type { UserConfig } from '../user-config.js';
import type { CeoCommandDeps } from './ceo-commands.js';

/** Endings are ordered from explicit punctuation to Korean question endings. Every row has a test example. */
export const CEO_QUESTION_ENDINGS = [
  /[?？]$/,
  /야$/,
  /니$/,
  /나요$/,
  /까요$/,
  /인가요$/,
  /어때$/,
  /알려\s?줘$/,
  /보여줘$/,
  /상황$/,
  /어디까지$/,
] as const;

export function classifyCeoIntent(text: string): 'question' | 'task' {
  const body = text.trim();
  return CEO_QUESTION_ENDINGS.some((ending) => ending.test(body)) ? 'question' : 'task';
}

/** The same channel + seat inbox delivery dependencies used by /coo, /cto, /cmo and /cxo. */
export function ceoTaskDeps(cfg: UserConfig, ownerId: string | null): CeoCommandDeps {
  const replyTarget = (cfg.raw?.decisions as { replyGhPr?: unknown } | undefined)?.replyGhPr;
  return {
    ownerId,
    replyTarget: typeof replyTarget === 'string' ? replyTarget : null,
    runGh,
    append: (message) => {
      const store = openMsgStore();
      try { return store.append(message); } finally { store.close(); }
    },
  };
}
