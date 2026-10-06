import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { MissionRoomApiClient, MissionRoomDecisionWire, MissionRoomStateWire } from '@/lib/mission-room-api';
import { DecisionCard } from './DecisionCard';
import { MissionRoomPanel } from './MissionRoomPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
});

test('mission panel renders the shared card and applies its choice with the existing mission action', async () => {
  const calls: Array<[string, string]> = [];
  const open: MissionRoomDecisionWire = { ts: 1, question: '어느 길?', opinions: [{ role: 'OP', text: '진행' }], resolution: { status: 'open' } };
  const state: MissionRoomStateWire = {
    missionId: 'mission-1', showroomSessionId: 'room-1', missionTag: 'tag', status: 'active', spawnedAt: 1, decisions: [open],
  };
  const api: MissionRoomApiClient = {
    spawn: async () => ({ state, missionShowroomUrl: '' }),
    deliberate: async () => open,
    decide: async (id, choice) => {
      calls.push([id, choice]);
      return { ...open, resolution: { status: 'decided', chosen: choice } };
    },
    archive: async () => state,
  };
  await act(async () => { tree = create(<MissionRoomPanel missionId="mission-1" api={api} />); });
  expect(tree!.root.findAllByType(DecisionCard)).toHaveLength(1);
  expect(tree!.root.findAllByType('pre')[0]?.children.join('')).toBe('진행');
  await act(async () => tree!.root.findByType('input').props.onChange({ target: { value: '선택' } }));
  await act(async () => tree!.root.findByType(DecisionCard).findByType('form').props.onSubmit({ preventDefault: () => {} }));
  expect(calls).toEqual([['mission-1', '선택']]);
  expect(tree!.root.findAllByType('input')).toHaveLength(0);
});
