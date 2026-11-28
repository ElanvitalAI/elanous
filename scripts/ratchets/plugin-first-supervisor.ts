/**
 * PLUGIN-FIRST-RATCHET — no NEW agent-specific TS logic on the supervisor paths (LOOP-AGENT-PLUGIN-FIRST-RATCHET · 대표 11-28
 * «플러그인을 정의해놓고서 신규 구현을 그것으로 안 하면 어떡합니까»). A new supervisor is a plugin: an agent.yaml instance
 * (graphs/loop-agents/<id>/agent.yaml) over shared executor node kinds (src/loop-agent/v3/node-kinds.ts) and kits (src/kit/**).
 *
 * Inventory = every non-test .ts/.tsx file under SUPERVISOR_ROOTS plus every exported function-like declaration in it
 * (`file` and `file#name` entries; a file TypeScript cannot parse adds `file!parse-error`). The inventory of origin/main
 * is frozen in plugin-first-supervisor.baseline.json; a tree that adds an entry is RED. Allowed: src/loop-agent/v3/**
 * and src/kit/** (outside the roots — shared executor and kits, new node kinds included), deletions, edits inside
 * existing functions, tests. Same trust shape as scripts/plugin-only-ratchet.ts: the baseline must equal the
 * inventory of its sourceRef, an ancestor of origin/main.
 *
 *   bun scripts/ratchets/plugin-first-supervisor.ts                              # check (exit 1 on a new entry)
 *   bun scripts/ratchets/plugin-first-supervisor.ts --write-baseline origin/main  # re-freeze after main shrinks
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

export const PLUGIN_FIRST_BASELINE = 'scripts/ratchets/plugin-first-supervisor.baseline.json';
export const SUPERVISOR_ROOTS = [
  'src/guardian-agent', 'src/loop-agent/bodies', 'src/steward', 'src/judge-butler', 'src/land-steward', 'src/supervision',
] as const;
export const PLUGIN_FIRST_GUIDANCE =
  '에이전트별 감독 TS 로직 추가 금지 — 공용 실행기 노드 kind 로 + agent.yaml 인스턴스 (src/loop-agent/v3/node-kinds.ts 에 kind 등록은 허용)';
const PARSE_GUIDANCE = '구문 오류라 감독 경로를 셀 수 없다 — 고친 뒤 다시 잰다(fail-closed)';
const LOGIC_FILE = /\.tsx?$/;
const NOT_LOGIC = /(?:\.test\.tsx?|\.d\.ts)$/;

export interface PluginFirstBaseline { schema: 1; sourceRef: string; roots: string[]; entries: string[] }

const isLogicFile = (path: string): boolean => LOGIC_FILE.test(path) && !NOT_LOGIC.test(path);

function isFunctionLike(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  let n = node;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isClassExpression(n)) return true;
  // `export const tick = withLock(async () => …)` — a wrapped body is still a body.
  return ts.isCallExpression(n) && n.arguments.some((a) => isFunctionLike(a));
}

const hasExport = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const hasDefault = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

/** Exported function-like names of one source (pure). `null` = TypeScript reported a syntax error. */
export function scanExportedFunctions(source: string, file: string): string[] | null {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const diagnostics = (tree as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return null;
  const local = new Set<string>();
  const names = new Set<string>();
  for (const stmt of tree.statements) {
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) local.add(stmt.name.text);
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name) && isFunctionLike(d.initializer)) local.add(d.name.text);
    }
  }
  for (const stmt of tree.statements) {
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && hasExport(stmt)) {
      names.add(hasDefault(stmt) ? 'default' : stmt.name?.text ?? 'default');
    } else if (ts.isVariableStatement(stmt) && hasExport(stmt)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name) && isFunctionLike(d.initializer)) names.add(d.name.text);
    } else if (ts.isExportAssignment(stmt)) {
      if (isFunctionLike(stmt.expression) || (ts.isIdentifier(stmt.expression) && local.has(stmt.expression.text))) names.add('default');
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) if (local.has((el.propertyName ?? el.name).text)) names.add(el.name.text);
    }
  }
  return [...names].sort();
}

/** Inventory entries of one file (pure). */
export function fileEntries(path: string, source: string): string[] {
  const names = scanExportedFunctions(source, path);
  return names === null ? [path, `${path}!parse-error`] : [path, ...names.map((n) => `${path}#${n}`)];
}

function walk(root: string, dir: string): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs) || lstatSync(abs).isSymbolicLink()) return [];
  const out: string[] = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const child = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(root, child));
    else if (e.isFile() && isLogicFile(child)) out.push(child);
  }
  return out;
}

/** Inventory of the working tree (committed ⊕ staged ⊕ unstaged ⊕ untracked). */
export function inventoryFromTree(root: string): string[] {
  return SUPERVISOR_ROOTS.flatMap((r) => walk(root, r))
    .flatMap((p) => fileEntries(p, readFileSync(join(root, p), 'utf8'))).sort();
}

/** Inventory of a git ref — `ls-tree` for the paths, one `cat-file --batch` for the blobs. */
export function inventoryAtRef(root: string, ref: string): string[] {
  const listed = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', ref, '--', ...SUPERVISOR_ROOTS], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\0').filter((p) => p && isLogicFile(p));
  if (listed.length === 0) return [];
  const batch = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: listed.map((p) => `${ref}:${p}`).join('\n') + '\n', maxBuffer: 256 * 1024 * 1024 });
  if (batch.status !== 0) throw new Error(`plugin-first: git cat-file failed at ${ref}: ${batch.stderr.toString()}`);
  const buf = batch.stdout;
  const entries: string[] = [];
  let at = 0;
  for (const path of listed) {
    const nl = buf.indexOf(0x0a, at);
    const header = buf.subarray(at, nl).toString('utf8').split(' ');
    if (header[1] !== 'blob') throw new Error(`plugin-first: ${ref}:${path} is not a blob`);
    const size = Number(header[2]);
    entries.push(...fileEntries(path, buf.subarray(nl + 1, nl + 1 + size).toString('utf8')));
    at = nl + 1 + size + 1;
  }
  return entries.sort();
}

export function regenerateBaseline(root: string, ref: string): PluginFirstBaseline {
  const sourceRef = execFileSync('git', ['rev-parse', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
  return { schema: 1, sourceRef, roots: [...SUPERVISOR_ROOTS], entries: inventoryAtRef(root, sourceRef) };
}

const git = (root: string, args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
};

/** A shallow checkout may lack the old sourceRef; trust only a baseline byte-identical to origin/main's. */
function isUnchangedMainBaselineInShallowCheckout(root: string): boolean {
  if (git(root, ['rev-parse', '--is-shallow-repository']).out !== 'true') return false;
  const work = git(root, ['hash-object', join(root, PLUGIN_FIRST_BASELINE)]);
  const main = git(root, ['rev-parse', `origin/main:${PLUGIN_FIRST_BASELINE}`]);
  return work.ok && main.ok && work.out === main.out;
}

/** Violations of the working tree at `root` (empty = GREEN). Throws when the baseline itself cannot be trusted. */
export function checkPluginFirstRatchet(root: string): string[] {
  const path = join(root, PLUGIN_FIRST_BASELINE);
  if (!existsSync(path)) {
    throw new Error(`plugin-first baseline missing: ${PLUGIN_FIRST_BASELINE} — bun scripts/ratchets/plugin-first-supervisor.ts --write-baseline origin/main`);
  }
  const baseline = JSON.parse(readFileSync(path, 'utf8')) as PluginFirstBaseline;
  if (baseline.schema !== 1) throw new Error(`unsupported plugin-first baseline schema: ${String(baseline.schema)}`);
  if (JSON.stringify(baseline.roots) !== JSON.stringify(SUPERVISOR_ROOTS)) throw new Error('plugin-first baseline roots differ from SUPERVISOR_ROOTS — re-freeze from origin/main');
  const allowed = new Set(baseline.entries);
  if (!isUnchangedMainBaselineInShallowCheckout(root)) {
    if (!git(root, ['merge-base', '--is-ancestor', baseline.sourceRef, 'HEAD']).ok) throw new Error(`plugin-first baseline sourceRef is not an ancestor of HEAD: ${baseline.sourceRef}`);
    if (!git(root, ['merge-base', '--is-ancestor', baseline.sourceRef, 'origin/main']).ok) throw new Error(`plugin-first baseline sourceRef must come from origin/main: ${baseline.sourceRef}`);
    if (JSON.stringify(inventoryAtRef(root, baseline.sourceRef)) !== JSON.stringify(baseline.entries)) {
      throw new Error(`plugin-first baseline does not match sourceRef inventory: ${baseline.sourceRef}`);
    }
    // Race: an entry that reached main after the baseline was frozen is main's, not this PR's — tolerate it.
    const base = git(root, ['merge-base', 'HEAD', 'origin/main']);
    if (base.ok && base.out && base.out !== baseline.sourceRef) for (const e of inventoryAtRef(root, base.out)) allowed.add(e);
  }
  const current = inventoryFromTree(root);
  const newFiles = new Set(current.filter((e) => !e.includes('#') && !e.includes('!') && !allowed.has(e)));
  return current.flatMap((e) => {
    if (allowed.has(e)) return [];
    if (e.endsWith('!parse-error')) return [`plugin-first:parse-error:${e.slice(0, -'!parse-error'.length)} — ${PARSE_GUIDANCE}`];
    if (newFiles.has(e)) return [`plugin-first:new-file:${e} — ${PLUGIN_FIRST_GUIDANCE}`];
    const file = e.slice(0, e.indexOf('#'));
    return newFiles.has(file) ? [] : [`plugin-first:new-function:${e} — ${PLUGIN_FIRST_GUIDANCE}`];
  });
}

if (import.meta.main) {
  const root = process.cwd();
  const args = process.argv.slice(2);
  if (args[0] === '--write-baseline') {
    const baseline = regenerateBaseline(root, args[1] ?? 'origin/main');
    writeFileSync(join(root, PLUGIN_FIRST_BASELINE), `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`wrote ${PLUGIN_FIRST_BASELINE} from ${baseline.sourceRef} (${baseline.entries.length} entries)`);
  } else {
    const violations = checkPluginFirstRatchet(root);
    if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
    else console.log('PLUGIN-FIRST-RATCHET pass: no new agent-specific supervisor files or exported functions');
  }
}
