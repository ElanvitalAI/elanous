// ── `eln msg receipts` · `eln msg receipt` (SEAT-INBOX B1-C · 내부 문서 `SEAT-INBOX-PROTOCOL` §4c) ──
//   receipts [msgId] [--from <seat>] [--follow [--until <state>]] [--sse <url>]
//     = 원장의 영수증을 덧붙인 순서대로 보여 준다. --follow 면 우체국 SSE `GET /receipts` 의 `event: receipt` 를
//       흘려 받는다(폴링 0 · fs.watch 0). 신호(SIGINT · SIGTERM · deps.signal) 또는 --until 상태 도달에 끝난다.
//   receipt <msgId> <accepted|rejected|done> --to <seat> [--plan-item] [--reason] [--evidence]
//     = 계획 없는 자리·외부 CLI 의 «명시» 구조 행동(§4a · D3 · D6). 문장 판독 0.
// 종료 코드: 0 = 정상 · 2 = 인자/원장 오류 · 3 = --follow 인데 우체국이 없음(원장 폴링으로 대신하지 않는다).
import type { Command } from 'commander';
import { debug } from '../debug/log.js';
import { ensureAuthToken } from '../auth/acp-token.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { discoverPostOfficeUrl } from '../msg/msg-post-office.js';
import { formatReceipt, isReceiptState, receiptMatches, receiptReaches, type Receipt, type ReceiptState } from '../msg/msg-receipts.js';
import { canonicalMessageAddress, canonicalSeatId, type MsgStore } from '../msg/msg-store.js';

export const RECEIPTS_EXIT_NO_POST_OFFICE = 3;

/** MSG-RECEIPTS-FOLLOWUP ② (#84659 A②): an unauthorized SSE answer — judged by its own class, never by message text. */
export class SseUnauthorizedError extends Error {
  constructor() { super('SSE unauthorized (401)'); this.name = 'SseUnauthorizedError'; }
}

export interface MsgReceiptsCliDeps {
  openStore: () => MsgStore;
  out: Pick<Console, 'log' | 'error'>;
  setExitCode: (code: number) => void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  authToken?: () => string;
  /** Post office discovery (default: the state root's registered `msg serve --sse`). */
  discoverUrl?: () => Promise<string | null>;
  /** Reconnect wait after a dropped stream — bounded backoff, never a ledger poll. */
  reconnectMs?: number;
  /** Clock for `overdue` (A217). */
  now?: () => Date;
  /** Install SIGINT/SIGTERM → stop (default true; tests pass false and use `signal`). */
  handleSignals?: boolean;
}

function positiveId(raw: string, label: string): number {
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${label} must be a positive integer`);
  const id = Number(raw);
  if (!Number.isSafeInteger(id)) throw new Error(`${label} must be a positive integer`);
  return id;
}

/** Parse SSE frames, yielding only `event: receipt` payloads (keepalives and other events are skipped). */
export function parseReceiptFrames(pending: string): { receipts: Receipt[]; rest: string } {
  const receipts: Receipt[] = [];
  let rest = pending.replace(/\r\n/g, '\n');
  let boundary: number;
  while ((boundary = rest.indexOf('\n\n')) >= 0) {
    const frame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const lines = frame.split('\n');
    if (!lines.includes('event: receipt')) continue;
    const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
    if (data) receipts.push(JSON.parse(data) as Receipt);
  }
  return { receipts, rest };
}

// Source: #38361 Terra ③ — page size for walking every overdue request (the store's own limit cap is 1000).
const OVERDUE_PAGE = 100;

/** The system sender of SLA alerts (structural origin = system · never a person or a seat's own words). */
export const SLA_ALERT_SENDER = 'MSG-SLA';

/**
 * SEAT-MAIL-ACK-SLA «미ack 나이 경보 → 보낸 쪽·OP»: one alert per (request, late seat, stage, target) — the sender and OP, never
 * the late seat itself (its inbox already holds the request). No body: ids, seats, age and due only.
 * #38361 Terra ①②: «already alerted» is the alert ledger per stage and target (not the overdue receipt), and each alert commits
 * with its ledger row — a target whose post failed is retried on the next run, a target that got it is never mailed twice.
 */
export function notifyOverdue(store: MsgStore, message: { id: number; from: string; createdAt: string; deadlineAt?: string }, recipient: string, stage: 'seen' | 'ack', stageWord: string, now: Date): { sent: number[]; failed: string[] } {
  const ageMin = Math.max(0, Math.floor((now.getTime() - Date.parse(message.createdAt)) / 60_000));
  const body = `[미ack 경보] #${message.id} ${message.from}→${recipient} · ${stageWord} ${ageMin}분${message.deadlineAt ? ` · 기한 ${message.deadlineAt}` : ''} — ${recipient}: eln msg list --to ${recipient} · receipt accepted|rejected`;
  const targets = [...new Set([message.from, 'OP'])].filter(seat => seat !== recipient && seat !== SLA_ALERT_SENDER);
  const sent: number[] = [];
  const failed: string[] = [];
  for (const target of targets) {
    try {
      const alert = store.postSlaAlertOnce({ messageId: message.id, recipient, stage, target },
        { from: SLA_ALERT_SENDER, to: target, body, kind: 'alert', intent: 'alert', refs: [`msg#${message.id}`], origin: { kind: 'system', seat: SLA_ALERT_SENDER } });
      if (alert !== null) sent.push(alert.id);
    } catch (error) {
      failed.push(target);
      try { debug.log('msg.sla', 'alert-failed', { msgId: message.id, recipient, stage, to: target, error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
      catch { /* observability is fail-open */ }
    }
  }
  return { sent, failed };
}

export function registerMsgReceiptsCommands(msg: Command, deps: MsgReceiptsCliDeps): void {
  const { out, setExitCode } = deps;
  const run = (name: string, action: () => void | Promise<void>) => async () => {
    try { await action(); }
    catch (error) {
      out.error(`msg ${name}: ${error instanceof Error ? error.message : String(error)}`);
      setExitCode(2);
    }
  };
  const emit = (receipt: Receipt, json: boolean | undefined) => out.log(json ? JSON.stringify(receipt) : formatReceipt(receipt));
  const withStore = <T>(action: (store: MsgStore) => T): T => {
    const store = deps.openStore();
    try { return action(store); } finally { store.close(); }
  };

  msg.command('receipts [msgId]').description('Show receipts (posted → delivered → seen …) for a message or a sender; --follow streams them from the post office')
    .option('--from <seat>', 'receipts for messages this seat sent')
    .option('--follow', 'keep streaming new receipts (post office SSE · no polling)')
    .option('--until <state>', 'with --follow: stop once a receipt reaches this state')
    .option('--sse <url>', 'post office base URL (default: the registered msg serve --sse)')
    .option('--json')
    .action((msgId: string | undefined, opts: { from?: string; follow?: boolean; until?: string; sse?: string; json?: boolean }) => run('receipts', async () => {
      const filter = {
        ...(msgId === undefined ? {} : { messageId: positiveId(msgId, 'msgId') }),
        ...(opts.from === undefined ? {} : { from: canonicalSeatId(opts.from) }),
      };
      if (filter.messageId === undefined && filter.from === undefined) throw new Error('give a msgId or --from <seat>');
      let until: ReceiptState | undefined;
      if (opts.until !== undefined) {
        if (!opts.follow) throw new Error('--until needs --follow');
        if (!isReceiptState(opts.until)) throw new Error(`--until must be a receipt state (${opts.until})`);
        until = opts.until;
      }
      let lastId = 0;
      let reached = false;
      // Ledger first (authoritative) — then the stream continues from the last receipt id.
      withStore(store => {
        for (;;) {
          const page = store.listReceipts({ ...filter, afterId: lastId });
          for (const receipt of page) {
            emit(receipt, opts.json);
            lastId = receipt.id;
            if (until !== undefined && receiptReaches(receipt.state, until)) reached = true;
          }
          if (page.length < 1000) break;
        }
      });
      if (!opts.follow || reached) return;
      const base = opts.sse ?? await (deps.discoverUrl ?? (() => discoverPostOfficeUrl(elanousStateRoot())))();
      if (!base) {
        out.error('msg receipts --follow: 우체국(eln msg serve --sse)이 없다 — 폴링으로 대신하지 않는다. 우체국을 띄우거나 --follow 없이 읽는다');
        setExitCode(RECEIPTS_EXIT_NO_POST_OFFICE);
        return;
      }
      const url = new URL('/receipts', base);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--sse requires an HTTP URL');
      if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('--sse requires HTTPS outside localhost');
      if (filter.messageId !== undefined) url.searchParams.set('msg', String(filter.messageId));
      if (filter.from !== undefined) url.searchParams.set('from', filter.from);
      const token = (deps.authToken ?? (() => ensureAuthToken().token))();
      const stop = new AbortController();
      const onOuter = () => stop.abort();
      deps.signal?.addEventListener('abort', onOuter, { once: true });
      if (deps.signal?.aborted) stop.abort();
      const handleSignals = deps.handleSignals ?? true;
      if (handleSignals) { process.once('SIGINT', onOuter); process.once('SIGTERM', onOuter); }
      const reconnectMs = deps.reconnectMs ?? 1000;
      try {
        while (!stop.signal.aborted) {
          url.searchParams.set('since', String(lastId));
          try {
            const response = await (deps.fetch ?? fetch)(url, { headers: { Authorization: `Bearer ${token}`, 'Last-Event-ID': String(lastId) }, signal: stop.signal });
            if (response.status === 401) throw new SseUnauthorizedError();
            if (!response.ok || !response.body) throw new Error(`SSE unavailable (${response.status})`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let pending = '';
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              const parsed = parseReceiptFrames(pending + decoder.decode(chunk.value, { stream: true }));
              pending = parsed.rest;
              for (const receipt of parsed.receipts) {
                if (receipt.id <= lastId || !receiptMatches(receipt, filter)) continue;
                emit(receipt, opts.json);
                lastId = receipt.id;
                if (until !== undefined && receiptReaches(receipt.state, until)) { stop.abort(); break; }
              }
              if (stop.signal.aborted) { try { await reader.cancel(); } catch { /* closed */ } break; }
            }
          } catch (error) {
            if (stop.signal.aborted) break;
            if (error instanceof SseUnauthorizedError) throw error;
            out.error(`msg receipts: 스트림 끊김 — ${reconnectMs}ms 뒤 같은 커서(${lastId})로 다시 붙는다: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (stop.signal.aborted) break;
          await new Promise<void>(resolve => {
            const timer = setTimeout(done, reconnectMs);
            function done() { clearTimeout(timer); stop.signal.removeEventListener('abort', done); resolve(); }
            stop.signal.addEventListener('abort', done, { once: true });
          });
        }
      } finally {
        deps.signal?.removeEventListener('abort', onOuter);
        if (handleSignals) { process.removeListener('SIGINT', onOuter); process.removeListener('SIGTERM', onOuter); }
      }
    })());

  // A217 — «15분 미확인 요청»을 A216 기다림 원장(RES WAITS · waits.py register)의 칸 그대로 낸다. 등록은 그 원장 주인(RES 순회)이
  // 한다 — 여기는 원장 사실만(영수증 상태·ack). --mark 면 overdue 영수증을 한 번 남긴다(상태는 옮기지 않는 주석 · §4a).
  msg.command('overdue').description('List requests nobody has seen after a grace period, in the A216 waits register shape (--mark records one overdue receipt each)')
    .option('--after <minutes>', 'grace period after posting', '15')
    .option('--within <minutes>', 'only requests posted within this many minutes (older ones belong to retired/mistyped seats)', '1440')
    .option('--mark', 'record an overdue receipt for each listed request (once per message)')
    .option('--stage <stage>', 'seen (nobody saw it · default) | ack (nobody accepted/rejected it — SEAT-MAIL-ACK-SLA)', 'seen')
    // #38361 follow-up ①: no scheduler calls this yet (OP decision cell) — the help must not read as a running alarm.
    .option('--notify', 'one-shot: one alert mail to the sender and OP per overdue request and stage, only when you run it — nothing runs it on a schedule yet (never the body · a failed target is retried next run)')
    .option('--json', 'one JSON object per line (A216 register fields)')
    .action((opts: { after: string; within: string; mark?: boolean; stage: string; notify?: boolean; json?: boolean }) => run('overdue', () => {
      if (opts.stage !== 'seen' && opts.stage !== 'ack') throw new Error('--stage must be seen or ack');
      const stage = opts.stage;
      const stageWord = stage === 'ack' ? 'undecided' : 'unseen';
      if (!/^[1-9]\d{0,4}$/.test(opts.after)) throw new Error('--after must be a positive number of minutes');
      if (!/^[1-9]\d{0,5}$/.test(opts.within) || Number(opts.within) <= Number(opts.after)) throw new Error('--within must be a number of minutes larger than --after');
      const graceMs = Number(opts.after) * 60_000;
      const now = (deps.now ?? (() => new Date()))();
      const postedAfter = new Date(now.getTime() - Number(opts.within) * 60_000);
      withStore(store => {
        // #38361 Terra ③: walk every page inside the age window — alerted-but-open requests must not crowd older ones out.
        const rows: ReturnType<MsgStore['listUnseenRequests']> = [];
        for (let beforeId: number | undefined; ;) {
          const page = store.listUnseenRequests({ postedBefore: new Date(now.getTime() - graceMs), postedAfter, stage, limit: OVERDUE_PAGE, ...(beforeId === undefined ? {} : { beforeId }) });
          rows.push(...page);
          if (page.length < OVERDUE_PAGE) break;
          beforeId = page.at(-1)!.message.id;
        }
        let failedAlerts = 0;
        for (const { message, recipient, current } of rows) {
          if (opts.notify) failedAlerts += notifyOverdue(store, message, recipient, stage, stageWord, now).failed.length;
          if (opts.mark) {
            try {
              store.recordReceipt({ messageId: message.id, recipient, state: 'overdue', source: 'cli', reason: `${stageWord} ${opts.after}m` });
            }
            catch (error) {
              // Annotation only — the listing stands — but never silent (#38219 REVIEW-2 ④).
              try { debug.log('msg.receipt-writer', 'record-failed', { msgId: message.id, recipient, state: 'overdue', source: 'cli', error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
              catch { /* observability is fail-open */ }
              out.error(`msg overdue: #${message.id} ${recipient} overdue 영수증 기록 실패 — ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          const wait = {
            id: `MSG${message.id}-${recipient}`, kind: 'seat-request', owner: recipient,
            deadline: message.deadlineAt ?? new Date(Date.parse(message.createdAt) + graceMs).toISOString(),
            reason: `request #${message.id} from ${message.from} ${stageWord} ${opts.after}m (receipt ${current ?? 'none'})`,
            'next-action': `${recipient}: eln msg list --to ${recipient} · ack or reply #${message.id}`,
            source: `msg#${message.id}`, from: message.from, msgId: message.id, postedAt: message.createdAt,
            ...(message.doneWhen === undefined ? {} : { done: message.doneWhen }),
          };
          out.log(opts.json ? JSON.stringify(wait) : `${wait.id} · ${wait.reason} · due ${wait.deadline}`);
        }
        // Never silent (#38361 Terra ②): the listing stands, the failed targets are retried by the next run, and the run fails.
        if (failedAlerts > 0) throw new Error(`경보 ${failedAlerts}건 발송 실패 — 보낸 대상은 그대로 · 실패분만 다음 실행이 재시도 (eln logs --grep alert-failed)`);
      });
    })());

  msg.command('receipt <msgId> <state>').description('Record an explicit receipt (accepted · rejected · done) for one recipient — structured action, no text parsing')
    .requiredOption('--to <seat>', 'the recipient seat whose receipt this is')
    .option('--plan-item <id>', 'plan item id that accepted the message')
    .option('--reason <text>', 'why it is refused — required for rejected')
    .option('--evidence <text>', 'what shows it is done (test, PR, receipt) — required for done')
    .option('--json')
    .action((rawId: string, rawState: string, opts: { to: string; planItem?: string; reason?: string; evidence?: string; json?: boolean }) => run('receipt', () => {
      const messageId = positiveId(rawId, 'msgId');
      if (rawState !== 'accepted' && rawState !== 'rejected' && rawState !== 'done') throw new Error('state must be accepted, rejected or done');
      const state = rawState as 'accepted' | 'rejected' | 'done';
      // MSG-RECEIPTS-FOLLOWUP (TC ①): name the missing flag and how to fix it, before anything is stored.
      if (state === 'rejected' && !opts.reason?.trim()) throw new Error('rejected needs --reason <text> (why it is refused), e.g. --reason "duplicate of #123"');
      if (state === 'done' && !opts.evidence?.trim()) throw new Error('done needs --evidence <text> (what shows it is done), e.g. --evidence "PR #456 merged"');
      const recipient = canonicalMessageAddress(opts.to);
      const outcome = withStore(store => store.recordReceipt({
        messageId, recipient, state, source: 'cli',
        ...(opts.planItem === undefined ? {} : { planItemId: opts.planItem }),
        ...(opts.reason === undefined ? {} : { reason: opts.reason }),
        ...(opts.evidence === undefined ? {} : { evidence: opts.evidence }),
      }));
      if (outcome.recorded) { emit(outcome.receipt, opts.json); return; }
      if (opts.json) out.log(JSON.stringify(outcome));
      else out.log(`msg:${messageId} ${recipient} ${state} 기록 안 함 — ${outcome.reason} (현재 ${outcome.current ?? '없음'})`);
      if (outcome.reason === 'unknown-message') setExitCode(2);
    })());
}
