// els attach keys — herdr's prefix scheme for the app view: ctrl+b, then one key. Everything else is typed into the pane.
// Pure: a stream of decoded key text in, events out. A prefix split across two reads stays armed.

export type KeyAction =
  | 'detach' | 'next' | 'previous' | 'next-workspace' | 'toggle-sidebar' | 'new' | 'new-workspace'
  | 'new-chat' | 'close' | 'close-workspace' | 'help' | 'goto';

export type KeyEvent =
  | { readonly kind: 'input'; readonly bytes: string }
  | { readonly kind: 'action'; readonly action: KeyAction; readonly n?: number }
  | { readonly kind: 'unknown'; readonly key: string };

const PREFIX = '\u0002';
const ESCAPE = '\u001b';

// ELS-ONE-SPACE: `s` toggles the side list (OP's suggestion, ctrl+b s; `b` stays — it is herdr's); `a` opens an elanous chat pane (`e` is kept for expand/collapse of the tree).
// herdr words: h/j/k/l move between panes, n/p tabs, w workspaces, c/N new, x/D close, b sidebar, q detach, ? help.
// With one pane per tab (stage 3) j/l/n step down the list and k/h/p step up.
const AFTER_PREFIX: Readonly<Record<string, KeyAction>> = {
  q: 'detach', j: 'next', l: 'next', n: 'next', k: 'previous', h: 'previous', p: 'previous', w: 'next-workspace',
  b: 'toggle-sidebar', s: 'toggle-sidebar', c: 'new', a: 'new-chat', N: 'new-workspace', x: 'close', D: 'close-workspace', '?': 'help',
};

export function createKeyRouter(): { feed: (text: string) => KeyEvent[] } {
  let armed = false;
  return {
    feed(text) {
      const events: KeyEvent[] = [];
      let typed = '';
      const flush = (): void => { if (typed) { events.push({ kind: 'input', bytes: typed }); typed = ''; } };
      for (const char of text) {
        if (!armed) {
          if (char === PREFIX) { flush(); armed = true; } else typed += char;
          continue;
        }
        armed = false;
        if (char === PREFIX) typed += PREFIX;             // ctrl+b ctrl+b = one literal ctrl+b
        else if (char === ESCAPE) { /* the prefix is cancelled */ }
        else if (char >= '1' && char <= '9') events.push({ kind: 'action', action: 'goto', n: Number(char) });
        else if (AFTER_PREFIX[char]) events.push({ kind: 'action', action: AFTER_PREFIX[char]! });
        else events.push({ kind: 'unknown', key: char });
      }
      flush();
      return events;
    },
  };
}
