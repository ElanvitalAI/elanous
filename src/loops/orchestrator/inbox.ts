import { ASK_OP_COMMAND } from '../../session/channel-ask-op-envelope.js';
import { openMsgStore, type Message, type MsgStore } from '../../msg/msg-store.js';
import { classifySeatTrafficProposal } from '../../seat-loop/traffic-signal.js';
import { debug, redactSecretText } from '../../debug/log.js';
import { LOOP_MESSAGE_ROUTES } from '../msg-address.js';
import { replyWithAgent, type AgentReplyInput } from '../agent-reply.js';
import { knowhowAdvice, type KnowhowAdvice, type KnowhowOptions } from './knowhow-pack.js';
import type { RoleLlmSpec } from '../../user-config.js';
import type { LLMProvider } from '../../llm.js';
import { askOpContextBundle, type AskOpContextBundle } from '../../context-bus/context-now.js';

const RECIPIENT = LOOP_MESSAGE_ROUTES.orchestrator.msgAddress;

export interface CoordinatorInboxResult { replied: number; acknowledged: number }
export interface AskOpTestHarness {
  /** A test-only sink; this never defaults to a real surface transport. */
  replySink: (reply: { from: string; to: string; body: string; kind: 'reply'; replyTo: number }) => Message;
  /** Capture both clocks without writing to the production log store in tests. */
  eventSink?: (event: { requestId: number; requestToReplyMs: number | null; processingMs: number }) => void;
}
export interface AskOpContextInboxOptions {
  store?: MsgStore;
  path?: string;
  limit?: number;
  context?: typeof askOpContextBundle;
  knowhow?: KnowhowOptions | false;
  /** Only the ordered tick scan may advance the durable cursor. */
  acknowledge?: boolean;
  /** SSE delivery handles exactly its message; the ordered tick scans the cursor. */
  request?: Message;
  /** Explicit opt-in for synthetic TEST ASK-OP questions only. Production callers must omit this. */
  testHarness?: AskOpTestHarness;
}

const ASK_OP_SENDERS = new Set(['TELEGRAM', 'DISCORD']);
const REFUSE = '모름 — 확인된 근거가 없어 답할 수 없습니다.';

function isAskOpRequest(request: Message, allowTestSource = false): boolean {
  const testSource = allowTestSource && request.from === 'TEST'
    && /^Test \/(?:askop|ask-op)(?:\r?\n|$)/.test(request.body);
  return request.kind === 'question' && (ASK_OP_SENDERS.has(request.from) || testSource)
    && (testSource || new RegExp(`^(?:Telegram|Discord) \/(?:${ASK_OP_COMMAND}|ask-op)(?:\\r?\\n|$)`).test(request.body));
}

function askOpLatencyMs(request: Message, repliedAt: number): number | null {
  const createdAt = Date.parse(request.createdAt);
  const latencyMs = repliedAt - createdAt;
  return Number.isFinite(createdAt) && latencyMs >= 0 ? latencyMs : null;
}

function writeAskOpReply(store: MsgStore, request: Message, replyText: string, options: AskOpContextInboxOptions) {
  if (options.testHarness && request.from === 'TEST') {
    const marker = `re #${request.id}\n`;
    const body = replyText.startsWith(marker) ? replyText.slice(marker.length) : replyText;
    const reply = options.testHarness.replySink({ from: RECIPIENT, to: request.from,
      body, kind: 'reply', replyTo: request.id });
    return { id: reply.id, posted: true };
  }
  return writeCoordinatorReply(store, request, replyText);
}

function askOpQuestion(request: Message): string {
  const match = /^question: (.*)$/m.exec(request.body);
  return match?.[1]?.trim() ?? '';
}

function unsafeAskOp(question: string): boolean {
  // Reject explicit commands, not descriptive questions such as "What changed since the release?".
  return /^(?:(?:please|can you|could you|would you)\s+)?(?:run|execute|deploy|publish|push|merge|delete|drop|write|edit|change|set)\b|(?:실행해|발행해|배포해|푸시해|병합해|삭제해|수정해|바꿔|설정해)(?:줘|주세요)?|\b(?:show|reveal|give|tell|display|print|read|open|what is|what's)\b.{0,80}\b(?:secret|token|password|credential|api[ -]?key|private[ -]?key)\b|(?:비밀|토큰|암호|패스워드|인증키|API\s*키).{0,80}(?:보여|알려|공개|읽어)/i.test(question);
}

async function askOpAnswer(request: Message, options: AskOpContextInboxOptions): Promise<string> {
  const question = askOpQuestion(request);
  if (!question) return `제안: ${REFUSE}\n근거: 질문이 비었습니다.`;
  if (unsafeAskOp(question)) return '제안: 요청한 권한 실행·비밀 조회·traffic/칸 변경은 실행할 수 없습니다.\n근거: OP 질문 답변은 읽기 전용입니다.';
  let bundle: AskOpContextBundle;
  // These replies are delivered to an external channel, not the private operator console.
  try { bundle = await (options.context ?? askOpContextBundle)(question, { audience: 'public-demo', limit: 8 }); }
  catch { return `제안: ${REFUSE}\n근거: 맥락 조회 실패.`; }
  const facts = bundle.facts.filter(fact => fact.source?.trim() && fact.summary?.trim()).slice(0, 8);
  if (!facts.length) {
    const gaps = bundle.gaps.slice(0, 3).map(gap => `${redactSecretText(gap.kind)}: ${redactSecretText(gap.reason)}`).join('; ');
    return `제안: ${REFUSE}\n근거: ${gaps || '미관측'}.`;
  }
  const evidence = facts.map(fact => `- ${redactSecretText(fact.summary)} — ${redactSecretText(fact.source)} (관측 ${redactSecretText(fact.observedAt)})`).join('\n');
  return `제안: 다음은 관측된 OP 맥락입니다 (${redactSecretText(bundle.topic)}; 조회 ${redactSecretText(bundle.queriedAt)}).\n근거:\n${evidence}\n판단·승인·실행은 하지 않았습니다.`;
}
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

/** Surface ask-op questions use the same linked reply and durable acknowledgement as the resident inbox. */
export async function runAskOpContextInbox(options: AskOpContextInboxOptions = {}): Promise<CoordinatorInboxResult> {
  const store = options.store ?? openMsgStore(options.path);
  const ownStore = options.store === undefined;
  const result = { replied: 0, acknowledged: 0 };
  const acknowledge = options.acknowledge !== false;
  try {
    const requests = options.request ? [options.request]
      : store.listByRecipient(RECIPIENT, store.getCursor(RECIPIENT), options.limit ?? 100);
    for (const request of requests) {
      if (request.to !== RECIPIENT || request.from === RECIPIENT ||
        (request.kind !== undefined && request.kind !== 'request' && request.kind !== 'question')) {
        if (acknowledge) { store.ack(RECIPIENT, request.id); result.acknowledged++; }
        continue;
      }
      const testAskOp = request.from === 'TEST' && isAskOpRequest(request, true);
      if (testAskOp && !options.testHarness) continue;
      const key = `coord-inbox:${request.id}:${request.from}`;
      const existing = store.db.query('SELECT message_id FROM msg_provenance WHERE provenance_key = ?')
        .get(key) as { message_id: number } | null;
      // Legacy seat traffic and knowhow requests preserve the existing answer path.
      const startedAt = Date.now();
      const replyText = existing ? '' : (isAskOpRequest(request, options.testHarness !== undefined)
        ? `re #${request.id}\n${await askOpAnswer(request, options)}` : coordinatorReply(request, options.knowhow ?? {}));
      const one = store.db.transaction(() => {
        const receipt = store.db.query('SELECT message_id FROM msg_provenance WHERE provenance_key = ?')
          .get(key) as { message_id: number } | null;
        const reply = receipt ? { id: receipt.message_id, posted: false } : writeAskOpReply(store, request, replyText, options);
        if (!receipt) store.db.query('INSERT INTO msg_provenance(provenance_key, message_id) VALUES (?, ?)').run(key, reply.id);
        if (acknowledge) store.ack(RECIPIENT, request.id);
        return reply.posted;
      }).immediate();
      if (one) result.replied++;
      if (acknowledge) result.acknowledged++;
      debug.log('loop.coordinator-inbox', 'reply', { requestId: request.id, recipient: request.from, duplicate: !one });
      if (one && isAskOpRequest(request, options.testHarness !== undefined)) {
        const repliedAt = Date.now();
        const latencyMs = askOpLatencyMs(request, repliedAt);
        const processingMs = Math.max(0, repliedAt - startedAt);
        if (options.testHarness && request.from === 'TEST') {
          options.testHarness.eventSink?.({ requestId: request.id, requestToReplyMs: latencyMs, processingMs });
        } else {
          debug.log('ask-op.inbox', 'replied', { requestId: request.id, requestToReplyMs: latencyMs,
            processingMs, clockSkew: latencyMs === null });
        }
      }
    }
    return result;
  } finally { if (ownStore) store.close(); }
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
    if (isAskOpRequest(request) && request.to === RECIPIENT) {
      return await runAskOpContextInbox({ store, request, acknowledge });
    }
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
