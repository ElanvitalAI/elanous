import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanCliJsonExits, scanJsonExitSource } from './cli-json-exit-scan.js';

test('reports only a raw JSON write followed by exit in the same function', () => {
  const source = [
    "const unsafe = async (opts: { json: boolean }) => {",
    "  if (opts.json) {",
    "    process.stdout.write(JSON.stringify({ x: 1 }));",
    "    process.exit(2);",
    "  }",
    "};",
    "const safe = async (options: { json: boolean }) => {",
    "  if (options.json) { await writeStdoutFully(JSON.stringify({ x: 1 })); process.exitCode = 2; return; }",
    "};",
  ].join('\n');
  expect(scanJsonExitSource(source, 'src/cli/example.ts')).toEqual([{ file: 'src/cli/example.ts', line: 3, exitLine: 4 }]);
});

test('ignores strings, comments, nested function exits and non-JSON handlers', () => {
  const source = `
const first = (opts: { json: boolean }) => {
  // process.stdout.write('x'); process.exit(1);
  const quoted = 'console.log(1); process.exit(1)';
  if (opts.json) { const nested = () => process.exit(1); console.log(quoted); }
};
const second = () => { console.log('ordinary'); process.exit(1); };
const third = (opts: { json: boolean }) => {
  if (opts.json) { await writeStdoutFully('ok'); return; }
  console.log('human only'); process.exit(1);
};`;
  expect(scanJsonExitSource(source, 'src/cli/example.ts')).toEqual([]);
});

test('recurses into CLI subdirectories and has JSON-serializable file:line findings', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-json-exit-'));
  try {
    mkdirSync(join(root, 'src/cli/deep'), { recursive: true });
    writeFileSync(join(root, 'src/index.ts'), '');
    writeFileSync(join(root, 'src/cli/deep/candidate.ts'), 'const fn = (options: any) => { if (options.json) { console.log("{}"); process.exit(3); } };');
    const found = scanCliJsonExits(root);
    expect(JSON.parse(JSON.stringify(found))).toEqual([{ file: 'src/cli/deep/candidate.ts', line: 1, exitLine: 1 }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('repository has no raw JSON output followed by immediate exit', () => {
  expect(scanCliJsonExits()).toEqual([]);
});

test('a JSON conditional console.log followed by exit is caught while a flushed write is not', () => {
  const unsafe = 'const f = (opts: any) => { console.log(opts.json ? JSON.stringify({a:1}) : "human"); process.exit(2); };';
  expect(scanJsonExitSource(unsafe, 'src/index.ts')).toEqual([{ file: 'src/index.ts', line: 1, exitLine: 1 }]);
  const safe = 'const f = async (opts: any) => { if (opts.json) await writeStdoutFully(JSON.stringify({a:1})); else console.log("human"); process.exitCode = 2; return; };';
  expect(scanJsonExitSource(safe, 'src/index.ts')).toEqual([]);
});

test('return in JSON arm prevents a later human-only exit from being reported', () => {
  const source = `const f = (opts: any) => {
    if (opts.json) { console.log('{}'); return; }
    process.exit(1);
  };`;
  expect(scanJsonExitSource(source, 'src/index.ts')).toEqual([]);
});
