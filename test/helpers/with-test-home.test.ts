import { describe, expect, it } from 'bun:test';
import { homedir } from 'node:os';
import { withTestHome } from './with-test-home.js';

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
