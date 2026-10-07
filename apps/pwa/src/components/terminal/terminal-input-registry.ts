import { debugLog } from '@/lib/debug';
import type { Terminal } from '@xterm/xterm';
import type { ModifierState } from '@/lib/key-sequences';

export type TerminalHistoryView = Pick<Terminal, 'buffer' | 'modes' | 'scrollPages'>;

const views = new Map<string, { view: TerminalHistoryView }>();
const viewListeners = new Set<() => void>();

export function registerTerminalHistoryView(terminalId: string, view: TerminalHistoryView): () => void {
  const registration = { view };
  views.set(terminalId, registration);
  viewListeners.forEach((listener) => listener());
  return () => {
    if (views.get(terminalId) !== registration) return;
    views.delete(terminalId);
    viewListeners.forEach((listener) => listener());
  };
}

export function getTerminalHistoryView(terminalId: string): TerminalHistoryView | null {
  return views.get(terminalId)?.view ?? null;
}

export function subscribeTerminalHistoryView(listener: () => void): () => void {
  viewListeners.add(listener);
  return () => { viewListeners.delete(listener); };
}

type TerminalInput = (data: string) => void;

const senders = new Map<string, { sender: TerminalInput }>();
const stickyModifiers = new Map<string, ModifierState>();
const stickyListeners = new Map<string, Set<() => void>>();

function notifyStickyModifiers(terminalId: string): void {
  stickyListeners.get(terminalId)?.forEach((listener) => listener());
}

/** Arms Ctrl/Alt for the next input on this terminal; an idle state disarms it. */
export function setStickyModifiers(terminalId: string, mods: ModifierState): void {
  if (mods.ctrl || mods.alt) stickyModifiers.set(terminalId, { ctrl: mods.ctrl, alt: mods.alt });
  else stickyModifiers.delete(terminalId);
}

/** Returns the armed modifiers once, clearing them before notifying subscribers. */
export function takeStickyModifiers(terminalId: string): ModifierState | null {
  const mods = stickyModifiers.get(terminalId) ?? null;
  if (mods) {
    stickyModifiers.delete(terminalId);
    notifyStickyModifiers(terminalId);
  }
  return mods;
}

export function subscribeStickyModifiers(terminalId: string, listener: () => void): () => void {
  let listeners = stickyListeners.get(terminalId);
  if (!listeners) {
    listeners = new Set();
    stickyListeners.set(terminalId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stickyListeners.get(terminalId) === listeners) stickyListeners.delete(terminalId);
  };
}

/** Returns a cleanup that only removes this registration, even when callbacks are reused. */
export function registerTerminalInput(terminalId: string, sender: TerminalInput): () => void {
  const registration = { sender };
  senders.set(terminalId, registration);
  return () => {
    if (senders.get(terminalId) === registration) senders.delete(terminalId);
  };
}

/** Routes through the terminal's input sender, including its pre-connection queue. */
export function sendToTerminal(terminalId: string, data: string): boolean {
  const sender = senders.get(terminalId);
  if (!sender) {
    debugLog('webterm.input.no-sender', { terminalId, bytes: new TextEncoder().encode(data).length });
    return false;
  }
  sender.sender(data);
  return true;
}
