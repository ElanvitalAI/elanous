import { act, create } from 'react-test-renderer';
import { expect, test } from 'bun:test';
import { ChatProjectSwitcher } from './ChatProjectSwitcher';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const projects = [{ id: 'p', name: '일', createdAt: '' }];

test('without projects only «＋ 프로젝트 만들기» (the first project must be creatable); otherwise offers all, inbox, projects and one-line creation', async () => {
  const changes: string[] = [];
  const names: string[] = [];
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ChatProjectSwitcher projects={[]} selection="all" onChange={(s) => changes.push(s)} onCreate={async (n) => { names.push(n); }} />); });
  expect(tree!.root.findAllByType('select')).toHaveLength(0);
  const first = tree!.root.findByType('button');
  expect(first.props.children).toBe('＋ 프로젝트 만들기');
  await act(async () => first.props.onClick());
  await act(async () => tree!.root.findByType('input').props.onChange({ target: { value: '첫 프로젝트' } }));
  await act(async () => tree!.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(names).toEqual(['첫 프로젝트']);
  names.length = 0;
  await act(async () => { tree!.update(<ChatProjectSwitcher projects={projects} selection="all" onChange={(s) => changes.push(s)} onCreate={async (n) => { names.push(n); }} />); });
  expect(tree!.root.findAllByType('option').map((o) => o.props.value)).toEqual(['all', 'none', 'p', 'create']);
  const select = tree!.root.findByType('select');
  await act(async () => select.props.onChange({ target: { value: 'none' } }));
  await act(async () => select.props.onChange({ target: { value: 'p' } }));
  expect(changes).toEqual(['none', 'p']);
  await act(async () => select.props.onChange({ target: { value: 'create' } }));
  const input = tree!.root.findByType('input');
  expect(input.props.maxLength).toBe(80);
  await act(async () => input.props.onChange({ target: { value: '  새 프로젝트  ' } }));
  await act(async () => tree!.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  expect(names).toEqual(['새 프로젝트']);
  await act(async () => tree!.unmount());
});
