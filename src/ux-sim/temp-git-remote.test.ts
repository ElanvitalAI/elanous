import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { createTempGitRemote } from './temp-git-remote.js';

setDefaultTimeout(60_000);

describe('temporary Git remote', () => {
  it('clones main, exposes a real two-commit behind state, then removes origin', () => {
    const fixture = createTempGitRemote();
    try {
      expect(fixture.git(fixture.remote, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
      expect(fixture.git(fixture.checkout, ['rev-parse', 'HEAD']))
        .toBe(fixture.git(fixture.seed, ['rev-parse', 'HEAD']));
      fixture.advanceMain(2);
      expect(fixture.git(fixture.checkout, ['rev-list', '--count', 'HEAD..origin/main'])).toBe('2');
      fixture.advanceMain(1);
      expect(fixture.git(fixture.checkout, ['rev-list', '--count', 'HEAD..origin/main'])).toBe('3');
      fixture.removeOrigin();
      expect(fixture.git(fixture.checkout, ['remote'])).toBe('');
    } finally {
      fixture.cleanup();
      fixture.cleanup();
    }
    expect(existsSync(fixture.root)).toBe(false);
  });

  it('ignores inherited Git config and credentials', () => {
    const oldConfig = process.env.GIT_CONFIG_COUNT;
    const oldKey = process.env.GIT_CONFIG_KEY_0;
    const oldValue = process.env.GIT_CONFIG_VALUE_0;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'user.name';
    process.env.GIT_CONFIG_VALUE_0 = 'Host User';
    try {
      const fixture = createTempGitRemote();
      try {
        expect(fixture.git(fixture.seed, ['config', '--get', 'user.name'])).toBe('Test User');
        expect(fixture.gitEnv.GIT_CONFIG_COUNT).toBeUndefined();
        expect(fixture.gitEnv.GIT_TERMINAL_PROMPT).toBe('0');
        expect(fixture.gitEnv.GIT_CONFIG_GLOBAL).toBeTruthy();
      } finally { fixture.cleanup(); }
    } finally {
      if (oldConfig === undefined) delete process.env.GIT_CONFIG_COUNT; else process.env.GIT_CONFIG_COUNT = oldConfig;
      if (oldKey === undefined) delete process.env.GIT_CONFIG_KEY_0; else process.env.GIT_CONFIG_KEY_0 = oldKey;
      if (oldValue === undefined) delete process.env.GIT_CONFIG_VALUE_0; else process.env.GIT_CONFIG_VALUE_0 = oldValue;
    }
  });
});
