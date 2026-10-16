// GATE-REUSE-BY-DIFF (0.2.25 · 10-12): which test files can a code change reach? A test whose whole module closure
// (static ⊕ literal dynamic imports ⊕ requires ⊕ literal repo paths it reads or spawns) avoids every changed file runs
// the same code at both commits, so its prior gate result is reusable. Everything else — and every test whose closure we
// cannot read for sure («opaque») — is re-run. Doubt never shrinks the set: a closure we cannot build is a full gate.
//
// Read from the tip commit's git objects, never from the working tree (the resume can run from any checkout).
import { spawnSync } from 'node:child_process';
import { dirname, join, normalize } from 'node:path/posix';
import ts from 'typescript';
import { sourceCandidates } from '../../src/self-implement/importer-test-index.js';

/** Files the closure follows (code). Changing anything else that is not a test or inert Markdown is a full gate. */
export const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /^(?:[\w.-]+\/)*[\w.-]+\.test\.(?:tsx?|jsx?|mts|cts)$/;
/** Test-side helpers: their filesystem scans and unresolved code paths make a test opaque (production code is trusted to
 *  reach code only through imports and the literal paths below). */
const TEST_SIDE_DIR = /(?:^|\/)(?:test|tests|__tests__|__mocks__|fixtures|__fixtures__|test-helpers|testing)\//;
const TEST_SIDE_NAME = /(?:^|[-_.])(?:test-?utils?|test-?helpers?|test-?support|testing|fixtures?|mocks?)$/i;
const isTestSide = (file: string): boolean => TEST_FILE.test(file) || TEST_SIDE_DIR.test(file)
  || TEST_SIDE_NAME.test((file.split('/').pop() ?? file).replace(CODE_FILE, ''));
/** A test-side file that lists directories or tracked files reads paths we cannot see. */
const FS_SCAN = /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|Glob|walkSync)\b|\bls-files\b/;
/** `import(x)` / `require(x)` with a non-literal argument loads a module we cannot name. */
const NON_LITERAL_LOAD = /(?<![.\w$])(?:import|require)\s*\(\s*(?!['"`)\s])([^)]*)\)?/g;
/** `const NAME = "literal"` bindings — `import(NAME)` with such a NAME loads that literal. */
const CONST_STRING = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:process\.env\.[\w$]+\s*(?:\?\?|\|\|)\s*)?(['"`])((?:(?!\2)[^\n\\$])*)\2\s*[;,\n]/g;
/** `import(["..", "x", "y.js"].join("/"))` — a specifier spelled as joined literals. */
const JOINED_IMPORT = /(?<![.\w$])import\s*\(\s*\[((?:\s*"[^"\n]*"\s*,?)+)\]\.join\(\s*"([^"\n]*)"\s*\)\s*\)/g;
/** Process launches — a file that has one may run a repo path it names. */
const SPAWNS = /(?<![\w$])(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|Bun\.spawn|Bun\.spawnSync|Bun\.\$)\s*[(`]/;
const LITERAL = /(['"`])((?:(?!\1)[^\n\\])*)\1/g;
/** An npm package specifier (`x`, `x/sub`, `@scope/x/sub`). */
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*(?:\/[^\s]*)?$/i;
const SUFFIXES = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

export interface ClosureTree {
  /** Every tracked path at the tip. */
  files: readonly string[];
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
  for (const file of tree.files) {
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
      specs = [...transpilers[loaderOf(file)].scanImports(source)];
      code = transpilers[loaderOf(file)].transformSync(source).replace(JOINED_IMPORT, (_all, items: string, separator: string) => {
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
      const pathLike = value.startsWith('./') || value.startsWith('../') || (value.includes('/') && /^[\w@.-]+(?:\/[\w@.-]+)+\/?$/.test(value)) || CODE_FILE.test(value);
      if (!pathLike) continue;
      const plain = value.replace(/\/$/, '');
      const hit = resolveLiteral(file, plain);
      // A path naming another test file is runner input (a list, a fixture string), not code this file loads.
      if (hit) {
        // A production file that names the CLI entry but spawns nothing only prints it (help text, a goal's command line).
        const printsOnly = (options.cliEntries ?? []).includes(hit) && !SPAWNS.test(code);
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
    if (eager.has(file)) selfStaticImports.add(file);
    edges.delete(file);
    eager.delete(file);
    forward.set(file, [...edges]);
    staticImports.set(file, [...eager]);
  }
  return { forward, staticImports, selfStaticImports, opaque, tracked };
}

/** The tests among `tests` that can reach any of `changed` (code files) — or whose closure is opaque. */
export function testsReachingChanged(tree: ClosureTree, changed: readonly string[], tests: readonly string[], options: ClosureOptions = {}): ClosureVerdict {
  const { forward, staticImports, opaque, tracked } = buildClosureGraph(tree, options);
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

/** The tip tree from git objects (`ls-tree` ⊕ one `cat-file --batch`). Throws on any git failure. */
export function gitClosureTree(repo: string, commit: string): ClosureTree {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`not a full sha: ${commit}`);
  // git-spawn-allow: read-only object reads of one release commit.
  const listed = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', commit], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (listed.status !== 0 || listed.error) throw new Error(`git ls-tree failed: ${(listed.stderr || listed.error || '').toString().trim()}`);
  const files = listed.stdout.split('\0').filter(Boolean);
  const wanted = files.filter((file) => CODE_FILE.test(file) || file === 'bunfig.toml' || /(?:^|\/)tsconfig[\w.-]*\.json$/.test(file));
  // git-spawn-allow: read-only object reads of one release commit.
  const batch = spawnSync('git', ['cat-file', '--batch'], { cwd: repo, input: wanted.map((file) => `${commit}:${file}`).join('\n') + '\n', maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (batch.status !== 0 || batch.error) throw new Error(`git cat-file failed: ${(batch.stderr || batch.error || '').toString().trim()}`);
  const out = batch.stdout as Buffer;
  const contents = new Map<string, string>();
  let at = 0;
  for (const file of wanted) {
    const end = out.indexOf(10, at);
    if (end < 0) throw new Error('git cat-file output truncated');
    const header = out.subarray(at, end).toString('utf8');
    const size = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!size) { at = end + 1; continue; } // «missing» (a submodule or symlink target) — read() answers undefined → opaque
    const length = Number(size[1]);
    contents.set(file, out.subarray(end + 1, end + 1 + length).toString('utf8'));
    at = end + 1 + length + 1;
  }
  const preload = bunfigPreload(contents.get('bunfig.toml'));
  if (preload === null) throw new Error('bunfig.toml [test].preload is unreadable');
  return { files, read: (path) => contents.get(path), preload, aliases: tsconfigAliases(contents) };
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
