import { expect, test } from 'bun:test';
import { createDashboardTermSlashRuntime } from './term-slash-runtime.js';

test('/term help distinguishes Ctrl+B background from Ctrl+X c control mode', () => {
  const plain = (text: string) => text;
  const help = createDashboardTermSlashRuntime({
    accent: plain, muted: plain, warning: plain, error: plain, text: plain,
  }).helpLines();
  expect(help).toContain('  Ctrl+B (while streaming)  Background running child tasks; turn continues.');
  expect(help).toContain('  Ctrl+X c (chat input)     Enter control mode.');
});
