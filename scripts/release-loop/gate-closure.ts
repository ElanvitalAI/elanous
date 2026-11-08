// GATE-REUSE-BY-DIFF (0.2.25 · 10-12): which test files can a code change reach? A test whose whole module closure
// (static ⊕ literal dynamic imports ⊕ requires ⊕ literal repo paths it reads or spawns) avoids every changed file runs
// the same code at both commits, so its prior gate result is reusable. Everything else — and every test whose closure we
// cannot read for sure («opaque») — is re-run. Doubt never shrinks the set: a closure we cannot build is a full gate.
//
// Read from the tip commit's git objects, never from the working tree (the resume can run from any checkout).
import { createHash } from 'node:crypto';
import { createCutSnapshot } from './gate-cut-snapshot.js';
import { dirname, join, normalize } from 'node:path/posix';
import ts from 'typescript';
import { sourceCandidates } from '../../src/self-implement/importer-test-index.js';

/** Files the closure follows (code). Changing anything else that is not a test or inert Markdown is a full gate. */
export const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** One release input whose readers use a literal basename in readFileSync(join(import.meta.dir, ...)).
 *  Other JSON stays a full gate until its dependency edge is proved. */
export const TRACEABLE_RELEASE_JSON = 'scripts/release-loop/known-issues-0.2.33-approved.json';
const TEST_FILE = /^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/;
/** Test-side helpers: their filesystem scans and unresolved code paths make a test opaque (production code is trusted to
 *  reach code only through imports and the literal paths below). */
const TEST_SIDE_DIR = /(?:^|\/)(?:test|tests|__tests__|__mocks__|fixtures|__fixtures__|test-helpers|testing)\//;
const TEST_SIDE_NAME = /(?:^|[-_.])(?:test-?utils?|test-?helpers?|test-?support|testing|fixtures?|mocks?)$/i;
const isTestSide = (file: string): boolean => TEST_FILE.test(file) || TEST_SIDE_DIR.test(file)
  || TEST_SIDE_NAME.test((file.split('/').pop() ?? file).replace(CODE_FILE, ''));
/** A test-side file that lists directories or tracked files reads paths we cannot see. */
const FS_SCAN = /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|Glob|walkSync)\b|\bls-files\b/;
const FS_READ = /\b(?:readFileSync|readFile|createReadStream|openSync|open)\s*\(/;
/** `import(x)` / `require(x)` with a non-literal argument loads a module we cannot name. */
const NON_LITERAL_LOAD = /(?<![.\w$])(?:import|require)\s*\(\s*(?!['"`)\s])([^)]*)\)?/g;
/** `const NAME = "literal"` bindings — `import(NAME)` with such a NAME loads that literal. */
const CONST_STRING = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:process\.env\.[\w$]+\s*(?:\?\?|\|\|)\s*)?(['"`])((?:(?!\2)[^\n\\$])*)\2\s*[;,\n]/g;
/** `import(["..", "x", "y.js"].join("/"))` — a specifier spelled as joined literals. */
const JOINED_IMPORT = /(?<![.\w$])import\s*\(\s*\[((?:\s*"[^"\n]*"\s*,?)+)\]\.join\(\s*"([^"\n]*)"\s*\)\s*\)/g;
/** Process launches — a file that has one may run a repo path it names. */
const SPAWN_CANDIDATE = /(?<![\w$])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|Bun\.spawn|Bun\.spawnSync|Bun\.\$)\s*[\x60(]|(?:node:)?child_process\b/;
const LITERAL = /(['"`])((?:(?!\1)[^\n\\])*)\1/g;

const PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const PROCESS_APIS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
function hasCommandSpawn(code: string, file: string): boolean {
  if (!SPAWN_CANDIDATE.test(code)) return false;
  const kind = /\.tsx?$/.test(file) ? (file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) : ts.ScriptKind.JS;
  const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
  const direct = new Set<string>(), namespaces = new Set<string>(), declared = new Set<string>();
  const uncertainImports = new Set<string>(), nonProcessValues = new Set<string>(), nonProcessFunctions = new Set<string>();
  const knownTypes = new Set<string>();
  const addBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) declared.add(name.text);
    else for (const item of name.elements) if (ts.isBindingElement(item)) addBinding(item.name);
  };
  const isProcessModule = (node: ts.Expression): boolean => ts.isStringLiteralLike(node) && PROCESS_MODULES.has(node.text);
  const knownType = (node: ts.TypeNode | undefined): boolean => {
    if (!node) return false;
    if (ts.isTypeReferenceNode(node)) {
      let root = node.typeName;
      while (ts.isQualifiedName(root)) root = root.left;
      return knownTypes.has(root.text);
    }
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) return node.types.every(knownType);
    return false;
  };
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && node.importClause) {
      const processModule = PROCESS_MODULES.has(node.moduleSpecifier.text), localModule = node.moduleSpecifier.text.startsWith('.');
      const bindings = node.importClause;
      if (bindings.name) {
        declared.add(bindings.name.text);
        if (processModule) namespaces.add(bindings.name.text);
        else if (localModule) knownTypes.add(bindings.name.text);
      }
      if (bindings.namedBindings && ts.isNamespaceImport(bindings.namedBindings)) {
        declared.add(bindings.namedBindings.name.text);
        if (processModule) namespaces.add(bindings.namedBindings.name.text);
        else if (localModule) knownTypes.add(bindings.namedBindings.name.text);
      }
      if (bindings.namedBindings && ts.isNamedImports(bindings.namedBindings)) for (const item of bindings.namedBindings.elements) {
        const imported = item.propertyName?.text ?? item.name.text, alias = item.name.text;
        declared.add(alias);
        if (processModule && PROCESS_APIS.has(imported)) direct.add(alias);
        else if (PROCESS_APIS.has(imported)) uncertainImports.add(alias);
        if (localModule) knownTypes.add(alias);
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && isProcessModule(node.moduleReference.expression)) {
      declared.add(node.name.text); namespaces.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node)) {
      addBinding(node.name);
      if (ts.isIdentifier(node.name)) {
        if (knownType(node.type) || (node.initializer && ts.isNewExpression(node.initializer)
          && ts.isIdentifier(node.initializer.expression) && knownTypes.has(node.initializer.expression.text))) nonProcessValues.add(node.name.text);
        if (node.initializer && ts.isIdentifier(node.initializer)) {
          const from = node.initializer.text;
          if (direct.has(from)) direct.add(node.name.text);
          if (uncertainImports.has(from)) uncertainImports.add(node.name.text);
          if (namespaces.has(from)) namespaces.add(node.name.text);
          if (nonProcessValues.has(from)) nonProcessValues.add(node.name.text);
        }
        if (node.initializer && ts.isPropertyAccessExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
          && namespaces.has(node.initializer.expression.text) && PROCESS_APIS.has(node.initializer.name.text)) direct.add(node.name.text);
      }
      if (node.initializer && ts.isIdentifier(node.initializer) && ts.isObjectBindingPattern(node.name)
        && namespaces.has(node.initializer.text)) for (const item of node.name.elements) {
        const imported = item.propertyName && ts.isIdentifier(item.propertyName) ? item.propertyName.text
          : ts.isIdentifier(item.name) ? item.name.text : '';
        if (PROCESS_APIS.has(imported) && ts.isIdentifier(item.name)) direct.add(item.name.text);
      }
      if (node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
        && node.initializer.expression.text === 'require' && node.initializer.arguments.length === 1
        && isProcessModule(node.initializer.arguments[0]!)) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
        else for (const item of node.name.elements) if (ts.isBindingElement(item)) {
          const imported = item.propertyName && ts.isIdentifier(item.propertyName) ? item.propertyName.text
            : ts.isIdentifier(item.name) ? item.name.text : '';
          if (PROCESS_APIS.has(imported) && ts.isIdentifier(item.name)) direct.add(item.name.text);
        }
      }
    }
    if (ts.isParameter(node)) {
      addBinding(node.name);
      if (ts.isIdentifier(node.name) && knownType(node.type)) nonProcessValues.add(node.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      declared.add(node.name.text); if (knownType(node.type)) nonProcessFunctions.add(node.name.text);
    }
    if (ts.isClassDeclaration(node) && node.name) { declared.add(node.name.text); knownTypes.add(node.name.text); }
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) knownTypes.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(ast);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = node.tag;
      if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)
        && tag.expression.text === 'Bun' && tag.name.text === '$') { found = true; return; }
    }
    if (!ts.isCallExpression(node)) { ts.forEachChild(node, visit); return; }
    const callee = node.expression;
    if (ts.isIdentifier(callee) && (direct.has(callee.text) || uncertainImports.has(callee.text))) found = true;
    else if (ts.isIdentifier(callee) && PROCESS_APIS.has(callee.text) && !nonProcessValues.has(callee.text)
      && !nonProcessFunctions.has(callee.text)) found = true;
    else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
      && callee.expression.text === 'Bun' && (callee.name.text === 'spawn' || callee.name.text === 'spawnSync' || callee.name.text === '$')) found = true;
    else if (ts.isPropertyAccessExpression(callee) && PROCESS_APIS.has(callee.name.text)) {
      const receiver = callee.expression;
      if (ts.isIdentifier(receiver)) {
        if (namespaces.has(receiver.text) || !nonProcessValues.has(receiver.text)) found = true;
      } else if (ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression)) {
        if (!nonProcessFunctions.has(receiver.expression.text)) found = true;
      } else if (receiver.kind !== ts.SyntaxKind.ThisKeyword) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}
function importsFileReader(code: string): boolean {
  const imports = /\bimport\s*\{([^}]*)\}\s*from\s*(['"])(?:node:)?fs(?:\/promises)?\2/g;
  for (const match of code.matchAll(imports)) {
    for (const item of match[1]!.split(',')) {
      const reader = item.trim().match(/^(?:type\s+)?(readFileSync|readFile|createReadStream|openSync|open)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!reader) continue;
      const local = reader[2] ?? reader[1]!;
      if (new RegExp(`(?<![\\w$])${local}\\s*\\(`).test(code)) return true;
    }
  }
  return false;
}
/** An npm package specifier (`x`, `x/sub`, `@scope/x/sub`). */
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*(?:\/[^\s]*)?$/i;
const SUFFIXES = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

export interface ClosureTree {
  /** Every tracked path at the tip. */
  files: readonly string[];
  /** Optional roots for a forward-only graph. `files` remains the complete resolver/tracked inventory. */
  roots?: readonly string[];
  /** Content at the tip (code files only are asked for); undefined = unreadable. */
  read: (path: string) => string | undefined;
  /** bun test preload files (bunfig.toml `[test].preload`), repo-relative. */
  preload: readonly string[];
  /** tsconfig `paths` aliases: specifier prefix → repo dir, scoped to importers under `scope`. */
  aliases?: readonly { scope: string; prefix: string; target: string }[];
}

export type ClosureVerdict =
  | { ok: true; tests: string[]; reached: number; opaque: number; opaqueFiles: string[] }
  | { ok: false; reason: string };

function loaderOf(file: string): 'ts' | 'tsx' | 'js' {
  return /\.[jt]sx$/.test(file) ? 'tsx' : /\.[cm]?ts$/.test(file) ? 'ts' : 'js';
}

export interface ClosureOptions {
  /** CLI entry files a production literal does not make a dependency of (help text, child command builders). */
  cliEntries?: readonly string[];
  /** Shadow-only candidate: omit require edges found only inside functions; callers must retain the current verdict. */
  omitFunctionLocalRequires?: boolean;
}

export interface ClosureGraph {
  /** Every dependency a file can load: imports of any kind ⊕ literal repo paths. */
  readonly forward: ReadonlyMap<string, readonly string[]>;
  /** Only top-level `import`/`export … from` — what loading the file evaluates before any of its code runs. */
  readonly staticImports: ReadonlyMap<string, readonly string[]>;
  /** Static self-imports are omitted from closure traversal but remain visible to structural diagnostics. */
  readonly selfStaticImports: ReadonlySet<string>;
  readonly opaque: ReadonlyMap<string, string>;
  readonly tracked: ReadonlySet<string>;
}

/** Forward dependency edges of every code file at the tip ⊕ the files whose dependencies we cannot fully name. */
export function buildClosureGraph(tree: ClosureTree, options: ClosureOptions = {}): ClosureGraph {
  const tracked = new Set(tree.files);
  const dirs = new Set<string>();
  for (const file of tree.files) for (let at = file.indexOf('/'); at > 0; at = file.indexOf('/', at + 1)) dirs.add(file.slice(0, at));
  const resolveFrom = (from: string, spec: string): string | undefined => {
    for (const candidate of sourceCandidates(from, spec)) if (tracked.has(candidate)) return candidate;
    const base = normalize(join(dirname(from), spec.replace(/[?#].*$/, '')));
    if (tracked.has(base)) return base;
    for (const suffix of SUFFIXES) {
      if (tracked.has(`${base}${suffix}`)) return `${base}${suffix}`;
      if (tracked.has(`${base}/index${suffix}`)) return `${base}/index${suffix}`;
    }
    return undefined;
  };
  /** A literal is a file name, not a module specifier: exact (or emitted `.js` → `.ts`), extensionless relative ones get
   *  a source suffix (`mock.module('../y')`) — never a directory index (`'src/'` is not `src/index.ts`). */
  const resolveLiteral = (from: string, value: string): string | undefined => {
    const relative = value.startsWith('./') || value.startsWith('../');
    const bases = relative ? [from] : [from, '_'];
    if (/\.[A-Za-z0-9]+$/.test(value.split('/').pop() ?? '')) {
      for (const base of bases) for (const candidate of sourceCandidates(base, value)) if (tracked.has(candidate)) return candidate;
      return undefined;
    }
    if (!relative) return undefined;
    const base = normalize(join(dirname(from), value));
    for (const suffix of SUFFIXES) if (tracked.has(`${base}${suffix}`)) return `${base}${suffix}`;
    return undefined;
  };
  const transpilers = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }), js: new Bun.Transpiler({ loader: 'js' }) };
  const forward = new Map<string, string[]>();
  const staticImports = new Map<string, string[]>();
  const selfStaticImports = new Set<string>();
  const opaque = new Map<string, string>();
  const blindAs = (file: string, why: string): void => { if (!opaque.has(file)) opaque.set(file, why); };
  const scanQueue = [...(tree.roots ?? tree.files)];
  const scanned = new Set<string>();
  for (let scanIndex = 0; scanIndex < scanQueue.length; scanIndex++) {
    const file = scanQueue[scanIndex]!;
    if (scanned.has(file)) continue;
    scanned.add(file);
    if (!CODE_FILE.test(file)) continue;
    const text = tree.read(file);
    if (text === undefined) { blindAs(file, 'unreadable'); continue; }
    const edges = new Set<string>();
    const testSide = isTestSide(file);
    let specs: { path: string; kind: string }[];
    // The transpiled text has no comments or types: literals and loads are read from code only (a path in a comment is
    // not a dependency).
    let code: string;
    try {
      const source = text.replace(/^#![^\n]*/, '');
      code = transpilers[loaderOf(file)].transformSync(source);
      if (options.omitFunctionLocalRequires && !testSide) {
        // Find and mask against the same transformed text consumed below. TS erases declarations/comments before
        // emitting code, so source offsets cannot safely be applied to the transformed closure text.
        const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        const local: Array<{ start: number; end: number; spec: string }> = [];
        const topLevelSpecs = new Set<string>();
        const collect = (node: ts.Node, inFunction: boolean): void => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
            && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
            const spec = node.arguments[0]!.text;
            if (inFunction) local.push({ start: node.getStart(ast), end: node.end, spec }); else topLevelSpecs.add(spec);
          }
          ts.forEachChild(node, (child) => collect(child, inFunction || ts.isFunctionLike(node)));
        };
        collect(ast, false);
        const omit = local.filter(({ spec }) => !topLevelSpecs.has(spec));
        if (omit.length) {
          const chars = code.split('');
          for (const { start, end } of omit) {
            for (let index = start; index < end; index++) if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' ';
            chars[start] = '0';
          }
          code = chars.join('');
          const omittedCounts = new Map<string, number>();
          for (const { spec } of omit) omittedCounts.set(spec, (omittedCounts.get(spec) ?? 0) + 1);
          specs = [...transpilers[loaderOf(file)].scanImports(source)].filter((item) => {
            if (item.kind !== 'require-call') return true;
            const count = omittedCounts.get(item.path) ?? 0;
            if (count === 0) return true;
            omittedCounts.set(item.path, count - 1);
            return false;
          });
        } else {
          specs = [...transpilers[loaderOf(file)].scanImports(source)];
        }
      } else {
        // Preserve the existing selector's source-based import radius; emitted JS may erase unused TS value imports.
        specs = [...transpilers[loaderOf(file)].scanImports(source)];
      }
      code = code.replace(JOINED_IMPORT, (_all, items: string, separator: string) => {
        const joined = [...items.matchAll(/"([^"\n]*)"/g)].map((item) => item[1]).join(separator);
        specs.push({ path: joined, kind: 'dynamic-import' });
        return `import(${JSON.stringify(joined)})`;
      });
    } catch { blindAs(file, 'unparsable'); continue; }
    // A load whose argument is not a literal: resolvable only when it is one identifier bound to a string constant in
    // this file (`const M = './pitch-api.js'; import(M)`); anything else loads a module we cannot name.
    const bindings = new Map<string, string>();
    for (const match of code.matchAll(CONST_STRING)) bindings.set(match[1]!, match[3]!);
    const codeOnly = code.replace(LITERAL, '""');
    for (const match of codeOnly.matchAll(NON_LITERAL_LOAD)) {
      const bound = bindings.get((match[1] ?? '').trim());
      if (bound === undefined) { blindAs(file, 'non-literal import/require'); continue; }
      if (!bound.startsWith('.')) continue; // a package name (optional dependency)
      const hit = resolveFrom(file, bound);
      if (hit) specs.push({ path: bound, kind: 'dynamic-import' }); else blindAs(file, `unresolved import ${bound}`);
    }
    if (testSide && FS_SCAN.test(code)) blindAs(file, `scans (${FS_SCAN.exec(code)?.[0]})`);
    // A code module may execute a repo script through a command or argument assembled at runtime. Its target is not
    // necessarily recoverable from literal-path edges, so importing tests must rerun after source changes.
    if (hasCommandSpawn(text, file)) blindAs(file, 'spawns a command with an opaque repo input');
    const eager = new Set<string>();
    for (const { path: spec, kind } of specs) {
      let hit: string | undefined;
      if (spec.startsWith('.') || spec.startsWith('/')) {
        hit = spec.startsWith('/') ? undefined : resolveFrom(file, spec);
        if (!hit) { blindAs(file, `unresolved import ${spec}`); continue; }
      } else {
        const alias = tree.aliases?.find((entry) => (entry.scope === '' || file.startsWith(`${entry.scope}/`)) && spec.startsWith(entry.prefix));
        if (!alias) {
          // Not a package name (`@/x`, `~/x`, `#x`): an alias we do not know — never assume it is outside the repo.
          if (!/^(?:node:|bun:)/.test(spec) && !PACKAGE_NAME.test(spec)) blindAs(file, `unresolved alias ${spec}`);
          continue;
        }
        hit = resolveFrom(`${alias.target}/_`, `./${spec.slice(alias.prefix.length)}`);
        if (!hit) { blindAs(file, `unresolved alias ${spec}`); continue; }
      }
      edges.add(hit);
      if (kind === 'import-statement') eager.add(hit);
      // Anything else is a package (node_modules / builtin) — lockfile and package.json changes are full gates.
    }
    // Literal repo paths: a test that reads `src/x.ts`, spawns `bin/elanous.mjs` or mocks `../y` depends on that file.
    for (const match of code.matchAll(LITERAL)) {
      const value = match[2]!;
      if (!value || value.length > 300 || value.includes('${') || /\s/.test(value) || /^[a-z]+:/i.test(value)) continue;
      const pathLike = value.startsWith('./') || value.startsWith('../') || (value.includes('/') && /^[\w@.-]+(?:\/[\w@.-]+)+\/?$/.test(value)) || CODE_FILE.test(value)
        || value === TRACEABLE_RELEASE_JSON.split('/').at(-1);
      if (!pathLike) continue;
      const plain = value.replace(/\/$/, '');
      const hit = resolveLiteral(file, plain);
      // A path naming another test file is runner input (a list, a fixture string), not code this file loads.
      if (hit) {
        // A production file that names the CLI entry but spawns nothing only prints it (help text, a goal's command line).
        const printsOnly = (options.cliEntries ?? []).includes(hit) && !hasCommandSpawn(text, file);
        if (!TEST_FILE.test(hit) && (testSide || !printsOnly)) edges.add(hit);
        continue;
      }
      if (!testSide) continue;
      const rootDir = normalize(plain.startsWith('.') ? join(dirname(file), plain) : plain);
      // A test-side literal naming a tracked directory scans it; one naming a code file we cannot find is a path we miss.
      if (dirs.has(rootDir) || (plain.startsWith('.') && dirs.has(normalize(join(dirname(file), plain))))) blindAs(file, `names directory ${plain}`);
      // With or without a slash: `join(dir, '..', 'oauth', 'store.ts')` builds the path from pieces, so the bare file name
      // is all we see — and a code file we cannot find is a path we miss.
      else if (CODE_FILE.test(plain) && !TEST_FILE.test(plain)) blindAs(file, `unresolved path ${plain}`);
    }
    // A code module may read a repo fixture through a variable, member access, or helper call. Literal edges above
    // are useful evidence, but cannot prove that every read's runtime-selected path is covered. Mark the module
    // opaque so tests importing it are rerun when source inputs change.
    if (FS_READ.test(code) || importsFileReader(code) || /\brequire\s*\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/.test(code))
      blindAs(file, 'reads a file through an opaque path');
    if (eager.has(file)) selfStaticImports.add(file);
    edges.delete(file);
    eager.delete(file);
    forward.set(file, [...edges]);
    staticImports.set(file, [...eager]);
    if (tree.roots) scanQueue.push(...edges);
  }
  return { forward, staticImports, selfStaticImports, opaque, tracked };
}

/** The tests among `tests` that can reach any of `changed` (code files) — or whose closure is opaque. */
export function testsReachingChanged(tree: ClosureTree, changed: readonly string[], tests: readonly string[], options: ClosureOptions = {}): ClosureVerdict {
  return testsReachingChangedFromGraph(tree, changed, tests, buildClosureGraph(tree, options));
}

function testsReachingChangedFromGraph(tree: ClosureTree, changed: readonly string[], tests: readonly string[], graph: ClosureGraph): ClosureVerdict {
  const { forward, staticImports, opaque, tracked } = graph;
  const reverse = new Map<string, string[]>();
  for (const [from, edges] of forward) for (const to of edges) {
    const list = reverse.get(to);
    if (list) list.push(from); else reverse.set(to, [from]);
  }
  const reachedFrom = (seeds: Iterable<string>): Set<string> => {
    const seen = new Set<string>(seeds);
    const queue = [...seen];
    while (queue.length) for (const importer of reverse.get(queue.pop()!) ?? []) if (!seen.has(importer)) { seen.add(importer); queue.push(importer); }
    return seen;
  };
  // Preload runs before every test file: what it evaluates on load (its static import closure) is a dependency of all
  // of them — changed, missing or unreadable there is a full gate.
  const preloadClosure = new Set<string>();
  const queue = [...tree.preload];
  while (queue.length) {
    const file = queue.pop()!;
    if (preloadClosure.has(file)) continue;
    preloadClosure.add(file);
    queue.push(...(staticImports.get(file) ?? []));
  }
  const changedSet = new Set(changed);
  for (const file of preloadClosure) {
    if (!tracked.has(file)) return { ok: false, reason: `bun test preload closure file ${file} is missing — full gate` };
    if (changedSet.has(file)) return { ok: false, reason: `bun test preload closure file ${file} changed — full gate` };
    // Any load we cannot name here — even one that looks lazy — may run before every test: a full gate (#26516 review).
    const why = opaque.get(file);
    if (why) return { ok: false, reason: `bun test preload closure file ${file} is opaque (${why}) — full gate` };
  }
  const reached = reachedFrom(changed);
  const blind = reachedFrom([...opaque.keys()].filter((file) => !preloadClosure.has(file)));
  const selected = tests.filter((test) => reached.has(test) || blind.has(test)).sort();
  return { ok: true, tests: selected, reached: tests.filter((test) => reached.has(test)).length, opaque: tests.filter((test) => blind.has(test) && !reached.has(test)).length,
    opaqueFiles: [...opaque].filter(([file]) => !preloadClosure.has(file)).map(([file, why]) => `${file}: ${why}`).sort() };
}

// TRAIN-REACH-GROUPING — two PRs whose reach sets share a test ride the same release train (their gates
// cannot be reused independently); disjoint reach sets stay separate trains. Pure and deterministic: the
// ledger is derived from content alone — no file, clock, or network effects.

/** One PR's reach set for train grouping — the `tests` of a `testsReachingChanged` verdict (`ok: true`). */
export interface CliLazyRequireShadow {
  current: ClosureVerdict;
  proposed: { ok: true; tests: string[] } | { ok: false; reason: string };
  cliSpawnTests: string[];
}

/** Compare current reach with a conservative candidate that omits function-local require only for non-CLI tests.
 *  The caller owns activation; this function never changes the current release decision. */
export function testsReachingChangedCliLazyRequireShadow(tree: ClosureTree, changed: readonly string[], tests: readonly string[], options: ClosureOptions = {}): CliLazyRequireShadow {
  const graph = buildClosureGraph(tree, { ...options, omitFunctionLocalRequires: false });
  const current = testsReachingChangedFromGraph(tree, changed, tests, graph);
  const reachesCliSpawn = (test: string): boolean => {
    const seen = new Set<string>();
    const stack = [test];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      stack.push(...(graph.forward.get(file) ?? []));
    }
    // Evidence is aggregated across every reachable import: a path-returning helper and the spawn helper may
    // be different files, connected only by a call in the test. Keep these tests in the conservative CLI set.
    let hasSpawn = false;
    let hasCliPath = false;
    for (const file of seen) {
      const text = tree.read(file) ?? '';
      hasSpawn ||= hasCommandSpawn(text, file);
      const literals = [...text.matchAll(LITERAL)].map((match) => match[2] ?? '');
      const pathSegments = literals.flatMap((value) => normalize(value).split('/').filter(Boolean));
      hasCliPath ||= literals.some((value) => /(?:^|\/)bin\/elanous\.mjs$/.test(normalize(value)))
        || pathSegments.some((segment, index) => segment === 'bin' && pathSegments[index + 1] === 'elanous.mjs');
    }
    return hasSpawn && hasCliPath;
  };
  const cliSpawnTests = tests.filter(reachesCliSpawn);
  if (!current.ok) return { current, proposed: { ok: false, reason: current.reason }, cliSpawnTests };
  const cli = new Set(cliSpawnTests);
  const nonCliTests = tests.filter((file) => !cli.has(file));
  const reduced = nonCliTests.length ? testsReachingChangedFromGraph(tree, changed, nonCliTests,
    buildClosureGraph(tree, { ...options, omitFunctionLocalRequires: true })) : { ok: true as const, tests: [], reached: 0, opaque: 0, opaqueFiles: [] };
  if (!reduced.ok) return { current, proposed: { ok: false, reason: reduced.reason }, cliSpawnTests };
  const proposed = [...new Set([...current.tests.filter((file) => cli.has(file)), ...reduced.tests])].sort();
  return { current, proposed: { ok: true, tests: proposed }, cliSpawnTests };
}

/** Live selector for receipt reuse and partial re-gates. The cut sweep itself still runs the full assigned suite. */
export function testsReachingChangedForGateReuse(tree: ClosureTree, changed: readonly string[], tests: readonly string[], options: ClosureOptions = {}): ClosureVerdict {
  const comparison = testsReachingChangedCliLazyRequireShadow(tree, changed, tests, options);
  if (!comparison.current.ok) return comparison.current;
  if (!comparison.proposed.ok) return comparison.current; // Candidate uncertainty preserves the conservative receipt radius.
  return { ...comparison.current, tests: comparison.proposed.tests };
}

export interface TrainReach {
  /** The PR that owns this reach set (number or url). */
  readonly pr: string;
  /** 도달 시험 집합 — tests reaching the PR's changed files. */
  readonly tests: readonly string[];
}

/** 묶음 원장 — train grouping ledger returned by `defineTrainGrouping`. */
export interface TrainGrouping {
  /** Train id per PR — both PRs share one id when their reach sets intersect. */
  readonly trainIds: ReadonlyMap<string, string>;
  /** The tests both reach sets share (sorted, deduped) — empty when they stay separate trains. */
  readonly intersection: readonly string[];
  /** True when the reach sets intersect and the two PRs ride the same train. */
  readonly sameTrain: boolean;
}

/** Train id derived from content — same parts give the same id; a sha256 slice keeps the ledger readable. */
const trainIdOf = (parts: readonly string[]): string =>
  `train-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 12)}`;

/** Bundle two PRs' reach sets into trains: intersecting reach sets get one shared train id, disjoint reach
 * sets keep separate per-PR ids. Deterministic and side-effect free — same inputs, same ledger. */
export function defineTrainGrouping(left: TrainReach, right: TrainReach): TrainGrouping {
  const reachOf = (reach: TrainReach): string[] => [...new Set(reach.tests)].sort();
  const leftTests = reachOf(left);
  const rightTests = reachOf(right);
  const rightSet = new Set(rightTests);
  const shared = leftTests.filter((test) => rightSet.has(test));
  const trainIds = new Map<string, string>();
  if (shared.length > 0) {
    const sharedId = trainIdOf(shared);
    trainIds.set(left.pr, sharedId);
    trainIds.set(right.pr, sharedId);
  } else {
    // Disjoint reach sets: mix the PR key into each id so even two empty reach sets stay separate trains.
    trainIds.set(left.pr, trainIdOf([left.pr, ...leftTests]));
    trainIds.set(right.pr, trainIdOf([right.pr, ...rightTests]));
  }
  return { trainIds, intersection: shared, sameTrain: shared.length > 0 };
}

/** `[test].preload` of a bunfig.toml text (repo-relative). Null when the file has a preload we cannot parse. */
export function bunfigPreload(text: string | undefined): string[] | null {
  if (text === undefined) return [];
  const section = /^\s*\[test\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  const line = /^\s*preload\s*=\s*(.+)$/m.exec(section.replace(/#[^\n]*/g, ''));
  if (!line) return /preload/.test(section.replace(/#[^\n]*/g, '')) ? null : [];
  const list = /^\[([^\]]*)\]\s*$/.exec(line[1]!.trim()) ?? /^(["'][^"']*["'])\s*$/.exec(line[1]!.trim());
  if (!list) return null;
  return [...list[1]!.matchAll(/["']([^"']+)["']/g)].map((entry) => normalize(entry[1]!).replace(/^\.\//, ''));
}

/** Tip-tree planning always goes through the shared immutable snapshot; a cache miss creates it once. */
export function gitClosureTree(repo: string, commit: string): ClosureTree {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`not a full sha: ${commit}`);
  const snapshot = createCutSnapshot(repo, commit);
  const contents = new Map<string, string>();
  for (const file of snapshot.files) {
    const content = snapshot.read(file);
    if (content !== undefined && (CODE_FILE.test(file) || file === 'bunfig.toml' || /(?:^|\/)tsconfig[\w.-]*\.json$/.test(file)))
      contents.set(file, content);
  }
  const preload = bunfigPreload(contents.get('bunfig.toml'));
  if (preload === null) throw new Error('bunfig.toml [test].preload is unreadable');
  return { files: [...snapshot.files], read: (path) => contents.get(path), preload, aliases: tsconfigAliases(contents) };
}

/** `compilerOptions.paths` entries of the form `"<prefix>*": ["<dir>/*"]` — scoped to the tsconfig's directory. */
function tsconfigAliases(contents: ReadonlyMap<string, string>): { scope: string; prefix: string; target: string }[] {
  const aliases: { scope: string; prefix: string; target: string }[] = [];
  for (const [file, text] of contents) {
    if (!/(?:^|\/)tsconfig[\w.-]*\.json$/.test(file)) continue;
    // TypeScript's own JSONC reader (comments, trailing commas, `src/**/*.ts` globs). An alias we cannot read would
    // silently look like a package — so an unreadable tsconfig is an error (full gate), never skipped.
    const parsed = ts.parseConfigFileTextToJson(file, text);
    if (parsed.error) throw new Error(`tsconfig unreadable: ${file}`);
    const options = (parsed.config as { compilerOptions?: { paths?: unknown; baseUrl?: unknown } } | undefined)?.compilerOptions;
    const paths = options?.paths;
    const baseUrl = options?.baseUrl;
    if (!paths || typeof paths !== 'object') continue;
    const scope = dirname(file) === '.' ? '' : dirname(file);
    const base = normalize(join(scope || '.', typeof baseUrl === 'string' ? baseUrl : '.'));
    for (const [key, targets] of Object.entries(paths as Record<string, unknown>)) {
      if (key === '*' || !key.endsWith('*') || !Array.isArray(targets) || typeof targets[0] !== 'string' || !targets[0].endsWith('*')) continue;
      aliases.push({ scope, prefix: key.slice(0, -1), target: normalize(join(base, targets[0].slice(0, -1))).replace(/\/$/, '') });
    }
  }
  return aliases;
}
