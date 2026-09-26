import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveCurrentInstance } from '../src/instance/current.js';
import { prodInstanceRoot } from '../src/instance/resolve.js';

const withStateDir = <T>(stateDir: string | undefined, fn: () => T): T => {
  const previous = process.env.ELANOUS_STATE_DIR;
  if (stateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = stateDir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
  }
};

describe('resolveCurrentInstance', () => {
  test('ELANOUS_STATE_DIR test root is resolved as test through the runtime input assembly', () => {
    const testRoot = join(process.cwd(), '.elanous-test');
    const result = withStateDir(testRoot, () => resolveCurrentInstance({
      treeDerivedEnabled: () => false,
    }));

    expect(result.kind).toBe('test');
    expect(result.layer).toBe('parent-stamp');
    expect(result.root).toBe(testRoot);
  });

  test('ELANOUS_STATE_DIR production root is resolved as prod through the runtime input assembly', () => {
    const prodRoot = prodInstanceRoot();
    const result = withStateDir(prodRoot, () => resolveCurrentInstance({
      treeDerivedEnabled: () => false,
    }));

    expect(result.kind).toBe('prod');
    expect(result.layer).toBe('parent-stamp');
    expect(result.root).toBe(prodRoot);
  });

  test('an explicit test root wins over the parent stamp', () => {
    const explicitRoot = join(process.cwd(), '.elanous-test-explicit');
    const result = withStateDir(prodInstanceRoot(), () => resolveCurrentInstance({
      explicitFlagRoot: () => explicitRoot,
      treeDerivedEnabled: () => false,
    }));

    expect(result.kind).toBe('test');
    expect(result.layer).toBe('explicit-flag');
    expect(result.root).toBe(explicitRoot);
  });

  test('with no flag or stamp, a source tree stays isolated even if the retired switch is disabled', () => {
    const result = withStateDir(undefined, () => resolveCurrentInstance({
      explicitFlagRoot: () => undefined,
      treeDerivedEnabled: () => false,
    }));

    expect(result.kind).toBe('test');
    expect(result.layer).toBe('tree-derived');
    expect(result.root).toBe(join(process.cwd(), '.elanous-test'));
  });
});
