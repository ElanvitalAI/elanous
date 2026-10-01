import { describe, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { SeatPicker } from './SeatPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('SeatPicker', () => {
  test('shows daemon titles and toggles the same seat back to chat', async () => {
    const choices: Array<string | null> = [];
    let selected: string | null = null;
    const seats = [{ id: 'MK', title: 'CMO' }, { id: 'TC', title: 'CTO' }];
    let tree!: ReturnType<typeof create>;
    const render = () => <SeatPicker seats={seats} selected={selected} onSelect={(seat) => { choices.push(seat); selected = seat; }} />;
    await act(async () => { tree = create(render()); });
    try {
      expect(tree.root.findAllByType('button').map((button) => button.children.join(''))).toEqual(['CMO', 'CTO']);
      await act(async () => { tree.root.findAllByType('button')[0]!.props.onClick(); tree.update(render()); });
      expect(choices).toEqual(['MK']);
      await act(async () => { tree.update(render()); });
      expect(tree.root.findAllByType('button')[0]!.props['aria-pressed']).toBe(true);
      await act(async () => { tree.root.findAllByType('button')[0]!.props.onClick(); });
      expect(choices).toEqual(['MK', null]);
    } finally { await act(async () => { tree.unmount(); }); }
  });
});
