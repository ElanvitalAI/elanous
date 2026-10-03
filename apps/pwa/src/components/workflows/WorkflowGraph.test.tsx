import { afterAll, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { parse } from 'yaml';
import { WorkflowGraph } from './WorkflowGraph';

const globals = globalThis as { window?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousWindow = globals.window;
const previousActEnvironment = globals.IS_REACT_ACT_ENVIRONMENT;
const listeners = new Set<(event: KeyboardEvent) => void>();
globals.window = {
  addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
    if (type === 'keydown') listeners.add(listener);
  },
  removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
    if (type === 'keydown') listeners.delete(listener);
  },
};
globals.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  if (previousWindow === undefined) delete globals.window;
  else globals.window = previousWindow;
  if (previousActEnvironment === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT;
  else globals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function key(keyName: string, options: { shiftKey?: boolean; target?: object } = {}) {
  let prevented = false;
  const event = {
    key: keyName, metaKey: true, ctrlKey: false, altKey: false,
    shiftKey: options.shiftKey ?? false, target: options.target ?? { tagName: 'DIV' },
    preventDefault: () => { prevented = true; },
  } as unknown as KeyboardEvent;
  for (const listener of [...listeners]) listener(event);
  return prevented;
}

const initial = 'name: demo\n# exact snapshot\nnodes: []\n';

// ⚠️ React Flow with nodes loops («Maximum update depth») under react-test-renderer with the minimal window stub
// (#23099). So these tests start from an empty graph and call edits *outside* act: the one-node graph is never
// committed and the canvas never mounts. Copy/paste needs a mounted selection — its logic is tested in
// graph-clipboard.test.ts and the wired shortcuts are checked live in a browser (W3a harvest).
test('editable graph history: an edit records the exact previous YAML and ⌘Z restores it; typing in a field is not intercepted', async () => {
  let yaml = initial;
  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(<WorkflowGraph yaml={yaml} editable onChangeYaml={(next) => { yaml = next; }} />); });
  const button = (label: string) => renderer.root.findAllByType('button').find((b) => b.children.includes(label))!;
  expect(button('Undo').props.disabled).toBe(true);
  button('+ bash').props.onClick(); // outside act (see above)
  const first = yaml;
  expect((parse(first) as { nodes: unknown[] }).nodes).toHaveLength(1);
  expect(key('z', { target: { tagName: 'TEXTAREA' } })).toBe(false); // typing in a field is not intercepted
  expect(yaml).toBe(first);
  expect(key('z')).toBe(true);
  expect(yaml).toBe(initial);
  // Redo needs the post-undo commit, which this test avoids on purpose — checked live (⇧⌘Z).
  renderer.unmount();
  listeners.clear(); // unmount outside act does not flush the effect cleanup
});

test('read-only graph never registers editing shortcuts or changes YAML', async () => {
  let changes = 0;
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<WorkflowGraph yaml={initial} editable={false} onChangeYaml={() => { changes++; }} />);
  });
  expect(renderer.root.findAllByType('button').some((b) => b.children.includes('Undo'))).toBe(false);
  expect(key('v')).toBe(false);
  expect(key('z')).toBe(false);
  expect(changes).toBe(0);
  await act(async () => renderer.unmount());
});
