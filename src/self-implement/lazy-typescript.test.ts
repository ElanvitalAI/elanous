import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('lazy TypeScript module delays loading until first API access and reuses the cached compiler', () => {
  const modulePath = join(import.meta.dir, 'lazy-typescript.js');
  const script = `
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const url = pathToFileURL(${JSON.stringify(modulePath)}).href;
    const require = createRequire(url);
    const compilerPath = () => Object.keys(require.cache).find((path) => /[/\\\\]typescript[/\\\\]lib[/\\\\]typescript\\.js$/.test(path));

    await import(url);
    if (compilerPath()) throw new Error('TypeScript loaded during lazy module import');
    const { default: ts } = await import(url);
    if (compilerPath()) throw new Error('TypeScript loaded before API access');
    void ts.ScriptTarget;
    const loadedPath = compilerPath();
    if (!loadedPath) throw new Error('TypeScript did not load on first API access');
    const loadedModule = require.cache[loadedPath].exports;
    const source = ts.createSourceFile('example.ts', 'const answer: number = 42;', ts.ScriptTarget.Latest, true);
    if (source.statements.length !== 1 || !ts.isVariableStatement(source.statements[0])) throw new Error('TypeScript API did not parse the source');
    if (require.cache[loadedPath].exports !== loadedModule) throw new Error('TypeScript module cache entry changed');
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: import.meta.dir,
    encoding: 'utf8',
    timeout: 10_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});

test('comment-only source analysis loads TypeScript only when the analysis runs', () => {
  const consumerPath = join(import.meta.dir, 'comment-only-source.js');
  const script = `
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const url = pathToFileURL(${JSON.stringify(consumerPath)}).href;
    const require = createRequire(url);
    const compilerPath = () => Object.keys(require.cache).find((path) => /[/\\\\]typescript[/\\\\]lib[/\\\\]typescript\\.js$/.test(path));

    const { isCommentOnlySourceChange } = await import(url);
    if (compilerPath()) throw new Error('consumer import eagerly loaded TypeScript');
    const before = '/** Previous prose. */\\nexport const answer = 42;\\n';
    const after = '/** Revised prose. */\\nexport const answer = 42;\\n';
    if (!isCommentOnlySourceChange(before, after, 'example.ts')) throw new Error('consumer analysis did not detect a comment-only change');
    if (!compilerPath()) throw new Error('consumer analysis did not load TypeScript');
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: import.meta.dir,
    encoding: 'utf8',
    timeout: 10_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
