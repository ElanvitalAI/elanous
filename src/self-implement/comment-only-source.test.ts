import { expect, test } from 'bun:test';
import { isCommentOnlySourceChange } from './comment-only-source.js';

test('a JSDoc example change with identical code and whitespace is comment only', () => {
  const before = '/** username: `@private_bot` */\nexport const bot = 1;\n';
  const after = '/** username: `@example_bot` */\nexport const bot = 1;\n';
  expect(isCommentOnlySourceChange(before, after, 'src/user-config.ts')).toBe(true);
});

test('code, whitespace and comment newline changes retain importer coverage', () => {
  const before = '/** example */\nexport const bot = 1;\n';
  expect(isCommentOnlySourceChange(before, '/** example */\nexport const bot = 2;\n', 'src/a.ts')).toBe(false);
  expect(isCommentOnlySourceChange(before, '/** changed */\n\nexport const bot = 1;\n', 'src/a.ts')).toBe(false);
  expect(isCommentOnlySourceChange(before, '/** changed\n example */\nexport const bot = 1;\n', 'src/a.ts')).toBe(false);
  expect(isCommentOnlySourceChange(before, before, 'src/a.ts')).toBe(false);
});

test('TypeScript directives and semantic JSDoc tags retain importer coverage', () => {
  expect(isCommentOnlySourceChange('// @ts-ignore\nconst n: number = "x";\n', '// note\nconst n: number = "x";\n', 'src/a.ts')).toBe(false);
  expect(isCommentOnlySourceChange('/** @type {string} */\nconst n = 1;\n', '/** @type {number} */\nconst n = 1;\n', 'src/a.js')).toBe(false);
  expect(isCommentOnlySourceChange('/** @internal */\nexport const n = 1;\n', '/** public */\nexport const n = 1;\n', 'src/a.ts')).toBe(false);
  for (const tag of ['private', 'public', 'protected', 'override', 'futureTag']) {
    expect(isCommentOnlySourceChange(`/** @${tag} */\nexport const n = 1;\n`, '/** public prose */\nexport const n = 1;\n', 'src/a.ts')).toBe(false);
  }
  expect(isCommentOnlySourceChange('/// <reference path="a" />\nconst n = 1;\n', '/// <reference path="b" />\nconst n = 1;\n', 'src/a.ts')).toBe(false);
});

test('unattached comments are retained conservatively', () => {
  expect(isCommentOnlySourceChange('const n = (/* a */ 1);\n', 'const n = (/* b */ 1);\n', 'src/a.ts')).toBe(false);
  expect(isCommentOnlySourceChange('// ordinary note\nexport const n = 1;\n', '// changed note\nexport const n = 1;\n', 'src/a.ts')).toBe(false);
});
