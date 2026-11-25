// A200 ELN-MIDTURN-STEER — the REPL child's per-turn steer inbox.
//
// The Next TUI sends input typed during a running turn over Bun IPC instead of holding it until
// the turn ends. The child puts it in the session's pending-input registry, which the tool loop
// (`streamLLMWithTools` · `drainPendingUserInput`) drains right before the next model request,
// after tool results are appended (codex/opencode «steer»). The in-flight tool or stream is not cut.
// When the turn ends with no further model request, the undelivered items are withdrawn here and
// the parent, which still holds them, submits them as the next turn — nothing is lost or doubled.

import { signalShellPreempt, steerPreemptsShell } from '../session/shell-preempt.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve as resolvePath } from 'node:path';
import type { InterjectionImage } from '../chat/interjection.js';
import { debug } from '../debug/log.js';
import { enqueuePendingUserInput, removePendingUserInput, type PendingSeatMailSource } from '../session/pending-input.js';
import { signalUrgentSteer } from '../session/urgent-steer.js';

export const NEXT_TUI_STEER_TYPE = 'elanous.next-tui.steer';
export const NEXT_TUI_STEER_RETRACT_TYPE = 'elanous.next-tui.steer-retract';

/** IMAGE-IN-STEER-FU — an attachment typed with a steer line: its file path and the composer token that names it. */
export interface NextTuiSteerAttachment { readonly path: string; readonly token?: string }

/** At most this many attachments per steer line (the turn-start path has no larger practical count). */
export const STEER_ATTACHMENT_MAX = 8;
/** A steer image over this many bytes is not inlined (a note replaces it) — the request must not fail on one image. */
export const STEER_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const STEER_IMAGE_MEDIA: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

export type NextTuiSteerRequest =
  | { kind: 'steer'; steerId: string; text: string; urgent?: boolean; seatMail?: PendingSeatMailSource; attachments?: NextTuiSteerAttachment[] }
  | { kind: 'retract'; steerIds: string[] };

/** Structured seat-mail provenance on a steer message; null = malformed. */
function parseSeatMailSource(value: unknown): PendingSeatMailSource | null {
  if (value === undefined || value === null || typeof value !== 'object') return null;
  const raw = value as { msgId?: unknown; from?: unknown; intent?: unknown; crownDirective?: unknown; originKind?: unknown; viaLedger?: unknown };
  if (typeof raw.msgId !== 'number' || !Number.isSafeInteger(raw.msgId) || raw.msgId <= 0) return null;
  if (typeof raw.from !== 'string' || raw.from.length === 0 || raw.from.length > 64) return null;
  if (raw.intent !== undefined && raw.intent !== null && typeof raw.intent !== 'string') return null;
  const short = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64;
  return { msgId: raw.msgId, from: raw.from, ...(typeof raw.intent === 'string' ? { intent: raw.intent } : {}),
    ...(short(raw.crownDirective) ? { crownDirective: raw.crownDirective } : {}),
    // A present-but-malformed origin is kept as «invalid» (a non-agent kind), so the mail stays untrusted.
    ...(raw.originKind === undefined || raw.originKind === null ? {} : { originKind: short(raw.originKind) ? raw.originKind : 'invalid' }),
    ...(raw.viaLedger === true ? { viaLedger: true } : {}) };
}

/** Steer attachments from the IPC message; null = malformed (the message is refused). */
function parseSteerAttachments(value: unknown): NextTuiSteerAttachment[] | null {
  if (!Array.isArray(value) || value.length > STEER_ATTACHMENT_MAX) return null;
  const out: NextTuiSteerAttachment[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') return null;
    const { path, token } = raw as { path?: unknown; token?: unknown };
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096) return null;
    if (token !== undefined && (typeof token !== 'string' || token.length === 0 || token.length > 512)) return null;
    out.push({ path, ...(typeof token === 'string' ? { token } : {}) });
  }
  return out;
}

/**
 * IMAGE-IN-STEER-FU — read a steer line's image attachments as real bytes and rewrite their composer tokens.
 * A token of an attached image becomes «[attached image k]» (k = its image part); one that could not be attached
 * becomes a visible note naming the file, so the model never reads a bare «[image N]» it cannot see.
 * Non-image attachments are left as they are (the line keeps its text).
 */
export function loadSteerImages(text: string, attachments: readonly NextTuiSteerAttachment[], baseDir: string): {
  text: string; images: InterjectionImage[]; dropped: Array<{ path: string; reason: string }>;
} {
  const images: InterjectionImage[] = [];
  const dropped: Array<{ path: string; reason: string }> = [];
  let out = text;
  const seen = new Set<string>();
  for (const attachment of attachments.slice(0, STEER_ATTACHMENT_MAX)) {
    const resolved = isAbsolute(attachment.path) ? attachment.path : resolvePath(baseDir, attachment.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const mediaType = STEER_IMAGE_MEDIA[extname(resolved).toLowerCase()];
    if (!mediaType) continue;
    let reason: string | null = null;
    let base64 = '';
    try {
      if (!existsSync(resolved)) reason = 'not found';
      else if (statSync(resolved).size > STEER_IMAGE_MAX_BYTES) reason = 'too large';
      else base64 = readFileSync(resolved).toString('base64');
    } catch (error) { reason = error instanceof Error ? error.message.slice(0, 80) : 'unreadable'; }
    if (reason === null && base64.length === 0) reason = 'empty';
    const replacement = reason === null
      ? `[attached image ${images.length + 1}]`
      : `[image not attached: ${basename(resolved)} · ${reason}]`;
    if (reason === null) images.push({ mediaType, base64 });
    else dropped.push({ path: resolved, reason });
    if (attachment.token) out = out.split(attachment.token).join(replacement);
  }
  return { text: out, images, dropped };
}

/** Buffers steer messages that arrive before the child turn installs its listener (same shape as push-now). */
export function createNextTuiSteerRouter() {
  const listeners = new Map<string, (request: NextTuiSteerRequest) => void>();
  const pending = new Map<string, NextTuiSteerRequest[]>();
  return {
    receive(message: unknown): boolean {
      if (message === null || typeof message !== 'object') return false;
      const raw = message as { type?: unknown; turnId?: unknown; steerId?: unknown; text?: unknown; urgent?: unknown; steerIds?: unknown; seatMail?: unknown; attachments?: unknown };
      if (typeof raw.turnId !== 'string' || !raw.turnId) return false;
      let request: NextTuiSteerRequest;
      if (raw.type === NEXT_TUI_STEER_TYPE && typeof raw.steerId === 'string' && raw.steerId && typeof raw.text === 'string'
        && (raw.urgent === undefined || typeof raw.urgent === 'boolean')) {
        const seatMail = parseSeatMailSource(raw.seatMail);
        // A malformed provenance object is refused, not downgraded to operator input.
        if (raw.seatMail !== undefined && seatMail === null) return false;
        // IMAGE-IN-STEER-FU — operator attachments only (seat mail never carries files into the turn).
        const attachments = raw.attachments === undefined ? [] : parseSteerAttachments(raw.attachments);
        if (attachments === null || (seatMail && attachments.length > 0)) return false;
        request = { kind: 'steer', steerId: raw.steerId, text: raw.text, ...(raw.urgent === true ? { urgent: true } : {}),
          ...(seatMail ? { seatMail } : {}), ...(attachments.length > 0 ? { attachments } : {}) };
      } else if (raw.type === NEXT_TUI_STEER_RETRACT_TYPE && Array.isArray(raw.steerIds)
        && raw.steerIds.every((id) => typeof id === 'string')) {
        request = { kind: 'retract', steerIds: raw.steerIds as string[] };
      } else return false;
      const listener = listeners.get(raw.turnId);
      if (listener) listener(request);
      else pending.set(raw.turnId, [...(pending.get(raw.turnId) ?? []), request]);
      return true;
    },
    listen(turnId: string, listener: (request: NextTuiSteerRequest) => void): () => void {
      listeners.set(turnId, listener);
      for (const request of pending.get(turnId) ?? []) listener(request);
      pending.delete(turnId);
      return () => {
        if (listeners.get(turnId) === listener) listeners.delete(turnId);
        pending.delete(turnId);
      };
    },
  };
}

/**
 * One turn's steer inbox. `onApplied` receives the parent's steer ids once the tool loop drained them
 * into the next model request. `finish()` withdraws what was never drained and returns those ids.
 */
export function createNextTuiSteerInbox(sessionId: string, onApplied: (steerIds: string[]) => void) {
  const steerIdByPendingId = new Map<string, string>();
  const onDrained = (_texts: readonly string[], items: readonly { id: string }[]): void => {
    const steerIds: string[] = [];
    for (const item of items) {
      const steerId = steerIdByPendingId.get(item.id);
      if (steerId === undefined) continue;
      steerIdByPendingId.delete(item.id);
      steerIds.push(steerId);
    }
    if (steerIds.length === 0) return;
    debug.log('turn.steer', 'injected', { sessionId, steerIds, count: steerIds.length }, { level: 'info' });
    onApplied(steerIds);
  };
  const pendingIdsFor = (steerIds: readonly string[]): string[] => {
    const wanted = new Set(steerIds);
    return [...steerIdByPendingId].filter(([, steerId]) => wanted.has(steerId)).map(([pendingId]) => pendingId);
  };
  return {
    push(steerId: string, text: string, urgent = false, seatMail?: PendingSeatMailSource,
      attachments: readonly NextTuiSteerAttachment[] = [], baseDir = process.cwd()): boolean {
      const loaded = !seatMail && attachments.length > 0 ? loadSteerImages(text, attachments, baseDir) : null;
      const pendingId = enqueuePendingUserInput(sessionId, loaded?.text ?? text, onDrained, seatMail, loaded?.images);
      if (pendingId === null) return false;
      steerIdByPendingId.set(pendingId, steerId);
      debug.log('turn.steer', 'received', { sessionId, steerId, chars: text.length,
        ...(loaded ? { images: loaded.images.length, imagesDropped: loaded.dropped.length } : {}) });
      if (loaded && loaded.dropped.length > 0) {
        debug.log('turn.steer', 'image-not-attached', { sessionId, steerId, reasons: loaded.dropped.map((d) => d.reason) }, { level: 'warn' });
      }
      if (urgent) signalUrgentSteer(sessionId);
      // RUNSHELL-BG-ENDS-TURN ① — an urgent steer detaches a foreground shell wait (structured urgency only).
      if (steerPreemptsShell(seatMail, urgent)) signalShellPreempt(sessionId);
      return true;
    },
    retract(steerIds: readonly string[]): void {
      const pendingIds = pendingIdsFor(steerIds);
      for (const pendingId of pendingIds) steerIdByPendingId.delete(pendingId);
      if (pendingIds.length > 0) removePendingUserInput(pendingIds, 'recalled');
    },
    /** Turn ended: what no model request consumed goes back to the parent's queue as the next turn. */
    finish(): string[] {
      const carried = [...steerIdByPendingId.values()];
      if (steerIdByPendingId.size > 0) removePendingUserInput([...steerIdByPendingId.keys()], 'submitted-as-prompt');
      steerIdByPendingId.clear();
      if (carried.length > 0) debug.log('turn.steer', 'carried-to-next-turn', { sessionId, steerIds: carried, count: carried.length });
      return carried;
    },
  };
}
