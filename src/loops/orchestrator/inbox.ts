import { openMsgStore, type Message, type MsgStore } from '../../msg/msg-store.js';
import { classifySeatTrafficProposal } from '../../seat-loop/traffic-signal.js';
import { debug } from '../../debug/log.js';
import { LOOP_MESSAGE_ROUTES } from '../msg-address.js';
import { replyWithAgent, type AgentReplyInput } from '../agent-reply.js';
import { knowhowAdvice, type KnowhowAdvice, type KnowhowOptions } from './knowhow-pack.js';
import type { RoleLlmSpec } from '../../user-config.js';
import type { LLMProvider } from '../../llm.js';

const RECIPIENT = LOOP_MESSAGE_ROUTES.orchestrator.msgAddress;

export interface CoordinatorInboxResult { replied: number; acknowledged: number }
export interface CoordinatorAgentInboxOptions {
  role: RoleLlmSpec;
  pack: string;
  store?: MsgStore;
  path?: string;
  root?: string;
  limit?: number;
  runAgent?: AgentReplyInput['runAgent'];
  provider?: LLMProvider;
  /** Only the ordered tick scan may advance the durable inbox cursor. */
  acknowledge?: boolean;
}

function trafficProposal(request: Message): 'hold' | 'UNHOLD' | null {
  // A question mentioning a signal is not evidence that the signal occurred.
  return request.kind === 'question' || /[?？]|되나|됐나|맞나|풀어도|해제해도|확인 요청/.test(request.body)
    ? null : classifySeatTrafficProposal(request.body);
}

export interface CoordinatorInboxOptions {
  /** `false` disables the resident knowhow pack (traffic rule only). */
  knowhow?: KnowhowOptions | false;
}

const NO_LOCK_LINE = '실제 잠금 변경은 수행하지 않았습니다.';

function flatten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Propose a resident K item: cite the pack, the item id and the measurement it was judged by. */
function knowhowProposal(advice: KnowhowAdvice): { proposal: string; evidence: string } {
  const cite = `${advice.packVersion} 팩 ${advice.packHash} · ${advice.item.id} «${advice.item.title}»`;
  const measurement = `재는 명령: \`${advice.item.command}\` → ${advice.detail}`;
  if (advice.freshness === 'stale') {
    return {
      proposal: `모름 — 노하우 낡음 의심 (${advice.item.id})`,
      evidence: `${cite} · ${measurement} — 기대와 어긋나 처방을 제안하지 않습니다. OP 가 항목을 갱신해야 합니다.`,
    };
  }
  const freshness = advice.freshness === 'confirmed' ? '기대 일치'
    : advice.freshness === 'unverifiable' ? '기대 문면 — 사람 확인' : '재지 못함 — 사람 확인';
  return {
    proposal: `${advice.item.id} — ${flatten(advice.item.prescription, 240)}`,
    evidence: `${cite} · ${measurement} (${freshness}) — 제안만 하고 어떤 쓰기도 하지 않습니다.`,
  };
}

/** This loop suggests traffic moves and quotes knowhow; it never changes traffic.json or the ledgers. */
export function coordinatorReply(request: Message, knowhow: KnowhowOptions | false = {}): string {
  const traffic = trafficProposal(request);
  if (traffic !== null) {
    const proposal = traffic === 'hold' ? 'hold 제안' : 'UNHOLD 제안';
    const evidence = traffic === 'hold' ? '자리 메시지에 «손 구현 착수»가 있습니다.'
      : '자리 메시지에 «첫 줄 확정»이 있습니다.';
    return `re #${request.id}\n제안: ${proposal}\n근거: ${evidence}\n${NO_LOCK_LINE}`;
  }
  const advice = knowhow === false ? null : knowhowAdvice(request.body, knowhow);
  if (advice) {
    const { proposal, evidence } = knowhowProposal(advice);
    return `re #${request.id}\n제안: ${proposal}\n근거: ${evidence}\n${NO_LOCK_LINE}`;
  }
  const candidate = flatten(request.body, 200);
  debug.log('loop.coordinator-knowhow', 'candidate', { requestId: request.id, from: request.from, question: candidate });
  return `re #${request.id}\n제안: 모름 — OP/자리 판단 필요\n근거: 착수·첫 줄 확정을 확정 진술로 확인하지 못했고, `
    + `맞는 K-OP 노하우 항목도 없습니다. 칸·traffic 근거를 사람이 확인해야 합니다.\n`
    + `노하우 후보: ${candidate} — 새 K-OP 항목의 입력으로 쓸 수 있습니다.\n${NO_LOCK_LINE}`;
}

/** Single reply writer: prefer the durable thread link, while recognizing pre-migration body markers. */
function writeCoordinatorReply(store: MsgStore, request: Message, replyText: string): { id: number; posted: boolean } {
  const marker = `re #${request.id}`;
  const linked = store.db.query(`SELECT id FROM msg_messages WHERE sender = ? AND recipient = ?
    AND reply_to = ? AND kind = 'reply' ORDER BY id LIMIT 1`).get(RECIPIENT, request.from, request.id) as { id: number } | null;
  if (linked) return { id: linked.id, posted: false };
  const legacy = store.db.query(`SELECT id FROM msg_messages WHERE sender = ? AND recipient = ?
    AND reply_to IS NULL AND kind = 'reply' AND (body = ? OR substr(body, 1, ?) = ?) ORDER BY id LIMIT 1`)
    .get(RECIPIENT, request.from, marker, marker.length + 1, `${marker}\n`) as { id: number } | null;
  if (legacy) return { id: legacy.id, posted: false };
  const reply = store.post({ from: RECIPIENT, to: request.from,
    body: replyText.slice(marker.length + 1), kind: 'reply', replyTo: request.id });
  return { id: reply.id, posted: true };
}

/** One transaction ties a reply to its acknowledgement. A retry finds the durable receipt. */
export function runCoordinatorInbox(inputStore?: MsgStore, limit = 100, path?: string,
  options: CoordinatorInboxOptions = {}): CoordinatorInboxResult {
  const knowhow = options.knowhow ?? {};
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
      // Measurement runs outside the write transaction: a pack command never holds the ledger lock.
      const known = store.db.query('SELECT message_id FROM msg_provenance WHERE provenance_key = ?')
        .get(key) as { message_id: number } | null;
      const replyText = known ? '' : coordinatorReply(request, knowhow);
      const result = store.db.transaction(() => {
        const existing = store.db.query('SELECT message_id FROM msg_provenance WHERE provenance_key = ?')
          .get(key) as { message_id: number } | null;
        const reply = existing ? { id: existing.message_id, posted: false } : writeCoordinatorReply(store, request, replyText);
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

/** One SSE delivery or tick scan uses the same durable handler. At-least-once wake is safe. */
export async function handleCoordinatorAgentMessage(
  request: Message, input: CoordinatorAgentInboxOptions,
): Promise<CoordinatorInboxResult> {
  const store = input.store ?? openMsgStore(input.path);
  const ownStore = input.store === undefined;
  const acknowledge = input.acknowledge === true;
  try {
    if (request.to !== RECIPIENT || request.from === RECIPIENT ||
      (request.kind !== undefined && request.kind !== 'request' && request.kind !== 'question')) {
      if (acknowledge) store.ack(RECIPIENT, request.id);
      return { replied: 0, acknowledged: acknowledge ? 1 : 0 };
    }
    // With explicit role selection, every request goes through the agent body.
    const result = await replyWithAgent({ address: RECIPIENT, request, role: input.role,
      pack: input.pack, store, observationRoot: input.root,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.runAgent ? { runAgent: input.runAgent } : {}) });
    if (result.replyId === null) throw new Error(`coordinator agent returned no reply for #${request.id}`);
    if (acknowledge) store.ack(RECIPIENT, request.id);
    return { replied: result.posted ? 1 : 0, acknowledged: acknowledge ? 1 : 0 };
  } finally { if (ownStore) store.close(); }
}

/** Configured body path; callers must check the explicit roleLlm opt-in before invoking it. */
export async function runCoordinatorAgentInbox(input: CoordinatorAgentInboxOptions): Promise<CoordinatorInboxResult> {
  const store = input.store ?? openMsgStore(input.path);
  const ownStore = input.store === undefined;
  const result = { replied: 0, acknowledged: 0 };
  try {
    const requests = store.listByRecipient(RECIPIENT, store.getCursor(RECIPIENT), input.limit ?? 100);
    for (const request of requests) {
      const one = await handleCoordinatorAgentMessage(request, { ...input, store, acknowledge: true });
      result.replied += one.replied;
      result.acknowledged += one.acknowledged;
    }
    debug.log('loop.coordinator-inbox', 'agent-tick', result);
    return result;
  } finally { if (ownStore) store.close(); }
}
