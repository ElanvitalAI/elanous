import { expect, it } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { useState, type ChangeEvent } from 'react';
import type { WorkflowDefinitionLike } from './workflow-graph-layout';
import { ExpressionInput, cursorFragment, insertCandidate } from './ExpressionInput';
import { WorkflowNodeEditor } from './WorkflowNodeEditor';

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
  return { renderer, control, element, type, key, get value() { return value; }, get edits() { return edits; } };
}

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
