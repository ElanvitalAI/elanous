import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { spawnSyncText } from '../src/util/spawn-sync-output.js';

const ROOT = resolve(import.meta.dir, '..');

test('spawnSyncText reads a 2 MiB child output without truncation', () => {
  const output = spawnSyncText('bun', ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))']);
  expect(output.length).toBe(2 * 1024 * 1024);
  expect(output).toBe('x'.repeat(2 * 1024 * 1024));
});

test('spawnSyncText rejects a small maxBuffer rather than returning partial output', () => {
  expect(() => spawnSyncText('bun', ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
    { encoding: 'utf8', maxBuffer: 1024 })).toThrow(/ENOBUFS|maxBuffer|buffer/i);
});

test('repository git ls-files spawnSync readers specify maxBuffer or use spawnSyncText', () => {
  const args = ['-l', 'ls-files', '.', '-g', '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];
  const files = execFileSync('rg', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim().split('\n').filter(Boolean);
  expect(files.length).toBeGreaterThan(0);
  const violations: string[] = [];
  let covered = 0;
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(resolve(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
          (node.expression.text === 'spawnSync' || node.expression.text === 'spawnSyncText') &&
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'git' &&
          node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1]) &&
          node.arguments[1].elements.some((arg) => ts.isStringLiteral(arg) && arg.text === 'ls-files')) {
        covered++;
        const opts = node.arguments[2];
        if (node.expression.text === 'spawnSync' && (!opts || !ts.isObjectLiteralExpression(opts) ||
            !opts.properties.some((property) => ts.isPropertyAssignment(property) &&
              (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === 'maxBuffer'))) {
          violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(covered).toBeGreaterThan(0);
  expect(violations).toEqual([]);
});
