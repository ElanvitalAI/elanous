import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';

const registryPath = resolve(import.meta.dir, 'coord-tracks.json');

test('four existing positions use claude-code without assigning a runtime to the legacy entry', async () => {
  const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
    tracks: Array<{ id: string; runtime?: string }>;
  };
  expect(registry.tracks.map(({ id }) => id)).toEqual(['OP', 'MK', 'TC', 'UX', 'E']);
  expect(registry.tracks.slice(0, 4).map(({ runtime }) => runtime)).toEqual(Array(4).fill('claude-code'));
  expect(registry.tracks[4]).not.toHaveProperty('runtime');
});
