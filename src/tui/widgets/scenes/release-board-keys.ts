/**
 * Release Board keys — a pure reducer: (ui, key, ctx) → ui' (+ an action to perform). m/s/r are OP/REL only and always
 * go through a y/N confirmation (s first asks for a reason). Unknown keys are ignored.
 */
import type { ReleaseBoardUi } from './release-board.js';

export type BoardKey = 'up' | 'down' | 'enter' | 'esc' | 'tab' | 'backspace' | { readonly char: string };
export interface BoardAction { readonly kind: 'mark' | 'skip' | 'resume'; readonly step: string; readonly reason?: string }
export interface KeyCtx { readonly steps: readonly string[]; readonly role: string | null }
export interface KeyState extends ReleaseBoardUi {
  /** Pending write: collecting a reason (skip) or waiting for y/N. */
  readonly pending?: { readonly kind: BoardAction['kind']; readonly step: string; readonly reason?: string; readonly stage: 'reason' | 'confirm' };
}
export interface KeyResult { readonly ui: KeyState; readonly action?: BoardAction; readonly quit?: boolean; readonly nextRun?: boolean; readonly follow?: boolean }

export const WRITE_ROLES = ['OP', 'REL'] as const;
export const initialUi: KeyState = { selected: 0, detail: false, help: false, preview: false };

const VERB: Record<BoardAction['kind'], string> = { mark: 'Mark', skip: 'Skip', resume: 'Resume from' };

function confirmLine(p: NonNullable<KeyState['pending']>): string {
  return `${VERB[p.kind]} ${p.step}${p.reason ? ` (reason: ${p.reason})` : ''}? y confirm · any other key cancels`;
}

export function boardKey(ui: KeyState, key: BoardKey, ctx: KeyCtx): KeyResult {
  const base: KeyState = { ...ui, flash: undefined };
  const p = ui.pending;
  if (p?.stage === 'reason') {
    if (key === 'esc') return { ui: { ...base, pending: undefined, prompt: undefined, flash: 'Skip cancelled' } };
    if (key === 'enter') {
      const reason = (p.reason ?? '').trim();
      if (!reason) return { ui: { ...base, prompt: `Skip ${p.step} — a reason is required: ` } };
      const next = { ...p, reason, stage: 'confirm' as const };
      return { ui: { ...base, pending: next, prompt: confirmLine(next) } };
    }
    const reason = key === 'backspace' ? (p.reason ?? '').slice(0, -1) : typeof key === 'object' ? `${p.reason ?? ''}${key.char}` : p.reason ?? '';
    return { ui: { ...base, pending: { ...p, reason }, prompt: `Skip ${p.step} — reason: ${reason}` } };
  }
  if (p?.stage === 'confirm') {
    const yes = typeof key === 'object' && (key.char === 'y' || key.char === 'Y');
    const cleared: KeyState = { ...base, pending: undefined, prompt: undefined };
    if (!yes) return { ui: { ...cleared, flash: `${VERB[p.kind]} ${p.step} cancelled` } };
    return { ui: cleared, action: { kind: p.kind, step: p.step, ...(p.reason ? { reason: p.reason } : {}) } };
  }
  const n = ctx.steps.length;
  const step = ctx.steps[Math.min(ui.selected, Math.max(0, n - 1))];
  if (key === 'up') return { ui: { ...base, selected: n ? (ui.selected - 1 + n) % n : 0 } };
  if (key === 'down') return { ui: { ...base, selected: n ? (ui.selected + 1) % n : 0 } };
  if (key === 'enter') return { ui: { ...base, detail: !ui.detail, help: false } };
  if (key === 'esc') return { ui: { ...base, detail: false, help: false } };
  if (key === 'tab') return { ui: base, nextRun: true };
  if (typeof key !== 'object') return { ui: base };
  switch (key.char) {
    case 'q': return { ui: base, quit: true };
    case '?': return { ui: { ...base, help: !ui.help, detail: false } };
    case 'p': return { ui: { ...base, preview: !ui.preview } };
    case 'f': return { ui: { ...base, flash: 'Following the newest run' }, follow: true };
    case 'k': return boardKey(ui, 'up', ctx);
    case 'j': return boardKey(ui, 'down', ctx);
    case 'm': case 's': case 'r': {
      const kind: BoardAction['kind'] = key.char === 'm' ? 'mark' : key.char === 's' ? 'skip' : 'resume';
      if (!step) return { ui: { ...base, flash: 'No step selected' } };
      if (!ctx.role || !(WRITE_ROLES as readonly string[]).includes(ctx.role)) {
        return { ui: { ...base, flash: `Read-only: ${VERB[kind].toLowerCase()} is for OP or REL (you are ${ctx.role ?? 'unknown'})` } };
      }
      if (ui.preview) return { ui: { ...base, flash: 'Leave the preview (p) before changing the run' } };
      if (kind === 'skip') return { ui: { ...base, pending: { kind, step, stage: 'reason', reason: '' }, prompt: `Skip ${step} — reason: ` } };
      const pending = { kind, step, stage: 'confirm' as const };
      return { ui: { ...base, pending, prompt: confirmLine(pending) } };
    }
    default: return { ui: base };
  }
}

/** Raw terminal bytes → keys (arrows, Enter, Esc, Tab, Backspace, printable chars). */
export function parseKeys(data: string): BoardKey[] {
  const out: BoardKey[] = [];
  for (let i = 0; i < data.length;) {
    const rest = data.slice(i);
    if (rest.startsWith('\x1b[A') || rest.startsWith('\x1bOA')) { out.push('up'); i += 3; continue; }
    if (rest.startsWith('\x1b[B') || rest.startsWith('\x1bOB')) { out.push('down'); i += 3; continue; }
    if (/^\x1b\[[0-9;]*[ -/]*[@-~]/.test(rest)) { i += /^\x1b\[[0-9;]*[ -/]*[@-~]/.exec(rest)![0].length; continue; }
    const c = data[i]!;
    i += 1;
    if (c === '\r' || c === '\n') out.push('enter');
    else if (c === '\x1b') out.push('esc');
    else if (c === '\t') out.push('tab');
    else if (c === '\x7f' || c === '\b') out.push('backspace');
    else if (c === '\x03') out.push({ char: 'q' });
    else if (c >= ' ') out.push({ char: c });
  }
  return out;
}
