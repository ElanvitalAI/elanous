import { setDefaultTimeout, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tempRoots: string[] = [];

function copy(relativePath: string, destinationRoot: string): string {
  const destination = join(destinationRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(join(root, relativePath), 'utf8'));
  return destination;
}

function runTypeScript(cwd: string, args: string[]) {
  return spawnSync('bun', [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function compile(rootDir: string) {
  return runTypeScript(rootDir, [
    '--noEmit', '--pretty', 'false', '--strict', '--target', 'ES2022', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', 'test/guardian/dispatch-surface-contract.fixture.ts',
  ]);
}

function outputOf(result: ReturnType<typeof compile>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function typeScriptDiagnosticPaths(output: string): string[] {
  return [...output.matchAll(/^(src\/[^\r\n(]+)\(\d+,\d+\): error TS\d+:/gm)].map(match => match[1]);
}

function createWholeProjectSentinel(): { tsconfigPath: string; sentinelPath: string } {
  const rootDir = mkdtempSync(join(root, '.dispatch-surface-whole-project-'));
  tempRoots.push(rootDir);
  const sentinelPath = join(rootDir, 'whole-project-sentinel.ts');
  const tsconfigPath = join(rootDir, 'tsconfig.json');
  writeFileSync(sentinelPath, "const wholeProjectSentinel: never = 'dispatch-surface-sentinel';\n");
  writeFileSync(tsconfigPath, JSON.stringify({
    extends: '../tsconfig.json',
    include: ['../src/**/*.ts', '../test/**/*.ts', './whole-project-sentinel.ts'],
  }));
  return { tsconfigPath, sentinelPath };
}

function createFixtureTree(): { rootDir: string; guardianTypes: string; verifierTypes: string } {
  const rootDir = mkdtempSync(join(tmpdir(), 'dispatch-surface-contract-'));
  tempRoots.push(rootDir);
  copy('src/tool-runtime/types.ts', rootDir);
  const guardianTypes = copy('src/guardian/types.ts', rootDir);
  const verifierTypes = copy('src/verifier/types.ts', rootDir);
  copy('src/tool-surface.ts', rootDir);
  const requestOrigin = readFileSync(join(root, 'src', 'policy', 'claude-subscription-guard.ts'), 'utf8')
    .match(/^export type RequestOrigin = [^;]+;/m)?.[0];
  if (!requestOrigin) throw new Error('Missing RequestOrigin declaration in claude-subscription-guard.ts');
  mkdirSync(join(rootDir, 'src', 'feedback'), { recursive: true });
  writeFileSync(join(rootDir, 'src', 'feedback', 'envelope.ts'), 'export interface FeedbackEnvelope {}\n');
  writeFileSync(join(rootDir, 'src', 'llm.ts'), 'export interface LLMToolSpec {}\n');
  mkdirSync(join(rootDir, 'src', 'hitl'), { recursive: true });
  writeFileSync(join(rootDir, 'src', 'hitl', 'confirm.ts'), 'export interface ConfirmChannel {}\n');
  mkdirSync(join(rootDir, 'src', 'policy'), { recursive: true });
  writeFileSync(join(rootDir, 'src', 'policy', 'claude-subscription-guard.ts'), `${requestOrigin}\n`);
  mkdirSync(join(rootDir, 'src', 'plugins', 'core'), { recursive: true });
  writeFileSync(join(rootDir, 'src', 'plugins', 'core', 'manifest.ts'), "export type PluginCapability = string;\nexport type PluginSource = string;\n");
  copy('test/guardian/dispatch-surface-contract.fixture.ts', rootDir);
  return { rootDir, guardianTypes, verifierTypes };
}

function replaceReceiverWithToolHost(path: string, receiver: 'guardian' | 'verifier'): void {
  const source = readFileSync(path, 'utf8');
  const replacement = receiver === 'guardian'
    ? source.replace(
      "import type { ToolRuntimeContext } from '../tool-runtime/types.js';",
      "import type { ToolHost } from '../tool-surface.js';",
    ).replace("export type GuardianSurface = ToolRuntimeContext['surface'];", 'export type GuardianSurface = ToolHost;')
    : source.replace(
      "import type { ToolRuntimeContext } from '../tool-runtime/types.js';",
      "import type { ToolHost } from '../tool-surface.js';",
    ).replace("surface: ToolRuntimeContext['surface'];", 'surface: ToolHost;');
  writeFileSync(path, replacement);
}

afterEach(() => {
  for (const rootDir of tempRoots.splice(0)) rmSync(rootDir, { recursive: true, force: true });
});

describe('tool runtime dispatch surface contract', () => {
  test('TypeScript accepts the runtime surface at both hook receivers', () => {
    const { rootDir } = createFixtureTree();
    const result = compile(rootDir);

    expect(result.status, outputOf(result)).toBe(0);
  });

  test('the whole-project compiler reaches a sentinel without target-file diagnostics', () => {
    const { tsconfigPath, sentinelPath } = createWholeProjectSentinel();
    const result = runTypeScript(root, ['--noEmit', '--pretty', 'false', '--project', tsconfigPath]);
    const output = outputOf(result);
    const diagnosticPaths = typeScriptDiagnosticPaths(output);
    const targetPaths = [
      'src/tool-runtime/registry.ts',
      'src/tool-runtime/types.ts',
      'src/guardian/types.ts',
      'src/verifier/types.ts',
    ];

    expect(result.status).not.toBe(null);
    expect(output).toContain(`${sentinelPath.slice(root.length + 1)}(1,7): error TS2322:`);
    expect(output).toContain('Type \'"dispatch-surface-sentinel"\' is not assignable to type \'never\'.');
    for (const targetPath of targetPaths) expect(diagnosticPaths).not.toContain(targetPath);
  }, 40_000);

  test('TypeScript rejects the prior ToolHost receiver contracts', () => {
    const guardianTree = createFixtureTree();
    replaceReceiverWithToolHost(guardianTree.guardianTypes, 'guardian');
    const guardianResult = compile(guardianTree.rootDir);
    expect(guardianResult.status).not.toBe(0);
    expect(outputOf(guardianResult)).toContain("Type '\"dashboard\"' is not assignable to type 'ToolHost'.");

    const verifierTree = createFixtureTree();
    replaceReceiverWithToolHost(verifierTree.verifierTypes, 'verifier');
    const verifierResult = compile(verifierTree.rootDir);
    expect(verifierResult.status).not.toBe(0);
    expect(outputOf(verifierResult)).toContain("Type '\"dashboard\"' is not assignable to type 'ToolHost'.");
  });
});
