import { expect, test } from 'bun:test';
import { createDefaultPanels } from './runtime';
import type { ShowroomPanel } from './types';

test('showroom chat-panel provider contract is unchanged after removing the chat header picker', () => {
  const panels: ShowroomPanel[] = createDefaultPanels();
  expect(panels.map((panel) => panel.provider)).toEqual(['', '']);
});
