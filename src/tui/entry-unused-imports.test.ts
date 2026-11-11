import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dir, '../..');
const UNUSED_DIAGNOSTIC_CODES = new Set([6133, 6138, 6192, 6196, 6198, 6199]);
const isUnusedDiagnostic = (diagnostic: ts.Diagnostic): boolean => UNUSED_DIAGNOSTIC_CODES.has(diagnostic.code);
const ENTRY_FILES = [
  'src/tui/entry.ts',
  'src/tui/core/input.ts',
  'src/tui/core/entry-render.ts',
  'src/esc-shell-timing.ts',
] as const;

// Use the project compiler's own noUnusedLocals diagnostic on the Next entry and shell seam.
// This catches unused value imports without inspecting the classic dashboard implementation.
test('Next TUI entry and shell have no unused imports or locals', () => {
  const configPath = join(ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const paths = ENTRY_FILES.map((path) => join(ROOT, path));
  const program = ts.createProgram(paths, { ...parsed.options, noEmit: true, noUnusedLocals: true });
  const violations = paths.flatMap((path) => {
    const source = program.getSourceFile(path);
    if (!source) throw new Error(`TypeScript source missing: ${path}`);
    return program.getSemanticDiagnostics(source)
      .filter(isUnusedDiagnostic)
      .map((diagnostic) => `${path.slice(ROOT.length + 1)}:${source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  });
  expect(violations).toEqual([]);
}, 15_000);

test("unused-import guard catches TS6198 when every destructured element is unused", () => {
  const fixture = join(ROOT, "src/tui/__unused-destructure-fixture.ts");
  const source = "export function check(x: { a: number; b: number }) { const { a, b } = x; return 1; }";
  const options: ts.CompilerOptions = { noEmit: true, noUnusedLocals: true };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === fixture
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const diagnostics = ts.createProgram([fixture], options, host).getSemanticDiagnostics();
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(6198);
  expect(diagnostics.filter(isUnusedDiagnostic).map((diagnostic) => diagnostic.code)).toContain(6198);
});

test("unused-import guard catches TS6199 when every variable declaration is unused", () => {
  const fixture = join(ROOT, "src/tui/__unused-variable-list-fixture.ts");
  const source = "export function check() { const a = 1, b = 2; return 1; }";
  const options: ts.CompilerOptions = { noEmit: true, noUnusedLocals: true };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    fileName === fixture
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const diagnostics = ts.createProgram([fixture], options, host).getSemanticDiagnostics();
  expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(6199);
  expect(diagnostics.filter(isUnusedDiagnostic).map((diagnostic) => diagnostic.code)).toContain(6199);
});
