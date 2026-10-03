import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import type { WorkflowDefinitionLike } from './workflow-graph-layout';
import { WorkflowNodeEditor } from './WorkflowNodeEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// W5b harvest: the form refilled its drafts whenever the parent handed it a new node *object*. The parent re-parses
// the YAML on every render, and its own debounced commit lands later — either one clobbered typing in progress
// (live: a chosen `$step-1.output` and typed text flipped back to the older value).

const def = (bash: string): WorkflowDefinitionLike => ({
  name: 'w', nodes: [{ id: 'step-1', bash: 'echo one' }, { id: 'step-2', bash, depends_on: ['step-1'] }],
});

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let timers: Array<{ fn: () => void; cleared: boolean }> = [];
beforeEach(() => {
  timers = [];
  globalThis.setTimeout = ((fn: () => void) => { timers.push({ fn, cleared: false }); return timers.length as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; }) as typeof clearTimeout;
});
afterEach(() => { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; });
const flushCommit = () => { const t = timers.filter((x) => !x.cleared).at(-1); if (t) act(() => t.fn()); };

function mount(initial: WorkflowDefinitionLike) {
  const committed: WorkflowDefinitionLike[] = [];
  const props = { nodeId: 'step-2', onChange: (next: WorkflowDefinitionLike) => { committed.push(next); }, onClose: () => {}, onDelete: () => {} };
  let renderer!: ReturnType<typeof create>;
  act(() => { renderer = create(<WorkflowNodeEditor definition={initial} {...props} />, { createNodeMock: () => ({ focus() {}, setSelectionRange() {}, selectionStart: 0, selectionEnd: 0 }) }); });
  const bash = () => renderer.root.findAll((n) => n.type === 'textarea' && typeof n.props.value === 'string' && n.props.value.startsWith('echo two'))[0];
  const type = (text: string) => act(() => bash().props.onChange({ target: { value: text, selectionStart: text.length } }));
  const rerender = (next: WorkflowDefinitionLike) => act(() => renderer.update(<WorkflowNodeEditor definition={next} {...props} />));
  return { bash, type, rerender, committed, unmount: () => act(() => renderer.unmount()) };
}

test('a re-render with a new node object of the same content keeps the draft being typed', () => {
  const ui = mount(def('echo two'));
  ui.type('echo two typed');
  ui.rerender(def('echo two'));
  expect(ui.bash().props.value).toBe('echo two typed');
  ui.unmount();
});

test('our own lagging commit landing does not pull the draft back; the next commit sends the newer text', () => {
  const ui = mount(def('echo two'));
  ui.type('echo two $st');
  flushCommit();
  expect(ui.committed.at(-1)?.nodes?.[1]?.bash).toBe('echo two $st');
  ui.type('echo two $step-1.output');
  ui.rerender(def('echo two $st'));
  expect(ui.bash().props.value).toBe('echo two $step-1.output');
  flushCommit();
  expect(ui.committed.at(-1)?.nodes?.[1]?.bash).toBe('echo two $step-1.output');
  ui.unmount();
});

test('a real content change from outside (YAML view) still refills the draft', () => {
  const ui = mount(def('echo two'));
  ui.rerender(def('echo two from yaml'));
  expect(ui.bash().props.value).toBe('echo two from yaml');
  ui.unmount();
});
