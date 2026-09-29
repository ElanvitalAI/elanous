import { describe, expect, test } from 'bun:test';
import { DENIED_IDS, STYLE_CATEGORIES, selectStyleSystems } from './vendor-open-design-systems';

describe('selectStyleSystems', () => {
  test('keeps style families, drops brand categories and denied ids, sorted by id', () => {
    const picked = selectStyleSystems([
      { id: 'minimal', name: 'Minimal', category: 'Modern & Minimal' },
      { id: 'apple', name: 'Apple', category: 'Media & Consumer' },
      { id: 'stripe', name: 'Stripe', category: 'Fintech & Crypto' },
      { id: 'brutalism', name: 'Brutalism', category: 'Bold & Expressive' },
      { id: 'material', name: 'Material', category: 'Professional & Corporate' },
      { id: 'pacman', name: 'Pacman', category: 'Themed & Unique' },
    ]);
    expect(picked.map((s) => s.id)).toEqual(['brutalism', 'minimal']);
  });

  test('no brand/industry category is in the style list', () => {
    for (const brandish of ['AI & LLM', 'Media & Consumer', 'Fintech & Crypto', 'Automotive', 'E-Commerce & Retail', 'Themed & Unique']) {
      expect(STYLE_CATEGORIES.has(brandish)).toBe(false);
    }
    for (const id of ['ant', 'material', 'lingo', 'levels']) expect(DENIED_IDS.has(id)).toBe(true);
  });
});
