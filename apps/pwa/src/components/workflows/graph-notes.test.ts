import { afterAll, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { WorkflowGraph, showEmptyCanvas } from './WorkflowGraph';
import { addNote, loadNotes, removeNote, saveNotes, updateNote } from './graph-notes';

const globals = globalThis as { window?: unknown; localStorage?: Storage; IS_REACT_ACT_ENVIRONMENT?: boolean };
const original = { window: globals.window, localStorage: globals.localStorage, act: globals.IS_REACT_ACT_ENVIRONMENT };
const data = new Map<string, string>();
const storage = {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => { data.set(key, value); },
} as Storage;
globals.localStorage = storage;
globals.window = { addEventListener: () => undefined, removeEventListener: () => undefined };
globals.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  if (original.window === undefined) delete globals.window; else globals.window = original.window;
  if (original.localStorage === undefined) delete globals.localStorage; else globals.localStorage = original.localStorage;
  if (original.act === undefined) delete globals.IS_REACT_ACT_ENVIRONMENT; else globals.IS_REACT_ACT_ENVIRONMENT = original.act;
});

test('add, edit, move and remove notes without mutating the previous list or reusing ids', () => {
  const first = addNote([], { x: 10, y: 20 });
  const second = addNote(first, { x: 30, y: 40 });
  expect(first).toEqual([{ id: 'note-1', x: 10, y: 20, text: '' }]);
  expect(second.map((note) => note.id)).toEqual(['note-1', 'note-2']);
  const edited = updateNote(second, 'note-2', { text: 'remember', x: -7, y: 42 });
  expect(edited[1]).toEqual({ id: 'note-2', x: -7, y: 42, text: 'remember' });
  expect(second[1]?.text).toBe('');
  expect(removeNote(edited, 'note-1')).toEqual([edited[1]]);
  expect(addNote(removeNote(second, 'note-1'), { x: 0, y: 0 }).map((note) => note.id)).toEqual(['note-2', 'note-1']);
  saveNotes('edited', edited);
  expect(loadNotes('edited')).toEqual(edited);
  saveNotes('edited', removeNote(edited, 'note-1'));
  expect(loadNotes('edited')).toEqual([edited[1]]);
});

test('notes are isolated by workflow name and malformed or unavailable storage returns an empty list without throwing', () => {
  data.clear();
  const notes = addNote([], { x: 1, y: 2 });
  saveNotes('alpha', notes);
  expect(data.get('elanous.workflow.notes.alpha')).toBe(JSON.stringify(notes));
  expect(loadNotes('alpha')).toEqual(notes);
  expect(loadNotes('beta')).toEqual([]);
  data.set('elanous.workflow.notes.beta', '{broken');
  expect(loadNotes('beta')).toEqual([]);
  data.set('elanous.workflow.notes.beta', JSON.stringify([{ id: 1, x: 2, y: 3, text: '' }]));
  expect(loadNotes('beta')).toEqual([]);
  globals.localStorage = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('denied'); } } as unknown as Storage;
  expect(loadNotes('alpha')).toEqual([]);
  expect(() => saveNotes('alpha', notes)).not.toThrow();
  globals.localStorage = storage;
});

test('a node-free workflow renders its canvas when a note exists', () => {
  expect(showEmptyCanvas(0, 0)).toBe(true);
  expect(showEmptyCanvas(0, 1)).toBe(false);
  expect(showEmptyCanvas(1, 0)).toBe(false);
});

test('empty canvas adds one note to localStorage without changing YAML; read-only cannot add', async () => {
  data.clear();
  let yamlChanges = 0;
  const yaml = 'name: canvas\nnodes: []\n';
  let readonly!: ReturnType<typeof create>;
  await act(async () => { readonly = create(createElement(WorkflowGraph, { yaml, definition: { name: 'canvas', nodes: [] }, editable: false, onChangeYaml: () => { yamlChanges++; } })); });
  expect(readonly.root.findAllByType('button').some((button) => button.children.includes('메모 추가'))).toBe(false);
  await act(async () => readonly.unmount());

  let renderer!: ReturnType<typeof create>;
  await act(async () => { renderer = create(createElement(WorkflowGraph, { yaml, definition: { name: 'canvas', nodes: [] }, editable: true, onChangeYaml: () => { yamlChanges++; } })); });
  const add = renderer.root.findAllByType('button').find((button) => button.children.includes('메모 추가'))!;
  expect(add).toBeDefined();
  add.props.onClick(); // Do not flush a note node into React Flow in the minimal test window.
  expect(loadNotes('canvas')).toEqual([{ id: 'note-1', x: 0, y: 0, text: '' }]);
  expect(showEmptyCanvas(0, loadNotes('canvas').length)).toBe(false);
  add.props.onClick(); // A second click before React commits must not reuse the first id.
  expect(loadNotes('canvas').map((note) => note.id)).toEqual(['note-1', 'note-2']);
  expect(yamlChanges).toBe(0);
  expect(renderer.root.findAllByType('button').find((button) => button.children.includes('Undo'))?.props.disabled).toBe(true);
  renderer.unmount();
});
