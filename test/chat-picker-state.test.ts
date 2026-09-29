// KX2-a — chat-picker-state unit tests.
//
// Covers the shared state machine extracted from chat.ts:
// mode detection, refresh cache/reset, and dispatch paths for the
// slash / arg / at pickers. Buffer mutations are verified through
// the returned BufferAction.

import { describe, expect, test } from 'bun:test';
import {
  createPickerState,
  isSlashMode,
  parseArgContext,
  parseAtContext,
  parseSkillContext,
  type PickerBufferView,
  type BufferAction,
} from '../src/chat/pickers/state.js';
import type { SlashCommand, AtCandidate } from '../src/chat/index.js';
import type { Key } from '../src/tui.js';

const cmds: SlashCommand[] = [
  { name: 'help',   aliases: ['?'], description: 'Show help' },
  { name: 'quit',   aliases: ['q', 'exit'], description: 'Exit' },
  { name: 'clear',  aliases: ['cls'], description: 'Clear log' },
  { name: 'plugin', aliases: [], description: 'Plugins', subcommands: ['list', 'activate'] },
];

function buf(text: string, colIdx?: number): PickerBufferView {
  return {
    lines: [text],
    lineIdx: 0,
    colIdx: colIdx ?? text.length,
  };
}

function key(name: string, extra: Partial<Key> = {}): Key {
  return { name, ctrl: false, shift: false, ...extra };
}

// ── pure helpers ───────────────────────────────────────────────────

describe('isSlashMode', () => {
  test('true when line starts with / and has no space', () => {
    expect(isSlashMode(buf('/he'))).toBe(true);
    expect(isSlashMode(buf('/'))).toBe(true);
  });

  test('false once a space appears', () => {
    expect(isSlashMode(buf('/plugin '))).toBe(false);
    expect(isSlashMode(buf('plain text'))).toBe(false);
  });
});

describe('parseArgContext', () => {
  test('parses cmd + priorArgs + currentArg', () => {
    const ctx = parseArgContext(buf('/plugin en'), cmds);
    expect(ctx).not.toBeNull();
    expect(ctx!.cmd.name).toBe('plugin');
    expect(ctx!.priorArgs).toEqual([]);
    expect(ctx!.currentArg).toBe('en');
    expect(ctx!.currentArgStart).toBe('/plugin '.length);
  });

  test('returns null for unknown command', () => {
    expect(parseArgContext(buf('/nope foo'), cmds)).toBeNull();
  });

  test('trailing space → empty currentArg (mirrors chat.ts token split)', () => {
    const ctx = parseArgContext(buf('/plugin list '), cmds);
    expect(ctx!.currentArg).toBe('');
    // chat.ts original: tokens from /\s+/ on 'list ' = ['list',''] then push('')
    // → slice(0,-1) = ['list', '']. Preserve the exact behaviour.
    expect(ctx!.priorArgs).toEqual(['list', '']);
  });
});

describe('parseAtContext', () => {
  test('matches @ at line start', () => {
    const ctx = parseAtContext(buf('@src/'));
    expect(ctx).toEqual({ prefix: 'src/', prefixStart: 0 });
  });

  test('matches @ after whitespace', () => {
    const ctx = parseAtContext(buf('hey @foo'));
    expect(ctx).toEqual({ prefix: 'foo', prefixStart: 4 });
  });

  test('does not match non-boundary @', () => {
    expect(parseAtContext(buf('email@example'))).toBeNull();
  });
});

describe('parseSkillContext', () => {
  test('matches single-line $ prefix at line start', () => {
    expect(parseSkillContext(buf('$omni'))).toEqual({ prefix: 'omni', prefixStart: 0 });
  });

  test('stops matching after whitespace appears', () => {
    expect(parseSkillContext(buf('$omni digest'))).toBeNull();
  });
});

// ── state machine: mode ─────────────────────────────────────────────

describe('createPickerState.mode', () => {
  test('reports null/slash/arg/at based on buffer', () => {
    const s = createPickerState({ commands: cmds });
    expect(s.mode(buf(''))).toBeNull();
    expect(s.mode(buf('/he'))).toBe('slash');
    expect(s.mode(buf('/plugin list'))).toBe('arg');
    expect(s.mode(buf('@foo'))).toBe('at');
    expect(s.mode(buf('$omni'))).toBe('skill');
  });
});

// ── slash picker ───────────────────────────────────────────────────

describe('dispatch slash', () => {
  test('down navigates cursor + sets pickerNavigated', async () => {
    const s = createPickerState({ commands: cmds });
    await s.refresh(buf('/h'));
    expect(s.selectedIdx()).toBe(0);
    const r = await s.dispatch(key('down'), buf('/h'));
    expect(r).toEqual({ consumed: true, action: null });
    expect(s.selectedIdx()).toBe(1 % s.slashFiltered(buf('/h')).length);
    expect(s._snapshot().pickerNavigated).toBe(true);
  });

  test('Tab autofills to /name via splice action', async () => {
    const s = createPickerState({ commands: cmds });
    const b = buf('/he');
    await s.refresh(b);
    const r = await s.dispatch(key('tab'), b);
    expect(r.consumed).toBe(true);
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action.kind).toBe('splice');
    expect((action as { text: string }).text).toBe('/help');
  });

  test('Enter on navigated selection submits', async () => {
    const s = createPickerState({ commands: cmds });
    const b = buf('/h');
    await s.refresh(b);
    await s.dispatch(key('down'), b);                  // navigate away then back
    await s.dispatch(key('up'),   b);
    const r = await s.dispatch(key('enter'), b);
    expect(r.consumed).toBe(true);
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action.kind).toBe('submit');
    expect((action as { text: string }).text.startsWith('/')).toBe(true);
  });

  test('Enter without navigation + non-exact match submits the typed slash unchanged', async () => {
    const s = createPickerState({ commands: cmds });
    const b = buf('/h');
    await s.refresh(b);
    const r = await s.dispatch(key('enter'), b);
    expect(r.consumed).toBe(true);
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action).toEqual({ kind: 'submit', text: '/h' });
  });

  test('Enter on exact typed name submits even without nav', async () => {
    const s = createPickerState({ commands: cmds });
    const b = buf('/help');
    await s.refresh(b);
    const r = await s.dispatch(key('enter'), b);
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action.kind).toBe('submit');
    expect((action as { text: string }).text).toBe('/help');
  });
});

// ── arg picker ─────────────────────────────────────────────────────

describe('dispatch arg', () => {
  test('Tab autofills the selected subcommand via splice', async () => {
    const s = createPickerState({ commands: cmds });
    const b = buf('/plugin ac');
    await s.refresh(b);
    expect(s.argItems().map((i) => i.value)).toContain('activate');
    // navigate to 'activate' if needed (first filtered item after prefix-filter is 'activate')
    const r = await s.dispatch(key('tab'), b);
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action.kind).toBe('splice');
    expect((action as { text: string }).text).toBe('/plugin activate');
  });

  test('Enter on empty currentArg only selects a subcommand after navigation', async () => {
    const s = createPickerState({ commands: cmds });
    const b = buf('/plugin ');
    await s.refresh(b);
    const r = await s.dispatch(key('enter'), b);
    expect((r as { consumed: true; action: BufferAction }).action).toEqual({ kind: 'submit', text: '/plugin' });

    await s.dispatch(key('down'), b);
    await s.dispatch(key('up'), b);
    const selected = await s.dispatch(key('enter'), b);
    expect((selected as { consumed: true; action: BufferAction }).action).toEqual({ kind: 'submit', text: '/plugin list' });
  });

  test('sequential refreshes narrow currentArg prefix filter in place', async () => {
    // Regression for debug-arc-a #2: typing `/plugin l` used to show
    // all four subcommands because chat.ts's drawAll called
    // picker.argItems() WITHOUT re-running refresh after the typing
    // fallthrough mutated the buffer, so the modal painted from the
    // previous iteration's cache. The fix adds an explicit
    // `await picker.refresh(bufView())` before drawAll; this test
    // locks in the picker-state contract that feeds that fix — every
    // refresh recomputes the filter against the current buffer's
    // currentArg. Without the contract holding, the chat.ts fix would
    // silently regress again.
    const s = createPickerState({ commands: cmds });

    await s.refresh(buf('/plugin '));
    expect(s.argItems().map((i) => i.value).sort()).toEqual(['activate', 'list']);

    await s.refresh(buf('/plugin l'));
    expect(s.argItems().map((i) => i.value)).toEqual(['list']);

    await s.refresh(buf('/plugin a'));
    expect(s.argItems().map((i) => i.value)).toEqual(['activate']);

    // cursor stays within the filtered range even when the shrink
    // brings the effective list below the previous cursor index.
    await s.refresh(buf('/plugin '));
    await s.dispatch(key('down'), buf('/plugin '));
    expect(s.selectedIdx()).toBe(1);
    await s.refresh(buf('/plugin a'));
    expect(s.selectedIdx()).toBe(0);
  });
});

// ── at picker ──────────────────────────────────────────────────────

const atCandidates: AtCandidate[] = [
  { label: 'src/',        absPath: '/abs/src',        isDir: true  },
  { label: 'README.md',   absPath: '/abs/README.md',  isDir: false },
];

describe('dispatch at', () => {
  test('`@` alone fetches default candidates and down wraps', async () => {
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async () => atCandidates,
    });
    const b = buf('@', 1);
    await s.refresh(b);
    expect(s.atItems().length).toBe(2);
    const r = await s.dispatch(key('down'), b);
    expect(r).toEqual({ consumed: true, action: null });
    expect(s.selectedIdx()).toBe(1);
    expect(s._snapshot().atPickerNavigated).toBe(true);
  });

  test('empty @-prefix still caches after the first fetch', async () => {
    let calls = 0;
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async () => {
        calls++;
        return atCandidates;
      },
    });
    const b = buf('@', 1);
    await s.refresh(b);
    await s.refresh(b);
    expect(calls).toBe(1);
    expect(s.atItems().map((item) => item.label)).toEqual(['src/', 'README.md']);
  });

  test('Tab on dir produces @<label> splice and invalidates cache', async () => {
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async () => atCandidates,
    });
    const b = buf('@s', 2);
    await s.refresh(b);
    const r = await s.dispatch(key('tab'), b);
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action.kind).toBe('splice');
    expect((action as { text: string }).text).toBe('@src/');
    // newColIdx = prefixStart + text.length
    expect((action as { newColIdx: number }).newColIdx).toBe(5);
    // cache invalidated so refresh can re-fetch for the new dir
    expect(s._snapshot().atCacheKey).toBe('');
  });

  test('Enter WITHOUT nav mid-typing → 포커스(top) 후보 선택 · submit 으로 새지 않음 (codex 패리티 · TUI 부활 T4)', async () => {
    // Regression (dogfood 2026-07-12): 종전 `atPickerNavigated ||
    // exactMatch` 게이트는 "@RE" 중간 타이핑 + Enter 를 consumed:false
    // 로 흘려 전체 라인이 그대로 submit 됐다. codex ref
    // (chat_composer.rs handle_key_event_with_file_popup) 는 popup 에
    // selected_match 가 있으면 Enter 가 무조건 그 후보를 삽입한다.
    let pickedPath = '';
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async () => atCandidates,
      onAtPick: async (abs: string) => {
        pickedPath = abs;
        return '[File #1]';
      },
    });
    const b = buf('@s', 2);
    await s.refresh(b);
    // NO navigation — 후보 리스트만 뜬 상태에서 곧장 Enter.
    const r = await s.dispatch(key('enter'), b);
    expect((r as { consumed: boolean }).consumed).toBe(true);
    const action = (r as { consumed: true; action: BufferAction }).action;
    // top 후보가 dir(src/)이면 plain reference splice, file 이면 onAtPick
    // splice — 어느 쪽이든 submit 으로 새지 않는 것이 계약.
    expect(action.kind).toBe('splice');
    if ((action as { text: string }).text !== '@src/ ') {
      expect(pickedPath).not.toBe('');
    }
  });

  test('Enter on file after nav → onAtPick resolved text spliced', async () => {
    let pickedPath = '';
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async () => atCandidates,
      onAtPick: async (abs: string) => {
        pickedPath = abs;
        return '[File #1]';
      },
    });
    const b = buf('@RE', 3);
    await s.refresh(b);
    // Navigate to force atPickerNavigated, then the only non-dir
    // candidate is README.md.
    await s.dispatch(key('down'), b);
    const r = await s.dispatch(key('enter'), b);
    expect(pickedPath).toBe('/abs/README.md');
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action.kind).toBe('splice');
    expect((action as { text: string }).text).toBe('[File #1]');
  });

  test('refresh resets cursor + nav when @-prefix changes', async () => {
    let call = 0;
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async () => {
        call++;
        return atCandidates;
      },
    });
    await s.refresh(buf('@s', 2));
    await s.dispatch(key('down'), buf('@s', 2));
    expect(s._snapshot().atPickerNavigated).toBe(true);
    expect(s.selectedIdx()).toBe(1);
    await s.refresh(buf('@src/', 5));
    expect(s._snapshot().atPickerNavigated).toBe(false);
    expect(s.selectedIdx()).toBe(0);
    expect(call).toBeGreaterThanOrEqual(2);
  });

  // ── Arc C · v2 — Enter on folder = plain reference ───────────────
  test('Enter on folder splices plain `@<label> ` (trailing space) — no host callback', async () => {
    // Regression for the v2 split: plain Enter on a folder should
    // produce a plain-text reference, NOT trigger onAtPick or any
    // attach pipeline. The trailing space causes the at-regex to
    // miss at the new cursor, so the picker auto-exits.
    let pickCalled = 0;
    let folderAttachCalled = 0;
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async () => atCandidates,
      onAtPick: async () => { pickCalled++; return '[File #1]'; },
      onAtFolderAttach: async () => { folderAttachCalled++; return '[Folder #1]'; },
    });
    const b = buf('@s', 2);
    await s.refresh(b);
    // 'src/' is at index 0 (dir). Navigate so atPickerNavigated is
    // true — Enter only accepts after explicit navigation unless
    // the prefix exactly matches the label.
    await s.dispatch(key('down'), b);
    await s.dispatch(key('up'), b);
    const r = await s.dispatch(key('enter'), b);
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action.kind).toBe('splice');
    expect((action as { text: string }).text).toBe('@src/ ');
    expect((action as { newColIdx: number }).newColIdx).toBe('@src/ '.length);
    // Neither file nor folder attach callback should fire for plain
    // Enter on a folder — the whole point of the v2 split.
    expect(pickCalled).toBe(0);
    expect(folderAttachCalled).toBe(0);
    // Cache invalidated so a later refresh parses the new buffer.
    expect(s._snapshot().atCacheKey).toBe('');
  });

  // ── Arc C · v2 — Ctrl+I on folder = attachment override ──────────
  test('Ctrl+I on folder calls onAtFolderAttach and splices the returned token', async () => {
    const seen: string[] = [];
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async () => atCandidates,
      onAtFolderAttach: async (abs: string) => {
        seen.push(abs);
        return '[Folder #1] ';
      },
    });
    const b = buf('@s', 2);
    await s.refresh(b);
    const r = await s.dispatch(key('i', { ctrl: true }), b);
    expect(seen).toEqual(['/abs/src']);
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action.kind).toBe('splice');
    expect((action as { text: string }).text).toBe('[Folder #1] ');
  });

  test('Ctrl+I on folder without host callback falls back to plain-Enter splice', async () => {
    // Graceful degradation: if the host didn't wire onAtFolderAttach
    // we still do *something* predictable instead of dropping the
    // keystroke. Same as plain Enter on the folder.
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async () => atCandidates,
    });
    const b = buf('@s', 2);
    await s.refresh(b);
    const r = await s.dispatch(key('i', { ctrl: true }), b);
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action.kind).toBe('splice');
    expect((action as { text: string }).text).toBe('@src/ ');
  });

  test('Ctrl+I on file aliases to Enter — onAtPick path', async () => {
    let pickedAbs = '';
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async () => atCandidates,
      onAtPick: async (abs: string) => {
        pickedAbs = abs;
        return '[File #1]';
      },
    });
    const b = buf('@RE', 3);
    await s.refresh(b);
    await s.dispatch(key('down'), b);   // navigate to README.md (only non-dir)
    const r = await s.dispatch(key('i', { ctrl: true }), b);
    expect(pickedAbs).toBe('/abs/README.md');
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action.kind).toBe('splice');
    expect((action as { text: string }).text).toBe('[File #1]');
  });

  test('Ctrl+I with empty host result leaves the buffer intact (consumed, null action)', async () => {
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async () => atCandidates,
      onAtFolderAttach: async () => '',   // user cancelled in modal
    });
    const b = buf('@s', 2);
    await s.refresh(b);
    const r = await s.dispatch(key('i', { ctrl: true }), b);
    expect(r.consumed).toBe(true);
    expect((r as { consumed: true; action: BufferAction | null }).action).toBeNull();
  });
});

describe('dispatch skill', () => {
  test('$ alone fetches default skill candidates', async () => {
    const s = createPickerState({
      commands: cmds,
      getSkillCandidates: async () => [
        { name: 'omni-digest', description: 'Digest any URL or file' },
        { name: 'ast-grep', description: 'Structural code search' },
      ],
    });
    const b = buf('$', 1);
    await s.refresh(b);
    expect(s.skillItems().map((item) => item.name)).toEqual(['omni-digest', 'ast-grep']);
  });

  test('Enter on exact skill rewrites buffer to /run-skill <name> ', async () => {
    const s = createPickerState({
      commands: cmds,
      getSkillCandidates: async () => [{ name: 'omni-digest', description: 'Digest any URL or file' }],
    });
    const b = buf('$omni-digest');
    await s.refresh(b);
    const r = await s.dispatch(key('enter'), b);
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action.kind).toBe('splice');
    expect((action as { text: string }).text).toBe('/run-skill omni-digest ');
  });

  test('Tab after navigation inserts selected skill into /run-skill prefill', async () => {
    const s = createPickerState({
      commands: cmds,
      getSkillCandidates: async () => [
        { name: 'alpha', description: 'A' },
        { name: 'beta', description: 'B' },
      ],
    });
    const b = buf('$a');
    await s.refresh(b);
    await s.dispatch(key('down'), b);
    const r = await s.dispatch(key('tab'), b);
    const action = (r as { consumed: true; action: BufferAction }).action;
    expect(action.kind).toBe('splice');
    expect((action as { text: string }).text).toBe('/run-skill beta ');
  });
});

// ── passthrough ────────────────────────────────────────────────────

describe('dispatch passthrough', () => {
  test('non-picker keys return consumed:false even in picker mode', async () => {
    const s = createPickerState({ commands: cmds });
    const b = buf('/h');
    await s.refresh(b);
    const r = await s.dispatch(key('backspace'), b);
    expect(r).toEqual({ consumed: false });
  });

  test('returns passthrough when no picker is active', async () => {
    const s = createPickerState({ commands: cmds });
    const r = await s.dispatch(key('enter'), buf('plain'));
    expect(r).toEqual({ consumed: false });
  });

  test('Esc in picker mode returns passthrough so host Esc handler fires', async () => {
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async () => atCandidates,
    });
    const b = buf('@src', 4);
    await s.refresh(b);
    const r = await s.dispatch(key('escape'), b);
    expect(r).toEqual({ consumed: false });
  });

  test('Ctrl+Y in picker mode returns passthrough', async () => {
    const s = createPickerState({ commands: cmds });
    const b = buf('/help');
    await s.refresh(b);
    const r = await s.dispatch(key('y', { ctrl: true }), b);
    expect(r).toEqual({ consumed: false });
  });
});

// ── golden-path integration (KX2-e) ────────────────────────────────

describe('golden path', () => {
  test('1: /<nav x2>Enter submits second-ranked command', async () => {
    const s = createPickerState({ commands: cmds });
    const b = buf('/');
    await s.refresh(b);
    await s.dispatch(key('down'), b);
    await s.dispatch(key('down'), b);
    const r = await s.dispatch(key('enter'), b);
    const a = (r as { consumed: true; action: BufferAction }).action;
    expect(a.kind).toBe('submit');
  });

  test('3: Enter with no nav + non-exact → submit literal input', async () => {
    const s = createPickerState({ commands: cmds });
    const b = buf('/');
    await s.refresh(b);
    const r = await s.dispatch(key('enter'), b);
    const a = (r as { consumed: true; action: BufferAction }).action;
    expect(a).toEqual({ kind: 'submit', text: '/' });
  });

  test('7: Tab on dir invalidates cache + next refresh re-fetches', async () => {
    const fetched: string[] = [];
    const candidates: AtCandidate[] = [
      { label: 'src/', absPath: '/abs/src', isDir: true },
    ];
    const s = createPickerState({
      commands: cmds,
      onAtCandidates: async (p: string) => {
        fetched.push(p);
        return candidates;
      },
    });
    await s.refresh(buf('@sr', 3));
    const r = await s.dispatch(key('tab'), buf('@sr', 3));
    const a = (r as { consumed: true; action: BufferAction }).action;
    expect((a as { text: string }).text).toBe('@src/');
    // Simulate chat.ts applying the splice → buffer becomes '@src/'
    // → refresh should re-fetch with the new prefix.
    await s.refresh(buf('@src/', 5));
    expect(fetched).toEqual(['sr', 'src/']);
  });

  test('8: picker-open + onBufferEdit clears nav so Enter submits the typed text', async () => {
    const s = createPickerState({ commands: cmds });
    await s.refresh(buf('/he'));
    await s.dispatch(key('down'), buf('/he'));
    expect(s._snapshot().pickerNavigated).toBe(true);
    s.onBufferEdit();
    expect(s._snapshot().pickerNavigated).toBe(false);
    const result = await s.dispatch(key('enter'), buf('/he'));
    expect((result as { consumed: true; action: BufferAction }).action).toEqual({ kind: 'submit', text: '/he' });
  });

  test('10: bracketed-paste body never reaches dispatch (caller gates)', async () => {
    // State machine itself has no paste concept — chat.ts skips
    // dispatch while pasteMode is on. Verify dispatch with an
    // arbitrary non-picker key still returns passthrough so the
    // caller's skip is the only gate needed.
    const s = createPickerState({ commands: cmds });
    const r = await s.dispatch(key('a'), buf('plain text'));
    expect(r).toEqual({ consumed: false });
  });
});
