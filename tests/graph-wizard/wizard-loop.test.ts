import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadGraphTemplates } from '../../src/self-implement/graph-yaml';

const root = join(import.meta.dir, '..', '..');
const wizardDir = join(root, 'graphs', 'wizard');

describe('SW-WIZARD-LOOP-DECL production read', () => {
  test('SW-WIZARD-LOOP-DECL: graphs/wizard/ 에서 wizard-loop 만 그래프로 읽고 recipes.yaml 은 제외된다', () => {
    const loaded = loadGraphTemplates(wizardDir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.scannedFiles).toBe(1);
    expect(Object.keys(loaded.templates)).toEqual(['wizard-loop']);
    expect(loaded.templates['wizard-loop']!.entryNode).toBe('intake');
  });
});
