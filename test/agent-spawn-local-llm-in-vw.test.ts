import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('removed virtual-window local LLM entry has no module to launch', () => {
  const legacyPath = fileURLToPath(new URL('../src/agent/spawn-local-llm-in-vw.ts', import.meta.url));
  expect(existsSync(legacyPath)).toBe(false);
});
