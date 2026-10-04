import { isImageAttachment } from './attachment-content';
import type { AttachmentMeta } from './upload-attachment';
import type { DaemonClient } from './daemon-client';

type CardFollowupStatus = {
  status: 'judging' | 'running' | 'done' | 'not-card' | 'failed';
  replies?: [string, string, string];
  error?: string;
};

type CardClient = Pick<DaemonClient, 'fetchResponse'>;

export const CARD_FOLLOWUP_STORAGE_KEY = 'elanous.pwa.pendingCardFollowups';
export const CARD_FOLLOWUP_MAX_AGE_MS = 15 * 60 * 1000;
export type PendingCardFollowup = { sessionId: string; id: string; startedAt: number };
type CardStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function pendingCards(storage: CardStorage, now: number): PendingCardFollowup[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CARD_FOLLOWUP_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PendingCardFollowup => {
      if (!entry || typeof entry !== 'object') return false;
      const card = entry as Record<string, unknown>;
      return typeof card.sessionId === 'string' && card.sessionId.length > 0
        && typeof card.id === 'string' && card.id.length > 0
        && typeof card.startedAt === 'number' && Number.isFinite(card.startedAt)
        && card.startedAt <= now && now - card.startedAt < CARD_FOLLOWUP_MAX_AGE_MS;
    });
  } catch { return []; }
}

function writePendingCards(storage: CardStorage, cards: PendingCardFollowup[]): void {
  try {
    if (cards.length) storage.setItem(CARD_FOLLOWUP_STORAGE_KEY, JSON.stringify(cards));
    else storage.removeItem(CARD_FOLLOWUP_STORAGE_KEY);
  } catch { /* storage can be unavailable or full */ }
}

export function readPendingCardFollowups(storage: CardStorage, sessionId: string, now = Date.now()): PendingCardFollowup[] {
  const cards = pendingCards(storage, now);
  writePendingCards(storage, cards);
  return cards.filter((card) => card.sessionId === sessionId);
}

export function rememberCardFollowup(storage: CardStorage, entry: PendingCardFollowup, now = Date.now()): void {
  const cards = pendingCards(storage, now).filter((card) => card.sessionId !== entry.sessionId || card.id !== entry.id);
  if (!entry.sessionId || !entry.id || !Number.isFinite(entry.startedAt)
    || entry.startedAt > now || now - entry.startedAt >= CARD_FOLLOWUP_MAX_AGE_MS) {
    writePendingCards(storage, cards);
    return;
  }
  writePendingCards(storage, [...cards, entry]);
}

export function forgetCardFollowup(storage: CardStorage, sessionId: string, id: string, now = Date.now()): void {
  writePendingCards(storage, pendingCards(storage, now).filter((card) => card.sessionId !== sessionId || card.id !== id));
}

export function cardFollowupStorage(): CardStorage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

export function isCardRequest(text: string, attachments: readonly AttachmentMeta[]):
  { ok: true; attachmentId: string; context?: string } | { ok: false } {
  if (attachments.length !== 1 || !attachments[0] || !isImageAttachment(attachments[0]) || !attachments[0].id) {
    return { ok: false };
  }
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, attachmentId: attachments[0].id };
  const words = trimmed.replace(/메일\s*초안/g, '메일초안').split(/[\s,]+/).filter(Boolean);
  if (!words.length || words.some((word) => !/^(?:명함|전략|메일초안|crm)$/i.test(word))) return { ok: false };
  return { ok: true, attachmentId: attachments[0].id, context: trimmed };
}

export async function startCardFollowup(client: CardClient, attachmentId: string, context?: string, signal?: AbortSignal): Promise<string> {
  const response = await client.fetchResponse('/v1/card-followup', {
    ...(signal ? { signal } : {}),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ attachmentId, ...(context === undefined ? {} : { context }) }),
  });
  if (!response.ok) throw new Error(`card followup start failed: ${response.status}`);
  const body = await response.json() as { id: string };
  if (typeof body.id !== 'string' || !body.id) throw new Error('card followup start returned no id');
  return body.id;
}

export async function waitCardFollowup(
  client: CardClient,
  id: string,
  { intervalMs = 3000, signal, onStatus, startedAt }: {
    intervalMs?: number;
    signal?: AbortSignal;
    onStatus?: (status: CardFollowupStatus['status']) => void;
    startedAt?: number;
  } = {},
): Promise<CardFollowupStatus> {
  const duration = startedAt === undefined ? 10 * 60 * 1000
    : Math.max(0, startedAt + CARD_FOLLOWUP_MAX_AGE_MS - Date.now());
  const deadline = Date.now() + duration;
  const failed: CardFollowupStatus = { status: 'failed' };
  const timeoutController = new AbortController();
  const pollSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
  let timedOut = false;
  const pause = (ms: number, visible = false): Promise<void> => new Promise((resolve, reject) => {
    if (pollSignal.aborted) { reject(signal?.reason ?? new Error('aborted')); return; }
    let timer: ReturnType<typeof setTimeout>;
    const page = typeof document === 'undefined' ? undefined : document;
    const finish = () => {
      clearTimeout(timer);
      page?.removeEventListener('visibilitychange', wake);
      pollSignal.removeEventListener('abort', abort);
    };
    const wake = () => { if (page?.visibilityState !== 'hidden') { finish(); resolve(); } };
    const abort = () => { finish(); reject(signal?.reason ?? new Error('aborted')); };
    timer = setTimeout(() => { finish(); resolve(); }, ms);
    if (visible) page?.addEventListener('visibilitychange', wake);
    pollSignal.addEventListener('abort', abort, { once: true });
  });

  const poll = async (): Promise<CardFollowupStatus> => {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        await pause(deadline - Date.now(), true);
        continue;
      }
      const response = await client.fetchResponse(`/v1/card-followup/${encodeURIComponent(id)}`, { signal: pollSignal });
      if (!response.ok) throw new Error(`card followup poll failed: ${response.status}`);
      const result = await response.json() as CardFollowupStatus;
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      if (timedOut) return failed;
      onStatus?.(result.status);
      if (result.status === 'done' || result.status === 'not-card' || result.status === 'failed') return result;
      await pause(Math.min(Math.max(0, intervalMs), Math.max(0, deadline - Date.now())));
    }
    onStatus?.('failed');
    return failed;
  };
  let timeout: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([poll(), new Promise<CardFollowupStatus>((resolve) => {
      timeout = setTimeout(() => { timedOut = true; timeoutController.abort(); onStatus?.('failed'); resolve(failed); }, duration);
    })]);
  } finally {
    clearTimeout(timeout!);
  }
}
