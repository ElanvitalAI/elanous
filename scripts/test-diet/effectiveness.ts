import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { pickRange } from './lib.js';

export type Flake = 'stable' | 'flaky' | 'failing';
export type Mutation = 'caught' | 'survived' | 'n/a';
export type TestRun = { rc: number | null; pass: number | null; fail: number | null };

export function flakeVerdict(runs: Array<{ rc: number | null; pass: number | null; fail: number | null }>): Flake {
  if (runs.length !== 3) throw new Error('flakeVerdict requires exactly 3 runs');
  const passed = runs.map((r) => r.rc === 0 && (r.fail === null || r.fail === 0) && r.pass !== null && r.pass > 0);
  return passed.every(Boolean) ? 'stable' : passed.some(Boolean) ? 'flaky' : 'failing';
}

export function sweepSlice({ totalCostSecs, runsPerDay = 4, days = 7, safety = 1.2, files, costs, start = 0, remaining = files?.length, slotsLeft = runsPerDay * days, minBudgetSecs = 0 }: {
  totalCostSecs: number; runsPerDay?: number; days?: number; safety?: number;
  files?: readonly string[]; costs?: ReadonlyMap<string, number>; start?: number; remaining?: number; slotsLeft?: number; minBudgetSecs?: number;
}): { budgetSecs: number; slicesNeeded: number } {
  if (![totalCostSecs, runsPerDay, days, safety].every((n) => Number.isFinite(n) && n > 0)) throw new Error('sweepSlice requires positive finite inputs');
  const baseBudget = totalCostSecs / (runsPerDay * days) * safety;
  if (!files) return { budgetSecs: baseBudget, slicesNeeded: Math.ceil(totalCostSecs / baseBudget) };
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(remaining) || remaining! < 0 || remaining! > files.length
    || !Number.isSafeInteger(slotsLeft) || slotsLeft < 1 || !Number.isFinite(minBudgetSecs) || minBudgetSecs < 0)
    throw new Error('sweepSlice requires a valid cursor, remaining file count and slots');
  const sliceCount = (budget: number): number => {
    let cursor = start;
    let visited = 0;
    let count = 0;
    while (visited < remaining!) {
      const slice = pickRange(files, cursor, costs ?? new Map(), budget);
      visited += slice.files.length;
      cursor = slice.next;
      count++;
    }
    return count;
  };
  const target = slotsLeft;
  let budgetSecs = Math.max(baseBudget, minBudgetSecs);
  let slicesNeeded = sliceCount(budgetSecs);
  if (slicesNeeded > target) {
    // Whole files cannot be split across slices. Grow the budget until the actual cursor walk fits.
    let low = budgetSecs;
    let high = budgetSecs;
    do {
      high *= 2;
      if (!Number.isFinite(high)) throw new Error('sweepSlice budget overflow');
    } while (sliceCount(high) > target);
    for (let i = 0; i < 48; i++) {
      const mid = (low + high) / 2;
      if (sliceCount(mid) > target) low = mid;
      else high = mid;
    }
    budgetSecs = high;
    slicesNeeded = sliceCount(budgetSecs);
  }
  return { budgetSecs, slicesNeeded };
}

const repositoryRead = /\b(?:readdirSync|globSync|new\s+Glob)\b|['"]ls-files['"]|\b(?:execFileSync\s*\(\s*['"]git['"]|spawnSync\s*\(\s*['"](?:git|rg)['"])/;

/** Static signal only: literal count assertions coupled to a direct repository reader. */
export function fixedCountAssertions(testPath: string, root: string): Array<{ line: number; count: number }> {
  const repo = realpathSync(resolve(root));
  const testFile = resolve(repo, testPath);
  const inside = (path: string) => path !== repo && !relative(repo, path).startsWith(`..${sep}`)
    && relative(repo, path) !== '..' && !isAbsolute(relative(repo, path));
  if (!inside(testFile) || realpathSync(testFile) !== testFile) throw new Error('test path outside repository or symlinked');
  const text = readFileSync(testFile, 'utf8');
  const source = ts.createSourceFile(testFile, text, ts.ScriptTarget.Latest, true);
  let readsRepository = repositoryRead.test(text);
  if (!readsRepository) {
    const imports: string[] = [];
    const collectImports = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) imports.push(node.arguments[0]!.text);
      ts.forEachChild(node, collectImports);
    };
    collectImports(source);
    for (const specifier of imports) {
      if (!/^\.{1,2}\//.test(specifier)) continue;
      const base = resolve(dirname(testFile), specifier);
      const candidates = base.endsWith('.js')
        ? [base.replace(/\.js$/, '.ts'), base, `${base}.ts`, join(base, 'index.ts')]
        : [base, `${base}.ts`, join(base, 'index.ts')];
      for (const candidate of candidates) {
        if (!inside(candidate) || !existsSync(candidate) || realpathSync(candidate) !== candidate || !statSync(candidate).isFile()) continue;
        if (repositoryRead.test(readFileSync(candidate, 'utf8'))) readsRepository = true;
        break;
      }
      if (readsRepository) break;
    }
  }
  if (!readsRepository) return [];

  const assertions: Array<{ line: number; count: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length === 1
      && ['toBe', 'toEqual', 'toHaveLength'].includes(node.expression.name.text)
      && ts.isNumericLiteral(node.arguments[0]!)
      && /^(?:\d[\d_]*|0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+)$/.test(node.arguments[0]!.text)) {
      const receiver = node.expression.expression;
      if (ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression) && receiver.expression.text === 'expect'
        && receiver.arguments.length === 1) {
        const line = source.getLineAndCharacterOfPosition(receiver.getStart(source)).line + 1;
        const matcherLine = source.getLineAndCharacterOfPosition(node.expression.name.getStart(source)).line + 1;
        if (line === matcherLine && (node.expression.name.text === 'toHaveLength'
          || /\.(?:length|size)\b|\bcount\b/.test(receiver.arguments[0]!.getText(source)))) {
          assertions.push({ line, count: Number(node.arguments[0]!.text.replaceAll('_', '')) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return assertions.sort((a, b) => a.line - b.line);
}

export function mutationProbe(file: string, deps: { root: string; run?: (root: string, file: string) => number | null; baselineStable?: boolean }): Mutation {
  if (deps.baselineStable === false) return 'n/a';
  const root = realpathSync(resolve(deps.root));
  const testPath = resolve(root, file);
  const inside = (path: string) => path !== root && !relative(root, path).startsWith(`..${sep}`) && relative(root, path) !== '..' && !isAbsolute(relative(root, path));
  if (!inside(testPath) || realpathSync(testPath) !== testPath) throw new Error('test path outside repository or symlinked');
  const source = readFileSync(testPath, 'utf8');
  // Only direct relative imports into src/ qualify; never mutate the test or an external dependency.
  const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g);
  let target: string | undefined;
  let changed: string | undefined;
  for (const match of imports) {
    const base = resolve(dirname(testPath), match[1]!);
    for (const candidate of [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')]) {
      if (!inside(candidate) || !relative(root, candidate).startsWith(`src${sep}`) || !existsSync(candidate) || realpathSync(candidate) !== candidate) continue;
      const original = readFileSync(candidate, 'utf8');
      const mutation = original.includes('return true') ? original.replace('return true', 'return false')
        : original.includes('===') ? original.replace('===', '!==') : undefined;
      if (!mutation) return 'n/a';
      target = candidate;
      changed = mutation;
      break;
    }
    if (target) break;
  }
  if (!target || changed === undefined) return 'n/a';
  // Real path up front: on macOS tmpdir is under /var → /private/var, and the symlink guards below compare real paths.
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'test-diet-mutation-')));
  try {
    const clone = join(temp, 'repo');
    const copied = spawnSync('git', ['clone', '--quiet', '--no-hardlinks', '--', root, clone], { encoding: 'utf8', timeout: 300_000 });
    if (copied.status !== 0) throw new Error(`mutation copy failed: ${copied.error?.message ?? copied.stderr}`);
    // Copy the actual file bytes (including uncommitted fixture edits) into the isolated clone.
    for (const path of [testPath, target]) {
      const destination = join(clone, relative(root, path));
      mkdirSync(dirname(destination), { recursive: true });
      if (existsSync(destination) && realpathSync(destination) !== destination) throw new Error('mutation copy destination is symlinked');
      cpSync(path, destination);
    }
    if (!deps.run && existsSync(join(clone, 'package.json'))) {
      const install = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: clone, timeout: 300_000, stdio: 'ignore' });
      if (install.status !== 0) throw new Error('mutation copy install failed');
      if (relative(root, testPath).startsWith(`apps${sep}pwa${sep}`) && existsSync(join(clone, 'apps/pwa/package.json'))) {
        const pwa = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: join(clone, 'apps/pwa'), timeout: 300_000, stdio: 'ignore' });
        if (pwa.status !== 0) throw new Error('mutation copy PWA install failed');
      }
    }
    const targetInCopy = join(clone, relative(root, target));
    if (existsSync(targetInCopy) && realpathSync(targetInCopy) !== targetInCopy) throw new Error('mutation target in copy is symlinked');
    const testFile = `./${relative(root, testPath)}`;
    const command = existsSync(join(clone, 'scripts/test-deterministic.ts'))
      ? ['run', 'scripts/test-deterministic.ts', testFile] : ['test', testFile];
    const runTest = () => deps.run ? { status: deps.run(clone, relative(root, testPath)), stdout: '', stderr: '' }
      : spawnSync('bun', command, { cwd: clone, timeout: 300_000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (deps.baselineStable !== true) {
      for (let i = 0; i < 3; i++) {
        const baseline = runTest();
        if (baseline.status === null) throw new Error('baseline test did not complete');
        if (baseline.status !== 0) return 'n/a';
      }
    }
    writeFileSync(targetInCopy, changed);
    const run = runTest();
    if (run.status === null) throw new Error('mutation test did not complete');
    if (!deps.run && run.status !== 0 && !/^\s*[1-9][0-9]* fail\b/m.test(`${run.stdout}\n${run.stderr}`))
      throw new Error('mutation test did not report a failing assertion');
    return run.status === 0 ? 'survived' : 'caught';
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const result = mutationProbe(process.argv[2]!, { root: process.cwd(), baselineStable: process.argv[3] === 'stable' });
  console.log(result);
}
