import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { rmSync } from 'node:fs';

const script = resolve(import.meta.dir, 'train-side-invariants.sh');
const expected = [
  'scripts/ratchets/test-interference-patterns.test.ts',
  'scripts/ratchets/next-tui-entry-budget.test.ts',
  'src/domains/finance-cli.test.ts',
  'src/instance/state-dir-provenance-ratchet.test.ts',
  'src/self-implement/graph-yaml.test.ts',
  'src/self-implement/self-cli-sink-surface.test.ts',
  'test/identity-env.test.ts',
  'test/no-absolute-path-imports.test.ts',
  'test/scenarios/integration.test.ts',
  'test/rules-contract.test.ts',
  'test/hook-order-sweep.test.ts',
  'src/cli/g6a-commands.test.ts',
  'test/spawn-sync-max-buffer.test.ts',
  'test/telegram-coding-model-terra.test.ts',
];

function fixture(run: (root: string, env: NodeJS.ProcessEnv, calls: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'train-side-invariants-'));
  try {
    const bin = join(root, 'bin');
    const calls = join(root, 'calls');
    mkdirSync(bin);
    writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$2" >> "$TRAIN_INVARIANT_CALLS"\n[ "$2" != "$TRAIN_INVARIANT_FAIL_FILE" ]\n', { mode: 0o755 });
    for (const file of expected) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, '');
    }
    run(root, { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRAIN_INVARIANT_CALLS: calls }, calls);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('train-side invariant sentinel', () => {
  test('the fixed list contains the HARD regressions and release-critical invariants', () => {
    const listed = execFileSync('bash', [script, '--list'], { encoding: 'utf8' }).trim().split('\n');
    expect(listed).toEqual(expected);
  });

  test('runs every file and emits a complete pass marker', () => fixture((root, env, calls) => {
    const result = spawnSync('bash', [script, root], { env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`TRAIN_INVARIANTS_PASS files=${expected.length}`);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(expected);
  }));

  test('missing file fails before any test is run', () => fixture((root, env, calls) => {
    rmSync(join(root, expected[3]));
    const result = spawnSync('bash', [script, root], { env, encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(`TRAIN_INVARIANTS_UNMEASURED missing-file=${expected[3]}`);
    expect(() => readFileSync(calls)).toThrow();
  }));

  test('a failing test stops the side and names the file', () => fixture((root, env, calls) => {
    env.TRAIN_INVARIANT_FAIL_FILE = expected[2];
    const result = spawnSync('bash', [script, root], { env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`TRAIN_INVARIANTS_FAIL file=${expected[2]} rc=1`);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(expected.slice(0, 3));
  }));
});
