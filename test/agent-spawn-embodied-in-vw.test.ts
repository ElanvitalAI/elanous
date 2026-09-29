import { describe, expect, test } from 'bun:test';
import {
  findLiveSessionById,
  findLiveSessionByPaneId,
  listLiveEmbodiedSessions,
} from '../src/agent/spawn-embodied-agent-in-vw.js';

describe('live embodied session registry after virtual-window spawn removal', () => {
  test('all three lookup exports remain available with an empty registry', () => {
    expect(listLiveEmbodiedSessions()).toEqual([]);
    expect(findLiveSessionById('missing')).toBeUndefined();
    expect(findLiveSessionByPaneId('missing')).toBeUndefined();
  });

  test('each snapshot is independent of subsequent reads', () => {
    const snapshot = listLiveEmbodiedSessions();
    expect(snapshot).not.toBe(listLiveEmbodiedSessions());
    expect(snapshot).toHaveLength(0);
  });
});
