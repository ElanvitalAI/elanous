import { describe, expect, test } from 'bun:test';
import { loadDashboardMouseWiring } from './mouse-wiring-loader.js';

describe('dashboard mouse wiring lazy boundary', () => {
  test('loads the real mouse wiring factory at dashboard startup', async () => {
    const module = await loadDashboardMouseWiring();
    expect(typeof module.createDashboardMouseWiring).toBe('function');
  });
});
