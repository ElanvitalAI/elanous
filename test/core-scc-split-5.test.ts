import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { HarnessCliInputError as CoreHarnessCliInputError, isCliUserError } from '../src/cli/cli-user-error.js';
import { HarnessCliInputError as HarnessExport } from '../src/harness/harness-cli-command.js';
import { defaultUnixSocketPath as LeafSocketPath } from '../src/boot/acp-socket-path.js';
import { defaultUnixSocketPath as BootSocketPath } from '../src/boot/acp-server.js';
import { elanousDaemonSocketPath } from '../src/elanous-daemon.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../src/elanous-config-dir.js';

const repo = resolve(import.meta.dir, '..');
const sourcePaths = [
  ['src/cli/cli-user-error.ts', 5],
  ['src/elanous-daemon.ts', 60],
  ['src/boot/acp-socket-path.ts', 40],
] as const;

function importSpecifiers(source: string): string[] {
  const imports = ts.preProcessFile(source, true, true).importedFiles.map((entry) => entry.fileName);
  for (const match of source.matchAll(/\btypeof\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!imports.includes(match[1]!)) imports.push(match[1]!);
  }
  return imports;
}

function localDependencies(path: string): string[] {
  return importSpecifiers(readFileSync(path, 'utf8'))
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => {
      const target = resolve(dirname(path), specifier);
      return target.replace(/\.(?:js|mjs)$/, '.ts');
    })
    .filter((target) => existsSync(target));
}

function firstImportPath(root: string, counted: Set<string>): string {
  const queue: string[][] = [[resolve(repo, root)]];
  const seen = new Set<string>();
  while (queue.length) {
    const chain = queue.shift()!;
    const current = chain[chain.length - 1]!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (chain.length > 1 && counted.has(current)) {
      return chain.map((path) => relative(repo, path)).join(' → ');
    }
    for (const dependency of localDependencies(current)) {
      if (!seen.has(dependency)) queue.push([...chain, dependency]);
    }
  }
  return root;
}

function tscSourceFiles(root: string): Set<string> {
  const result = spawnSync(join(repo, 'node_modules/.bin/tsc'), [
    '--listFilesOnly', '--noEmit', '--target', 'ES2022', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--types', 'bun-types', root,
  ], { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`tsc --listFilesOnly ${root}: ${result.error ?? result.stderr ?? result.stdout}`);
  return new Set(result.stdout.split(/\r?\n/)
    .filter((line) => relative(repo, resolve(line)).startsWith('src/'))
    .map((line) => resolve(line)));
}

describe('CORE-SCC-SPLIT-5', () => {
  for (const [root, limit] of sourcePaths) {
    test(`${root} has at most ${limit} repository src files in standalone tsc`, () => {
      const files = tscSourceFiles(root);
      console.log(`${root}: ${files.size} repository src files (limit ${limit})`);
      expect(files.size, `${root}: ${files.size} > ${limit}; first import path: ${firstImportPath(root, files)}`)
        .toBeLessThanOrEqual(limit);
    });
  }

  test('leaf import boundaries and injected forbidden edge', () => {
    const cli = readFileSync(join(repo, 'src/cli/cli-user-error.ts'), 'utf8');
    const daemon = readFileSync(join(repo, 'src/elanous-daemon.ts'), 'utf8');
    const forbiddenHarness = (source: string) => importSpecifiers(source).filter((path) => path.includes('harness/'));
    const forbiddenServer = (source: string) => importSpecifiers(source).filter((path) => path.endsWith('boot/acp-server.js'));
    expect(forbiddenHarness(cli)).toHaveLength(0);
    expect(forbiddenServer(daemon)).toHaveLength(0);
    expect(forbiddenHarness("import { HarnessCliInputError } from '../harness/harness-cli-command.js';\n" + cli))
      .toEqual(['../harness/harness-cli-command.js']);
    expect(forbiddenServer("type Socket = typeof import('./boot/acp-server.js');\n" + daemon))
      .toEqual(['./boot/acp-server.js']);
  });

  test('harness re-export retains class identity, name and brand classification', () => {
    expect(HarnessExport).toBe(CoreHarnessCliInputError);
    for (const Constructor of [CoreHarnessCliInputError, HarnessExport]) {
      const error = new Constructor('x');
      expect(error.name).toBe('HarnessCliInputError');
      expect(Object.getOwnPropertyDescriptor(error, Symbol.for('elanous.cli.HarnessCliInputError'))?.value).toBe(true);
      expect(isCliUserError(error)).toBe(true);
    }
  });

  test('boot re-export and daemon use the same configurable socket path', () => {
    setElanousConfigDir(join(repo, '.elanous-test', 'core-scc-split-5'));
    try {
      const expected = join(repo, '.elanous-test', 'core-scc-split-5', 'elanous.sock');
      expect(LeafSocketPath()).toBe(expected);
      expect(BootSocketPath).toBe(LeafSocketPath);
      expect(BootSocketPath()).toBe(expected);
      expect(elanousDaemonSocketPath()).toBe(expected);
    } finally {
      resetElanousConfigDir();
    }
  });
});
