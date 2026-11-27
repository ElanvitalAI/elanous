// ELS-ZAXIS S4 — the toast element (decision 5: toast first, to prove the layer path). A short line in the top-right corner,
// band `toast`, focus `none` (keys and clicks go straight through), gone after its ttl. Several toasts stack downward.
// Idea from classic ui/widgets/toast-stack.ts (8/31 export): placement top-right, kinds info/success/warning/error, ttl.

import { fitAnsi } from '../attach-view.js';
import type { ElementDef } from './element.js';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';
export interface ToastProps { readonly text: string; readonly level: ToastLevel }

const LEVELS: readonly ToastLevel[] = ['info', 'success', 'warning', 'error'];
const MARK: Readonly<Record<ToastLevel, string>> = { info: 'ℹ', success: '✓', warning: '!', error: '✕' };
const COLOR: Readonly<Record<ToastLevel, string>> = { info: '\u001b[36m', success: '\u001b[32m', warning: '\u001b[33m', error: '\u001b[31m' };
// 출처: #40244 classic toast-stack maxWidth default 40 cells (+ frame) — longer text is cut, never wrapped over the pane.
export const TOAST_MAX_TEXT = 200;
export const TOAST_MAX_WIDTH = 48;

export const toast: ElementDef<ToastProps> = {
  kind: 'toast',
  defaults: { band: 'toast', focus: 'none', ttlMs: 5_000, multi: true },
  frames: ['popup'],
  props: (raw) => {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    const text = typeof value?.text === 'string' ? value.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    if (!text || text.length > TOAST_MAX_TEXT) return undefined;
    const level = LEVELS.includes(value?.level as ToastLevel) ? value!.level as ToastLevel : 'info';
    return { text, level };
  },
  rect: (props, others) => ({ anchor: 'tr', w: Math.min(TOAST_MAX_WIDTH, Bun.stringWidth(props.text) + 6), h: 3, dx: -1, dy: 1 + others * 3 }),
  render: (props, size) => {
    const inner = Math.max(0, size.w - 2);
    const color = COLOR[props.level];
    return [
      `${color}╭${'─'.repeat(inner)}╮\u001b[0m`,
      `${color}│\u001b[0m${fitAnsi(` ${color}${MARK[props.level]}\u001b[0m ${props.text}`, inner)}${color}│\u001b[0m`,
      `${color}╰${'─'.repeat(inner)}╯\u001b[0m`,
    ].slice(0, size.h);
  },
};
