import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseSimWorldExpectTable } from '../expect.js';

test('seed-7 capsule world registers C4 and C3-ESC product scenarios', () => {
  const world = join(import.meta.dir, '../../worlds');
  const pack = parseYaml(readFileSync(join(world, 'sim-world-capsule-events.yaml'), 'utf8')) as {
    scenarios: Array<{ id: string; module: string }>;
  };
  const table = parseSimWorldExpectTable(readFileSync(join(world, 'sim-world-expect.json'), 'utf8'));
  expect(pack.scenarios).toContainEqual({ id: 'C4', module: 'src/ux-sim/sim-world/capsule-events/c4-agent-background.ts' });
  expect(pack.scenarios).toContainEqual({ id: 'C3-ESC', module: 'src/ux-sim/sim-world/capsule-events/c3-esc-cancel.ts' });
  expect(table.entries['capsule-events/C4']?.expect).toBe('green');
  expect(table.entries['capsule-events/C3-ESC']?.expect).toBe('green');
});
