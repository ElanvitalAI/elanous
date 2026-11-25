// Identifier queries — which files DEFINE the symbol a Grep pattern names, so Grep can list them first.
//
// Why (search-bench #40045): structural definition / call-site search lifted code recall@5 +0.22 (symbol and
// call-site queries 0.4 → 1.0); dropping the boost cost code −0.15. ast-grep is the structural engine when it is
// installed; otherwise a definition regex over rg (equal on TypeScript in the bench). ast-grep is optional — minim5 /
// node-b may not have it.
// Three faces: observe = `tools.search` `definition-fallback` log + the «via regex (ast-grep …)» note in the tool
// result (a missing ast-grep is never silent) · judge = only identifier-shaped alternatives (camelCase, PascalCase,
// snake_case, CONST) · repair = the regex path answers when ast-grep is absent or fails.
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { debug } from '../../debug/log.js';
import { topLevelAlternatives } from './search-terms.js';

const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_IDENTIFIERS = 3;

/** camelCase / PascalCase / snake_case / CONST_CASE — a symbol, not an English word. */
export function isIdentifierTerm(t: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(t) && (/[a-z][A-Z]/.test(t) || /_/.test(t) || /^[A-Z][A-Z0-9_]+$/.test(t) || /^[A-Z][a-z0-9]+[A-Z]/.test(t));
}

/** Identifier-shaped top-level alternatives of a Grep pattern (at most 3). */
export function identifierAlternatives(pattern: string): string[] {
  return [...new Set(topLevelAlternatives(pattern).filter(isIdentifierTerm))].slice(0, MAX_IDENTIFIERS);
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const DEF_KINDS: Record<string, readonly string[]> = {
  TypeScript: ['function_declaration', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'method_definition', 'variable_declarator'],
  Tsx: ['function_declaration', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'method_definition', 'variable_declarator'],
  JavaScript: ['function_declaration', 'class_declaration', 'method_definition', 'variable_declarator'],
  Python: ['function_definition', 'class_definition'],
  Rust: ['function_item', 'struct_item', 'enum_item', 'trait_item', 'type_item', 'const_item', 'static_item'],
  Go: ['function_declaration', 'method_declaration', 'type_spec'],
  Swift: ['function_declaration', 'class_declaration', 'protocol_declaration'],
};
const CALL_LANGS = ['TypeScript', 'Tsx', 'JavaScript', 'Python', 'Rust', 'Go'];

/** ast-grep inline rules: a declaration whose name is exactly `id`, in every supported language. */
export function astGrepDefRules(id: string): string {
  const re = JSON.stringify(`^${escapeRegex(id)}$`);
  return Object.entries(DEF_KINDS).map(([lang, kinds]) =>
    `id: def-${lang.toLowerCase()}\nlanguage: ${lang}\nrule:\n  any:\n${kinds.map((k) => `    - { kind: ${k}, has: { field: name, regex: ${re} } }`).join('\n')}`).join('\n---\n');
}

/** ast-grep inline rules: a call whose callee is `id` or `x.id`. */
export function astGrepCallRules(id: string): string {
  const re = JSON.stringify(`(^|\\.)${escapeRegex(id)}$`);
  return CALL_LANGS.map((lang) => `id: call-${lang.toLowerCase()}\nlanguage: ${lang}\nrule:\n  kind: ${lang === 'Python' ? 'call' : 'call_expression'}\n  has: { field: function, regex: ${re} }`).join('\n---\n');
}

/** rg regex for a definition of `id` (the bench's def-boost regex). */
export function definitionRegex(id: string): string {
  return `(function|class|interface|type|const|let|var|def|fn|func|struct|enum|trait)\\s+${escapeRegex(id)}\\b`;
}

export interface DefinitionLookup {
  /** Absolute paths of files defining one of the identifiers. */
  files: string[];
  via: 'ast-grep' | 'regex';
  /** Why the regex path answered (ast-grep missing / failed) — shown to the model, logged. */
  fallbackReason?: string;
}

type Spawn = (cmd: string, args: string[], cwd: string) => { status: number | null; stdout: string; stderr: string; missing?: boolean };
const defaultSpawn: Spawn = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', missing: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' };
};

let binaryCache: string | null | undefined;
let spawnImpl: Spawn = defaultSpawn;

/** Test seam: replace the process runner (null = real) and forget the cached ast-grep probe. */
export function setStructuralSpawnForTesting(fn: Spawn | null): void {
  spawnImpl = fn ?? defaultSpawn;
  binaryCache = undefined;
}

function astGrepBinaryCached(): string | null {
  if (binaryCache === undefined) {
    binaryCache = null;
    for (const name of ['ast-grep', 'sg']) {
      const r = spawnImpl(name, ['--version'], process.cwd());
      if (r.status === 0 && /ast-grep/i.test(`${r.stdout}${r.stderr}`)) { binaryCache = name; break; }
    }
  }
  return binaryCache;
}

const toAbs = (cwd: string) => (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));

/** Files under `searchPath` that define any of `ids`. ast-grep when installed, else the definition regex via rg.
 *  Never throws — a failed lookup is an empty list (Grep's own result stands). */
export function findDefinitionFiles(ids: readonly string[], searchPath: string, cwd: string, extraRgArgs: readonly string[] = []): DefinitionLookup {
  const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);
  const bin = astGrepBinaryCached();
  let fallbackReason = 'ast-grep not installed';
  if (bin) {
    const files = new Set<string>();
    let failed = '';
    for (const id of ids) {
      const r = spawnImpl(bin, ['scan', '--inline-rules', astGrepDefRules(id), '--files-with-matches', searchPath], cwd);
      if (r.status !== 0 && r.status !== 1) { failed = (r.stderr || `exit ${r.status}`).trim().split('\n')[0]!.slice(0, 160); break; }
      for (const p of lines(r.stdout)) files.add(toAbs(cwd)(p));
    }
    if (!failed) return { files: [...files], via: 'ast-grep' };
    fallbackReason = `ast-grep failed: ${failed}`;
  }
  const args = ['-l', '--no-messages', ...extraRgArgs];
  for (const id of ids) args.push('-e', definitionRegex(id));
  args.push('--', searchPath);
  const r = spawnImpl('rg', args, cwd);
  const files = r.status === 0 ? lines(r.stdout).map(toAbs(cwd)) : [];
  debug.log('tools.search', 'definition-fallback', { ids: [...ids], reason: fallbackReason, files: files.length }, { level: 'info' });
  return { files, via: 'regex', fallbackReason };
}
