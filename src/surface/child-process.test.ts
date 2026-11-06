import { expect, test } from 'bun:test';
import { spawnWithOwnedStderr } from './child-process.js';

test('spawnWithOwnedStderr keeps stdout piped for JSON report consumers', async () => {
  const child = spawnWithOwnedStderr([
    process.execPath,
    '-e',
    "process.stdout.write('{\"allPass\":true}');",
  ]);

  if (!(child.stdout instanceof ReadableStream)) throw new Error('spawnWithOwnedStderr did not pipe stdout');
  const output = await new Response(child.stdout).text();
  await child.exited;

  expect(child.exitCode).toBe(0);
  expect(JSON.parse(output)).toEqual({ allPass: true });
});
