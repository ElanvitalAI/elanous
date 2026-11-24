// els attach keys — herdr's prefix scheme for the app view: ctrl+b, then one key. Everything else is typed into the pane.
// Pure: a stream of decoded key text in, events out. A prefix split across two reads stays armed.
// ELS-MOUSE: SGR 1006 마우스 시퀀스는 라우터 앞단에서 추출해 mouse KeyEvent으로 나온다.

import { mouseEvent, splitMouse } from './attach-mouse.js';
import type { MouseReport } from './attach-mouse.js';

export type KeyAction =
  | 'detach' | 'next' | 'previous' | 'next-workspace' | 'toggle-sidebar' | 'new' | 'new-workspace'
  | 'new-chat' | 'rename-tab' | 'close' | 'close-workspace' | 'help' | 'goto' | 'scroll-up' | 'scroll-down' | 'move-tab' | 'toggle-agents-order';

export type KeyEvent =
  | { readonly kind: 'input'; readonly bytes: string }
  | { readonly kind: 'paste-incomplete' }
  | { readonly kind: 'paste-discarded' }
  | { readonly kind: 'action'; readonly action: KeyAction; readonly n?: number }
  | { readonly kind: 'mouse'; readonly report: MouseReport }
  | { readonly kind: 'unknown'; readonly key: string };

const PREFIX = '\u0002';
const ESCAPE = '\u001b';

// ELS-ONE-SPACE: `s` toggles the side list (OP's suggestion, ctrl+b s; `b` stays — it is herdr's); `a` opens an elanous chat pane (`e` is kept for expand/collapse of the tree).
// herdr words: h/j/k/l move between panes, n/p tabs, w workspaces, c/N new, x/D close, b sidebar, q detach, ? help.
// With one pane per tab (stage 3) j/l/n step down the list and k/h/p step up.
const AFTER_PREFIX: Readonly<Record<string, KeyAction>> = {
  ',': 'rename-tab', q: 'detach', j: 'next', l: 'next', n: 'next', k: 'previous', h: 'previous', p: 'previous', w: 'next-workspace',
  b: 'toggle-sidebar', s: 'toggle-sidebar', g: 'toggle-agents-order', c: 'new', a: 'new-chat', N: 'new-workspace', x: 'close', D: 'close-workspace', m: 'move-tab', '?': 'help', '[': 'scroll-up', ']': 'scroll-down',
};

const PASTE_BEGIN = '\u001b[200~';
const PASTE_END = '\u001b[201~';

export function createKeyRouter(options: { pasteTimeoutMs?: number } = {}): { resetPrefix: () => void; feed: (text: string, literalPrefix?: boolean | (() => boolean), dispatch?: (event: KeyEvent) => void, detectPaste?: boolean) => KeyEvent[] } {
  let armed = false;
  let pendingMouse = '';
  let pendingBegin = '';
  let paste: string | undefined;
  let prefixTimer: ReturnType<typeof setTimeout> | undefined;
  let pasteTimer: ReturnType<typeof setTimeout> | undefined;
  let discarding = false;
  let discardTail = '';
  return {
    resetPrefix() { armed = false; },
    feed(text, literalPrefix = false, dispatch, detectPaste = true) {
      const events: KeyEvent[] = [];
      const emit = (event: KeyEvent): void => { events.push(event); dispatch?.(event); };
      const ordinary = (input: string): void => {
        const split = splitMouse(pendingMouse + input);
        pendingMouse = split.pending;
        let typed = '';
        const flush = (): void => { if (typed) { emit({ kind: 'input', bytes: typed }); typed = ''; } };
        for (const segment of split.segments) {
          if (segment.kind !== 'text') { flush(); emit(mouseEvent(segment.report)); continue; }
          for (const char of segment.text) {
            if (!armed) {
              if (char === PREFIX && !(typeof literalPrefix === 'function' ? literalPrefix() : literalPrefix)) { flush(); armed = true; } else typed += char;
              continue;
            }
            armed = false;
            if (char === PREFIX) typed += PREFIX;
            else if (char === ESCAPE) { /* the prefix is cancelled */ }
            else if (char >= '1' && char <= '9') emit({ kind: 'action', action: 'goto', n: Number(char) });
            else if (AFTER_PREFIX[char]) emit({ kind: 'action', action: AFTER_PREFIX[char]! });
            else emit({ kind: 'unknown', key: char });
          }
        }
        flush();
      };
      if (prefixTimer) clearTimeout(prefixTimer);
      prefixTimer = undefined;
      if (pasteTimer) clearTimeout(pasteTimer);
      pasteTimer = undefined;
      let remaining = pendingBegin + text;
      pendingBegin = '';
      if (!detectPaste && paste === undefined && !discarding) { ordinary(remaining); return events; }
      while (remaining) {
        if (discarding) {
          const chunk = discardTail + remaining;
          const end = chunk.indexOf(PASTE_END);
          if (end < 0) {
            discardTail = chunk.slice(-(PASTE_END.length - 1));
            break;
          }
          remaining = chunk.slice(end + PASTE_END.length);
          discardTail = '';
          discarding = false;
          emit({ kind: 'paste-discarded' });
          continue;
        }
        if (paste !== undefined) {
          paste += remaining;
          const end = paste.indexOf(PASTE_END, PASTE_BEGIN.length);
          if (end < 0) break;
          const boundary = end + PASTE_END.length;
          const complete = paste.slice(0, boundary);
          remaining = paste.slice(boundary);
          paste = undefined;
          armed = false;
          emit({ kind: 'input', bytes: complete });
          continue;
        }
        const start = remaining.indexOf(PASTE_BEGIN);
        if (start >= 0) {
          ordinary(remaining.slice(0, start));
          paste = PASTE_BEGIN;
          remaining = remaining.slice(start + PASTE_BEGIN.length);
          if (!remaining) break;
          continue;
        }
        let tail = 0;
        for (let n = 1; n < PASTE_BEGIN.length && n <= remaining.length; n++) {
          if (remaining.endsWith(PASTE_BEGIN.slice(0, n))) tail = n;
        }
        pendingBegin = tail ? remaining.slice(-tail) : '';
        ordinary(tail ? remaining.slice(0, -tail) : remaining);
        remaining = '';
      }
      // A standalone Escape must still reach the pane. Only callback users can
      // receive the delayed fragment; direct synchronous consumers keep it.
      if (pendingBegin && dispatch) prefixTimer = setTimeout(() => {
        const fragment = pendingBegin; pendingBegin = ''; prefixTimer = undefined;
        if (fragment) ordinary(fragment);
      }, 40);
      // Discard late bytes too: otherwise a slow paste's tail could become
      // ordinary shell input after the timeout.
      if (paste !== undefined && dispatch) pasteTimer = setTimeout(() => {
        discardTail = paste!.slice(-(PASTE_END.length - 1));
        paste = undefined;
        pasteTimer = undefined;
        armed = false;
        discarding = true;
        dispatch({ kind: 'paste-incomplete' });
      }, options.pasteTimeoutMs ?? 10_000);
      return events;
    },
  };
}
