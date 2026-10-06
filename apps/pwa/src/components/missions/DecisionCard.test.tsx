import { expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { DecisionCard } from './DecisionCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('mission decision card preserves opinions, chosen input, and apply callback', async () => {
  const chosen: string[] = [];
  const decision = { ts: 1, question: '다음은?', opinions: [{ role: 'OP', text: '진행' }], resolution: { status: 'open' as const } };
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(<DecisionCard decision={decision} decidingChoice={null} onDecide={choice => chosen.push(choice)} />); });
  expect(tree.root.findAllByType('pre')[0]?.children.join('')).toBe('진행');
  await act(async () => tree.root.findByType('input').props.onChange({ target: { value: ' 선택 ' } }));
  await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault: () => {} }));
  expect(chosen).toEqual(['선택']);
  await act(async () => tree.unmount());
});
