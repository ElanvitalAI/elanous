import { describe, expect, mock, test } from 'bun:test';

import type { RotationEntry } from '../src/user-config/types.js';
import { createMousePickerRuntime } from '../src/dashboard/input/mouse-picker-runtime.js';

const ROTATION_ENTRY: RotationEntry = { provider: 'openai', model: 'gpt-5' };

describe('createMousePickerRuntime', () => {
  test('delegates rotation and wd inventories unchanged', () => {
    const getRotation = () => [ROTATION_ENTRY];
    const getCurrentModelEntry = () => ROTATION_ENTRY;
    const getRecentWds = () => ['/tmp/project'];
    const runtime = createMousePickerRuntime({
      getRotation,
      getCurrentModelEntry,
      applyActiveModel: () => {},
      getRecentWds,
      applySessionWd: () => {},
      reportModelSwitchError: () => {},
      reportWdSwitchError: () => {},
    });

    expect(runtime.getRotation()).toEqual([ROTATION_ENTRY]);
    expect(runtime.getCurrentModelEntry?.()).toEqual(ROTATION_ENTRY);
    expect(runtime.getRecentWds()).toEqual(['/tmp/project']);
  });

  test('reports model switch failures through injected sink', () => {
    const reportModelSwitchError = mock((_message: string) => {});
    const runtime = createMousePickerRuntime({
      getRotation: () => [],
      getCurrentModelEntry: () => null,
      applyActiveModel: () => {
        throw new Error('boom');
      },
      getRecentWds: () => [],
      applySessionWd: () => {},
      reportModelSwitchError,
      reportWdSwitchError: () => {},
    });

    runtime.setActiveModel(ROTATION_ENTRY);

    expect(reportModelSwitchError).toHaveBeenCalledWith('boom');
  });

  test('reports wd switch failures through injected sink', () => {
    const reportWdSwitchError = mock((_message: string) => {});
    const runtime = createMousePickerRuntime({
      getRotation: () => [],
      getCurrentModelEntry: () => null,
      applyActiveModel: () => {},
      getRecentWds: () => [],
      applySessionWd: () => {
        throw new Error('wd fail');
      },
      reportModelSwitchError: () => {},
      reportWdSwitchError,
    });

    runtime.setSessionWd('/tmp/project');

    expect(reportWdSwitchError).toHaveBeenCalledWith('wd fail');
  });
});
