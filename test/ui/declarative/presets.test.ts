import { describe, expect, test } from 'bun:test';
import {
  buildWidgetLabPreset,
  buildWidgetLabPresetNodes,
  buildWidgetLabPresetReferenceYAML,
  buildWidgetLabPresetYAML,
  cycleWidgetLabPreset,
  getWidgetLabPreset,
  listWidgetLabPresets,
} from '../../../src/ui/declarative/index.js';

describe('WidgetLab presets', () => {
  test('lists multiple named presets', () => {
    const presets = listWidgetLabPresets();
    expect(presets.length).toBeGreaterThanOrEqual(3);
    expect(presets.map((preset) => preset.id)).toContain('telemetry-stack');
    expect(presets.map((preset) => preset.id)).toContain('approval-dialog');
    expect(presets.map((preset) => preset.id)).toContain('notes-panel');
    expect(presets.map((preset) => preset.id)).toContain('ask-user-flow');
  });

  test('buildWidgetLabPreset returns fluent-built specs', () => {
    const specs = buildWidgetLabPreset('telemetry-stack');
    expect(specs[0]?.type).toBe('log');
    expect(specs[0]?.chrome?.title).toBe('Telemetry');
    expect(specs[0]?.motion?.enter?.preset).toBe('fade');
  });

  test('buildWidgetLabPresetNodes preserves builder-authored top-level nodes', () => {
    const nodes = buildWidgetLabPresetNodes('approval-dialog');
    expect(nodes).toHaveLength(1);
    expect(typeof nodes[0]?.build).toBe('function');
  });

  test('buildWidgetLabPresetYAML returns yaml with declarative chrome', () => {
    const yaml = buildWidgetLabPresetYAML('approval-dialog');
    expect(yaml).toContain('widget: dialog');
    expect(yaml).toContain('title: Approve patch?');
    expect(yaml).toContain('variant: dialog');
  });

  test('text-area preset is authored through dedicated family builder', () => {
    const specs = buildWidgetLabPreset('notes-panel');
    expect(specs[0]).toMatchObject({
      type: 'text-area',
      chrome: { variant: 'panel', title: 'Notes' },
      config: {
        readOnly: true,
        wrap: true,
        maxLength: 800,
      },
    });

    const yaml = buildWidgetLabPresetYAML('notes-panel');
    expect(yaml).toContain('widget: text-area');
    expect(yaml).toContain('title: Notes');
  });

  test('buildWidgetLabPresetReferenceYAML returns compact preset yaml', () => {
    const yaml = buildWidgetLabPresetReferenceYAML('approval-dialog');
    expect(yaml).toContain('preset: approval-dialog');
  });

  test('preset lookup and cycling are stable', () => {
    expect(getWidgetLabPreset('notes-panel')?.title).toBe('Notes Panel');
    expect(getWidgetLabPreset('ask-user-flow')?.title).toBe('Ask User Flow');
    expect(cycleWidgetLabPreset('telemetry-stack')).not.toBe('telemetry-stack');
    expect(cycleWidgetLabPreset('telemetry-stack', -1)).toBeTruthy();
  });
});
