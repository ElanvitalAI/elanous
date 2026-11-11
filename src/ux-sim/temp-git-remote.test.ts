import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempGitRemote } from './temp-git-remote.js';

setDefaultTimeout(60_000);

describe('temporary Git remote', () => {
  it('rejects a pushInsteadOf rewrite before either local remote changes', () => {
    const fixture = createTempGitRemote();
    const rogue = createTempGitRemote();
    try {
      const pinnedBefore = fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main']);
      const rogueBefore = rogue.git(rogue.remote, ['rev-parse', 'refs/heads/main']);
      fixture.git(fixture.checkout, ['config', '--local', '--add', `url.${rogue.remote}.pushInsteadOf`, fixture.remote]);
      writeFileSync(join(fixture.checkout, 'README.md'), 'rewritten target\n');
      fixture.git(fixture.checkout, ['add', 'README.md']);
      fixture.git(fixture.checkout, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'rewrite']);
      expect(() => fixture.pushCheckoutMain()).toThrow('Git push URL rewrite');
      expect(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main'])).toBe(pinnedBefore);
      expect(rogue.git(rogue.remote, ['rev-parse', 'refs/heads/main'])).toBe(rogueBefore);
    } finally { fixture.cleanup(); rogue.cleanup(); }
  });

  it('rejects a real pushInsteadOf value containing a newline without changing either remote', () => {
    const fixture = createTempGitRemote();
    const rogue = createTempGitRemote();
    try {
      const pinnedBefore = fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main']);
      const rogueBefore = rogue.git(rogue.remote, ['rev-parse', 'refs/heads/main']);
      const rewriteKey = `url.${rogue.remote}.pushInsteadOf`;
      const rewriteValue = `${fixture.remote}\nshadow`;
      fixture.git(fixture.checkout, ['config', '--local', '--add', rewriteKey, rewriteValue]);
      expect(fixture.git(fixture.checkout, ['config', '--local', '--get', rewriteKey])).toBe(rewriteValue);
      writeFileSync(join(fixture.checkout, 'README.md'), 'newline value\n');
      fixture.git(fixture.checkout, ['add', 'README.md']);
      fixture.git(fixture.checkout, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'newline value']);
      expect(() => fixture.pushCheckoutMain()).toThrow('Git push URL rewrite');
      expect(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main'])).toBe(pinnedBefore);
      expect(rogue.git(rogue.remote, ['rev-parse', 'refs/heads/main'])).toBe(rogueBefore);
    } finally { fixture.cleanup(); rogue.cleanup(); }
  });

  it('pushes to its pinned bare remote even when origin has a different pushurl', () => {
    const fixture = createTempGitRemote();
    const rogue = createTempGitRemote();
    try {
      const pinnedBefore = fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main']);
      const rogueBefore = rogue.git(rogue.remote, ['rev-parse', 'refs/heads/main']);
      fixture.git(fixture.checkout, ['remote', 'set-url', '--push', 'origin', rogue.remote]);
      writeFileSync(join(fixture.checkout, 'README.md'), 'pinned target\n');
      fixture.git(fixture.checkout, ['add', 'README.md']);
      fixture.git(fixture.checkout, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'pinned']);
      const after = fixture.git(fixture.checkout, ['rev-parse', 'HEAD']);
      expect(fixture.pushCheckoutMain()).toEqual({ before: pinnedBefore, after });
      expect(fixture.git(fixture.remote, ['rev-parse', 'refs/heads/main'])).toBe(after);
      expect(rogue.git(rogue.remote, ['rev-parse', 'refs/heads/main'])).toBe(rogueBefore);
    } finally { fixture.cleanup(); rogue.cleanup(); }
  });

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
