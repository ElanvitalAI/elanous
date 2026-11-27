import { routeAtEntrance } from '../kit/mail-route/entrance.js';
import { handAskReference } from '../kit/mail-route/hand-dedupe.js';
import { randomUUID } from 'node:crypto';
import { goalSetterRefusal, goalSetterVerdict } from '../session-autopilot/crown-goal-apply.js';
import type { Command } from 'commander';
import { Database } from 'bun:sqlite';
import { formatMessage, registerMsgListCommand } from './msg-list-cli.js';
import { readUnreadCount } from '../msg/msg-store.js';
import { registerMsgWaitForCommands } from './msg-wait-for-cli.js';
import { registerMsgHandCommands } from './msg-hand-cli.js';
import { registerMsgClearCommand, registerMsgQuestionCommand, registerMsgResetCommand } from './msg-clear-cli.js';
import { registerMsgRequirementCommands } from './msg-requirement-cli.js';
import { registerMsgReceiptsCommands } from './msg-receipts-cli.js';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureAuthToken } from '../auth/acp-token.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { knownSeats } from '../msg/msg-reset.js';
import { canonicalMessageAddress, canonicalSeatId, defaultMsgStorePath, openMsgStore, openMsgStoreReadOnly, type Message, type MessageEnvelope, type MsgStore } from '../msg/msg-store.js';
import { archiveDeliveredRows, defaultArchivePath, MSG_ARCHIVE_DEFAULT_DAYS } from '../msg/msg-archive.js';
import { buildMsgHookOutput, seatFromCwd, type MsgHookEvent, type MsgHookFormat } from '../msg/msg-hook.js';
import { SEAT_AGENT_RUNTIMES, type SeatAgentRuntime } from '../loops/seat-registry.js';
import { MAIL_FALLBACK_MS, runMailFallback, spawnMailFallback } from '../msg/msg-mail-fallback.js';
import { clearPostOffice, discoverPostOfficeUrl, ensurePostOffice, writePostOffice } from '../msg/msg-post-office.js';
import { triageMailbox, type TriageRow } from '../msg/inbox-triage.js';
import { divertedRootForStore, gatePost, storeGateDeps } from '../msg/post-gate.js';
import { loadFederationLadder } from '../msg/hand-raise-ladder.js';
import { parseExpiresDuration, postExpiry } from '../msg/directive-expiry.js';
import { COALESCE_WINDOW_MS, coalesceEligible, OUTBOUND_WINDOW_MS } from '../msg/outbound-coalesce.js';
import { senderAboveOnLadder } from '../tui/seat-mail-turn-policy.js';
import { acquireLockSync } from '../storage/file-lock.js';
import { GitHubMsgMirrorTransport } from '../msg/msg-mirror-github.js';
import { configuredMirrorTarget, runMsgMirrorTick, type MirrorTarget, type MsgMirrorStateStore, type MsgMirrorTransport } from '../msg/msg-mirror-runner.js';
import { JsonMsgMirrorStateStore } from '../msg/msg-mirror-state.js';
import { startMsgSseServer } from '../msg/msg-sse-server.js';
import { debug } from '../debug/log.js';
import { ANNOUNCE_KIND, announceRefs, newAnnounceId, normalizeAnnounceId, normalizeAnnounceScope, parseApplyField, recordAnnounceApply } from '../msg/announce.js';
import { ackDigestInputs, recordAckDigest, type AckDigestInput, type AckDigestPorts } from '../msg/msg-ack-digest.js';

/** OP 승인 #106323(2026-11-19) — TTY 가 아닌데도 닫히지 않는 파이프 stdin(테스트·데몬이 fd 0 을 붙잡은 경우)에
 *  hook 이 영구 블록되지 않게 하는 읽기 상한. 상한 초과 시 빈 입력 폴백 + 원장 'stdin-timeout' 1줄. */
export const HOOK_STDIN_READ_LIMIT_MS = 5_000;

const hookStdinTimedOut = Symbol('hook-stdin-timeout');

/** 파이프 stdin 을 상한까지 읽고, 초과 시 빈 입력(프로세스 문맥 폴백)을 돌려준다. TTY 인 경우 호출하지 않는다.
 *  [JUD-B #106365] 상한 초과 시 cancel() 로 진행 중 읽기까지 취소 — fd0 를 붙잡은 채 종료하지 않는 결함 방지. */
async function readHookStdinWithLimit(readStdin: () => Promise<string>, limitMs: number, cancel?: () => void): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    readStdin(),
    new Promise<typeof hookStdinTimedOut>(resolve => { timer = setTimeout(() => resolve(hookStdinTimedOut), limitMs); }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  if (settled === hookStdinTimedOut) {
    try { cancel?.(); } catch { /* 취소는 best-effort — 폴백은 계속 진행 */ }
    try { debug.log('msg.hook', 'stdin-timeout', { limitMs }); } catch { /* 원장 기록은 fail-open */ }
    return '';
  }
  return settled;
}
import type { AgentReplyAddress, AgentReplyInput, AgentReplyResult } from '../loops/agent-reply.js';
import { noReplyBodyNotice, unsupportedLoopAddressNotice } from '../loops/msg-address.js';
import { isLocalWakeHost, messageReplyBodyFor, registerSeatPaneAddress, registrySnapshot, resolveElsSeat, resolveHerdrSeatLiveness, resolveRemoteSeatLiveness, resolveSeatStateRoot, resolveWake, seatDeliveryView, seatRouteHint, isLiveWakeUniverse, wakeRecipient, type WakeDeps, type WakeOutcome } from '../loops/msg-wake.js';
import { classifySeatInbox, seatInboxAlivePath } from '../loops/inbox-liveness.js';
import { getUserConfig } from '../user-config/reader.js';
import type { RoleLlmSpec } from '../user-config/types.js';
import { postReleaseOpCommand, postReleaseOpQuestion } from '../release-loop/op-channel.js';

/** Where the directive index lives. Local on purpose: `src/directives/directive-index` is not part of the public export, and
 *  this file is — importing it only for a path broke the public build («Cannot find module»). Same path it computes. */
const directiveDbPath = (): string => join(elanousStateRoot(), 'directives', 'directives.db');

/** The loop rows whose reply body is an LLM agent: `--agent-reply` picks one of these. */
const AGENT_REPLY_ROLES = { COORDINATOR: 'coordinator', GUARDIAN: 'guardian' } as const;

export interface MsgCliDeps {
  /** MAIL-ANTI-FLOOD F·G side ledgers (default: next to the mail ledger · `<msg dir>/diverted`). */
  divertedRoot?: string;
  /** COND-WATCH `--watch` arming seam (default: armMessageFollowUp — commitment ⊕ waker ⊕ detached watcher). */
  followUp?: typeof import('../msg/msg-follow-up.js').armMessageFollowUp;
  /** 60s eln-mail safety net launcher (default: detached `eln msg mail-fallback` in the live universe only). */
  spawnMailFallback?: (input: { messageId: number; recipient: string; from: string }) => void;
  /** `mail-fallback` sleep seam. */
  fallbackSleep?: (ms: number) => Promise<void>;
  openStore?: () => MsgStore;
  /** Clock for relative/clock-time `--deadline` (A217). */
  now?: () => Date;
  openReadStore?: () => MsgStore;
  out?: Pick<Console, 'log' | 'error'>;
  readStdin?: () => Promise<string>;
  // TTY stdin 이면 hook 이 EOF 대기로 영구 블록되지 않도록 판정만 주입 가능하게 (기본 process.stdin.isTTY).
  stdinIsTty?: () => boolean;
  /** 테스트 주입용: 닫히지 않는 파이프 stdin 읽기 상한(ms). 미지정 시 HOOK_STDIN_READ_LIMIT_MS. */
  stdinReadLimitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  setExitCode?: (code: number) => void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  authToken?: () => string;
  mirrorTarget?: MirrorTarget | null;
  mirrorState?: MsgMirrorStateStore;
  mirrorTransport?: MsgMirrorTransport;
  hookStateDir?: string;
  /** Wake-path resolution for `msg route` (tests inject; default reads pty manifest ⊕ seat folders). */
  wakeDeps?: WakeDeps;
  /** Attach the logs.db sink so `msg.wake` reaches `elanous logs` (a short CLI otherwise writes only the file trail). */
  registerLogSink?: () => Promise<unknown>;
  /** Wake the recipient after a durable post; never changes the post outcome. */
  wake?: (address: string, msgId: number, message: { from: string; kind?: string; fallback?: boolean }, deps: WakeDeps) => Promise<WakeOutcome>;
  /**
   * Agent auto-reply producer (`--agent-reply`). The default resolves the selected role LLM, loads its pack,
   * and calls the real `replyWithAgent`; the seams exist so a test still traverses that producer.
   */
  agentReply?: {
    role?: RoleLlmSpec;
    pack?: string;
    /** Test seam: a fake turn still goes through `replyWithAgent` and its ledger transaction. */
    runAgent?: AgentReplyInput['runAgent'];
    /** Test seam for the role ladder — `undefined` means «역할 LLM 미설정». */
    resolveRole?: (address: AgentReplyAddress) => RoleLlmSpec | undefined;
    observationRoot?: string;
  };
  /** `msg serve --sse` discovery file root (default: the state root). `msg post` restarts a dead service found here. */
  postOfficeStateRoot?: string;
  postOfficeAlive?: (pid: number) => boolean;
  postOfficeProbe?: (url: string) => Promise<boolean>;
  postOfficeLaunch?: (input: { port: number }) => void;
  /** Test seams for the existing self-send transport and the selected task-card ledger. */
  readCard?: typeof import('../task-agent/task-hand.js').readTaskCard;
  podFragmentsForRun?: typeof import('../harness/self-send-target.js').listPodFragmentsForRun;
  sendPod?: typeof import('../harness/self-send-target.js').dispatchPodSelfSend;
  runScreen?: typeof import('../self-implement/run-ledger.js').queryRunScreenKey;
  sendMemo?: typeof import('../harness/control-inbox.js').enqueueControlMemo;
  sendStop?: typeof import('../harness/control-inbox.js').enqueueSoftStop;
  screenAlive?: (spaceId: string) => boolean;
  /** MSG-FILTERS-RELAX: the seat actually running this CLI (default: ELANOUS_TRACK). A different `--from` is stored with
   *  this seat in `origin.seat`, never refused. */
  callerSeat?: () => string | null;
  /** KIT mail-route hand-route — the classifier for an unstructured ✋ line (default: the router's cheap model · null = codes only). */
  classifyHand?: import('../kit/mail-route/hand-route.js').HandRootClassifier | null;
  /** KIT mail-route hand-route — the ✋ cell lookups (claimed cell · cell owner); default: the live checklist (none under bun test). */
  handCells?: import('../kit/mail-route/hand-cells.js').HandCellLookups | null;
  /** Working directory for the `--from` default (seat folder). */
  cwd?: () => string;
  /** MSG-FILTERS-RELAX bulk-ack digest saver (default: the `eln memory add` store). */
  saveAckDigest?: AckDigestPorts['save'];
}

type CommonOptions = { json?: boolean };
type RecipientOptions = CommonOptions & { to?: string; after?: string; limit?: string; thread?: string };

/**
 * MSG-WAIT-CONTRACT ① — the envelope threaded onto the recipient's newest unanswered question/decision (or a mail the
 * recipient waits on). The waker store is read only when there is a candidate (lazy: msg post stays light).
 */
function threadedEnvelope<E extends MessageEnvelope>(store: MsgStore, envelope: E, optOut: boolean): E {
  if (optOut) return envelope;
  const contract = require('../msg/msg-wait-contract.js') as typeof import('../msg/msg-wait-contract.js');
  return contract.withAutoReplyTo(store, envelope, {
    waitedOn: (seatId) => contract.wakerWaitedOn((s) => (require('../msg/self-timer-watch.js') as typeof import('../msg/self-timer-watch.js')).listWakers(s))(seatId),
  });
}

function seat(raw: string | undefined, flag: string): string {
  if (raw === undefined) throw new Error(`${flag} is required`);
  return canonicalSeatId(raw);
}

function messageRecipient(raw: string | undefined, flag: string): string {
  if (raw === undefined) throw new Error(`${flag} is required`);
  const address = canonicalMessageAddress(raw);
  if (address === 'ALL' || address.startsWith('group:')) throw new Error(`${flag} must name one recipient`);
  return address;
}

const PRIORITY_LEVELS: Record<string, number> = { urgent: 2, p0: 1, normal: 0 };

/** MSG-FILTERS-RELAX: a word level or any integer; anything else is a warning and the message is stored without it. */
function cliPriorityLevel(raw: string | undefined, flag: string, warn: (line: string) => void): number | undefined {
  if (raw === undefined) return undefined;
  const level = PRIORITY_LEVELS[raw.trim().toLowerCase()];
  if (level !== undefined) return level;
  if (/^-?\d{1,6}$/.test(raw.trim())) return Number(raw.trim());
  warn(`msg post 경고: ${flag} ${raw} 를 모른다 (urgent · p0 · normal · 정수) — 우선순위 없이 저장한다`);
  return undefined;
}

/**
 * mf2 §1: `--crown-directive <id>` names the crown directive this message executes. The id must
 * resolve against the directive ledger (directives.db rowid); a missing ledger or unknown id is a
 * human-readable rejection — the post must not silently drop the delegation link.
 */
function checkCrownDirective(crownDirective: string | undefined, warn: (line: string) => void): void {
  if (crownDirective === undefined) return;
  // MSG-FILTERS-RELAX: an unresolved directive id is a warning — the message and its link are stored as written.
  try {
    const dbPath = directiveDbPath();
    if (!existsSync(dbPath)) { warn(`msg post 경고: --crown-directive: 지시 원장을 찾을 수 없습니다 (${dbPath}) — 링크는 그대로 저장`); return; }
    const id = Number(crownDirective);
    if (!Number.isSafeInteger(id) || id < 1) { warn(`msg post 경고: --crown-directive: 올바른 지시 ID가 아닙니다: ${crownDirective} — 링크는 그대로 저장`); return; }
    const db = new Database(dbPath, { readonly: true });
    try {
      const hit = db.query('SELECT 1 FROM directives WHERE rowid = ? LIMIT 1').get(id);
      if (hit === null || hit === undefined) warn(`msg post 경고: --crown-directive: 존재하지 않는 지시 ID입니다: ${crownDirective} — 링크는 그대로 저장 (elanous directives search 로 확인)`);
    } finally { db.close(); }
  } catch (error) {
    warn(`msg post 경고: --crown-directive 확인 실패: ${error instanceof Error ? error.message : String(error)} — 링크는 그대로 저장`);
  }
}

function integer(raw: string | undefined, flag: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  return value;
}

function hasEmptyAssignment(body: string): boolean {
  let keyTail = false;
  let awaitingValue = false;
  for (const char of body) {
    if (awaitingValue) {
      if (char === ' ' || char === '\t') continue;
      if (',;|)]}\r\n\u2028\u2029'.includes(char)) return true;
      awaitingValue = false;
    }
    if (char === '=' || char === ':') {
      awaitingValue = keyTail;
      keyTail = false;
    } else {
      keyTail = /[\p{L}\p{M}\p{N}_.-]/u.test(char);
    }
  }
  return awaitingValue;
}

function postBodyWarnings(body: string): string[] {
  const warnings: string[] = [];
  if (body.includes('`')) warnings.push('백틱이 포함됨');
  if (/\S[^\S\r\n]{2,}\S/.test(body)) warnings.push('문장 중간 연속 공백: 셸 명령 치환으로 내용이 사라졌을 수 있음');
  if (hasEmptyAssignment(body))
    warnings.push('빈 값 패턴: 셸 명령 치환 결과를 확인하세요');
  return warnings;
}

/**
 * A217 due. New shorthands: local «HH:MM» (today, or tomorrow when already past) and «+<n>m» / «+<n>h» → ISO.
 * Everything the old `--deadline` accepted (`Date.parse` · e.g. a date-only value) is kept as written, so existing
 * callers are unchanged (#38198 REVIEW-2 ④). Only an unparsable value is refused.
 */
export function parseDue(raw: string, now: Date): string {
  const value = raw.trim();
  const relative = /^\+(\d{1,4})([mh])$/u.exec(value);
  if (relative) return new Date(now.getTime() + Number(relative[1]) * (relative[2] === 'h' ? 3_600_000 : 60_000)).toISOString();
  const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/u.exec(value);
  if (clock) {
    const at = new Date(now);
    at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.toISOString();
  }
  if (value && Number.isFinite(Date.parse(raw))) return raw;
  throw new Error(`--deadline must be a date/time Date.parse accepts, HH:MM or +<n>m|h (${raw})`);
}

/** §8 — a hand ack is a «seen» receipt (never accepted or more). Fail-open, but observed like every receipt writer. */
function recordHandSeen(store: MsgStore, to: string, id: number): void {
  try { store.recordReceipt({ messageId: id, recipient: to, state: 'seen', source: 'cli-ack' }); }
  catch (error) {
    try { debug.log('msg.receipt-writer', 'record-failed', { msgId: id, recipient: to, state: 'seen', source: 'cli-ack', error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
    catch { /* observability is fail-open */ }
  }
}

/** Register the durable, recipient-addressed CLI. Reading never advances the acknowledgement cursor. */
export function registerMsgCommands(program: Command, deps: MsgCliDeps = {}): void {
  const open = deps.openStore ?? (() => openMsgStore(undefined, { archivePath: defaultArchivePath() }));
  const openRead = deps.openReadStore ?? (() => openMsgStoreReadOnly(undefined, { archivePath: defaultArchivePath() }));
  const out = deps.out ?? console;
  // [JUD-B #106365 must 1] 기본 stdin 읽기는 취소 가능 reader — 상한 race 에서 져도 fd0 를 즉시 반납한다
  // (취소 없으면 진행 중 Bun.stdin.text() 읽기가 fd0 을 붙잡은 채 프로세스가 종료하지 않는다).
  let cancelDefaultStdin: (() => void) | undefined;
  const readStdin = deps.readStdin ?? (() => {
    const reader = Bun.stdin.stream().getReader();
    cancelDefaultStdin = () => { try { void reader.cancel(); } catch { /* 이미 닫힘 */ } try { process.stdin.destroy(); } catch { /* 이미 닫힘 */ } };
    const decoder = new TextDecoder();
    return (async () => {
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done || value === undefined) break;
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    })().catch(() => '');
  });
  const stdinIsTty = deps.stdinIsTty ?? (() => process.stdin.isTTY ?? false);
  const stdinReadLimitMs = deps.stdinReadLimitMs ?? HOOK_STDIN_READ_LIMIT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const setExitCode = deps.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const msg = program.command('msg').description('Durable seat-addressed messages');

  // Called by both msg post and msg ask after their durable TA request is written.
  const handleTaMessage = async (request: Message): Promise<void> => {
    if (request.to !== 'TA' || request.from === 'TA' || request.replyTo !== undefined) return;
    const command = /\b(stop|memo|status)\b/i.exec(request.body);
    const cardId = /\bta-[a-zA-Z0-9][a-zA-Z0-9._-]*\b/.exec(request.body)?.[0]?.replace(/[.,!?]+$/, '');
    if (!command || !cardId) return;
    const { readTaskCard } = await import('../task-agent/task-hand.js');
    const { queryRunScreenKey } = await import('../self-implement/run-ledger.js');
    const { listHarnessScreens } = await import('../harness/harness-screen.js');
    const { normalizeRunId } = await import('../harness/harness-space.js');
    const { dispatchPodSelfSend, listPodFragmentsForRun } = await import('../harness/self-send-target.js');
    const { enqueueControlMemo, enqueueSoftStop } = await import('../harness/control-inbox.js');
    withStore(store => {
      // Reserve one linked reply and pending delivery before touching another store or Pod.
      const pending = store.db.transaction(() => {
        // A concurrent sender may have claimed after an earlier read. Keep this
        // check in the same write transaction as any pending reply change.
        if (store.taDeliveryClaimState(request.id) === 'held') return null;
        const reply = store.listReplies(request.id, 1)[0];
        if (reply && store.taDeliveryStatus(request.id) !== 'pending') return null;
        let delivery: (() => void) | undefined;
        let deliveryReply: string | undefined;
        let answer: string;
        try {
          const card = (deps.readCard ?? readTaskCard)(cardId);
          if (!card) throw new Error(`카드 없음: ${cardId}`);
          if (command[1]!.toLowerCase() === 'status') {
            answer = `${card.id}: ${card.status}${card.runId ? ` · run ${card.runId}` : ''}`;
          } else {
            const runId = card.runId;
            if (!runId || normalizeRunId(runId) !== runId) throw new Error(`${cardId}: 연결된 런 없음`);
            const fragments = (deps.podFragmentsForRun ?? listPodFragmentsForRun)(runId);
            const resolved = fragments.length === 0 ? (deps.runScreen ?? queryRunScreenKey)(runId) : null;
            const screen = resolved?.logStoreStatus === 'read' ? resolved.screenKey : null;
            if (fragments.length > 1 || (fragments.length === 0 && (!screen || !(deps.screenAlive ?? ((id: string) => listHarnessScreens().some(row => row.spaceId === id)))(screen)))) {
              throw new Error(`${cardId}: 실행 중인 단일 런 공간을 찾을 수 없음`);
            }
            const space = fragments[0]?.spaceId ?? screen!;
            const stop = command[1]!.toLowerCase() === 'stop';
            const body = stop ? '' : request.body.replace(command[0], '').replace(cardId, '').trim().replace(/^[,.:;\s-]+/, '');
            if (!stop && (!body || /[\r\n]/.test(body))) throw new Error('memo는 비어 있지 않은 한 줄이어야 한다');
            const memo = { version: 1 as const, kind: 'supervisor', urgency: 'normal' as const, body };
            answer = `${cardId}: run ${runId} 전달 여부 미확인 (${space}) — 자동 재시도 중지; 런 인박스를 확인하세요.`;
            delivery = () => {
              if (fragments.length) {
                if (!(deps.sendPod ?? dispatchPodSelfSend)(space, stop ? { stop: true } : { memo })) throw new Error(`${cardId}: Pod 전달 실패`);
              } else if (stop) (deps.sendStop ?? enqueueSoftStop)(space);
              else (deps.sendMemo ?? enqueueControlMemo)(space, memo);
            };
            deliveryReply = stop ? `${cardId}: run ${runId} soft stop 요청 기록 (${space})`
              : `${cardId}: run ${runId} 감독 메모 기록 (${space})`;
          }
        } catch (error) {
          answer = `${cardId}: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (delivery) store.setTaDeliveryStatus(request.id, 'pending');
        if (reply) store.updateTaReply(request.id, answer);
        else store.post({ from: 'TA', to: request.from, kind: 'reply', body: answer, replyTo: request.id });
        return delivery && deliveryReply ? { delivery, reply: deliveryReply } : null;
      }).immediate();
      if (pending) {
        const claim = store.claimTaDelivery(request.id);
        if (!claim) return;
        try {
          pending.delivery();
          store.settleTaDelivery(request.id, claim, pending.reply, true);
        }
        catch (error) {
          // A transport error or failed DB settlement may follow a successful publication.
          // Keep the claim and require inspection rather than send the same memo again.
          store.markTaDeliveryUnknown(request.id, claim,
            `${cardId}: 전달 여부 미확인 — 자동 재시도 중지: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  };

  const run = (action: () => void | Promise<void>) => async () => {
    try { await action(); }
    catch (error) {
      out.error(`msg: ${error instanceof Error ? error.message : String(error)}`);
      setExitCode(2);
    }
  };
  const withStore = <T>(action: (store: MsgStore) => T): T => {
    const store = open();
    let result: T;
    try { result = action(store); }
    catch (error) { try { store.close(); } catch { /* the action's own error is the one to report */ } throw error; }
    // ELN-MSG-POST-IDEMPOTENT: the action already committed — a lock or I/O error while closing must not turn a stored
    // write into a reported failure (the caller would retry and duplicate it).
    try { store.close(); }
    catch (error) {
      try { debug.log('msg.post', 'close-after-commit-failed', { error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
      catch { /* observability is fail-open */ }
    }
    return result;
  };
  /** `#id time FROM → TO [kind] · N bytes` (+ the dedupe note) — the stored message without its body. */
  const postedLine = (message: Message): string => {
    const head = formatMessage({ ...message, body: '' }).replace(/: $/, '');
    const bytes = Buffer.byteLength(message.body, 'utf8');
    // SEAT-MAIL #24 — the human line names the auto-acked original; JSON output carries the field itself.
    const autoAcked = message.autoAcked === undefined ? '' : ` · auto-acked #${message.autoAcked}`;
    return message.deduped
      ? `${head} · ${bytes} bytes · deduped: already stored within the dedupe window — suppressed as ${message.repeatReason ?? `repeat of #${message.id}`}${autoAcked}`
      : `${head} · ${bytes} bytes${autoAcked}`;
  };
  const emit = (value: unknown, json: boolean | undefined, human: () => void) => {
    if (json) out.log(JSON.stringify(value));
    else human();
  };
  const officeRoot = () => deps.postOfficeStateRoot ?? elanousStateRoot();

  /** `--agent-reply <address>` — only the loop rows that answer with an LLM body. */
  const agentReplyAddress = (raw: string | undefined): AgentReplyAddress | null => {
    if (raw === undefined) return null;
    const name = raw.trim().toUpperCase();
    if (!Object.hasOwn(AGENT_REPLY_ROLES, name)) throw new Error('--agent-reply must be COORDINATOR or GUARDIAN');
    return name as AgentReplyAddress;
  };
  const requireAgentTarget = (address: AgentReplyAddress, to: string): void => {
    if (address !== to) throw new Error(`--agent-reply ${address} requires --to ${address}`);
  };

  msg.command('mirror').description('Mirror selected seat messages to the configured GitHub issue')
    .option('--dry-run', 'read the configured channel and ledger without writing')
    .option('--watch', 'repeat until interrupted')
    .option('--interval <seconds>', 'poll interval in watch mode (default 60)', '60')
    .option('--json')
    .action((opts: CommonOptions & { dryRun?: boolean; watch?: boolean; interval?: string }) => run(async () => {
      const intervalSeconds = integer(opts.interval, '--interval', 60, 1, 3600);
      const state = deps.mirrorState ?? new JsonMsgMirrorStateStore();
      const configTarget = deps.mirrorTarget === undefined
        ? configuredMirrorTarget(getUserConfig().raw.msgMirror) : deps.mirrorTarget ?? undefined;
      const existingState = state.read();
      if (!configTarget && !existingState) {
        const result = { status: 'disabled', reason: 'msgMirror.target is not configured', target: null };
        debug.log('msg.mirror', 'disabled', result);
        out.log(opts.json ? JSON.stringify(result) : 'msg mirror 비활성: msgMirror.target 미설정');
        return;
      }
      const store = openRead();
      const transport = deps.mirrorTransport ?? new GitHubMsgMirrorTransport();
      const signal = deps.signal;
      try {
        do {
          let release = () => {};
          if (state instanceof JsonMsgMirrorStateStore) {
            mkdirSync(dirname(state.path), { recursive: true, mode: 0o700 });
            release = acquireLockSync(`${state.path}.lock`, { breakDeadHolder: true });
          }
          let result: Awaited<ReturnType<typeof runMsgMirrorTick>>;
          try {
            result = await runMsgMirrorTick({
              ...(configTarget ? { configuredTarget: configTarget } : {}),
              ...(opts.dryRun ? { dryRun: true } : {}),
              source: { listAfter: (after, limit) => store.listAfter(after, limit),
                listWindow: (start, end) => store.listCreatedBetween(start, end), latestId: () => store.latestId() },
              state, transport,
            });
          } finally { release(); }
          debug.log('msg.mirror', 'tick', result);
          out.log(opts.json ? JSON.stringify(result)
            : `msg mirror ${result.status} · scanned ${result.scanned} · posted ${result.posted} · rotated ${result.rotated} · summaries ${result.summaries}`);
          if (!opts.watch || signal?.aborted) break;
          await sleep(intervalSeconds * 1000);
        } while (!signal?.aborted);
      } finally { store.close(); }
    })());

  /**
   * Human-free live conversation: the selected address's LLM body answers the message that was just saved.
   * The durable ledger stays authoritative — `replyWithAgent` owns the one-reply-per-request transaction and
   * its dedupe, so a retry finds the existing link instead of generating again. A failure never changes the
   * post's exit code; it is reported as one line on stderr.
   */
  const autoReply = async (address: AgentReplyAddress, request: Message, json: boolean | undefined): Promise<void> => {
    const seam = deps.agentReply;
    let role = seam?.role;
    if (role === undefined) {
      if (seam?.resolveRole) role = seam.resolveRole(address);
      else {
        const { resolveConfiguredAgentRoleLlm } = await import('../user-config.js');
        // Only an explicitly selected provider/tier/model starts an agent body; effort alone is not a selection.
        role = resolveConfiguredAgentRoleLlm(AGENT_REPLY_ROLES[address]);
      }
    }
    if (role === undefined) {
      out.error(`msg: ${address} 역할 LLM 미설정 — 자동 답 없음`);
      return;
    }
    let pack = seam?.pack;
    if (pack === undefined) {
      try {
        const { loadAgentRolePack } = await import('../loops/agent-reply.js');
        pack = loadAgentRolePack(AGENT_REPLY_ROLES[address]);
      } catch (error) {
        out.error(`msg: ${address} 역할 팩 없음 — 자동 답 없음: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    try {
      const { replyWithAgent } = await import('../loops/agent-reply.js');
      const store = open();
      let result: AgentReplyResult;
      try {
        result = await replyWithAgent({ address, role, pack, store,
          request: { id: request.id, from: request.from, body: request.body,
            ...(request.kind === undefined ? {} : { kind: request.kind }) },
          ...(seam?.runAgent ? { runAgent: seam.runAgent } : {}),
          ...(seam?.observationRoot ? { observationRoot: seam.observationRoot } : {}) });
      } finally { store.close(); }
      emit({ agentReply: { address, requestId: request.id, ...result } }, json,
        () => out.log(`자동 답 ${result.replyId === null ? '없음' : `#${result.replyId}`} (${address} → ${request.from})${result.posted ? '' : ' — 이미 있음'}`));
    } catch (error) {
      out.error(`msg: 자동 답 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * Installed post-office supervision: a registered `msg serve --sse` that no longer answers is restarted on
   * its recorded port. Nothing is spawned when no service registered itself, so a plain post is unchanged.
   */
  const supervisePostOffice = async (): Promise<void> => {
    const result = await ensurePostOffice({ stateRoot: officeRoot(),
      ...(deps.postOfficeAlive ? { alive: deps.postOfficeAlive } : {}),
      ...(deps.postOfficeProbe ? { probe: deps.postOfficeProbe } : {}),
      ...(deps.postOfficeLaunch ? { launch: deps.postOfficeLaunch } : {}) });
    if (result.state === 'restarted')
      out.error(`msg: post office 재시작 (port ${result.port}) — 원장이 정본이라 저장된 글은 다시 밀린다`);
  };

  msg.command('mail-fallback').description('(internal) 60s safety net for an eln seat: one «check your mail» knock when nothing was received')
    .requiredOption('--msg <id>').requiredOption('--to <seat>').requiredOption('--from <seat>')
    .option('--wait-ms <ms>', 'wait before checking', String(MAIL_FALLBACK_MS))
    .action((opts: { msg: string; to: string; from: string; waitMs: string }) => run(async () => {
      // #122460 ③ — attach the logs.db sink before the wait: this CLI lives for the one knock, so its msg.fallback /
      // msg.wake evidence lines must reach `elanous logs` — a short CLI otherwise leaves only the file trail (CX-16
      // postland: the fallback claimed at 11:15:15 but the retry wake's line was never observed in eln logs).
      try {
        let sinkTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          (deps.registerLogSink ?? (async () => (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('cli')))(),
          new Promise<void>(resolve => { sinkTimer = setTimeout(resolve, 1000); }),
        ]).finally(() => clearTimeout(sinkTimer));
      } catch { /* observability is fail-open */ }
      const result = await runMailFallback({ messageId: integer(opts.msg, '--msg', 0, 1, Number.MAX_SAFE_INTEGER), recipient: canonicalSeatId(opts.to), from: canonicalSeatId(opts.from) }, {
        openStore: open, waitMs: integer(opts.waitMs, '--wait-ms', MAIL_FALLBACK_MS, 0, 3_600_000),
        ...(deps.fallbackSleep ? { sleep: deps.fallbackSleep } : {}),
        wake: (address, msgId, message) => (deps.wake ?? wakeRecipient)(address, msgId, message, deps.wakeDeps ?? {}),
      });
      out.log(result);
    })());

  msg.command('post [body]').description('Post a message; use --body-file <path>, - or omit body to read stdin')
    .option('--from <seat>').option('--to <seat>').option('--kind <kind>').option('--body <text>')
    .option('--body-file <path>', 'read the message body from a UTF-8 file; use - for stdin')
    .option('--reject-undeclared', 'reject a recipient that has no routable seat or pane instead of storing it with a warning')
    .option('--reply-to <id>', 'point this reply at a question message ID (default: the newest unanswered question/decision from the recipient)')
    .option('--no-reply-to', 'do not thread this post onto the recipient\'s unanswered question')
    .option('--agent-reply <address>', 'let this address\'s agent body (COORDINATOR · GUARDIAN) answer the saved message once')
    .option('--origin-key <key>', 'deduplicate a channel mirror by coord:<commentId>:<recipient>')
    .option('--intent <kind>', 'message intent: request | decision | info | alert')
    .option('--ref <id>', 'message reference ID (repeatable)', (value: string, previous: string[]) => previous.concat([value]), [] as string[])
    .option('--deadline <due>', 'deadline: ISO-8601 · local HH:MM (next occurrence) · +<n>m|h from now')
    .option('--done <condition>', 'completion condition (A217 request contract · required with --intent request)')
    .option('--needs-ack', 'mark the message as acknowledgement-required')
    .option('--needs-reply', 'MAIL-ANTI-FLOOD E: you wait for an answer (default: question · decision)')
    .option('--no-needs-reply', 'MAIL-ANTI-FLOOD E: no answer expected — the receiver reads it in its digest')
    .option('--crown-directive <id>', 'crown directive ID this message executes')
    .option('--urgency <level>', 'OP-PULSE: CEO urgency of this crown directive — normal | urgent | all-in (stored as ref urgency:<level>; urgent → 4h burst proposal · all-in → max burst)')
    .option('--goal <text>', 'set the receiving seat\'s autopilot goal (structured field · OP / CLAUDE-OP or with --crown-directive)')
    .option('--priority <level>', 'priority: urgent(2) | p0(1) | normal(0)')
    .option('--expires <dur>', 'DIRECTIVE-EXPIRY: lapse after <dur> (30m · 2h · 1d); default by kind — info/notice/status 30m · coord/request 2h · directive 2h')
    .option('--standing', 'DIRECTIVE-EXPIRY: a standing directive (lapses after 24h)')
    .option('--no-expiry', 'DIRECTIVE-EXPIRY: never lapses')
    .option('--no-coalesce', 'OUTBOUND-COALESCE: store a separate row even when an unread mail to the same receiver could take these lines')
    .option('--retracts <msgId>', 'DIRECTIVE-EXPIRY: this mail withdraws an earlier one (closed now · dropped from the next turn)')
    .option('--no-dedupe', 'store even when the same from/to/body was posted within the dedupe window (default 30 min)')
    .option('--announce [id]', 'post as a federation announce (kind announce · ref announce:<id>); without an id one is generated')
    .option('--announce-scope <scope>', 'announce scope: federation | coordinators (default federation)')
    .option('--apply <line>', 'on a reply to an announce (--reply-to): the «적용:» line — what this seat will do differently')
    .option('--watch <condition>', 'the OUTCOME you await instead of a reply (pr-merged:<N> · pregate-receipt:<PR>[@head] · cell-status:<id>=green|owner=<seat> · seat-idle:<seat> · file-exists:<path> · mail-from:<seat>) — the commitment closes itself with evidence when it holds; the recipient reads «no reply needed»')
    .option('--json')
    .action((body: string | undefined, opts: CommonOptions & { watch?: string; from?: string; to?: string; kind?: string; body?: string; bodyFile?: string; replyTo?: string | false; originKey?: string; agentReply?: string; rejectUndeclared?: boolean; intent?: string; ref?: string[]; deadline?: string; done?: string; needsAck?: boolean; needsReply?: boolean; crownDirective?: string; urgency?: string; goal?: string; priority?: string; dedupe?: boolean; announce?: string | boolean; announceScope?: string; apply?: string; expires?: string; standing?: boolean; expiry?: boolean; retracts?: string; coalesce?: boolean }) => run(async () => {
      // MSG-WAIT-CONTRACT — `--no-reply-to` arrives as replyTo === false (commander negation).
      const noReplyTo = opts.replyTo === false;
      const replyToOpt = typeof opts.replyTo === 'string' ? opts.replyTo : undefined;
      const warn = (line: string) => out.error(line);
      // MSG-FILTERS-RELAX: the seat actually running this CLI. `--from` defaults to it; a different `--from` is stored
      // with the caller in origin.seat instead of being refused.
      const caller = (() => {
        try {
          const raw = (deps.callerSeat ?? (() => process.env.ELANOUS_TRACK?.trim() || null))();
          return raw ? canonicalSeatId(raw) : null;
        } catch { return null; }
      })();
      const fromRaw = opts.from ?? caller ?? seatFromCwd((deps.cwd ?? (() => process.cwd()))()) ?? undefined;
      if (fromRaw === undefined) throw new Error('--from is required (or run from a seat folder / set ELANOUS_TRACK)');
      const from = canonicalMessageAddress(fromRaw);
      const origin = caller !== null && caller !== from ? { origin: { kind: 'agent' as const, seat: caller } } : {};
      // A217 — a request names when it is due and what «done» means. MSG-FILTERS-RELAX: a missing part is a warning.
      if (opts.intent === 'request' && (opts.deadline === undefined || !opts.done?.trim()))
        warn('msg post 경고: --intent request 에 --deadline <due> 와 --done <condition> 이 없다 (A217 요청 계약) — 그대로 저장한다');
      const deadlineAt = (() => {
        if (opts.deadline === undefined) return undefined;
        try { return parseDue(opts.deadline, (deps.now ?? (() => new Date()))()); }
        catch (error) { warn(`msg post 경고: ${error instanceof Error ? error.message : String(error)} — 기한 없이 저장한다`); return undefined; }
      })();
      const unsupported = opts.to === undefined ? null : unsupportedLoopAddressNotice(opts.to);
      if (unsupported) out.error(unsupported);
      if (opts.to === undefined) throw new Error('--to is required');
      const to = canonicalMessageAddress(opts.to);
      const route = resolveWake(to, deps.wakeDeps);
      const undeclared = route.reason?.startsWith('undeclared-address');
      const unroutable = undeclared || route.reason?.startsWith('dead-');
      if (opts.rejectUndeclared && route.wake === 'none' && unroutable)
        throw new Error(`undeclared or dead message address: ${to} (${route.reason})`);
      // MSG-ADDRESS-DID-YOU-MEAN (OP #177316 «OP-CLAUDE» ≠ CLAUDE-OP · silently stored, never delivered): an undeclared
      // address that is a near miss of a known recipient is refused with the suggestion. A genuinely new address still posts.
      if (route.wake === 'none' && undeclared) {
        const known = (() => { try { const s = open(); try { return knownSeats(s); } finally { s.close(); } } catch { return [] as string[]; } })();
        const suggestion = didYouMeanAddress(to, known);
        if (suggestion) throw new Error(`unknown message address: ${to} — did you mean ${suggestion}? (nothing was stored)`);
      }
      if (route.wake === 'none' && undeclared) out.error(`${route.reason} · wake=none · ${to}: 수신 패널을 찾지 못했습니다 (거부하려면 --reject-undeclared)`);
      debug.log('msg.post', 'caller-runtime', { runtime: process.env.ELANOUS_AGENT_RUNTIME?.trim() || 'unknown', to });
      // Validate the auto-reply target before saving — a mismatched flag must not leave a stored message behind.
      const agentAddress = agentReplyAddress(opts.agentReply);
      if (agentAddress !== null) requireAgentTarget(agentAddress, to);
      const positionalBody = body !== undefined && body !== '-' ? body : undefined;
      if ((body === '-' && (opts.body !== undefined || opts.bodyFile !== undefined))
        || [positionalBody, opts.body, opts.bodyFile].filter(value => value !== undefined).length > 1)
        throw new Error('provide body once (argument, --body, or --body-file)');
      if (opts.bodyFile === '') throw new Error('--body-file requires a path or - for stdin');
      // COND-WATCH — parse before storing: a bad condition never leaves a stored message behind.
      const watchModule = opts.watch === undefined ? null : await import('../commitment/condition-watch.js');
      const watch = watchModule === null ? null : watchModule.parseWatch(opts.watch!, (deps.cwd ?? (() => process.cwd()))());
      const rawText = opts.bodyFile === undefined
        ? opts.body ?? positionalBody ?? await readStdin()
        : opts.bodyFile === '-' ? await readStdin() : await readFile(opts.bodyFile, 'utf8');
      const text = watchModule !== null && watch !== null ? watchModule.withWatchFooter(rawText, watch) : rawText;
      for (const warning of postBodyWarnings(text))
        out.error(`msg post 경고: ${warning} — 본문을 확인하고 다음 보고는 --body-file 또는 stdin 사용`);
      checkCrownDirective(opts.crownDirective, warn);
      // CROWN-GOAL-APPLY — the goal is a structured field; only a goal setter (or a crown-directive mail) may carry one.
      if (opts.goal !== undefined && !opts.goal.trim()) throw new Error('--goal needs a nonempty goal line');
      if (opts.goal !== undefined) {
        const verdict = goalSetterVerdict({ sender: from, seat: opts.to === undefined ? null : canonicalMessageAddress(opts.to), crownDirective: opts.crownDirective ?? null,
          ladder: () => (require('../msg/hand-raise-ladder.js') as typeof import('../msg/hand-raise-ladder.js')).loadFederationLadder() });
        if (!verdict.ok) throw new Error(`--goal: ${goalSetterRefusal(verdict)}`);
      }
      const priority = cliPriorityLevel(opts.priority, '--priority', warn);
      // ANNOUNCE-UPTAKE — an announce is kind=announce ⊕ refs announce:<id> · announce-scope:<scope> (default off).
      const apply = parseApplyField(opts.apply);
      if (apply !== null && replyToOpt === undefined) throw new Error('--apply needs --reply-to <announce message id>');
      if (opts.announceScope !== undefined && opts.announce === undefined) throw new Error('--announce-scope needs --announce');
      if (opts.announce !== undefined && opts.kind !== undefined && opts.kind.trim().toLowerCase() !== ANNOUNCE_KIND)
        throw new Error('--announce sets kind announce; drop --kind');
      const announce = opts.announce === undefined ? null : {
        id: typeof opts.announce === 'string' ? normalizeAnnounceId(opts.announce) : newAnnounceId(text, (deps.now ?? (() => new Date()))()),
        scope: normalizeAnnounceScope(opts.announceScope) };
      const urgency = opts.urgency === undefined ? null : (await import('../loops/op-pulse-urgency.js')).parseUrgency(opts.urgency);
      if (urgency !== null && !opts.crownDirective) throw new Error('--urgency needs --crown-directive (urgency is a field of a CEO line)');
      const refs = [...(opts.ref ?? []), ...(announce === null ? [] : announceRefs(announce.id, announce.scope)), ...(urgency === null ? [] : [`urgency:${urgency}`])];
      // DIRECTIVE-EXPIRY (Q5) — expiry by kind ⊕ structured directive fields; flags override. `--retracts` → supersedes.
      const retracts = opts.retracts === undefined ? undefined : integer(opts.retracts, '--retracts', 0, 1, Number.MAX_SAFE_INTEGER);
      const expiry = postExpiry({ kind: announce !== null ? ANNOUNCE_KIND : opts.kind ?? null, crownDirective: opts.crownDirective ?? null, goal: opts.goal ?? null,
        senderAbove: (() => { try { return senderAboveOnLadder(loadFederationLadder(), from, to) === true; } catch { return false; } })(),
        ...(opts.expires === undefined ? {} : { expires: opts.expires }), ...(opts.standing ? { standing: true } : {}),
        ...(opts.expiry === false ? { expiry: false } : {}), now: (deps.now ?? (() => new Date()))() });
      const envelope = { from, to, body: text, ...origin,
        ...(expiry.expiresAt === undefined ? {} : { expiresAt: expiry.expiresAt }),
        ...(retracts === undefined ? {} : { supersedes: retracts }),
        ...(announce !== null ? { kind: ANNOUNCE_KIND } : opts.kind === undefined ? {} : { kind: opts.kind }),
        ...(replyToOpt === undefined ? {} : { replyTo: integer(replyToOpt, '--reply-to', 0, 1, Number.MAX_SAFE_INTEGER) }),
        ...(priority === undefined ? {} : { priority }),
        ...(opts.intent === undefined ? {} : { intent: opts.intent as MessageEnvelope['intent'] }),
        ...(refs.length === 0 ? {} : { refs }),
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        ...(opts.done === undefined ? {} : { doneWhen: opts.done }),
        ...(opts.needsAck ? { needsAck: true } : {}),
        ...(opts.crownDirective === undefined ? {} : { crownDirective: opts.crownDirective }),
        ...(opts.goal === undefined ? {} : { goal: opts.goal }) };
      // DORMANT-ADDRESS REROUTE — a post to an address with no live tab (RES · REL · REVIEW-2 · JUD-2 · ORCHESTRATOR)
      // goes to the live reader instead (JUD · OP digest) unless the wake resolver finds a live reader for it (KIT
      // mail-route · LA-R2); the sender gets one line. A keyed relay is never rerouted.
      if (opts.originKey === undefined) {
        // KIT mail-route entrance — ✋ hand routing by root (WIP → TC · JUD verdict → JUDGE-BUTLER · env → GUARDIAN), then dormant.
        for (const move of await routeAtEntrance(envelope, { ...(deps.wakeDeps ? { wakeDeps: deps.wakeDeps } : {}), ...(deps.classifyHand !== undefined ? { classifyHand: deps.classifyHand } : {}),
          ...(deps.handCells !== undefined ? { cells: deps.handCells } : {}) })) {
          debug.log(move.kind === 'hand-route' ? 'msg.hand-route' : 'msg.dormant-reroute', 'rerouted', { from, to: move.to, into: move.into, ...(move.digest === undefined ? {} : { digest: move.digest }), ...(move.root ? { root: move.root } : {}) });
          out.error(`msg post: ${move.note}`);
        }
      }
      // #38516 r2 MF3: a per-attempt token goes into this INSERT, so recovery after an ambiguous write can name THIS
      // attempt's commit — an older identical row (`--no-dedupe`, or outside the window) never stands in for a send that
      // was not stored. MF4: the `--origin-key` path is idempotent by its provenance key instead (explicit contract:
      // the key names one logical message, so the stored row under it is this message whichever attempt wrote it;
      // the body-hash window does not apply there).
      // MAIL-ANTI-FLOOD E·F·G — kind ⊕ needsReply (a kind-less post is stored as passive info ⊕ one warning line) · self-mail → scheduled wake ·
      // coach injection → coach note · a saturated receiver folds non-urgent posts into its digest. A keyed channel
      // mirror (`--origin-key`) is a programmatic relay: legacy shape, never diverted.
      let gate: ReturnType<typeof gatePost> | null = null;
      let coalescedInto: number | null = null;
      const attemptToken = randomUUID();
      let stored: Message | null;
      try {
        stored = withStore(store => {
          if (opts.originKey !== undefined) return store.appendWithProvenance(envelope, opts.originKey);
          // G — an order from above on the ladder is never folded (same ladder relation the receiver's router reads).
          let senderAbove: boolean | undefined;
          try { senderAbove = senderAboveOnLadder(loadFederationLadder(), envelope.from, envelope.to); } catch { senderAbove = undefined; }
          // OUTBOUND-COALESCE (H6) — an ordinary order from above joins the sender's still-unread mail to the same receiver (≤10 min).
          if (opts.coalesce !== false && opts.originKey === undefined && coalesceEligible({ senderAbove: senderAbove === true, kind: envelope.kind ?? null, intent: envelope.intent ?? null, priority: envelope.priority ?? null,
            crownDirective: envelope.crownDirective ?? null, goal: envelope.goal ?? null, supersedes: envelope.supersedes ?? null, to: envelope.to, ...(replyToOpt === undefined ? {} : { replyTo: 1 }),
            ...(opts.needsReply === undefined ? {} : { needsReply: opts.needsReply }) })) {
            const joined = store.coalesceInto(envelope.from, envelope.to, envelope.body, COALESCE_WINDOW_MS, (deps.now ?? (() => new Date()))());
            if (joined !== null) { coalescedInto = joined.id; return joined; }
          }
          // MSG-WAIT-CONTRACT ① — thread onto the recipient's newest unanswered question/decision (or a mail it waits on)
          // BEFORE the gate (same order as the MsgPost tool): a reply to the receiver's own ask is judged as one (F keeps a
          // coach answer as mail · G never folds it).
          Object.assign(envelope, threadedEnvelope(store, envelope, noReplyTo || to === 'TA'));
          gate = gatePost({ envelope, entrance: 'cli', ...(opts.needsReply === undefined ? {} : { needsReply: opts.needsReply }), ...(senderAbove === undefined ? {} : { senderAbove }) },
            storeGateDeps(store, deps.divertedRoot ?? divertedRootForStore(store.storePath)));
          if (gate.action !== 'post') return null;
          // CLAUDE-OP-PROXY-LANE — the gate owns the `lane:proxy` ref (stamped on a lane post · dropped from any other).
          Object.assign(envelope, { kind: gate.envelope.kind, needsAck: gate.envelope.needsAck, refs: gate.envelope.refs });
          const laneCancel = gate.laneCancel;
          const laneCommit = gate.laneCommit;
          try { const row = store.post(envelope, { dedupe: opts.dedupe !== false, attemptToken }); laneCommit?.(); return row; }
          catch (error) {
            // A validation refusal stored nothing: release the proxy-lane slot now (an ambiguous storage error is settled below).
            if (!/database is locked|SQLITE_BUSY|SQLITE_IOERR|disk I\/O|database is busy/i.test(error instanceof Error ? error.message : String(error))) laneCancel?.();
            throw error;
          }
        });
      } catch (error) {
        // Only an ambiguous STORAGE error (lock / busy / I-O around COMMIT) can hide a commit. A validation refusal
        // (bad origin key, recipient mismatch, unknown group) stored nothing by definition — report it as is.
        const message = error instanceof Error ? error.message : String(error);
        if (!/database is locked|SQLITE_BUSY|SQLITE_IOERR|disk I\/O|database is busy/i.test(message)) throw error;
        let landed: Message | null = null;
        try {
          landed = withStore(store => opts.originKey === undefined
            ? store.findPostByAttempt(attemptToken)
            : store.findByProvenanceKeyFor(opts.originKey, envelope)); // r3 MF2: same sender → recipient only
        } catch { /* still unknown: report the write error */ }
        if (landed === null) {
          // CLAUDE-OP-PROXY-LANE — the row was not written: release the lane slot so a retry is not its own duplicate.
          const g = gate as ReturnType<typeof gatePost> | null;
          if (g?.action === 'post') g.laneCancel?.();
          throw error;
        }
        { const g = gate as ReturnType<typeof gatePost> | null; if (g?.action === 'post') g.laneCommit?.(); }
        debug.log('msg.post', 'recovered-after-error', { msgId: landed.id, from, to, by: opts.originKey === undefined ? 'attempt' : 'origin-key',
          error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
        stored = landed;
      }
      const decided = gate as ReturnType<typeof gatePost> | null;
      if (decided?.action === 'refuse') throw new Error(decided.error);
      if (decided?.action === 'divert') {
        emit({ diverted: decided.ledger, to, kind: decided.shape.kind, needsReply: decided.shape.needsReply, line: decided.line }, opts.json, () => out.log(`msg post: ${decided.line}`));
        return;
      }
      if (decided?.action === 'post' && decided.warning) out.error(decided.warning);
      if (stored === null) throw new Error('msg post: nothing stored');
      const posted: Message = stored;
      // OUTBOUND-COALESCE (H6) — the sender's outbound rate (metric · soft budget read by its own inbox snapshot).
      try { debug.log('msg.outbound', 'rate', { seat: from, per30m: withStore(store => store.countSentSince(from, new Date(Date.now() - OUTBOUND_WINDOW_MS))) }); } catch { /* metric only */ }
      if (coalescedInto !== null) {
        debug.log('msg.post', 'coalesced', { into: coalescedInto, from, to });
        emit({ ...posted, coalesced: true }, opts.json, () => out.log(`msg post: coalesced into #${coalescedInto} (${to} has not read it yet · one wake)`));
        return;
      }
      if (retracts !== undefined) {
        // DIRECTIVE-EXPIRY — after the retraction mail is stored: the original's expiry becomes now (a refusal is a warning; the mail stays).
        try {
          const closed = withStore(store => store.retract(retracts, from, (deps.now ?? (() => new Date()))()));
          debug.log('msg.post', 'retracted', { msgId: posted.id, retracts, closed: closed !== null });
          if (!opts.json) out.log(closed === null ? `retracts #${retracts}: already lapsed` : `retracted #${retracts}`);
        } catch (error) { out.error(`msg post: #${posted.id} stored; retracting #${retracts} failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      // The human line names the stored id without echoing the body: a caller that scans the output for an error word
      // must not find it inside its own message (11-18: a report quoting «database is locked» was re-sent 13 times).
      if (posted.digested !== undefined && posted.id === 0) {
        emit(posted, opts.json, () => out.log(`msg post: parked for the OP 30-min digest (item ${posted.digested})`));
        return;
      }
      // HAND-RAISE-DOMAIN-ROUTING — the same ✋ ask inside the window: the sender reads the first row's answer (or «still open»).
      if (posted.handAskRepeat) {
        const ref = withStore(store => handAskReference(store, posted));
        debug.log('msg.hand-ask', 'by-reference', { from, firstId: ref.firstId, to: ref.to, answered: ref.answer?.id ?? null });
        emit({ ...posted, byReference: { firstId: ref.firstId, to: ref.to, answerId: ref.answer?.id ?? null, answer: ref.answer?.body ?? null } }, opts.json, () => out.log(`msg post: ${ref.line}`));
        return;
      }
      emit(posted, opts.json, () => out.log(`${postedLine(posted)}${announce === null ? '' : ` · announce ${announce.id} (${announce.scope})`}`));
      // COND-WATCH — arm the outcome watch (after the commit; a failure is a warning with the stored id, never a resend).
      if (watch !== null) {
        try {
          const { armMessageFollowUp } = await import('../msg/msg-follow-up.js');
          const { formatWaitCondition } = await import('../msg/self-timer-watch.js');
          const armed = await (deps.followUp ?? armMessageFollowUp)(posted, undefined, undefined, formatWaitCondition(watch));
          if (!opts.json) out.log(`watch ${armed.condition} · commitment ${armed.commitmentId}${armed.merged ? ' (merged)' : ''}`);
        } catch (error) { out.error(`msg post: #${posted.id} stored; arming the watch failed: ${error instanceof Error ? error.message : String(error)} (do not resend; arm it with eln msg wait-for)`); }
      } else {
        try {
          const { suggestWatch } = await import('../commitment/condition-watch.js');
          const hint = suggestWatch({ kind: opts.kind, refs });
          if (hint) out.error(`msg post: tip — you await an outcome, not a reply: add --watch ${hint}`);
        } catch { /* a hint is optional */ }
      }
      // LEADER-HAND-CONTRACT ① — a free-text HOLD reply to a ✋ is sent but does not close it; say so (and count it).
      if (posted.replyTo !== undefined) {
        try {
          const { holdReplyWarning } = await import('../msg/hand-raise-ladder.js');
          const warning = withStore(store => holdReplyWarning(store, { from, replyTo: posted.replyTo, body: posted.body, refs: posted.refs ?? [], now: Date.now() }));
          if (warning) { out.error(`msg post: ${warning}`); debug.log('needhuman', 'hold-reply-warned', { msgId: posted.id, replyTo: posted.replyTo, from }); }
        } catch { /* a warning is optional */ }
      }
      // ANNOUNCE-UPTAKE — the reply's apply field lands as the seat's «applied» event. Fail-open: the reply is stored.
      if (apply !== null && posted.replyTo !== undefined) {
        try {
          const applied = withStore(store => recordAnnounceApply(store.db, { seat: from, messageId: posted.replyTo!, line: apply, viaMessageId: posted.id }));
          if (applied === null) out.error(`msg post: --apply ignored — #${posted.replyTo} is not an announce`);
        } catch (error) { out.error(`msg post: #${posted.id} stored; recording the apply line failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      // #38516 r2 MF2: TA handling runs after the commit and is separated from it — a TA failure is a warning with the
      // stored id, never exit 2 (exit 2 = «not stored», which makes callers resend). A retry with the same --origin-key
      // stays safe: it finds the stored request and re-drives the pending delivery (provenance + linked reply).
      try { await handleTaMessage(posted); } // msg post: process the durable TA request (including pending retry).
      catch (error) {
        debug.log('msg.post', 'after-commit-step-failed', { msgId: posted.id, step: 'ta', error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
        // #38516 r3 MF3: the recovery advice matches how this send was made. Only a keyed send is idempotent on retry;
        // an unkeyed resend (or adding a new key) would store a second message next to #id.
        const advice = opts.originKey === undefined
          ? `do not resend — it would be a second message; the request is #${posted.id}`
          : 'retry with the same --origin-key is safe';
        out.error(`msg post: #${posted.id} stored; the TA follow-up failed: ${error instanceof Error ? error.message : String(error)} (${advice})`);
      }
      // Everything below runs after the message is durable: a failure here is a warning, never a failed post.
      let noBody: string | null = null;
      try {
        const replyBody = messageReplyBodyFor(to, deps.wakeDeps);
        noBody = replyBody === 'none' ? noReplyBodyNotice(to) ?? '이 주소는 읽는 몸이 없다 — 지금은 OP' : null;
        if (noBody) out.error(noBody);
      } catch (error) {
        debug.log('msg.post', 'after-commit-step-failed', { msgId: posted.id, step: 'route', error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
        out.error(`msg post: #${posted.id} stored; a follow-up step failed (not resent)`);
      }
      // 저장 «뒤» 한 번 — 읽는 몸이 없다는 안내가 이미 나갔으면 깨움 경고는 겹쳐 내지 않는다.
      // 깨움은 post 의 성패를 바꾸지 않는다 — 동기 예외까지 여기서 막는다.
      // 로그 싱크 등록이 멈춰도 깨움·post 완료를 붙잡지 않는다(1초 상한).
      try {
        let sinkTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          (deps.registerLogSink ?? (async () => (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('cli')))(),
          new Promise<void>(resolve => { sinkTimer = setTimeout(resolve, 1000); }),
        ]).finally(() => clearTimeout(sinkTimer));
      } catch { /* observability is fail-open */ }
      // 설치본을 갈아 끼우면 우편국(SSE)은 조용히 사라진다 — 등록해 둔 서비스가 응답하지 않으면 같은 포트로 다시 띄운다.
      // 재시작도 관측도 post 의 성패를 바꾸지 않는다.
      try { await supervisePostOffice(); } catch { /* post office is fail-open */ }
      try {
        const woke = await (deps.wake ?? wakeRecipient)(to, posted.id, { from, ...(opts.kind === undefined ? {} : { kind: opts.kind }) },
          { ...deps.wakeDeps, warn: noBody ? () => {} : line => out.error(line) });
        if (woke?.wake === 'els' && woke.result !== 'injected')
          out.error(`msg wake: ${to} ${woke.result === 'busy' ? 'deferred' : 'not confirmed; check before retry'} (${woke.result}${woke.reason ? `: ${woke.reason}` : ''}); message #${posted.id} remains stored`);
        // ELS verified wake has opened a turn; record delivery, never seen or done.
        if (woke?.wake === 'els' && woke.result === 'injected') {
          try { withStore(store => store.recordReceipt({ messageId: posted.id, recipient: to, state: 'delivered', source: 'cli', evidence: woke.target ?? 'els:unknown' })); }
          catch (error) { debug.log('msg.receipt-writer', 'record-failed', { msgId: posted.id, recipient: to, state: 'delivered', error: error instanceof Error ? error.message : String(error) }, { level: 'warn' }); }
        }
        // OP 11-17 21:5x — an eln seat receives through its own mail watch; only if nothing is received in 60s, one knock.
        if (woke?.result === 'eln-mail-watch' || (woke?.wake === 'els' && woke.result === 'busy')) {
          try {
            (deps.spawnMailFallback ?? ((input) => { if (isLiveWakeUniverse(deps.wakeDeps)) spawnMailFallback(input); }))({ messageId: posted.id, recipient: to, from });
          } catch { /* the safety net never fails a post */ }
        }
      } catch { /* the wake outcome is logged by wakeRecipient; the post is already durable */ }
      if (agentAddress !== null) {
        try { await autoReply(agentAddress, posted, opts.json); }
        catch (error) {
          debug.log('msg.post', 'after-commit-step-failed', { msgId: posted.id, step: 'agent-reply', error: error instanceof Error ? error.message : String(error) }, { level: 'warn' });
          out.error(`msg post: #${posted.id} stored; the agent reply failed (not resent)`);
        }
      }
    })());

  msg.command('route <address>').description('Show how a post to this address is read (replyBody) and woken (wake)')
    .option('--json')
    .action((address: string, opts: CommonOptions) => run(async () => {
      const to = canonicalMessageAddress(address);
      const snapshot = registrySnapshot(deps.wakeDeps ?? {});
      const shared = { ...deps.wakeDeps, registrySnapshot: snapshot };
      const els = await resolveElsSeat(to, shared, seatRouteHint(to, shared));
      const wake = els.wake ?? resolveWake(to, shared);
      const delivery = seatDeliveryView(to, shared, snapshot);
      const seatName = to.replace(/^SEAT:/, '');
      const SEAT_ID_LIKE = /^[A-Z][A-Z0-9_-]{0,63}$/;
      const legacyLiveness = SEAT_ID_LIKE.test(seatName)
        ? classifySeatInbox(seatInboxAlivePath(resolveSeatStateRoot(deps.wakeDeps ?? {}), seatName), { host: wake.host || 'unknown' }, Date.now())
        : undefined;
      const remoteLiveness = els.liveness?.state === 'live' ? undefined : await resolveRemoteSeatLiveness(to, wake.host, shared);
      const herdrLiveness = els.liveness?.state === 'live' || remoteLiveness || !isLocalWakeHost(wake.host, shared)
        ? undefined : await resolveHerdrSeatLiveness(to, shared);
      const primaryLiveness = els.liveness?.state === 'live' ? els.liveness : remoteLiveness ?? (herdrLiveness?.state === 'live' ? herdrLiveness : els.liveness ?? herdrLiveness);
      const liveness = primaryLiveness?.state === 'unknown' && (legacyLiveness?.state === 'live' || legacyLiveness?.state === 'stale')
        ? legacyLiveness : primaryLiveness ?? legacyLiveness;
      const row = { msgAddress: to, replyBody: messageReplyBodyFor(to, shared), ...wake, ...delivery, ...(liveness ? {
        liveness: liveness.state,
        livenessAgeMs: 'ageMs' in liveness && Number.isFinite(liveness.ageMs) ? Math.round(liveness.ageMs) : undefined,
        ...('reason' in liveness ? { livenessReason: liveness.reason } : {}),
      } : {}) };
      emit(row, opts.json, () => out.log(`${to}\treplyBody=${row.replyBody ?? '모름'}\twake=${wake.wake}`
        + `${wake.host ? `\thost=${wake.host}` : ''}${wake.target ? `\ttarget=${wake.target}` : ''}${wake.optIn === undefined ? '' : `\toptIn=${wake.optIn ? 'yes' : 'no(주입 0)'}`}`
        + `${delivery.runtime ? `\truntime=${delivery.runtime}` : ''}${delivery.delivery ? `\tdelivery=${delivery.delivery}` : ''}${delivery.session ? `\tsession=${delivery.session}` : ''}`
        + `${liveness ? `\tliveness=${liveness.state}` : ''}`
        + `\t(${wake.source}${wake.reason ? `: ${wake.reason}` : ''})`));
    })());

  msg.command('address').description('Manage the central seat address registry')
    .command('register <seat>').description('Register a seat in the central seat address registry')
    .option('--herdr-pane <pane>', 'Herdr pane ID, for example wJ:p10')
    .option('--els-pane <pane>', 'ELS address els:workspace/tab/pane')
    .option('--tmux-session <session>', 'remote tmux session seat-<SEAT>')
    .requiredOption('--host <host>', 'local or remote SSH alias')
    .option('--wake', 'allow this registered seat to receive message wake prompts')
    .option('--replace', 'replace an existing pane address')
    .option('--runtime <body>', 'agent body in the pane: eln | claude-code | codex (eln ⊕ autowake = no typing, 60s fallback only)')
    .option('--json')
    .action((rawSeat: string, opts: { herdrPane?: string; elsPane?: string; tmuxSession?: string; host: string; wake?: boolean; replace?: boolean; runtime?: string; json?: boolean }) => run(() => {
      if ([opts.herdrPane, opts.elsPane, opts.tmuxSession].filter(Boolean).length !== 1) throw new Error('choose exactly one of --herdr-pane, --els-pane or --tmux-session');
      if (opts.runtime !== undefined && !SEAT_AGENT_RUNTIMES.includes(opts.runtime as SeatAgentRuntime)) throw new Error('--runtime must be eln, claude-code or codex');
      const result = registerSeatPaneAddress({
        address: canonicalSeatId(rawSeat), paneId: (opts.elsPane ?? opts.herdrPane ?? opts.tmuxSession)!, host: opts.host,
        ...(opts.elsPane ? { kind: 'els' as const } : opts.tmuxSession ? { kind: 'tmux' as const } : {}),
        ...(opts.wake ? { enableWake: true } : {}), ...(opts.replace ? { replace: true } : {}),
        ...(opts.runtime === undefined ? {} : { runtime: opts.runtime as SeatAgentRuntime }),
      }, deps.wakeDeps);
      emit(result, opts.json, () => out.log(`${result.address}\t${result.host}:${result.paneId}\t${result.changed ? 'registered' : 'unchanged'}\twake=${result.wakeEnabled ? 'on' : 'off'}`));
    })());

  msg.command('rla <command...>').description('Send an RLA question or release-loop command')
    .option('--from <seat>', 'operator address', 'OP').option('--json')
    .action((parts: string[], opts: CommonOptions & { from?: string }) => run(() => {
      const command = parts.join(' ');
      const isQuestion = parts[0] === 'ask';
      const body = isQuestion ? parts.slice(1).join(' ') : command;
      const posted = withStore(store => isQuestion
        ? postReleaseOpQuestion(store, seat(opts.from, '--from'), body)
        : postReleaseOpCommand(store, seat(opts.from, '--from'), command));
      emit({ address: 'RLA', ...(isQuestion ? { question: body } : { command }), messageId: posted.id, queued: true }, opts.json,
        () => out.log(`RLA ${isQuestion ? 'question' : 'command'} queued · #${posted.id} · ${body}`));
    })());

  const group = msg.command('group').description('Manage local message group subscriptions');
  group.command('create <name>').description('Create a group and subscribe its owner')
    .requiredOption('--from <seat>', 'seat creating and owning the group').option('--json')
    .action((name: string, opts: { from: string; json?: boolean }) => run(() => {
      const address = withStore(store => store.createGroup(name, opts.from));
      emit({ address, owner: canonicalSeatId(opts.from) }, opts.json, () => out.log(`${address} created; ${canonicalSeatId(opts.from)} subscribed`));
    })());
  group.command('join <name>').description('Subscribe a seat to a group')
    .requiredOption('--seat <seat>').option('--json')
    .action((name: string, opts: { seat: string; json?: boolean }) => run(() => {
      const joined = withStore(store => store.joinGroup(name, opts.seat));
      const row = { group: canonicalMessageAddress(name.startsWith('group:') ? name : `group:${name}`), seat: canonicalSeatId(opts.seat), joined };
      emit(row, opts.json, () => out.log(`${row.seat} ${row.joined ? 'joined' : 'already subscribed'} ${row.group}`));
    })());
  group.command('leave <name>').description('Unsubscribe a seat from a group')
    .requiredOption('--seat <seat>').option('--json')
    .action((name: string, opts: { seat: string; json?: boolean }) => run(() => {
      const left = withStore(store => store.leaveGroup(name, opts.seat));
      const row = { group: canonicalMessageAddress(name.startsWith('group:') ? name : `group:${name}`), seat: canonicalSeatId(opts.seat), left };
      emit(row, opts.json, () => out.log(`${row.seat} ${row.left ? 'left' : 'was not subscribed to'} ${row.group}`));
    })());
  group.command('list').description('List a seat’s active group subscriptions')
    .requiredOption('--seat <seat>').option('--json')
    .action((opts: { seat: string; json?: boolean }) => run(() => {
      const groups = withStore(store => store.listGroups(opts.seat));
      emit(groups, opts.json, () => { if (!groups.length) out.log('No groups.'); else for (const address of groups) out.log(address); });
    })());

  registerMsgListCommand(msg, { openStore: open, cacheReads: deps.openStore === undefined, out, setExitCode });
  // ELN-SELF-TIMER-WATCH(I3) — 원장 항목에 묶인 셀프 깨우개: wait-for · wait-tick · wait-list.
  registerMsgWaitForCommands(msg, { out, setExitCode });
  registerMsgRequirementCommands(msg, { out, setExitCode });
  // HAND-RAISE-LADDER — every ✋ ends in one outcome: hand <msgId> resolve|reject|escalate · sweep · board · list.
  registerMsgHandCommands(msg, { openStore: open, out, setExitCode, ...(deps.now === undefined ? {} : { now: deps.now }) });
  // MSG-CLEAR (CEO 11-25) — bulk-ack by filters (receipt · undo) ⊕ reset = delete by seat/space/federation (snapshot · restore).
  registerMsgClearCommand(msg, { openStore: open, out, setExitCode, ...(deps.now === undefined ? {} : { now: deps.now }) });
  registerMsgQuestionCommand(msg, { openStore: open, out, setExitCode });
  registerMsgResetCommand(msg, { openStore: open, out, setExitCode, ...(deps.now === undefined ? {} : { now: deps.now }) });
  // SEAT-INBOX B1-C — 영수증 읽기·구독(receipts --follow = 우체국 SSE) ⊕ 명시 영수증(receipt).
  registerMsgReceiptsCommands(msg, { openStore: open, out, setExitCode, ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal, handleSignals: false }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.authToken === undefined ? {} : { authToken: deps.authToken }),
    discoverUrl: () => discoverPostOfficeUrl(officeRoot()) });

  msg.command('hook').description('Emit turn-boundary inbox context for Claude or Codex hooks')
    .requiredOption('--event <event>')
    .requiredOption('--format <format>')
    .option('--seat <seat>', 'seat ID or auto:cwd', 'auto:cwd')
    .action((opts: { event: MsgHookEvent; format: MsgHookFormat; seat: string }) => run(async () => {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(stdinIsTty() ? '' : await readHookStdinWithLimit(readStdin, stdinReadLimitMs, () => cancelDefaultStdin?.())) as Record<string, unknown>; } catch { /* empty input falls back to process context (TTY 는 즉시, 닫히지 않는 파이프는 HOOK_STDIN_READ_LIMIT_MS 뒤 빈 입력 + fd0 반납) */ }
      const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : process.cwd();
      const seat = opts.seat === 'auto:cwd' ? seatFromCwd(cwd) : canonicalSeatId(opts.seat);
      if (!seat || seat === 'ALL') return;
      const sessionId = typeof input.session_id === 'string' && input.session_id.trim() ? input.session_id : typeof input.sessionId === 'string' && input.sessionId.trim() ? input.sessionId : undefined;
      const output = withStore(store => buildMsgHookOutput({
        event: opts.event,
        format: opts.format,
        cwd,
        sessionId,
        seat,
        messages: store.listByRecipient(seat, store.getCursor(seat)),
        stateDir: deps.hookStateDir ?? join(dirname(defaultMsgStorePath()), 'hook-state'),
      }));
      if (output !== null) out.log(output);
    })());

  msg.command('ack [id]').description('Acknowledge selected messages; --through acknowledges every message up to and including that ID')
    .option('--to <seat>').option('--id <id>', 'acknowledge exactly one message').option('--ids <ids>', 'acknowledge selected comma-separated IDs').option('--through <id>', 'WARNING: acknowledge ALL messages through this ID, including earlier unread messages')
    .option('--receipted', 'acknowledge every message that already has an accepted, rejected, done or expired receipt (idempotent)')
    .option('--apply <line>', 'with a positional ID / --id / --ids naming an announce: the «적용:» line — what this seat will do differently')
    .option('--json')
    .action((positional: string | undefined, opts: CommonOptions & { to?: string; id?: string; ids?: string; through?: string; receipted?: boolean; apply?: string }) => run(async () => {
      const to = messageRecipient(opts.to, '--to');
      const apply = parseApplyField(opts.apply);
      if (apply !== null && opts.id === undefined && opts.ids === undefined && positional === undefined)
        throw new Error('--apply needs the announce message ID (positional, --id or --ids)');
      // MSG-FILTERS-RELAX: a bulk ack (2+ mails) leaves a compact digest — printed and saved as one seat memory entry.
      const digestOf = async (inputs: AckDigestInput[]) => recordAckDigest(to, inputs, {
        ...(deps.saveAckDigest ? { save: deps.saveAckDigest } : {}), ...(deps.now ? { now: deps.now } : {}), warn: line => out.error(line) });
      const printDigest = (recorded: Awaited<ReturnType<typeof digestOf>>) => {
        if (recorded === null || opts.json) return;
        out.log(`digest${recorded.saved ? ` (memory ${recorded.memory.name})` : ''}: ${recorded.digest.summary}`);
        for (const line of recorded.digest.lines) out.log(line);
      };
      const digestJson = (recorded: Awaited<ReturnType<typeof digestOf>>) => recorded === null ? {}
        : { digest: { ...(recorded.saved ? { memory: recorded.memory.name } : {}), summary: recorded.digest.summary, lines: recorded.digest.lines } };
      if (Number(opts.id !== undefined) + Number(opts.ids !== undefined) + Number(opts.through !== undefined) + Number(positional !== undefined) + Number(Boolean(opts.receipted)) !== 1) throw new Error('choose exactly one of positional ID, --id, --ids, --through, or --receipted');
      if (opts.receipted) {
        // MSG-RECEIPT-IMPLIES-ACK ③ — backfill for mail decided before a terminal receipt implied the ack.
        const { ids, inputs } = withStore(store => { const acked = store.ackReceipted(to); return { ids: acked, inputs: ackDigestInputs(store, to, acked) }; });
        const recorded = await digestOf(inputs);
        emit({ recipient: to, receipted: ids.length, ids, ...digestJson(recorded) }, opts.json, () => out.log(`${to} acknowledged ${ids.length} receipted message${ids.length === 1 ? '' : 's'}${ids.length === 0 ? '' : `: #${ids.join(' #')}`}`));
        printDigest(recorded);
        return;
      }
      if (opts.id !== undefined || positional !== undefined || opts.ids !== undefined) {
        const ids = [...new Set((opts.ids !== undefined ? opts.ids.split(',') : [opts.id ?? positional!]).map(raw => integer(raw.trim(), 'message ID', 1, 1, Number.MAX_SAFE_INTEGER)))];
        if (opts.ids !== undefined && (!opts.ids.trim() || opts.ids.split(',').some(raw => !raw.trim()))) throw new Error('--ids requires comma-separated positive message IDs');
        let inputs: AckDigestInput[] = [];
        withStore(store => {
          store.ackMessages(to, ids);
          // §8 — 손 ack 는 영수증 seen 으로 남는다(accepted 이상은 만들지 않는다). 영수증 실패는 ack 를 바꾸지 않는다.
          for (const id of ids) recordHandSeen(store, to, id);
          inputs = ackDigestInputs(store, to, ids);
          // ANNOUNCE-UPTAKE — the ack's apply field: the «applied» event for each acked announce (others are reported).
          if (apply !== null) {
            const notAnnounce = ids.filter(id => recordAnnounceApply(store.db, { seat: to, messageId: id, line: apply }) === null);
            if (notAnnounce.length > 0) out.error(`msg ack: --apply ignored for #${notAnnounce.join(' #')} (not an announce)`);
          }
        });
        const recorded = await digestOf(inputs);
        emit(ids.length === 1 ? { recipient: to, id: ids[0], status: 'acked' } : { recipient: to, ids, status: 'acked', ...digestJson(recorded) }, opts.json, () => out.log(`${to} acknowledged #${ids.join(' #')}`));
        printDigest(recorded);
        return;
      }
      const through = integer(opts.through, '--through', 0, 0, Number.MAX_SAFE_INTEGER);
      // MSG-RECEIPTS-FOLLOWUP ① (#84659 A①): positional and --through leave «seen» like --id — same store path as the MsgAck tool.
      const { acknowledged, inputs } = withStore(store => {
        // The unread set this ack moves past, read before the cursor moves (the digest's input).
        const passing = (() => { try { return store.list(to, store.getCursor(to), 1000).filter(message => message.id <= through).map(message => message.id); } catch { return []; } })();
        const moved = store.ackThroughSeen(to, through, 'cli-ack');
        return { acknowledged: moved, inputs: ackDigestInputs(store, to, passing) };
      });
      const recorded = await digestOf(inputs);
      emit({ recipient: to, through: acknowledged, ...digestJson(recorded) }, opts.json, () => out.log(`${to} acknowledged through #${acknowledged}`));
      printDigest(recorded);
    })());

  msg.command('count').description('Read one recipient’s unread count as JSON without reading message bodies')
    .option('--to <seat>').option('--json')
    .action((opts: { to?: string }) => run(() => {
      const to = messageRecipient(opts.to, '--to');
      let count: number | null = null;
      try {
        // A readable ledger alone does not establish that an inbox was declared.
        const registry = registrySnapshot(deps.wakeDeps ?? {}).routed;
        if (registry.status === 'ready' && registry.registry.seats.some(entry => entry.address === to)) count = readUnreadCount(to);
      } catch { /* An unavailable declaration or ledger is unknown, not zero. */ }
      out.log(JSON.stringify({ status: count === null ? 'unknown' : 'ok', count }));
    })());

  // MSG-NOISE (Q9 · EEMUA 191 daily bad-actor review) — the top sender × kind pairs by volume for the daily rationalisation.
  msg.command('noise').description('Top 5 sender × kind by message count in a window (daily noise review)')
    .option('--since <dur>', 'window: 30m · 6h · 24h · 7d (default 24h)', '24h').option('--top <n>', 'rows (default 5)', '5').option('--json')
    .action((opts: CommonOptions & { since: string; top: string }) => run(() => {
      const ms = parseExpiresDuration(opts.since);
      const since = new Date((deps.now ?? (() => new Date()))().getTime() - ms);
      const top = integer(opts.top, '--top', 5, 1, 100);
      const rows = withStore(store => store.noiseTop(since, top));
      emit({ since: since.toISOString(), rows }, opts.json, () => {
        out.log(`msg noise since ${since.toISOString()} (${opts.since}) — top ${top} sender × kind`);
        if (rows.length === 0) out.log('  (no messages)');
        for (const r of rows) out.log(`  ${String(r.count).padStart(5)}  ${r.sender} · ${r.kind}`);
      });
    })());

  msg.command('unread').description('Show recipients with unacknowledged messages')
    .option('--to <seat>').option('--json')
    .action((opts: CommonOptions & { to?: string }) => run(() => {
      const to = opts.to === undefined ? undefined : messageRecipient(opts.to, '--to');
      const rows = withStore(store => {
        const unreadAddressVisible = (address: string) => {
          const route = resolveWake(address, deps.wakeDeps);
          if (route.wake !== 'none') return true;
          if (route.source === 'loop-table' || route.reason === 'topic') return false;
          return !route.reason?.startsWith('dead-') && !route.reason?.startsWith('undeclared-address');
        };
        const liveRows = (items: ReturnType<typeof store.unread>) => items.filter(row => {
          return unreadAddressVisible(row.recipient);
        });
        if (to === undefined) return liveRows(store.unread());
        const count = store.unreadCount(to);
        return count && unreadAddressVisible(to) ? [{ recipient: to, count }] : [];
      });
      emit(rows, opts.json, () => {
        if (!rows.length) out.log('No unread messages.');
        for (const row of rows) out.log(`${row.recipient}: ${row.count} unread`);
      });
    })());

  // MSG-LEDGER-RETENTION-INDEX ①③ — 7일 지난 배달·ack 끝난 직통 행을 보관 원장으로(원장 보존·커서 정리).
  msg.command('archive').description('Move delivered-and-acked direct rows older than --days into the archive ledger')
    .option('--archive <path>', 'archive ledger path (default: messages-archive.db beside the ledger)')
    .option('--days <n>', 'retention window in days', String(MSG_ARCHIVE_DEFAULT_DAYS))
    .option('--json')
    .action((opts: CommonOptions & { archive?: string; days?: string }) => run(() => {
      const days = integer(opts.days, '--days', MSG_ARCHIVE_DEFAULT_DAYS, 1, 3650);
      const archive = opts.archive ?? defaultArchivePath();
      const outcome = withStore(store => archiveDeliveredRows(store, archive, { days }));
      emit({ ...outcome, archive, days }, opts.json,
        () => out.log(`archived ${outcome.archived} row(s) to ${archive} (cutoff ${outcome.cutoffIso}; cursors ${JSON.stringify(outcome.cursors)})`));
    })());

  // MAILBOX-HYGIENE-AUTO — 미읽음 우편함 분류(고아·대체·만료·비지도·종류별).
  msg.command('triage').description('Classify unread mailboxes: orphan mailboxes, superseded, expired, unsupervised')
    .option('--to <seat>').option('--json')
    .action((opts: CommonOptions & { to?: string }) => run(() => {
      const rows = withStore(store => triageMailbox(store, { now: new Date(), withTotals: true }) as { rows: TriageRow[]; totals: { recipients: number; unread: number } });
      const filtered = opts.to ? rows.rows.filter(r => r.recipient === seat(opts.to, '--to')) : rows.rows;
      emit(filtered, opts.json, () => {
        if (!filtered.length) { out.log('No unread mailboxes.'); return; }
        out.log(`recipients: ${rows.totals.recipients} unread: ${rows.totals.unread}`);
        for (const row of filtered) {
          out.log(`${row.recipient}: unread=${row.unread}${row.orphan ? ' [orphan]' : ''} unsupervised=${row.counts.unsupervised} superseded=${row.counts.superseded} expired=${row.counts.expired} request=${row.counts.request} decision=${row.counts.decision} alert=${row.counts.alert} report=${row.counts.report} digest=${row.counts.digest}`);
        }
      });
    })());

  msg.command('watch').description('Watch durable messages; SSE accelerates delivery and polling covers outages')
    .option('--to <seat>').option('--after <id>', 'exclusive message ID (default: acknowledged cursor)')
    .option('--since-ack', 'start from the recipient seat’s acknowledged cursor')
    .option('--interval <ms>', 'poll interval in milliseconds', '1000')
    .option('--sse <url>', 'post office base URL (fall back to ledger polling on disconnect)')
    .option('--once', 'poll once and exit').option('--json')
    .action((opts: RecipientOptions & { interval?: string; once?: boolean; sinceAck?: boolean; sse?: string }) => run(async () => {
      if (opts.sinceAck && opts.after !== undefined) throw new Error('--since-ack cannot be used with --after');
      const to = messageRecipient(opts.to, '--to');
      const interval = integer(opts.interval, '--interval', 1000, 1, 60000);
      const after = opts.after === undefined ? undefined : integer(opts.after, '--after', 0, 0, Number.MAX_SAFE_INTEGER);
      const store = open();
      try {
        let cursor = after ?? store.getCursor(to);
        const poll = () => {
          let messages: Message[];
          do {
            messages = store.list(to, cursor, 1000);
            for (const message of messages) {
              emit(message, opts.json, () => out.log(formatMessage(message)));
              cursor = message.id;
            }
          } while (messages.length === 1000 && !deps.signal?.aborted);
        };
        if (!opts.sse || opts.once) {
          do {
            poll();
            if (opts.once || deps.signal?.aborted) break;
            await sleep(interval);
          } while (!deps.signal?.aborted);
        } else {
          const url = new URL('/stream', opts.sse);
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--sse requires an HTTP URL');
          if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
            throw new Error('--sse requires HTTPS outside localhost');
          url.searchParams.set('to', to);
          const token = (deps.authToken ?? (() => ensureAuthToken().token))();
          let outage = false;
          while (!deps.signal?.aborted) {
            poll();
            url.searchParams.set('since', String(cursor));
            const controller = new AbortController();
            const onAbort = () => controller.abort();
            deps.signal?.addEventListener('abort', onAbort, { once: true });
            try {
              let connectTimer: ReturnType<typeof setTimeout> | undefined;
              const response = await Promise.race([
                (deps.fetch ?? fetch)(url, { headers: {
                  Authorization: `Bearer ${token}`, 'Last-Event-ID': String(cursor),
                }, signal: controller.signal }),
                new Promise<never>((_, reject) => { connectTimer = setTimeout(() => {
                  controller.abort();
                  reject(new Error('SSE connect timeout'));
                }, Math.max(1000, Math.min(5000, interval * 2))); }),
              ]).finally(() => clearTimeout(connectTimer));
              if (response.status === 401) throw new Error('SSE unauthorized (401)');
              if (!response.ok || !response.body) throw new Error(`SSE unavailable (${response.status})`);
              outage = false;
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              let pending = '';
              while (!deps.signal?.aborted) {
                let idleTimer: ReturnType<typeof setTimeout> | undefined;
                const chunk = await Promise.race([
                  reader.read(),
                  new Promise<never>((_, reject) => { idleTimer = setTimeout(() => {
                    controller.abort();
                    reject(new Error('SSE idle timeout'));
                  }, Math.max(1000, Math.min(5000, interval * 2))); }),
                ]).finally(() => clearTimeout(idleTimer));
                if (chunk.done) break;
                pending += decoder.decode(chunk.value, { stream: true });
                pending = pending.replace(/\r\n/g, '\n');
                if (pending.length > 1_000_000) throw new Error('SSE event exceeds limit');
                let boundary: number;
                while ((boundary = pending.indexOf('\n\n')) >= 0) {
                  const event = pending.slice(0, boundary);
                  pending = pending.slice(boundary + 2);
                  if (event.split('\n').some((line) => line.startsWith('id: '))) poll();
                }
              }
            } catch (error) {
              if (error instanceof Error && error.message === 'SSE unauthorized (401)') throw error;
              if (!outage && !deps.signal?.aborted) out.error(`msg: SSE disconnected; polling ledger (${error instanceof Error ? error.message : String(error)})`);
              outage = true;
            } finally { deps.signal?.removeEventListener('abort', onAbort); controller.abort(); }
            if (deps.signal?.aborted) break;
            poll();
            await sleep(interval);
          }
        }
      } finally { store.close(); }
    })());

  msg.command('ask <recipient> <question>').description('Post a question and wait for its first reply (any later mail from the recipient counts)')
    .option('--from <seat>', 'asking seat (required)')
    .option('--within <dur>', 'reply horizon (default 10m): then one reminder to the recipient, 5 more min, then the wait is cancelled with a result')
    .option('--wait <seconds>', 'short probe wait in seconds (no reminder · no cancel ladder below 10m); overrides --within')
    .option('--agent-reply <address>', 'let this address\'s agent body (COORDINATOR · GUARDIAN) answer before waiting')
    .option('--json')
    .action((recipient: string, question: string, opts: CommonOptions & { from?: string; wait?: string; within?: string; agentReply?: string }) => run(async () => {
      const from = seat(opts.from, '--from');
      const to = canonicalSeatId(recipient);
      const contract = await import('../msg/msg-wait-contract.js');
      // MSG-WAIT-CONTRACT ② — default horizon 10m (ceiling stays 86400s). A wait of 10m or more runs the ladder.
      const windowMs = opts.wait !== undefined ? integer(opts.wait, '--wait', 60, 0, 86400) * 1000
        : opts.within !== undefined ? (await import('../msg/self-timer-watch.js')).parseDuration(opts.within) : contract.MSG_WAIT_DEFAULT_WITHIN_MS;
      if (!(windowMs >= 0) || windowMs > 86400_000) throw new Error('--within must be between 0 and 24h');
      const waitSeconds = Math.round(windowMs / 1000);
      const ladderOn = windowMs >= contract.MSG_WAIT_DEFAULT_WITHIN_MS;
      const nowMs = () => (deps.now ?? (() => new Date()))().getTime();
      const agentAddress = agentReplyAddress(opts.agentReply);
      if (agentAddress !== null) requireAgentTarget(agentAddress, to);
      const interrupt = deps.signal === undefined ? new AbortController() : undefined;
      const signal = deps.signal ?? interrupt!.signal;
      const onInterrupt = () => interrupt?.abort();
      if (interrupt) {
        process.once('SIGINT', onInterrupt);
        process.once('SIGTERM', onInterrupt);
      }
      let store: MsgStore | undefined;
      try {
        const askedAt = nowMs();
        const asked = withStore(ledger => ledger.post({ from, to, body: question, kind: 'question',
          ...(ladderOn ? { refs: [contract.waitUntilRef(askedAt + windowMs)] } : {}) }));
        emit(asked, opts.json, () => out.log(`#${asked.id}`));
        // msg ask uses the same saved-message handler before waiting for its linked reply.
        await handleTaMessage(asked);
        // 사람 없는 live 대화: 답할 몸이 있으면 «기다리기 전»에 답을 원장에 남긴다 — 같은 대기 루프가 그 답을 집는다.
        if (agentAddress !== null) await autoReply(agentAddress, asked, opts.json);
        let reply: Message | undefined;
        store = open();
        // HAND-RAISE-LADDER — a ✋ to the asking seat ends the wait early: a coordinator is never deaf while it waits.
        const { handArrivedAfter, handPreemptLine, loadFederationLadder } = await import('../msg/hand-raise-ladder.js');
        const parentOf = ladderOn ? (() => { try { return loadFederationLadder().parentOf; } catch { return undefined; } })() : undefined;
        const hardStop = askedAt + windowMs + (ladderOn ? contract.MSG_WAIT_RETRY_GRACE_MS : 0);
        do {
          // MSG-WAIT-CONTRACT — a linked reply, or ANY later mail from the recipient (sender match, logged).
          // Any linked reply first (the agent-reply body answers under its own address), as before.
          reply = store.listReplies(asked.id, 1)[0];
          if (reply === undefined && ladderOn) {
            const step = contract.advanceWait(store, { messageId: asked.id, asker: from, counterpart: to, startedAtMs: askedAt, withinMs: windowMs, now: nowMs(), logMatch: true, ...(parentOf ? { parentOf } : {}) });
            if (step.state === 'answered') reply = step.match.reply;
            else if (step.state === 'retried') out.error(`msg ask: no reply to #${asked.id} in ${Math.round(windowMs / 60_000)}m — reminder #${step.mailId} sent to ${to}; waiting ${contract.MSG_WAIT_RETRY_GRACE_MS / 60_000} more min`);
            else if (step.state === 'cancelled') {
              emit({ cancelled: true, question: asked.id, result: step.cancel.result, notice: step.cancel.noticeId, coordinator: step.cancel.coordinator }, opts.json,
                () => out.log(`#${asked.id} wait cancelled: ${step.cancel.result}`));
              return;
            }
          } else if (reply === undefined) reply = contract.replyMatchLogged(store, { id: asked.id, from, to })?.reply;
          if (reply === undefined) {
            const hand = handArrivedAfter(store, from, asked.id);
            if (hand) { emit({ preempted: true, question: asked.id, hand: hand.id, line: handPreemptLine(hand) }, opts.json, () => out.log(handPreemptLine(hand))); return; }
          }
          if (reply !== undefined || signal.aborted || nowMs() >= hardStop) break;
          await sleep(1000);
        } while (true);
        if (reply === undefined && signal.aborted) throw new Error(`ask interrupted after posting #${asked.id}`);
        if (reply === undefined) throw new Error(`no reply to #${asked.id} within ${waitSeconds}s`);
        emit(reply, opts.json, () => out.log(formatMessage(reply)));
      } finally {
        store?.close();
        if (interrupt) {
          process.removeListener('SIGINT', onInterrupt);
          process.removeListener('SIGTERM', onInterrupt);
        }
      }
    })());

  msg.command('thread <id>').description('Show one question and its replies in time order')
    .option('--json')
    .action((id: string, opts: CommonOptions) => run(() => {
      const target = integer(id, 'message ID', 0, 1, Number.MAX_SAFE_INTEGER);
      const thread = withStore(store => {
        // Keep paging until a short page so a thread longer than one store page is never truncated.
        const messages: Message[] = [];
        let after = 0;
        let page: Message[];
        do {
          page = store.listThread(target, after, 100);
          messages.push(...page);
          after = page.at(-1)?.id ?? after;
        } while (page.length === 100);
        const [question, ...replies] = messages;
        return { question: question!, replies };
      });
      emit(thread, opts.json, () => {
        out.log(formatMessage(thread.question));
        for (const reply of thread.replies) out.log(formatMessage(reply));
      });
    })());

  msg.command('serve').description('Run the independent, read-only post office SSE service')
    .option('--sse', 'serve GET /stream')
    .option('--port <port>', 'port (or ELANOUS_MSG_SSE_PORT)')
    .option('--host <host>', 'bind address', '127.0.0.1')
    .action((opts: { sse?: boolean; port?: string; host?: string }) => run(() => {
      if (!opts.sse) throw new Error('serve requires --sse');
      const rawPort = opts.port ?? process.env.ELANOUS_MSG_SSE_PORT;
      if (rawPort === undefined) throw new Error('--port or ELANOUS_MSG_SSE_PORT is required');
      const port = integer(rawPort, '--port', 0, 0, 65535);
      const store = openRead();
      try {
        const service = startMsgSseServer({ store, token: (deps.authToken ?? (() => ensureAuthToken().token))(),
          port, hostname: opts.host });
        // 발견 줄 — 설치본을 갈아 끼운 뒤 `msg post` 가 이 줄을 읽어 죽은 서비스를 같은 포트로 다시 띄운다.
        writePostOffice(officeRoot(), { port: service.port });
        out.log(`msg SSE listening on ${opts.host}:${service.port}`);
        const stop = () => { service.stop(); store.close(); clearPostOffice(officeRoot()); };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      } catch (error) { store.close(); throw error; }
    })());

  // Commander reports option/argument errors before action handlers run. Scope their exit code
  // to msg so unrelated commands keep their own error and help behavior.
  for (const command of [msg, ...msg.commands]) {
    const reportError = command.error.bind(command);
    command.error = (message, options) => reportError(message, { ...options, exitCode: 2 });
  }
}

// Preserve the historical formatter export after moving list-only registration.
export { formatMessage } from './msg-list-cli.js';

/** A known recipient that `to` most likely meant: same dash-separated tokens in another order, or edit distance ≤ 2. */
export function didYouMeanAddress(to: string, known: readonly string[]): string | null {
  const t = to.toUpperCase();
  if (known.some(k => k.toUpperCase() === t)) return null;
  const tokens = (v: string) => v.toUpperCase().split(/[-_]/).filter(Boolean).sort().join('|');
  const reordered = known.find(k => tokens(k) === tokens(t));
  if (reordered) return reordered;
  if (t.length < 4) return null;
  let best: { k: string; d: number } | null = null;
  for (const k of known) {
    const d = editDistance(t, k.toUpperCase());
    if (d <= 2 && (!best || d < best.d)) best = { k, d };
  }
  return best?.k ?? null;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}
