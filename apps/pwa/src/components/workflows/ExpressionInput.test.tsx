import { expect, it, spyOn } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { useState, type ChangeEvent } from 'react';
import type { WorkflowDefinitionLike } from './workflow-graph-layout';
import { ExpressionInput, cursorFragment, insertAtSelection, insertCandidate } from './ExpressionInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const definition: WorkflowDefinitionLike = {
  name: 'test',
  nodes: [
    { id: 'fetch', bash: 'echo ok', output_format: { properties: { status: {} } } },
    { id: 'edit', depends_on: ['fetch'], bash: '' },
  ],
};

function setup(initial: string, multiline = false) {
  let value = initial;
  let edits = 0;
  const element = {
    value: initial, selectionStart: initial.length, selectionEnd: initial.length,
    focus: () => {},
    setSelectionRange(start: number, end: number) {
      element.selectionStart = start;
      element.selectionEnd = end;
    },
  };
  function Harness() {
    const [text, setText] = useState(initial);
    return <ExpressionInput definition={definition} nodeId="edit" value={text} multiline={multiline} rows={4} className="original" onChange={(event) => {
      value = event.target.value;
      edits++;
      setText(value);
    }} />;
  }
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(<Harness />, { createNodeMock: ({ type }) => type === 'input' || type === 'textarea' ? element : null }); });
  const control = () => renderer.root.findByType(multiline ? 'textarea' : 'input');
  const button = () => renderer.root.findByProps({ 'aria-label': '변수 넣기' });
  const type = (next: string, position = next.length) => {
    element.value = next;
    element.selectionStart = position;
    act(() => control().props.onChange({ target: element }));
  };
  const key = (name: string) => {
    let prevented = false;
    act(() => control().props.onKeyDown({ key: name, preventDefault: () => { prevented = true; } }));
    return prevented;
  };
  return { renderer, control, button, element, type, key, get value() { return value; }, get edits() { return edits; } };
}

it('shows the no-variable message when the candidate source returns an empty list', async () => {
  const completion = await import('./expression-completion');
  const candidateSource = spyOn(completion, 'getExpressionCandidates').mockReturnValue([]);
  try {
    const ui = setup('plain');
    act(() => ui.button().props.onClick());
    expect(ui.renderer.root.findByProps({ role: 'listbox', 'aria-label': '사용 가능한 변수' }).children).toHaveLength(1);
    expect(ui.renderer.root.findAllByType('span').some((item) => item.children.includes('쓸 수 있는 변수가 없습니다'))).toBe(true);
    expect(ui.renderer.root.findAllByProps({ role: 'option' })).toHaveLength(0);
    act(() => ui.renderer.unmount());
  } finally {
    candidateSource.mockRestore();
  }
});

it('inserts at a plain cursor and replaces the selected range without requiring a $ fragment', () => {
  expect(insertAtSelection('say  now', 4, 4, '$ARGUMENTS')).toEqual({ value: 'say $ARGUMENTS now', cursor: 14 });
  expect(insertAtSelection('say replace now', 4, 11, '$fetch.output')).toEqual({ value: 'say $fetch.output now', cursor: 17 });
});

it('keeps Enter and Tab insertion for typed $ suggestions', () => {
  const previousInput = globalThis.HTMLInputElement;
  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: class {
      set value(updated: string) { Object.defineProperty(this, 'value', { value: updated, writable: true, configurable: true }); }
    },
  });
  try {
    for (const key of ['Enter', 'Tab']) {
      const ui = setup('');
      ui.type('say $fe now', 7);
      ui.element.selectionEnd = 7;
      expect(ui.key(key)).toBe(true);
      expect(ui.value).toBe('say $fetch.output now');
      expect(ui.element.selectionStart).toBe(17);
      expect(ui.renderer.root.findAllByProps({ role: 'option' })).toHaveLength(0);
      act(() => ui.renderer.unmount());
    }
  } finally {
    if (previousInput === undefined) Reflect.deleteProperty(globalThis, 'HTMLInputElement');
    else Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: previousInput });
  }
});

it('opens the variable list with descriptions, inserts at the saved selection, and closes on Escape', () => {
  const ui = setup('say replace now');
  expect(ui.button().props['aria-haspopup']).toBe('listbox');
  ui.element.selectionStart = 4;
  ui.element.selectionEnd = 11;
  act(() => ui.control().props.onSelect({ currentTarget: ui.element }));
  act(() => ui.button().props.onMouseDown({ preventDefault: () => {} }));
  act(() => ui.button().props.onClick());
  expect(ui.renderer.root.findByProps({ role: 'listbox', 'aria-label': '사용 가능한 변수' })).toBeDefined();
  const options = ui.renderer.root.findAllByProps({ role: 'option' });
  expect(options.map((option) => option.findByType('span').children[0])).toEqual([
    '$ARGUMENTS', '$ARTIFACTS_DIR', '$fetch.output', '$fetch.output.status',
  ]);
  expect(options[0].children.slice(1)).toEqual([' · ', '실행할 때 받은 인자']);
  expect(options[2].children.slice(1)).toEqual([' · ', 'fetch 노드 결과']);
  const previousInput = globalThis.HTMLInputElement;
  Object.defineProperty(globalThis, 'HTMLInputElement', {
    configurable: true,
    value: class {
      set value(updated: string) { Object.defineProperty(this, 'value', { value: updated, writable: true, configurable: true }); }
    },
  });
  try {
    act(() => options[2].props.onClick());
  } finally {
    if (previousInput === undefined) Reflect.deleteProperty(globalThis, 'HTMLInputElement');
    else Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: previousInput });
  }
  expect(ui.value).toBe('say $fetch.output now');
  expect(ui.edits).toBe(1);
  expect(ui.element.selectionStart).toBe(17);
  expect(ui.renderer.root.findAllByProps({ role: 'listbox' })).toHaveLength(0);
  act(() => ui.button().props.onClick());
  expect(ui.key('Escape')).toBe(true);
  expect(ui.renderer.root.findAllByProps({ role: 'listbox' })).toHaveLength(0);
  act(() => ui.renderer.unmount());
});

it('closes the variable list on a pointer press outside the input', () => {
  const listeners = new Map<string, EventListener>();
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      addEventListener: (name: string, listener: EventListener) => { listeners.set(name, listener); },
      removeEventListener: (name: string) => { listeners.delete(name); },
    },
  });
  try {
    const ui = setup('plain');
    const root = { contains: (target: unknown) => target === root };
    ui.renderer.root.findByType('span').props.ref.current = root;
    act(() => ui.button().props.onClick());
    expect(ui.renderer.root.findAllByProps({ role: 'listbox' })).toHaveLength(1);
    act(() => listeners.get('pointerdown')?.({ target: {} } as PointerEvent));
    expect(ui.renderer.root.findAllByProps({ role: 'listbox' })).toHaveLength(0);
    act(() => ui.renderer.unmount());
  } finally {
    // Restore the descriptor itself: re-defining with `{ value }` would leave a non-writable `document` for the next file.
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', previousDocument);
  }
});

it('preserves input and textarea contracts and shows only the $ fragment at the cursor', () => {
  for (const multiline of [false, true]) {
    const ui = setup('before $fe after', multiline);
    expect(ui.control().props.value).toBe('before $fe after');
    expect(ui.control().props.className).toBe('original');
    if (multiline) expect(ui.control().props.rows).toBe(4);
    ui.type('before $fe after', 10);
    expect(ui.renderer.root.findAllByProps({ role: 'option' }).map((o) => o.children[0])).toEqual([
      '$fetch.output', '$fetch.output.status',
    ]);
    ui.type('before $fe after', 5);
    expect(ui.renderer.root.findAllByProps({ role: 'option' })).toHaveLength(0);
    ui.type('before $fe after', 10);
    ui.element.selectionStart = 5;
    act(() => ui.control().props.onSelect({ currentTarget: ui.element }));
    expect(ui.renderer.root.findAllByProps({ role: 'option' })).toHaveLength(0);
    ui.type('\\$fe');
    expect(ui.renderer.root.findAllByProps({ role: 'option' })).toHaveLength(0);
    ui.type('x$fe');
    expect(ui.renderer.root.findAllByProps({ role: 'option' })).toHaveLength(2);
    ui.type('ordinary input');
    expect(ui.value).toBe('ordinary input');
    expect(ui.edits).toBe(6);
    act(() => ui.renderer.unmount());
  }
});

it('navigates candidates and dismisses them without blocking ordinary editing', () => {
  const ui = setup('');
  ui.type('say $fe next', 7);
  expect(ui.key('ArrowDown')).toBe(true);
  expect(ui.renderer.root.findAllByProps({ role: 'option' })[1].props['aria-selected']).toBe(true);
  expect(ui.key('ArrowUp')).toBe(true);
  expect(ui.key('Escape')).toBe(true);
  expect(ui.renderer.root.findAllByProps({ role: 'option' })).toHaveLength(0);
  expect(ui.key('Enter')).toBe(false);
  ui.type('$z');
  expect(ui.renderer.root.findAllByProps({ role: 'option' })).toHaveLength(0);
  expect(ui.key('Tab')).toBe(false);
  act(() => ui.renderer.unmount());
});

// The real input path (focus · select · choose · cursor) is checked live in a browser. A react-dom-over-linkedom
// test of it broke under the full suite: React DOM fixes its input-event path when first loaded (W5b harvest).
it('insertCandidate replaces the $-fragment before the cursor and the selected tail, and moves the cursor after it', () => {
  expect(cursorFragment('$feTAIL after', 3)).toEqual({ start: 0, typed: '$fe' });
  expect(cursorFragment('echo \\$fe', 9)).toBeNull();
  expect(cursorFragment('no dollar', 4)).toBeNull();
  expect(insertCandidate('$feTAIL after', 3, 7, '$fetch.output')).toEqual({ value: '$fetch.output after', cursor: '$fetch.output'.length });
  expect(insertCandidate('run $ARG', 8, 8, '$ARGUMENTS')).toEqual({ value: 'run $ARGUMENTS', cursor: 14 });
  expect(insertCandidate('plain', 5, 5, '$ARGUMENTS')).toBeNull();
});
