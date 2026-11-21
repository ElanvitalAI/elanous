import { openMsgStore, defaultMsgStorePath } from '../msg/msg-store.js';
import { ceoReplyProofRef, type CeoReplyBinding } from '../els/ceo-reply-proof.js';

export type CeoTurnRef = Pick<CeoReplyBinding, 'source' | 'threadId' | 'messageId' | 'ingressId'>;

/** An authenticated ingress frame, never text parsed from the prompt, owns this reply. */
export function postCeoTurnReply(binding: CeoReplyBinding, body: string, secret: string,
  path: string = defaultMsgStorePath()): boolean {
  if (binding.source !== 'telegram' || !body.trim() || !/^[0-9a-f]{64}$/.test(secret)) return false;
  const store = openMsgStore(path);
  try {
    const chatRef = `telegram-chat:${binding.threadId}`;
    const messageRef = `telegram-message:${binding.messageId}`;
    const parent = store.db.query(`SELECT id FROM msg_messages
      WHERE sender = 'CEO' AND recipient = 'OP'
        AND CASE WHEN json_valid(refs_json) THEN
          EXISTS (SELECT 1 FROM json_each(refs_json) WHERE value = ?)
          AND EXISTS (SELECT 1 FROM json_each(refs_json) WHERE value = ?)
        ELSE 0 END
      ORDER BY id DESC LIMIT 1`).get(chatRef, messageRef) as { id: number } | null;
    if (!parent) return false;
    const proof = ceoReplyProofRef(binding, parent.id, body, secret);
    store.post({ from: 'OP', to: 'CEO', replyTo: parent.id, body, kind: 'reply', refs: [proof] }, { dedupe: true });
    return true;
  } finally { store.close(); }
}
