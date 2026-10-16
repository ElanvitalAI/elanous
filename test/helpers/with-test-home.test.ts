import { describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import { withTestEnv, withTestHome } from './with-test-home.js';

describe('withTestHome', () => {
  it('sets HOME and os.homedir() together across an await, then restores both', async () => {
    const previousHome = process.env.HOME;
    const previousHomedir = homedir();
    const result = await withTestHome('/tmp/with-test-home-fixture', async () => {
      await Promise.resolve();
      expect(process.env.HOME).toBe('/tmp/with-test-home-fixture');
      expect(homedir()).toBe('/tmp/with-test-home-fixture');
      return 'done';
    });
    expect(result).toBe('done');
    expect(process.env.HOME).toBe(previousHome);
    expect(homedir()).toBe(previousHomedir);
  });

  it('restores both after a rejected callback, including an initially absent HOME', async () => {
    const previousHome = process.env.HOME;
    const previousHomedir = homedir();
    delete process.env.HOME;
    try {
      await expect(withTestHome('/tmp/with-test-home-rejected', async () => {
        expect(homedir()).toBe('/tmp/with-test-home-rejected');
        expect(process.env.HOME).toBe('/tmp/with-test-home-rejected');
        throw new Error('callback failed');
      })).rejects.toThrow('callback failed');
      expect('HOME' in process.env).toBe(false);
      expect(homedir()).toBe(previousHomedir);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

describe('withTestEnv', () => {
  it('sets and removes keys for the callback, then restores values and absences exactly — also after a throw', async () => {
    const saved = { A: process.env.R4_WITH_TEST_ENV_A, B: process.env.R4_WITH_TEST_ENV_B };
    process.env.R4_WITH_TEST_ENV_A = 'outer';
    delete process.env.R4_WITH_TEST_ENV_B;
    try {
      await expect(withTestEnv({ R4_WITH_TEST_ENV_A: undefined, R4_WITH_TEST_ENV_B: 'inner' }, async () => {
        await Promise.resolve();
        expect('R4_WITH_TEST_ENV_A' in process.env).toBe(false);
        expect(process.env.R4_WITH_TEST_ENV_B).toBe('inner');
        throw new Error('callback failed');
      })).rejects.toThrow('callback failed');
      expect(process.env.R4_WITH_TEST_ENV_A).toBe('outer');
      expect('R4_WITH_TEST_ENV_B' in process.env).toBe(false);
    } finally {
      if (saved.A === undefined) delete process.env.R4_WITH_TEST_ENV_A; else process.env.R4_WITH_TEST_ENV_A = saved.A;
      if (saved.B === undefined) delete process.env.R4_WITH_TEST_ENV_B; else process.env.R4_WITH_TEST_ENV_B = saved.B;
    }
  });

  it('a HOME entry moves os.homedir() too; without HOME the homedir is left alone', async () => {
    const previousHomedir = homedir();
    await withTestEnv({ HOME: '/tmp/with-test-env-home', R4_WITH_TEST_ENV_A: 'x' }, () => {
      expect(homedir()).toBe('/tmp/with-test-env-home');
    });
    expect(homedir()).toBe(previousHomedir);
    await withTestEnv({ R4_WITH_TEST_ENV_A: 'x' }, () => { expect(homedir()).toBe(previousHomedir); });
  });

  it('refuses to remove HOME (os.homedir() would fall back to the real home) and changes nothing', async () => {
    const previousHome = process.env.HOME;
    const previousHomedir = homedir();
    let ran = false;
    await expect(withTestEnv({ HOME: undefined, R4_WITH_TEST_ENV_A: 'x' }, () => { ran = true; }))
      .rejects.toThrow('HOME cannot be removed');
    expect(ran).toBe(false);
    expect(process.env.HOME).toBe(previousHome);
    expect(homedir()).toBe(previousHomedir);
    expect('R4_WITH_TEST_ENV_A' in process.env).toBe(false);
  });
});
