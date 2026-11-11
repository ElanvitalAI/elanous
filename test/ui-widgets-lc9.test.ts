import { describe, expect, test } from 'bun:test';
import { Printer } from '../src/ui/printer.js';
import { stripAnsi } from '../src/tui.js';
import type { KeyEvent } from '../src/plugins/core/types.js';
import { RequestUserInputOverlay, type Question, type QuestionAnswer } from '../src/ui/widgets/request-user-input-overlay.js';
import { SlashMenu } from '../src/ui/widgets/slash-menu.js';
import { ContextMenu, computePlacement } from '../src/ui/widgets/context-menu.js';
import { Dialog } from '../src/ui/widgets/dialog.js';
import { PermissionPrompt } from '../src/ui/widgets/permission-prompt.js';

function key(name: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return { name, ctrl: false, shift: false, alt: false, ...mods };
}

function render(v: { draw: (p: Printer) => void }, w = 40, h = 6, focused = true): string[] {
  const p = Printer.create({ width: w, height: h, focused });
  v.draw(p);
  return p.lines().map(stripAnsi);
}

describe('LC9 RequestUserInputOverlay', () => {
  test('asks questions in sequence and collects answers', () => {
    let final: QuestionAnswer[] | null = null;
    const qs: Question[] = [
      { id: 'q1', title: 'Pick a', options: [
        { value: 'x', label: 'X' },
        { value: 'y', label: 'Y' },
      ]},
      { id: 'q2', title: 'Pick b', options: [
        { value: 'p', label: 'P' },
        { value: 'q', label: 'Q' },
      ]},
    ];
    const o = new RequestUserInputOverlay({ questions: qs, onSubmit: a => { final = a; } });
    o.takeFocus();
    // q1: pick Y
    o.onEvent(key('down'));
    o.onEvent(key('enter'));
    expect(o._state().idx).toBe(1);
    // q2: pick P
    o.onEvent(key('enter'));
    expect(final).toEqual([
      { questionId: 'q1', value: 'y', notes: undefined },
      { questionId: 'q2', value: 'p', notes: undefined },
    ]);
  });

  test('back nav returns to previous question', () => {
    let cancelled = false;
    const qs: Question[] = [
      { id: 'a', title: 'A', options: [{ value: 'a1', label: 'A1' }]},
      { id: 'b', title: 'B', options: [{ value: 'b1', label: 'B1' }]},
    ];
    const o = new RequestUserInputOverlay({
      questions: qs, allowBackNav: true,
      onSubmit: () => {},
      onCancel: () => { cancelled = true; },
    });
    o.takeFocus();
    // answer q1
    o.onEvent(key('enter'));
    expect(o._state().idx).toBe(1);
    // Esc should back-nav (not cancel since allowBackNav)
    o.onEvent(key('escape'));
    expect(o._state().idx).toBe(0);
    expect(cancelled).toBe(false);
  });

  test('back nav preserves prior free-text answer and notes for editing', () => {
    let result: QuestionAnswer[] | null = null;
    const qs: Question[] = [
      { id: 'msg', title: 'Message', inputType: { placeholder: 'type here' }, allowNotes: true, notesPlaceholder: 'why?' },
      { id: 'pick', title: 'Pick', options: [{ value: 'a', label: 'A' }] },
    ];
    const o = new RequestUserInputOverlay({
      questions: qs,
      allowBackNav: true,
      onSubmit: a => { result = a; },
    });
    o.takeFocus();

    o.onEvent(key('h'));
    o.onEvent(key('i'));
    o.onEvent(key('tab'));
    o.onEvent(key('n'));
    o.onEvent(key('1'));
    o.onEvent(key('tab'));
    o.onEvent(key('enter'));
    expect(o._state().idx).toBe(1);

    o.onEvent(key('escape'));
    expect(o._state().idx).toBe(0);

    o.onEvent(key('enter'));
    o.onEvent(key('enter'));

    expect(result).toEqual([
      { questionId: 'msg', value: 'hi', notes: 'n1' },
      { questionId: 'pick', value: 'a', notes: undefined },
    ]);
  });

  test('free-text question uses EditView', () => {
    let result: QuestionAnswer[] | null = null;
    const qs: Question[] = [
      { id: 'msg', title: 'Commit msg', inputType: { placeholder: 'type here' }},
    ];
    const o = new RequestUserInputOverlay({ questions: qs, onSubmit: a => { result = a; } });
    o.takeFocus();
    o.onEvent(key('h'));
    o.onEvent(key('i'));
    o.onEvent(key('enter'));
    expect(result).toEqual([{ questionId: 'msg', value: 'hi', notes: undefined }]);
  });

  test('Tab toggles focus when allowNotes is on', () => {
    const qs: Question[] = [
      { id: 'q', title: 'Q', options: [{ value: 'a', label: 'A' }], allowNotes: true, notesPlaceholder: 'why?' },
    ];
    const o = new RequestUserInputOverlay({ questions: qs, onSubmit: () => {} });
    o.takeFocus();
    expect(o._state().focus).toBe('answer');
    o.onEvent(key('tab'));
    expect(o._state().focus).toBe('notes');
    o.onEvent(key('tab'));
    expect(o._state().focus).toBe('answer');
  });

  test('chromeSpec can hide close glyph and use explicit title', () => {
    const qs: Question[] = [
      { id: 'q', title: 'Original title', options: [{ value: 'a', label: 'A' }] },
    ];
    const o = new RequestUserInputOverlay({
      questions: qs,
      chromeSpec: { title: 'Spec overlay', showClose: false, variant: 'panel' },
      onSubmit: () => {},
    });
    o.takeFocus();
    const lines = render(o, 40, 6);
    const joined = lines.join('\n');
    expect(joined).toContain('Spec overlay');
    expect(joined).not.toContain('×');
  });
});

describe('LC9 SlashMenu', () => {
  test('renders commands with descriptions', () => {
    const sm = new SlashMenu({
      commands: [
        { name: '/status', description: 'Show repo status', onRun: () => {} },
        { name: '/diff',   description: 'Show diff',        onRun: () => {} },
      ],
    });
    sm.takeFocus();
    const lines = render(sm, 50, 6);
    const joined = lines.join('\n');
    expect(joined).toContain('/status');
    expect(joined).toContain('Show repo status');
  });

  test('typing filters commands', () => {
    let fired = '';
    const sm = new SlashMenu({
      commands: [
        { name: '/status', description: 'S',      onRun: () => { fired = 'status'; } },
        { name: '/diff',   description: 'D',      onRun: () => { fired = 'diff'; } },
      ],
    });
    sm.takeFocus();
    sm.onEvent(key('d'));
    sm.onEvent(key('i'));
    sm.onEvent(key('enter'));
    expect(fired).toBe('diff');
  });

  test('chromeSpec can hide close glyph and override title', () => {
    const sm = new SlashMenu({
      title: 'Legacy',
      chromeSpec: { title: 'Spec commands', showClose: false, variant: 'panel' },
      commands: [
        { name: '/status', description: 'Show repo status', onRun: () => {} },
      ],
    });
    sm.takeFocus();
    const lines = render(sm, 40, 6);
    const joined = lines.join('\n');
    expect(joined).toContain('Spec commands');
    expect(joined).not.toContain('×');
  });
});

describe('LC9 ContextMenu', () => {
  test('Enter on selected item picks value', () => {
    let picked: string | null = null;
    const m = new ContextMenu<string>({
      items: [
        { value: 'copy',  label: 'Copy' },
        { value: 'paste', label: 'Paste' },
      ],
      onPick: v => { picked = v; },
    });
    m.takeFocus();
    m.onEvent(key('down'));
    m.onEvent(key('enter'));
    expect(picked).toBe('paste');
  });

  test('disabled items render with reason', () => {
    const m = new ContextMenu<string>({
      items: [
        { value: 'copy',  label: 'Copy' },
        { value: 'paste', label: 'Paste', disabled: true },
      ],
      onPick: () => {},
    });
    m.takeFocus();
    const lines = render(m, 40, 5);
    expect(lines.join('\n')).toContain('Paste');
  });

  test('renders titled chrome instead of a bare list box', () => {
    const m = new ContextMenu<string>({
      title: 'Browser actions',
      items: [
        { value: 'attach', label: 'Attach to chat' },
      ],
      onPick: () => {},
    });
    m.takeFocus();
    const lines = render(m, 40, 6);
    expect(lines.join('\n')).toContain('Browser actions');
  });

  test('chromeSpec overrides title and can hide close glyph', () => {
    const m = new ContextMenu<string>({
      title: 'Legacy title',
      chromeSpec: {
        title: 'Spec title',
        showClose: false,
        variant: 'panel',
      },
      items: [{ value: 'attach', label: 'Attach to chat' }],
      onPick: () => {},
    });
    m.takeFocus();
    const lines = render(m, 40, 6);
    const joined = lines.join('\n');
    expect(joined).toContain('Spec title');
    expect(joined).not.toContain('×');
  });
});

describe('LC9 Dialog', () => {
  test('chromeSpec can hide border and override title', () => {
    const d = new Dialog<string>({
      title: 'Legacy title',
      chromeSpec: {
        title: 'Spec dialog',
        showBorder: false,
      },
      body: 'Hello',
      buttons: [{ label: 'OK', value: 'ok' }],
      onSubmit: () => {},
    });
    d.takeFocus();
    const lines = render(d, 30, 5);
    const joined = lines.join('\n');
    expect(joined).toContain('Hello');
    expect(joined).not.toContain('┌');
    expect(joined).not.toContain('│');
  });
});

describe('LC9 PermissionPrompt', () => {
  test('chromeSpec overrides title and can hide close glyph', () => {
    const prompt = new PermissionPrompt<string>({
      title: 'Legacy permission',
      body: 'Allow edits?',
      chromeSpec: {
        title: 'Spec permission',
        showClose: false,
        variant: 'panel',
      },
      choices: [
        { value: 'allow', label: 'Allow', positive: true },
        { value: 'deny', label: 'Deny' },
      ],
      onSubmit: () => {},
    });
    prompt.takeFocus();
    const lines = render(prompt, 42, 8);
    const joined = lines.join('\n');
    expect(joined).toContain('Spec permission');
    expect(joined).not.toContain('×');
  });
});

describe('LC9 computePlacement', () => {
  test('places menu below-right of anchor when it fits', () => {
    const r = computePlacement({ x: 5, y: 3 }, { width: 10, height: 4 }, { width: 40, height: 20 });
    expect(r).toEqual({ x: 5, y: 4, width: 10, height: 4 });
  });

  test('shifts left when menu spills right', () => {
    const r = computePlacement({ x: 35, y: 3 }, { width: 10, height: 4 }, { width: 40, height: 20 });
    expect(r.x).toBe(30);
  });

  test('flips above when menu spills below', () => {
    const r = computePlacement({ x: 5, y: 18 }, { width: 10, height: 5 }, { width: 40, height: 20 });
    expect(r.y).toBe(13);
  });

  test('clamps to positive origin', () => {
    const r = computePlacement({ x: 0, y: 0 }, { width: 50, height: 30 }, { width: 40, height: 20 });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.width).toBe(40);
    expect(r.height).toBe(20);
  });
});
