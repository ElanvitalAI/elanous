import type { Message } from './msg-store.js';
import { buildMirrorSummary, isMirrorEvent, MIRROR_SUMMARY_INTERVAL_MS, selectMirrorEvents, shouldRotateMirrorChannel } from './msg-mirror-policy.js';

export interface MirrorTarget {
  repo: string;
  issueNumber: number;
}

export interface MsgMirrorState {
  version: 1;
  target: MirrorTarget;
  messageCursor: number;
  summaryWindowEnd: string;
  rotationPending?: { from: MirrorTarget; to: MirrorTarget };
}

export interface MsgMirrorSource {
  listAfter(afterId: number, limit: number): Message[];
  listWindow(start: string, end: string): Message[];
  latestId(): number;
}

export interface MsgMirrorStateStore {
  read(): MsgMirrorState | null;
  write(state: MsgMirrorState): void;
}

export interface MsgMirrorTransport {
  beginTick?(): Promise<void> | void;
  countComments(target: MirrorTarget): Promise<number> | number;
  hasMarker(target: MirrorTarget, marker: string): Promise<boolean> | boolean;
  postComment(target: MirrorTarget, body: string): Promise<void> | void;
  createNextChannel(target: MirrorTarget, idempotencyKey: string): Promise<MirrorTarget> | MirrorTarget;
  linkAndCloseChannel(from: MirrorTarget, to: MirrorTarget): Promise<void> | void;
}

export interface MsgMirrorTickOptions {
  configuredTarget?: MirrorTarget;
  nowMs?: number;
  dryRun?: boolean;
  source: MsgMirrorSource;
  state: MsgMirrorStateStore;
  transport: MsgMirrorTransport;
}

export interface MsgMirrorTickResult {
  status: 'disabled' | 'dry-run' | 'synced';
  target: MirrorTarget | null;
  scanned: number;
  posted: number;
  rotated: number;
  summaries: number;
  sourceCursor: number;
}

const VALID_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validateMirrorTarget(value: unknown): MirrorTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('mirror target must be an object');
  const target = value as Record<string, unknown>;
  if (typeof target.repo !== 'string' || !VALID_REPO.test(target.repo)
    || typeof target.issueNumber !== 'number' || !Number.isSafeInteger(target.issueNumber) || target.issueNumber < 1) {
    throw new Error('mirror target requires repo=owner/name and a positive issueNumber');
  }
  return { repo: target.repo, issueNumber: target.issueNumber as number };
}

/** Sparse settings are disabled by default; malformed nonempty settings are rejected. */
export function configuredMirrorTarget(raw: unknown): MirrorTarget | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('msgMirror config must be an object');
  const target = (raw as Record<string, unknown>).target;
  return target === undefined ? undefined : validateMirrorTarget(target);
}

export function validateMsgMirrorState(value: unknown): MsgMirrorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid message mirror state');
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || typeof state.messageCursor !== 'number' || !Number.isSafeInteger(state.messageCursor) || state.messageCursor < 0
    || typeof state.summaryWindowEnd !== 'string' || !Number.isFinite(Date.parse(state.summaryWindowEnd))) throw new Error('invalid message mirror state');
  const target = validateMirrorTarget(state.target);
  const pending = state.rotationPending;
  const rotationPending = pending && typeof pending === 'object' && !Array.isArray(pending)
    ? { from: validateMirrorTarget((pending as Record<string, unknown>).from), to: validateMirrorTarget((pending as Record<string, unknown>).to) }
    : undefined;
  if (pending !== undefined && !rotationPending) throw new Error('invalid pending mirror rotation');
  return { version: 1, target, messageCursor: state.messageCursor as number, summaryWindowEnd: new Date(state.summaryWindowEnd as string).toISOString(),
    ...(rotationPending ? { rotationPending } : {}) };
}

function initialState(target: MirrorTarget, nowMs: number, latestMessageId: number): MsgMirrorState {
  if (!Number.isSafeInteger(latestMessageId) || latestMessageId < 0) throw new Error('source latest message ID is invalid');
  const end = Math.floor(nowMs / MIRROR_SUMMARY_INTERVAL_MS) * MIRROR_SUMMARY_INTERVAL_MS;
  return { version: 1, target, messageCursor: latestMessageId, summaryWindowEnd: new Date(end).toISOString() };
}

function eventMarker(id: number): string { return `<!-- elanous-msg-mirror:event:${id} -->`; }
function summaryMarker(start: string): string { return `<!-- elanous-msg-mirror:summary:${start} -->`; }

function renderEvent(message: Message): string {
  return `## ${message.kind} · #${message.id}\n\n**${message.from} → ${message.to}** · ${message.createdAt}\n\n${message.body.trim()}`;
}

async function prepareTarget(state: MsgMirrorState, transport: MsgMirrorTransport, dryRun: boolean): Promise<{
  state: MsgMirrorState; rotated: number;
}> {
  let current = state;
  let rotated = 0;
  if (current.rotationPending) {
    if (dryRun) return { state: current, rotated };
    await transport.linkAndCloseChannel(current.rotationPending.from, current.rotationPending.to);
    current = { ...current, rotationPending: undefined };
  }
  const count = await transport.countComments(current.target);
  if (!shouldRotateMirrorChannel(count)) return { state: current, rotated };
  if (dryRun) return { state: current, rotated };
  const oldTarget = current.target;
  const nextTarget = validateMirrorTarget(await transport.createNextChannel(oldTarget,
    `msg-mirror-rotate:${oldTarget.repo}#${oldTarget.issueNumber}`));
  current = { ...current, target: nextTarget, rotationPending: { from: oldTarget, to: nextTarget } };
  // Persist the pointer before closing the old issue. On restart the pending link/close is retried.
  // If this write fails, the adapter's idempotency key prevents creating another channel.
  return { state: current, rotated: 1 };
}

/** One idempotent mirror pass. All GitHub effects are behind the injected transport. */
export async function runMsgMirrorTick(options: MsgMirrorTickOptions): Promise<MsgMirrorTickResult> {
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error('nowMs must be finite');
  const stored = options.state.read();
  const configured = options.configuredTarget ? validateMirrorTarget(options.configuredTarget) : undefined;
  if (!stored && !configured) return { status: 'disabled', target: null, scanned: 0, posted: 0, rotated: 0, summaries: 0, sourceCursor: 0 };
  await options.transport.beginTick?.();
  let state = stored ? validateMsgMirrorState(stored) : initialState(configured!, nowMs, options.source.latestId());
  let scanned = 0, posted = 0, rotated = 0, summaries = 0;
  if (!options.dryRun) options.state.write(state);

  const startTarget = state.target;
  const prepared = await prepareTarget(state, options.transport, options.dryRun === true);
  state = prepared.state;
  rotated += prepared.rotated;
  if (!options.dryRun && state !== stored) options.state.write(state);

  // A rotation is recorded before side effects that close the previous issue.
  if (state.rotationPending && !options.dryRun) {
    await options.transport.linkAndCloseChannel(state.rotationPending.from, state.rotationPending.to);
    state = { ...state, rotationPending: undefined };
    options.state.write(state);
  }

  let page = options.source.listAfter(state.messageCursor, 1000);
  while (page.length > 0) {
    const eligible = new Map(selectMirrorEvents(page, state.messageCursor).map(message => [message.id, message]));
    for (const message of page) {
      scanned++;
      const event = eligible.get(message.id);
      if (event) {
        const preparedNext = await prepareTarget(state, options.transport, options.dryRun === true);
        if (preparedNext.rotated) {
          state = preparedNext.state;
          rotated += preparedNext.rotated;
          if (!options.dryRun) {
            options.state.write(state);
            if (state.rotationPending) {
              await options.transport.linkAndCloseChannel(state.rotationPending.from, state.rotationPending.to);
              state = { ...state, rotationPending: undefined };
              options.state.write(state);
            }
          }
        }
        const marker = eventMarker(event.id);
        if (!options.dryRun && !(await options.transport.hasMarker(state.target, marker))) {
          await options.transport.postComment(state.target, `${marker}\n${renderEvent(event)}`);
          posted++;
        }
      }
      state = { ...state, messageCursor: message.id };
      if (!options.dryRun) options.state.write(state);
    }
    if (page.length < 1000) break;
    page = options.source.listAfter(state.messageCursor, 1000);
  }

  let windowStart = Date.parse(state.summaryWindowEnd);
  const nowWindowEnd = Math.floor(nowMs / MIRROR_SUMMARY_INTERVAL_MS) * MIRROR_SUMMARY_INTERVAL_MS;
  while (windowStart + MIRROR_SUMMARY_INTERVAL_MS <= nowWindowEnd) {
    const windowEnd = windowStart + MIRROR_SUMMARY_INTERVAL_MS;
    const from = new Date(windowStart).toISOString();
    const to = new Date(windowEnd).toISOString();
    const summary = buildMirrorSummary(options.source.listWindow(from, to), from, to);
    if (summary) {
      const preparedNext = await prepareTarget(state, options.transport, options.dryRun === true);
      if (preparedNext.rotated) {
        state = preparedNext.state;
        rotated += preparedNext.rotated;
        if (!options.dryRun) {
          options.state.write(state);
          if (state.rotationPending) {
            await options.transport.linkAndCloseChannel(state.rotationPending.from, state.rotationPending.to);
            state = { ...state, rotationPending: undefined };
            options.state.write(state);
          }
        }
      }
      const marker = summaryMarker(from);
      if (!options.dryRun && !(await options.transport.hasMarker(state.target, marker))) {
        await options.transport.postComment(state.target, `${marker}\n${summary}`);
        posted++;
      }
      summaries++;
    }
    state = { ...state, summaryWindowEnd: to };
    if (!options.dryRun) options.state.write(state);
    windowStart = windowEnd;
  }

  return { status: options.dryRun ? 'dry-run' : 'synced', target: options.dryRun ? startTarget : state.target,
    scanned, posted, rotated, summaries, sourceCursor: state.messageCursor };
}
