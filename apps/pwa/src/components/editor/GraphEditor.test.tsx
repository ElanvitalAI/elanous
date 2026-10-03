import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import type { GraphKindEntry } from '@/nexus/client';
import { GraphEditorPalette } from './GraphEditor';

const palette: GraphKindEntry[] = [
  { graph: 'workflow', kind: 'worker', plugin: null, description: 'Worker node', schema: {}, core: true },
  { graph: 'workflow', kind: 'custom', plugin: 'demo', description: 'Custom node', schema: {}, core: false },
];

describe('GraphEditorPalette', () => {
  beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
  afterEach(() => { delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

  test('collapses the phone palette below 640px and keeps the existing wide palette', () => {
    let root: ReturnType<typeof create> | undefined;
    try {
      act(() => { root = create(<GraphEditorPalette palette={palette} fallback={false} />); });
      const details = root!.root.findByType('details');
      const wide = root!.root.findAllByProps({ 'aria-label': '노드 팔레트' }).find((node) => node.type === 'div')!;
      expect(details.props.open).toBeUndefined();
      expect(details.props.className).toContain('min-[640px]:hidden');
      expect(details.findByType('summary').children).toEqual(['노드 더하기 (', '2', ')']);
      expect(wide.props.className).toContain('hidden');
      expect(wide.props.className).toContain('min-[640px]:block');
      for (const container of [details, wide]) {
        expect(container.findByType('strong').children).toEqual(['노드 팔레트']);
        expect(container.findAllByType('span').map((node) => node.props.title)).toEqual(['Worker node', 'Custom node']);
        expect(container.findByType('small').children).toEqual(['demo']);
      }
    } finally {
      if (root) act(() => { root!.unmount(); });
    }
  });

  test('shows the core fallback notice in both palettes', () => {
    let root: ReturnType<typeof create> | undefined;
    try {
      act(() => { root = create(<GraphEditorPalette palette={palette} fallback={true} />); });
      expect(root!.root.findAllByProps({ role: 'status' })).toHaveLength(2);
      expect(root!.root.findByType('summary').children).toEqual(['노드 더하기 (', '2', ')']);
    } finally {
      if (root) act(() => { root!.unmount(); });
    }
  });
});
