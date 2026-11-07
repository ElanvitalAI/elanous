import { describe, expect, test } from 'bun:test';
import { shouldSkipKernelPtyIntegration } from './host-pty.js';

describe('shouldSkipKernelPtyIntegration', () => {
  test('keeps the kernel PTY assertion active with node-pty outside a Pod', () => {
    expect(shouldSkipKernelPtyIntegration({ nodePtyAvailable: true })).toBe(false);
  });

  test('skips only the unsupported kernel PTY assertion in the gate Pod', () => {
    expect(shouldSkipKernelPtyIntegration({ nodePtyAvailable: true, substrate: 'pod' })).toBe(true);
  });

  test('skips when the optional native node-pty binding is absent', () => {
    expect(shouldSkipKernelPtyIntegration({ nodePtyAvailable: false, substrate: 'host' })).toBe(true);
  });
});
