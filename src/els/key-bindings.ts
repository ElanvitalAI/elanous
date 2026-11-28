// ELS-SHORTCUTS-POPUP (대표 11-28 19:2x «단축키를 한눈에 팝업으로») — the ONE table of els attach keys.
// The key router (attach-keys.ts: what ctrl+b <key> means), the tile view's own keys (attach-app.ts tileKey) and the
// ctrl+b ? shortcuts popup (elements/shortcuts.ts) all read this table — no second list of keys exists anywhere.
//
// A row is one thing a person can do: the raw key bytes, the action the app runs, an English label (user-facing text — no
// internal words), a group (where it sits in the popup) and a context (when it applies: always, on the tile grid, on the
// popup terminal, on a focused popup). Rows with `parse: false` are the same chord read differently in a context (ctrl+b q
// hides the popup terminal while it has the keys) — the router already knows the chord from its normal row.

/** What ctrl+b <key> means (the key router's output). */
export type KeyAction =
  | 'detach' | 'next' | 'previous' | 'next-workspace' | 'toggle-sidebar' | 'new' | 'new-workspace'
  | 'new-chat' | 'rename-tab' | 'close' | 'close-workspace' | 'help' | 'goto' | 'scroll-up' | 'scroll-down' | 'move-tab' | 'toggle-agents-order'
  | 'expand-all' | 'collapse-all' | 'toggle-active' | 'toggle-group' | 'list-page-up' | 'list-page-down' | 'list-home' | 'list-end' | 'tabs-left' | 'tabs-right' | 'tile'
  | 'voice' | 'sidechat' | 'obsidian' | 'cycle-focus' | 'memo' | 'files' | 'popup-term' | 'escape' | 'move-layer' | 'quit';
/** What a key means on the tile grid (no ctrl+b: the grid is read-only, so plain keys are free). */
export type TileAction = 'tile-left' | 'tile-down' | 'tile-up' | 'tile-right' | 'tile-zoom' | 'tile-page-prev' | 'tile-page-next' | 'tile-level-up';

export type ShortcutContext = 'normal' | 'tile' | 'popup-term' | 'overlay';
export const SHORTCUT_CONTEXTS: readonly ShortcutContext[] = ['normal', 'tile', 'popup-term', 'overlay'];
export const SHORTCUT_GROUPS = ['Panes & tabs', 'Workspaces', 'Views', 'Popup terminal', 'Scrolling', 'Session', 'Tile view'] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

export interface KeyBinding {
  /** Raw key bytes as the terminal sends them (after ctrl+b when `prefix`). */
  readonly keys: readonly string[];
  /** What the person reads: «ctrl+b j / l / n». */
  readonly chord: string;
  readonly action: KeyAction | TileAction;
  readonly label: string;
  readonly group: ShortcutGroup;
  readonly context: ShortcutContext;
  /** ctrl+b first. */
  readonly prefix: boolean;
  /** false = a context reading of a chord another row already defines (display only — not a parser entry). */
  readonly parse: boolean;
}

/** Key bytes → the name a person reads. Anything not here is shown as itself. */
const KEY_NAMES: Readonly<Record<string, string>> = {
  ' ': 'Space', '\r': 'Enter', '\n': 'Enter', '\t': 'Tab', '\u001b': 'Esc',
  '\u001b[5~': 'PgUp', '\u001b[6~': 'PgDn', '\u001b[H': 'Home', '\u001b[1~': 'Home', '\u001bOH': 'Home',
  '\u001b[F': 'End', '\u001b[4~': 'End', '\u001bOF': 'End',
  '\u001b[D': '←', '\u001bOD': '←', '\u001b[C': '→', '\u001bOC': '→', '\u001b[A': '↑', '\u001bOA': '↑', '\u001b[B': '↓', '\u001bOB': '↓',
};
const keyName = (key: string): string => Object.hasOwn(KEY_NAMES, key) ? KEY_NAMES[key]! : key;

type Spec = Omit<KeyBinding, 'chord' | 'prefix' | 'parse' | 'context'> & { readonly chord?: string; readonly prefix?: boolean; readonly parse?: boolean; readonly context?: ShortcutContext };
const row = (spec: Spec): KeyBinding => {
  const prefix = spec.prefix ?? true;
  const names = [...new Set(spec.keys.map(keyName))];
  return { ...spec, prefix, parse: spec.parse ?? true, context: spec.context ?? 'normal', chord: spec.chord ?? `${prefix ? 'ctrl+b ' : ''}${names.join(' / ')}` };
};
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const TILE_MOVE = '←↑↓→ / hjkl';

// herdr words: h/j/k/l move between panes, n/p tabs, w workspaces, c/N new, x/D close, b sidebar, q detach, ? help.
// With one pane per tab (stage 3) j/l/n step down the list and k/h/p step up.
export const KEY_BINDINGS: readonly KeyBinding[] = [
  // Panes & tabs
  row({ keys: ['j', 'l', 'n'], action: 'next', label: 'Next tab', group: 'Panes & tabs' }),
  row({ keys: ['k', 'h', 'p'], action: 'previous', label: 'Previous tab', group: 'Panes & tabs' }),
  row({ keys: DIGITS, chord: 'ctrl+b 1…9', action: 'goto', label: 'Go to tab 1 to 9', group: 'Panes & tabs' }),
  row({ keys: ['c'], action: 'new', label: 'New tab (shell)', group: 'Panes & tabs' }),
  row({ keys: ['a'], action: 'new-chat', label: 'New Elanous chat tab', group: 'Panes & tabs' }),
  row({ keys: [','], action: 'rename-tab', label: 'Rename the tab', group: 'Panes & tabs' }),
  row({ keys: ['m'], action: 'move-tab', label: 'Move the tab to a workspace', group: 'Panes & tabs' }),
  row({ keys: ['x'], action: 'close', label: 'Close the tab', group: 'Panes & tabs' }),
  row({ keys: ['b', 's'], action: 'toggle-sidebar', label: 'Show or hide the side list', group: 'Panes & tabs' }),
  row({ keys: ['g'], action: 'toggle-agents-order', label: 'Group or sort the agent list', group: 'Panes & tabs' }),
  // ELS-GROUP-FOLD-CONTROL: + / - expand / collapse every agent group · space or enter folds the selected pane's group.
  row({ keys: [' ', '\r'], action: 'toggle-group', label: "Fold the selected tab's group", group: 'Panes & tabs' }),
  row({ keys: ['+'], action: 'expand-all', label: 'Expand / collapse every group', group: 'Panes & tabs' }),
  row({ keys: ['-'], action: 'collapse-all', label: 'Expand / collapse every group', group: 'Panes & tabs' }),
  // ELS-ACTIVE-ONLY-FILTER: A flips «Active only» (lowercase a is already «new elanous chat»).
  row({ keys: ['A'], action: 'toggle-active', label: 'Show active tabs only', group: 'Panes & tabs' }),
  // Workspaces
  row({ keys: ['w'], action: 'next-workspace', label: 'Next workspace', group: 'Workspaces' }),
  row({ keys: ['N'], action: 'new-workspace', label: 'New workspace', group: 'Workspaces' }),
  row({ keys: ['D'], action: 'close-workspace', label: 'Close the workspace', group: 'Workspaces' }),
  // Views — ELS-TILE-MODE: t shows every pane of this workspace as a live grid (and from a zoomed tab, back to the grid).
  row({ keys: ['t'], action: 'tile', label: 'Tile view (every tab, live)', group: 'Views' }),
  row({ keys: ['f'], action: 'files', label: 'File browser', group: 'Views' }),
  row({ keys: ['o'], action: 'obsidian', label: 'Obsidian notes', group: 'Views' }),
  row({ keys: [':'], action: 'voice', label: 'Tell els what to do', group: 'Views' }),
  row({ keys: ['/'], action: 'sidechat', label: 'Side chat', group: 'Views' }),
  row({ keys: ['M'], action: 'memo', label: 'Memo pad', group: 'Views' }),
  row({ keys: ['\t'], action: 'cycle-focus', label: 'Move the keys: popups ↔ tab', group: 'Views', context: 'overlay' }),
  row({ keys: ['r'], action: 'move-layer', label: 'Move / resize the focused popup', group: 'Views', context: 'overlay' }),
  // Popup terminal (ELS-POPUP-TERM) — on the terminal, ctrl+b q / x / m mean «hide · close · to a tab».
  row({ keys: ['`'], action: 'popup-term', label: 'Show or hide the popup terminal', group: 'Popup terminal' }),
  row({ keys: ['q'], action: 'detach', label: 'On it: hide (keeps running)', group: 'Popup terminal', context: 'popup-term', parse: false }),
  row({ keys: ['\u001b'], action: 'escape', label: 'On it: hide (keeps running)', group: 'Popup terminal', context: 'popup-term' }),
  row({ keys: ['x'], action: 'close', label: 'On it: close the terminal', group: 'Popup terminal', context: 'popup-term', parse: false }),
  row({ keys: ['m'], action: 'move-tab', label: 'On it: turn it into a tab', group: 'Popup terminal', context: 'popup-term', parse: false }),
  // Scrolling — ELS-SCROLL-MOUSE: after the prefix, PgUp/PgDn/Home/End page the side list and ←/→ scroll the tab row (the
  // keys alone stay the pane's — a shell or an editor needs them).
  row({ keys: ['['], action: 'scroll-up', label: "Scroll the tab's history", group: 'Scrolling' }),
  row({ keys: [']'], action: 'scroll-down', label: "Scroll the tab's history", group: 'Scrolling' }),
  row({ keys: ['\u001b[5~'], action: 'list-page-up', label: 'Side list: page up / down', group: 'Scrolling' }),
  row({ keys: ['\u001b[6~'], action: 'list-page-down', label: 'Side list: page up / down', group: 'Scrolling' }),
  row({ keys: ['\u001b[H', '\u001b[1~', '\u001bOH'], action: 'list-home', label: 'Side list: top / bottom', group: 'Scrolling' }),
  row({ keys: ['\u001b[F', '\u001b[4~', '\u001bOF'], action: 'list-end', label: 'Side list: top / bottom', group: 'Scrolling' }),
  row({ keys: ['\u001b[D', '\u001bOD'], action: 'tabs-left', label: 'Scroll the tab row', group: 'Scrolling' }),
  row({ keys: ['\u001b[C', '\u001bOC'], action: 'tabs-right', label: 'Scroll the tab row', group: 'Scrolling' }),
  // Session
  row({ keys: ['?'], action: 'help', label: 'Show or hide these shortcuts', group: 'Session' }),
  row({ keys: ['q'], action: 'detach', label: 'Leave els (all keeps running)', group: 'Session' }),
  row({ keys: ['Q'], action: 'quit', label: 'Quit and close this workspace', group: 'Session' }),
  // Tile view (ELS-TILE-MODE) — plain keys on the grid.
  row({ keys: ['h', '\u001b[D', '\u001bOD'], chord: TILE_MOVE, action: 'tile-left', label: 'Move between tiles', group: 'Tile view', context: 'tile', prefix: false }),
  row({ keys: ['j', '\u001b[B', '\u001bOB'], chord: TILE_MOVE, action: 'tile-down', label: 'Move between tiles', group: 'Tile view', context: 'tile', prefix: false }),
  row({ keys: ['k', '\u001b[A', '\u001bOA'], chord: TILE_MOVE, action: 'tile-up', label: 'Move between tiles', group: 'Tile view', context: 'tile', prefix: false }),
  row({ keys: ['l', '\u001b[C', '\u001bOC'], chord: TILE_MOVE, action: 'tile-right', label: 'Move between tiles', group: 'Tile view', context: 'tile', prefix: false }),
  row({ keys: ['\r', '\n'], action: 'tile-zoom', label: 'Back to the pane (open the tile)', group: 'Tile view', context: 'tile', prefix: false }),
  row({ keys: ['['], chord: '[ / ]', action: 'tile-page-prev', label: 'Previous / next page', group: 'Tile view', context: 'tile', prefix: false }),
  row({ keys: [']'], chord: '[ / ]', action: 'tile-page-next', label: 'Previous / next page', group: 'Tile view', context: 'tile', prefix: false }),
  row({ keys: ['\u001b'], action: 'tile-level-up', label: 'Up: space → spaces → all', group: 'Tile view', context: 'tile', prefix: false }),
];

const isSequence = (key: string): boolean => key.length > 1 && key.startsWith('\u001b');
const parsed = KEY_BINDINGS.filter((one) => one.prefix && one.parse);
/** One-byte keys after ctrl+b → the action (the key router's table). A key is defined once — a second parse row for it
 *  is a table error, caught here at load. */
export const AFTER_PREFIX: Readonly<Record<string, KeyAction>> = Object.freeze(Object.fromEntries(parsed.flatMap((one) => one.keys.filter((key) => !isSequence(key)).map((key) => [key, one.action as KeyAction]))));
/** Escape sequences after ctrl+b (PgUp · Home · ←) → the action. */
export const AFTER_PREFIX_KEYS: readonly (readonly [string, KeyAction])[] = parsed.flatMap((one) => one.keys.filter(isSequence).map((key) => [key, one.action as KeyAction] as const));
{
  const seen = new Set<string>();
  for (const key of parsed.flatMap((one) => one.keys)) { if (seen.has(key)) throw new Error(`key-bindings: ctrl+b ${JSON.stringify(key)} is defined twice`); seen.add(key); }
}
const tileRows = KEY_BINDINGS.filter((one) => one.context === 'tile' && !one.prefix);
/** A plain key (or arrow sequence) on the tile grid → its action. */
export function tileActionOf(key: string): TileAction | undefined {
  return tileRows.find((one) => one.keys.includes(key))?.action as TileAction | undefined;
}

/** One popup row: the chord(s) and what they do (rows of one group and context with the same label are merged). */
/** `keys` = the keys this row defines for the router (a context re-reading such as ctrl+b q on the popup terminal has none). */
export interface ShortcutRow { readonly chord: string; readonly label: string; readonly context: ShortcutContext; readonly keys: readonly string[]; readonly prefix: boolean }
export interface ShortcutSection { readonly group: ShortcutGroup; readonly rows: readonly ShortcutRow[] }

/** The popup's model for a context: every group, the context's group(s) first (in table order) then the rest; inside a
 *  group the context's rows first. Pure — the popup renders exactly this. */
export function shortcutSections(context: ShortcutContext): ShortcutSection[] {
  const sections = SHORTCUT_GROUPS.map((group): ShortcutSection => {
    const merged: { chords: string[]; label: string; context: ShortcutContext; keys: string[]; prefix: boolean }[] = [];
    for (const one of KEY_BINDINGS.filter((binding) => binding.group === group)) {
      const same = merged.find((have) => have.label === one.label && have.context === one.context && have.prefix === one.prefix);
      const keys = one.parse ? one.keys : [];                    // a context re-reading defines no key of its own
      if (same) { if (!same.chords.includes(one.chord)) same.chords.push(one.chord); same.keys.push(...keys); continue; }
      merged.push({ chords: [one.chord], label: one.label, context: one.context, keys: [...keys], prefix: one.prefix });
    }
    // «ctrl+b q» + «ctrl+b Esc» read as «ctrl+b q / Esc».
    const rows = merged.map(({ chords, ...rest }): ShortcutRow => ({ ...rest, chord: chords.map((chord, at) => at && rest.prefix ? chord.replace(/^ctrl\+b /, '') : chord).join(' / ') }));
    return { group, rows: [...rows.filter((one) => one.context === context), ...rows.filter((one) => one.context !== context)] };
  });
  const first = sections.filter((section) => section.rows.some((one) => one.context === context));
  return [...first, ...sections.filter((section) => !first.includes(section))];
}

/** The table as markdown (for the docs): one section per group, in the normal order. */
export function shortcutsMarkdown(): string {
  const where: Readonly<Record<ShortcutContext, string>> = { normal: 'anywhere', tile: 'on the tile grid', 'popup-term': 'on the popup terminal', overlay: 'with a popup open' };
  const lines = ['# els keyboard shortcuts', '', 'Press **ctrl+b**, then the key. Inside els, **ctrl+b ?** shows this list.', ''];
  for (const section of shortcutSections('normal')) {
    lines.push(`## ${section.group}`, '', '| Keys | What it does | Where |', '|---|---|---|');
    for (const one of section.rows) {
      const chord = one.chord.replace(/\|/g, '\\|');
      lines.push(`| ${chord.includes('`') ? `\`\` ${chord} \`\`` : `\`${chord}\``} | ${one.label} | ${where[one.context]} |`);   // a backtick chord needs a double fence
    }
    lines.push('');
  }
  return lines.join('\n');
}
