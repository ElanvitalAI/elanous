import { openMsgStore, type Message, type MsgStore } from '../../msg/msg-store.js';
import { classifySeatTrafficProposal } from '../../seat-loop/traffic-signal.js';
import { debug } from '../../debug/log.js';

const RECIPIENT = 'COORDINATOR';

export interface CoordinatorInboxResult { replied: number; acknowledged: number }

function trafficProposal(request: Message): 'hold' | 'UNHOLD' | null {
  // A question mentioning a signal is not evidence that the signal occurred.
  return request.kind === 'question' || /[?？]|되나|됐나|맞나|풀어도|해제해도|확인 요청/.test(request.body)
    ? null : classifySeatTrafficProposal(request.body);
}

/** This loop suggests traffic moves; it never changes traffic.json. */
export function coordinatorReply(request: Message): string {
  const traffic = trafficProposal(request);
  const proposal = traffic === 'hold' ? 'hold 제안' : traffic === 'UNHOLD' ? 'UNHOLD 제안' : '모름 — OP/자리 판단 필요';
  const evidence = traffic === 'hold' ? '자리 메시지에 «손 구현 착수»가 있습니다.'
    : traffic === 'UNHOLD' ? '자리 메시지에 «첫 줄 확정»이 있습니다.'
      : '착수·첫 줄 확정을 확정 진술로 확인하지 못했습니다. 칸·traffic 근거를 사람이 확인해야 합니다.';
  return `re #${request.id}\n제안: ${proposal}\n근거: ${evidence}\n실제 잠금 변경은 수행하지 않았습니다.`;
}

/** Single reply writer: prefer the durable thread link, while recognizing pre-migration body markers. */
function writeCoordinatorReply(store: MsgStore, request: Message): { id: number; posted: boolean } {
  const marker = `re #${request.id}`;
  const linked = store.db.query(`SELECT id FROM msg_messages WHERE sender = ? AND recipient = ?
    AND reply_to = ? ORDER BY id LIMIT 1`).get(RECIPIENT, request.from, request.id) as { id: number } | null;
  if (linked) return { id: linked.id, posted: false };
  const legacy = store.db.query(`SELECT id FROM msg_messages WHERE sender = ? AND recipient = ?
    AND reply_to IS NULL AND (body = ? OR substr(body, 1, ?) = ?) ORDER BY id LIMIT 1`)
    .get(RECIPIENT, request.from, marker, marker.length + 1, `${marker}\n`) as { id: number } | null;
  if (legacy) return { id: legacy.id, posted: false };
  const reply = store.post({ from: RECIPIENT, to: request.from,
    body: coordinatorReply(request).slice(marker.length + 1), kind: 'reply', replyTo: request.id });
  return { id: reply.id, posted: true };
}

/** One transaction ties a reply to its acknowledgement. A retry finds the durable receipt. */
export function runCoordinatorInbox(inputStore?: MsgStore, limit = 100, path?: string): CoordinatorInboxResult {
  const store = inputStore ?? openMsgStore(path);
  const ownStore = inputStore === undefined;
  let replied = 0;
  let acknowledged = 0;
  try {
    const requests = store.listByRecipient(RECIPIENT, store.getCursor(RECIPIENT), limit);
    for (const request of requests) {
      // Broadcasts and replies are not new requests. Advancing past them keeps the cursor moving.
      if (request.to !== RECIPIENT || request.from === RECIPIENT ||
        (request.kind !== undefined && request.kind !== 'request' && request.kind !== 'question')) {
        store.ack(RECIPIENT, request.id);
        acknowledged++;
        continue;
      }
      const key = `coord-inbox:${request.id}:${request.from}`;
      const result = store.db.transaction(() => {
        const existing = store.db.query('SELECT message_id FROM msg_provenance WHERE provenance_key = ?')
          .get(key) as { message_id: number } | null;
        const reply = existing ? { id: existing.message_id, posted: false } : writeCoordinatorReply(store, request);
        if (!existing) store.db.query('INSERT INTO msg_provenance(provenance_key, message_id) VALUES (?, ?)').run(key, reply.id);
        store.ack(RECIPIENT, request.id);
        return { posted: reply.posted };
      }).immediate();
      if (result.posted) replied++;
      acknowledged++;
      debug.log('loop.coordinator-inbox', 'reply', { requestId: request.id, recipient: request.from,
        proposal: trafficProposal(request) ?? 'unknown', duplicate: !result.posted });
    }
    debug.log('loop.coordinator-inbox', 'tick', { replied, acknowledged });
    return { replied, acknowledged };
  } finally { if (ownStore) store.close(); }
}
