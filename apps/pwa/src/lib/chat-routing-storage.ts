'use client';

// chat-routing-storage — shared automatic-routing preference.
// Cross-tab sync via StorageEvent fan-out (same pattern as
// intent-panel-storage).

const AUTO_ROUTING_KEY = 'elanous.pwa.chat.autoRouting';
const CHANGE_EVENT = 'elanous-chat-routing-changed';

export interface ChatRoutingState {
  autoRouting: boolean;
}

export const DEFAULT_CHAT_ROUTING: ChatRoutingState = {
  autoRouting: false,
};

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = window.localStorage.getItem(key);
    if (v === '1') return true;
    if (v === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeBool(key: string, v: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, v ? '1' : '0');
  } catch { /* swallow */ }
}

export function getChatRouting(): ChatRoutingState {
  return {
    autoRouting: readBool(AUTO_ROUTING_KEY, DEFAULT_CHAT_ROUTING.autoRouting),
  };
}

export function setAutoRouting(v: boolean): void {
  writeBool(AUTO_ROUTING_KEY, v);
  fanout();
}

function fanout(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Subscribe to changes from this tab (CustomEvent) and other tabs
 *  (StorageEvent). Returns an unsubscribe function. */
export function subscribeChatRouting(cb: (state: ChatRoutingState) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (): void => cb(getChatRouting());
  const storageHandler = (e: StorageEvent): void => {
    if (e.key === AUTO_ROUTING_KEY) cb(getChatRouting());
  };
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}
