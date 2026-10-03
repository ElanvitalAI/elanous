import { expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { ChatQueueChips } from './ChatQueueChips';

test('empty queue has no chip row', async () => {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ChatQueueChips queue={[]} onRemove={() => {}} onClear={() => {}} />); });
  expect(tree.toJSON()).toBeNull();
  await act(async () => { tree.unmount(); });
});

test('chips number and truncate text to 20 characters; individual and all removal callbacks', async () => {
  const removed: number[] = [];
  let cleared = 0;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ChatQueueChips queue={[{ id: 10, text: 'abcdefghijklmnopqrstuvwxyz' }, { id: 11, text: 'next' }]} onRemove={(id) => removed.push(id)} onClear={() => cleared++} />); });
  const buttons = tree.root.findAllByType('button');
  expect(tree.root.findAllByType('span').map((span) => span.props.title).filter(Boolean)).toEqual(['abcdefghijklmnopqrstuvwxyz', 'next']);
  const label = tree.root.findAllByType('span').find((span) => span.props.title === 'abcdefghijklmnopqrstuvwxyz')!;
  expect(label.props.children).toEqual([1, ' · ', 'abcdefghijklmnopqrst']);
  buttons[1]!.props.onClick();
  buttons[2]!.props.onClick();
  expect(removed).toEqual([11]);
  expect(cleared).toBe(1);
  await act(async () => { tree.unmount(); });
});
