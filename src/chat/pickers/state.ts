// KX2-a — Shared picker state machine for chat.ts.
//
// Before this module, textInput() in chat.ts carried the full slash /
// arg / @-mention picker logic inline: ~217 LOC of state (cursor,
// nav flags, caches), async fetch helpers, and key dispatch. That
// coupled the picker to the readKey loop and made it impossible to
// drive the picker through coordinator.routeKey — which is KX2's
// end goal.
//
// This file hoists everything except the buffer mutation. The buffer
// stays where it belongs (lines[] + lineIdx + colIdx in textInput).
// The state machine:
//   - owns selection / nav-guard / fetch caches
//   - reads the buffer (by snapshot) to detect mode + arg/at context
//   - returns a BufferAction when a keystroke causes a buffer change,
//     letting the caller apply it on its own terms (splice text or
//     submit the whole line)
//
// chat.ts keeps its readKey loop; after the KX2-d hand-off it calls
// state.dispatch(key, buf) and applies the returned action.

import type { Key } from '../../tui.js';
import type {
  SlashCommand,
  ArgSuggestion,
  AtCandidate,
  SkillCandidate,
  GetArgSuggestions,
  GetSkillCandidates,
  GetAtCandidates,
  OnAtPick,
  OnAtFolderAttach,
} from '../index.js';
import { filterSlashCommands } from '../index.js';
import { filterInputMatches } from '../../input/query-match.js';

/** Read-only snapshot of the textInput buffer handed to state on
 *  every public call. The state machine never mutates it; it only
 *  produces BufferActions for the caller to apply. */
export interface PickerBufferView {
  readonly lines: string[];
  readonly lineIdx: number;
  readonly colIdx: number;
}

/** Host wiring. `commands` is the static slash-command catalogue
 *  textInput currently carries; the host-provided async sources
 *  match the existing chat.ts callbacks 1:1. */
export interface PickerDeps {
  commands: SlashCommand[];
  getArgSuggestions?: GetArgSuggestions;
  getSkillCandidates?: GetSkillCandidates;
  onAtCandidates?: GetAtCandidates;
  onAtPick?: OnAtPick;
  /** Arc C · v2 — Ctrl+I on a folder in the `@` picker escalates to
   *  an explicit attachment gesture. Host opens the folder picker
   *  modal, returns the attachment token text after the user picks
   *  a file inside. Optional — without this the Ctrl+I path falls
   *  through to plain Enter behavior (plain `@<label>/ ` splice). */
  onAtFolderAttach?: OnAtFolderAttach;
}

export type PickerMode = 'slash' | 'arg' | 'at' | 'skill' | null;

/** Buffer mutation produced by a picker keystroke. `splice` covers
 *  prefix rewrites (Tab autofill, @-tag insert) and `submit` covers
 *  Enter-on-navigated-selection — the picker decides the final line
 *  text and hands it off instead of the caller re-deriving it. */
export type BufferAction =
  | {
      kind: 'splice';
      lineIdx: number;
      start: number;
      end: number;
      text: string;
      newColIdx: number;
    }
  | { kind: 'submit'; text: string };

/** Dispatch outcome. `consumed:false` means the picker didn't care
 *  about the keystroke — caller falls through to textInput's other
 *  handlers. `consumed:true` with a null action means the picker
 *  handled it without touching the buffer (cursor nav, empty-list
 *  guard, etc.). */
export type DispatchResult =
  | { consumed: false }
  | { consumed: true; action: BufferAction | null };

/** Parsed arg-mode context. Exported so tests / callers can share
 *  the same derivation without re-parsing. */
export interface ArgContext {
  cmd: SlashCommand;
  priorArgs: string[];
  currentArg: string;
  currentArgStart: number;
}

/** Parsed @-mode context. `prefixStart` points at the `@` character
 *  itself, so callers can replace `@<prefix>` in one splice. */
export interface AtContext {
  prefix: string;
  prefixStart: number;
}

export interface SkillContext {
  prefix: string;
  prefixStart: number;
}

// ── Pure helpers (exported for tests) ──────────────────────────────

/** Slash-mode: line0 starts with `/`, no space, single-line input.
 *  Matches the original chat.ts `isSlashMode()`. */
export function isSlashMode(buf: PickerBufferView): boolean {
  if (buf.lineIdx !== 0 || buf.lines.length !== 1) return false;
  const text = buf.lines[0] ?? '';
  return text.startsWith('/') && !text.includes(' ');
}

/** Arg-mode: line0 = `/cmd <args...>`, command resolves against the
 *  catalogue. `currentArg` is the word under the cursor's right
 *  edge (trailing space → empty). */
export function parseArgContext(
  buf: PickerBufferView,
  commands: SlashCommand[],
): ArgContext | null {
  if (buf.lineIdx !== 0 || buf.lines.length !== 1) return null;
  const text = buf.lines[0] ?? '';
  if (!text.startsWith('/') || !text.includes(' ')) return null;
  const body = text.slice(1);
  const firstSpace = body.indexOf(' ');
  const cmdName = body.slice(0, firstSpace).toLowerCase();
  const cmd = commands.find((c) => c.name === cmdName || c.aliases?.includes(cmdName));
  if (!cmd) return null;
  const argsStr = body.slice(firstSpace + 1);
  const tokens = argsStr.split(/\s+/);
  if (argsStr.endsWith(' ')) tokens.push('');
  const currentArg = tokens[tokens.length - 1] || '';
  const priorArgs = tokens.slice(0, -1);
  const currentArgStart = text.length - currentArg.length;
  return { cmd, priorArgs, currentArg, currentArgStart };
}

/** At-mode: regex match of `@<prefix>` immediately before the cursor
 *  on the current line, with a whitespace boundary or line start
 *  before the `@`. Mirrors the original `HAS_AT_RE` pattern. */
const HAS_AT_RE = /(?:^|\s)@([\p{L}\p{N}_./~\-]*)$/u;
export function parseAtContext(buf: PickerBufferView): AtContext | null {
  const line = buf.lines[buf.lineIdx] ?? '';
  const head = line.slice(0, buf.colIdx);
  const m = head.match(HAS_AT_RE);
  if (!m) return null;
  const prefix = m[1] ?? '';
  const prefixStart = head.length - prefix.length - 1;
  return { prefix, prefixStart };
}

/** Skill-mode: line0 starts with `$`, has no spaces, and the cursor is
 *  on that first line. Accepting a selection rewrites the buffer to the
 *  existing `/run-skill <name> ` slash contract. */
export function parseSkillContext(buf: PickerBufferView): SkillContext | null {
  if (buf.lineIdx !== 0 || buf.lines.length !== 1) return null;
  const text = buf.lines[0] ?? '';
  if (!text.startsWith('$') || /\s/.test(text)) return null;
  return { prefix: text.slice(1), prefixStart: 0 };
}

// ── State machine ──────────────────────────────────────────────────

/** Opaque handle the caller keeps across loop iterations. All mutation
 *  happens through the methods below — state is never exposed
 *  directly (use `_snapshot()` for tests). */
export interface PickerState {
  /** Recompute async item lists for the current buffer. Resets the
   *  cursor / nav-guard when the context changed. Safe to call on
   *  every loop tick — internal caches dedupe identical queries. */
  refresh(buf: PickerBufferView): Promise<void>;

  /** Cheap mode check. Doesn't await. Used by callers to decide
   *  which paint function to call. */
  mode(buf: PickerBufferView): PickerMode;

  /** Sync dispatch of a keystroke. When an @-pick resolves through
   *  onAtPick (async), the promise awaits that resolution before
   *  returning the resulting splice action. */
  dispatch(key: Key, buf: PickerBufferView): Promise<DispatchResult>;

  /** Notify the state that the buffer changed under its feet
   *  (typing, backspace, history nav). Clears the nav-guard so an
   *  untouched picker can't accept a stale selection. */
  onBufferEdit(): void;

  /** F-E — mouse row click equivalent of "↑↓ to cursor + Enter".
   *  Sets the internal cursor to `idx`, arms the nav-guard so the
   *  current mode's dispatchSlash/Arg/At treats the selection as
   *  intentional, then dispatches a synthetic Enter so the submit
   *  path produces the same DispatchResult that keyboard Enter
   *  would. Idempotent when `idx` is already the current cursor.
   *  Returns the DispatchResult the caller (chat.ts onRowClick
   *  wrapper) feeds through its splice/submit handler. */
  submitAt(idx: number, buf: PickerBufferView): Promise<DispatchResult>;

  // ── render-time accessors ────────────────────────────────────────
  slashFiltered(buf: PickerBufferView): SlashCommand[];
  argItems(): ArgSuggestion[];
  atItems(): AtCandidate[];
  skillItems(): SkillCandidate[];
  selectedIdx(): number;

  /** Test-only: structured view of internal state. */
  _snapshot(): {
    cmdPickerIdx: number;
    pickerNavigated: boolean;
    atPickerNavigated: boolean;
    lastAtKey: string;
    argCacheKey: string;
      atCacheKey: string;
      skillCacheKey: string;
      argItemsLen: number;
      atItemsLen: number;
      skillItemsLen: number;
    };
}

export function createPickerState(deps: PickerDeps): PickerState {
  let cmdPickerIdx = 0;
  let pickerNavigated = false;
  let atPickerNavigated = false;
  let lastAtKey = '__off__';
  let argCache: { key: string; items: ArgSuggestion[] } = { key: '', items: [] };
  let atCache: { key: string; items: AtCandidate[] } = { key: '__uninitialized__', items: [] };
  let skillCache: { key: string; items: SkillCandidate[] } = { key: '__uninitialized__', items: [] };
  let currentArgItems: ArgSuggestion[] = [];
  let currentAtItems: AtCandidate[] = [];
  let currentSkillItems: SkillCandidate[] = [];

  const filteredSlash = (buf: PickerBufferView): SlashCommand[] =>
    filterSlashCommands((buf.lines[0] ?? '').slice(1), deps.commands);

  const refreshArgs = async (buf: PickerBufferView): Promise<ArgSuggestion[]> => {
    const ctx = parseArgContext(buf, deps.commands);
    if (!ctx) return [];
    const cacheKey = `${ctx.cmd.name}|${ctx.priorArgs.join(',')}`;
    if (argCache.key !== cacheKey) {
      const items: ArgSuggestion[] = [];
      if (ctx.priorArgs.length === 0 && ctx.cmd.subcommands) {
        items.push(...ctx.cmd.subcommands.map((s) => ({ value: s })));
      }
      if (deps.getArgSuggestions) {
        try {
          const dyn = await deps.getArgSuggestions(ctx.cmd.name, ctx.priorArgs, ctx.currentArg);
          items.push(...dyn);
        } catch {
          /* swallow — host errors shouldn't wedge the picker */
        }
      }
      argCache = { key: cacheKey, items };
    }
    return filterInputMatches(argCache.items, ctx.currentArg, (i) => i.value, 'prefix');
  };

  const refreshAt = async (buf: PickerBufferView): Promise<AtCandidate[]> => {
    const ctx = parseAtContext(buf);
    if (!ctx || !deps.onAtCandidates) return [];
    if (atCache.key === ctx.prefix) return atCache.items;
    let items: AtCandidate[] = [];
    try {
      items = await deps.onAtCandidates(ctx.prefix);
    } catch {
      items = [];
    }
    atCache = { key: ctx.prefix, items };
    return items;
  };

  const refreshSkills = async (buf: PickerBufferView): Promise<SkillCandidate[]> => {
    const ctx = parseSkillContext(buf);
    if (!ctx || !deps.getSkillCandidates) return [];
    if (skillCache.key === ctx.prefix) return skillCache.items;
    let items: SkillCandidate[] = [];
    try {
      items = await deps.getSkillCandidates(ctx.prefix);
    } catch {
      items = [];
    }
    skillCache = { key: ctx.prefix, items };
    return items;
  };

  const refresh = async (buf: PickerBufferView): Promise<void> => {
    const isAt = parseAtContext(buf) !== null;
    const isSkill = !isAt && parseSkillContext(buf) !== null;
    const isSlash = !isAt && !isSkill && isSlashMode(buf);
    const isArg = !isAt && !isSkill && !isSlash && parseArgContext(buf, deps.commands) !== null;

    if (isArg) {
      currentArgItems = await refreshArgs(buf);
    } else {
      currentArgItems = [];
    }
    if (isAt) {
      currentAtItems = await refreshAt(buf);
      // Prefix changed since last refresh → reset cursor + nav so a
      // fresh pick requires a fresh gesture.
      if (lastAtKey !== atCache.key) {
        cmdPickerIdx = 0;
        atPickerNavigated = false;
        lastAtKey = atCache.key;
      }
    } else {
      currentAtItems = [];
      lastAtKey = '__off__';
    }
    if (isSkill) {
      currentSkillItems = await refreshSkills(buf);
    } else {
      currentSkillItems = [];
      skillCache = { key: '__off__', items: skillCache.items };
    }
    // Clamp cursor for the picker that's actually active.
    if (isAt) {
      const n = currentAtItems.length;
      if (n === 0) cmdPickerIdx = 0;
      else if (cmdPickerIdx >= n) cmdPickerIdx = n - 1;
      else if (cmdPickerIdx < 0) cmdPickerIdx = 0;
    } else if (isArg) {
      const n = currentArgItems.length;
      if (n === 0) cmdPickerIdx = 0;
      else if (cmdPickerIdx >= n) cmdPickerIdx = n - 1;
      else if (cmdPickerIdx < 0) cmdPickerIdx = 0;
    } else if (isSlash) {
      const n = filteredSlash(buf).length;
      if (n === 0) cmdPickerIdx = 0;
      else if (cmdPickerIdx >= n) cmdPickerIdx = n - 1;
      else if (cmdPickerIdx < 0) cmdPickerIdx = 0;
    } else if (isSkill) {
      const n = currentSkillItems.length;
      if (n === 0) cmdPickerIdx = 0;
      else if (cmdPickerIdx >= n) cmdPickerIdx = n - 1;
      else if (cmdPickerIdx < 0) cmdPickerIdx = 0;
    }
  };

  const mode = (buf: PickerBufferView): PickerMode => {
    if (parseAtContext(buf) !== null) return 'at';
    if (parseSkillContext(buf) !== null) return 'skill';
    if (isSlashMode(buf)) return 'slash';
    if (parseArgContext(buf, deps.commands) !== null) return 'arg';
    return null;
  };

  const dispatchSkill = (key: Key, buf: PickerBufferView): DispatchResult => {
    if (currentSkillItems.length === 0) return { consumed: false };
    const ctx = parseSkillContext(buf);
    if (!ctx) return { consumed: false };

    if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
      cmdPickerIdx = (cmdPickerIdx - 1 + currentSkillItems.length) % currentSkillItems.length;
      pickerNavigated = true;
      return { consumed: true, action: null };
    }
    if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
      cmdPickerIdx = (cmdPickerIdx + 1) % currentSkillItems.length;
      pickerNavigated = true;
      return { consumed: true, action: null };
    }
    if ((key.name === 'tab') || (key.name === 'enter' && !key.shift)) {
      const selected = currentSkillItems[cmdPickerIdx];
      if (!selected) return { consumed: true, action: null };
      const exactMatch = ctx.prefix.toLowerCase() === selected.name.toLowerCase();
      if (key.name === 'tab' || pickerNavigated || exactMatch) {
        const text = `/run-skill ${selected.name} `;
        skillCache = { key: '', items: [] };
        return {
          consumed: true,
          action: {
            kind: 'splice',
            lineIdx: 0,
            start: 0,
            end: (buf.lines[0] ?? '').length,
            text,
            newColIdx: text.length,
          },
        };
      }
      const text = `$${selected.name}`;
      return {
        consumed: true,
        action: {
          kind: 'splice',
          lineIdx: 0,
          start: 0,
          end: (buf.lines[0] ?? '').length,
          text,
          newColIdx: text.length,
        },
      };
    }
    return { consumed: false };
  };

  const dispatchAt = async (key: Key, buf: PickerBufferView): Promise<DispatchResult> => {
    if (currentAtItems.length === 0) return { consumed: false };
    const ctx = parseAtContext(buf)!;
    const items = currentAtItems;

    if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
      cmdPickerIdx = (cmdPickerIdx - 1 + items.length) % items.length;
      atPickerNavigated = true;
      return { consumed: true, action: null };
    }
    if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
      cmdPickerIdx = (cmdPickerIdx + 1) % items.length;
      atPickerNavigated = true;
      return { consumed: true, action: null };
    }
    if (key.name === 'tab') {
      const sel = items[cmdPickerIdx];
      if (!sel) return { consumed: true, action: null };
      if (sel.isDir) {
        // Descend: splice `@<label>` in place of `@<prefix>` and
        // invalidate the fetch cache so the next refresh sees the
        // new directory content. Caller triggers refresh on its
        // own redraw tick.
        const insert = `@${sel.label}`;
        const line = buf.lines[buf.lineIdx] ?? '';
        const endCol = buf.colIdx;
        const newCol = ctx.prefixStart + insert.length;
        atCache = { key: '', items: [] };
        atPickerNavigated = true;
        return {
          consumed: true,
          action: {
            kind: 'splice',
            lineIdx: buf.lineIdx,
            start: ctx.prefixStart,
            end: endCol,
            text: insert,
            newColIdx: newCol,
          },
        };
      }
      // File: resolve through onAtPick → splice token in place.
      let inserted = sel.absPath;
      if (deps.onAtPick) {
        try {
          inserted = await deps.onAtPick(sel.absPath);
        } catch {
          inserted = sel.absPath;
        }
      }
      const endCol = buf.colIdx;
      const newCol = ctx.prefixStart + inserted.length;
      atCache = { key: '', items: [] };
      atPickerNavigated = false;
      // Suppress the side-effect of `line` eslint warn — we don't use it.
      void (buf.lines[buf.lineIdx] ?? '');
      return {
        consumed: true,
        action: {
          kind: 'splice',
          lineIdx: buf.lineIdx,
          start: ctx.prefixStart,
          end: endCol,
          text: inserted,
          newColIdx: newCol,
        },
      };
    }
    if (key.name === 'enter' && !key.shift) {
      const sel = items[cmdPickerIdx];
      // TUI 부활 T4 (2026-07-12) — codex 패리티: file popup 이 떠 있고
      // 후보가 포커스돼 있으면 Enter 는 **항상 그 후보를 선택**한다
      // (ref codex-rs chat_composer.rs handle_key_event_with_file_popup:
      // Tab|Enter → selected_match 있으면 무조건 삽입 · 없을 때만 submit
      // 폴백). 종전의 `atPickerNavigated || exactMatch` 게이트는 중간
      // 타이핑 + Enter 가 그대로 전체 라인 submit 으로 새는 원인이었다
      // (dogfood 발견). 후보를 무시하고 literal 로 보내려면 Esc 로 픽커를
      // 닫고 Enter — codex/claude-code 와 동일한 계약.
      if (sel) {
        if (sel.isDir) {
          // Arc C · v2 — Enter on folder is the "plain reference"
          // path: splice `@<label> ` (trailing space) as plain text.
          // The trailing space breaks the at-regex at the cursor
          // position, so the picker auto-exits — no modal, no host
          // callback, no registry entry. Users who want to actually
          // attach a file from inside the folder use Ctrl+I (below)
          // or the wd-browser double-click path.
          const insert = `@${sel.label} `;
          const endCol = buf.colIdx;
          const newCol = ctx.prefixStart + insert.length;
          atCache = { key: '', items: [] };
          atPickerNavigated = false;
          return {
            consumed: true,
            action: {
              kind: 'splice',
              lineIdx: buf.lineIdx,
              start: ctx.prefixStart,
              end: endCol,
              text: insert,
              newColIdx: newCol,
            },
          };
        }
        let inserted = sel.absPath;
        if (deps.onAtPick) {
          try {
            inserted = await deps.onAtPick(sel.absPath);
          } catch {
            inserted = sel.absPath;
          }
        }
        const endCol = buf.colIdx;
        const newCol = ctx.prefixStart + inserted.length;
        atCache = { key: '', items: [] };
        atPickerNavigated = false;
        return {
          consumed: true,
          action: {
            kind: 'splice',
            lineIdx: buf.lineIdx,
            start: ctx.prefixStart,
            end: endCol,
            text: inserted,
            newColIdx: newCol,
          },
        };
      }
      // Not yet pickable — fall through so Enter submits / inserts
      // newline per the regular handlers.
      return { consumed: false };
    }
    // Arc C · v2 — Ctrl+I: explicit "attach" escalation. On a folder,
    // delegate to the host's onAtFolderAttach (typically opens a
    // modal picker over the folder contents and attaches the chosen
    // file). On a file, behave as if the user had pressed Enter
    // (onAtPick path), so Ctrl+I is a consistent "always attach"
    // shortcut regardless of the row kind. Without the host callback
    // wired the Ctrl+I path falls back to plain Enter behavior.
    //
    // ASCII caveat: Ctrl+I is 0x09 / Tab on terminals without the
    // kitty keyboard protocol. chat.ts enables kitty (`\x1b[>1u`),
    // so modern terminals (iTerm2 / Kitty / Wezterm / Contour /
    // Ghostty) distinguish them; older terminals degrade the chord
    // to Tab (descend). Accepted for v1.
    if (key.ctrl && (key.name === 'i' || key.name === 'I')) {
      const sel = items[cmdPickerIdx];
      if (!sel) return { consumed: true, action: null };
      if (sel.isDir) {
        if (!deps.onAtFolderAttach) {
          // No host callback — fall through to plain-Enter folder
          // behavior (plain reference splice) so the gesture still
          // does something predictable.
          const insert = `@${sel.label} `;
          const endCol = buf.colIdx;
          const newCol = ctx.prefixStart + insert.length;
          atCache = { key: '', items: [] };
          atPickerNavigated = false;
          return {
            consumed: true,
            action: {
              kind: 'splice',
              lineIdx: buf.lineIdx,
              start: ctx.prefixStart,
              end: endCol,
              text: insert,
              newColIdx: newCol,
            },
          };
        }
        let inserted = '';
        try {
          inserted = await deps.onAtFolderAttach(sel.absPath);
        } catch {
          inserted = '';
        }
        if (!inserted) {
          // Host cancelled (empty result) — leave buffer intact.
          // Picker stays open; user can Esc out.
          return { consumed: true, action: null };
        }
        const endCol = buf.colIdx;
        const newCol = ctx.prefixStart + inserted.length;
        atCache = { key: '', items: [] };
        atPickerNavigated = false;
        return {
          consumed: true,
          action: {
            kind: 'splice',
            lineIdx: buf.lineIdx,
            start: ctx.prefixStart,
            end: endCol,
            text: inserted,
            newColIdx: newCol,
          },
        };
      }
      // File: Ctrl+I aliases to Enter → onAtPick path.
      let inserted = sel.absPath;
      if (deps.onAtPick) {
        try {
          inserted = await deps.onAtPick(sel.absPath);
        } catch {
          inserted = sel.absPath;
        }
      }
      const endCol = buf.colIdx;
      const newCol = ctx.prefixStart + inserted.length;
      atCache = { key: '', items: [] };
      atPickerNavigated = false;
      return {
        consumed: true,
        action: {
          kind: 'splice',
          lineIdx: buf.lineIdx,
          start: ctx.prefixStart,
          end: endCol,
          text: inserted,
          newColIdx: newCol,
        },
      };
    }
    return { consumed: false };
  };

  const dispatchArg = (key: Key, buf: PickerBufferView): DispatchResult => {
    if (currentArgItems.length === 0) return { consumed: false };

    if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
      cmdPickerIdx = (cmdPickerIdx - 1 + currentArgItems.length) % currentArgItems.length;
      pickerNavigated = true;
      return { consumed: true, action: null };
    }
    if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
      cmdPickerIdx = (cmdPickerIdx + 1) % currentArgItems.length;
      pickerNavigated = true;
      return { consumed: true, action: null };
    }
    if (key.name === 'tab') {
      const selected = currentArgItems[cmdPickerIdx];
      const ctx = parseArgContext(buf, deps.commands);
      if (selected && ctx) {
        const newLine0 = (buf.lines[0] ?? '').slice(0, ctx.currentArgStart) + selected.value;
        cmdPickerIdx = 0;
        argCache = { key: '', items: [] };
        return {
          consumed: true,
          action: {
            kind: 'splice',
            lineIdx: 0,
            start: 0,
            end: (buf.lines[0] ?? '').length,
            text: newLine0,
            newColIdx: newLine0.length,
          },
        };
      }
      return { consumed: true, action: null };
    }
    if (key.name === 'enter' && !key.shift) {
      const ctx = parseArgContext(buf, deps.commands);
      const selected = currentArgItems[cmdPickerIdx];
      let submitText = buf.lines[0] ?? '';
      if (ctx && ctx.currentArg === '' && selected && pickerNavigated) {
        submitText = submitText.slice(0, ctx.currentArgStart) + selected.value;
      }
      return {
        consumed: true,
        action: { kind: 'submit', text: submitText.trim() },
      };
    }
    return { consumed: false };
  };

  const dispatchSlash = (key: Key, buf: PickerBufferView): DispatchResult => {
    const filtered = filteredSlash(buf);
    if (filtered.length === 0) return { consumed: false };

    if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
      cmdPickerIdx = (cmdPickerIdx - 1 + filtered.length) % filtered.length;
      pickerNavigated = true;
      return { consumed: true, action: null };
    }
    if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
      cmdPickerIdx = (cmdPickerIdx + 1) % filtered.length;
      pickerNavigated = true;
      return { consumed: true, action: null };
    }
    if (key.name === 'tab') {
      const selected = filtered[cmdPickerIdx];
      if (selected) {
        const newLine0 = '/' + selected.name;
        cmdPickerIdx = 0;
        pickerNavigated = true;
        return {
          consumed: true,
          action: {
            kind: 'splice',
            lineIdx: 0,
            start: 0,
            end: (buf.lines[0] ?? '').length,
            text: newLine0,
            newColIdx: newLine0.length,
          },
        };
      }
      return { consumed: true, action: null };
    }
    if (key.name === 'enter' && !key.shift) {
      const selected = filtered[cmdPickerIdx];
      return {
        consumed: true,
        action: {
          kind: 'submit',
          text: pickerNavigated && selected ? '/' + selected.name : (buf.lines[0] ?? ''),
        },
      };
    }
    return { consumed: false };
  };

  const dispatch = async (key: Key, buf: PickerBufferView): Promise<DispatchResult> => {
    const m = mode(buf);
    if (m === 'at') return dispatchAt(key, buf);
    if (m === 'skill') return dispatchSkill(key, buf);
    if (m === 'arg') return dispatchArg(key, buf);
    if (m === 'slash') return dispatchSlash(key, buf);
    return { consumed: false };
  };

  const onBufferEdit = (): void => {
    cmdPickerIdx = 0;
    pickerNavigated = false;
    // at-picker nav flag is gated on lastAtKey → atCache.key drift,
    // which refresh() already handles; no extra reset here.
  };

  // F-E — mouse row click dispatch. Set cursor + arm nav-guard +
  // dispatch Enter. Arm BOTH pickerNavigated (slash/arg dispatchers
  // check this) and atPickerNavigated (at dispatcher has its own
  // flag) so whichever mode is live accepts the submit.
  const submitAt = async (idx: number, buf: PickerBufferView): Promise<DispatchResult> => {
    cmdPickerIdx = idx;
    pickerNavigated = true;
    atPickerNavigated = true;
    return dispatch({ name: 'enter' } as Key, buf);
  };

  return {
    refresh,
    mode,
    dispatch,
    onBufferEdit,
    submitAt,
    slashFiltered: filteredSlash,
    argItems: () => currentArgItems,
    atItems: () => currentAtItems,
    skillItems: () => currentSkillItems,
    selectedIdx: () => cmdPickerIdx,
    _snapshot: () => ({
      cmdPickerIdx,
      pickerNavigated,
      atPickerNavigated,
      lastAtKey,
      argCacheKey: argCache.key,
      atCacheKey: atCache.key,
      skillCacheKey: skillCache.key,
      argItemsLen: currentArgItems.length,
      atItemsLen: currentAtItems.length,
      skillItemsLen: currentSkillItems.length,
    }),
  };
}
