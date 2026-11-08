import { spawnSync } from 'node:child_process';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { isReleaseVersion } from './release-version.js';

export interface CutBranchOptions {
  version: string;
  /** Optional only on the --append path (RELEASE-APPEND-BASE-AUTO); required without --append. */
  base?: string;
  pick: string[];
  append?: boolean;
  dryRun?: boolean;
  repoRoot?: string;
  log?: (line: string) => void;
  /** Run ledger's version-release record ({ commit, branch, base? }) — consulted when --append omits --base. */
  ledger?: () => { commit?: unknown; base?: unknown; branch?: unknown } | undefined;
}

export interface CutBranchDependencyPick {
  sha: string;
  path: string;
  symbols: string[];
}

type NamedImport = { source: string; symbol: string; local: string };
type ImportDeclaration = { startLine: number; endLine: number; imports: NamedImport[] };

function importDeclarations(text: string): ImportDeclaration[] {
  const result: ImportDeclaration[] = [];
  for (const match of text.matchAll(/import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const before = text.slice(0, match.index);
    const startLine = before.split('\n').length - 1;
    const endLine = startLine + match[0]!.split('\n').length - 1;
    const imports: NamedImport[] = [];
    for (const entry of match[1]!.split(',')) {
      const parts = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map((part) => part.trim());
      const symbol = parts[0];
      const local = parts.at(-1);
      if (symbol && local && /^[\w$]+$/.test(symbol) && /^[\w$]+$/.test(local)) imports.push({ source: match[2]!, symbol, local });
    }
    if (imports.length) result.push({ startLine, endLine, imports });
  }
  for (const match of text.matchAll(/\bimport\s+(?:type\s+)?([\w$]+)(?:\s*,\s*\{[^}]*\})?\s+from\s*['"]([^'"]+)['"]/g)) {
    const before = text.slice(0, match.index);
    const startLine = before.split('\n').length - 1;
    const endLine = startLine + match[0]!.split('\n').length - 1;
    result.push({ startLine, endLine, imports: [{ source: match[2]!, symbol: 'default', local: match[1]! }] });
  }
  return result;
}

function exportedDeclarations(text: string): Set<string> {
  const symbols = new Set([...text.matchAll(/\bexport\s+(?:(?:declare|abstract|async)\s+)*(?:function|class|const|let|var|enum|interface|type)\s+([\w$]+)/g)]
    .map((match) => match[1]!));
  if (/\bexport\s+default\b/.test(text)) symbols.add('default');
  return symbols;
}

function localDeclarations(text: string): Set<string> {
  const names = new Set([...text.matchAll(/^[ \t]*(?:(?:export|declare|abstract|async)[ \t]+)*(?:function|class|enum|interface|type)[ \t]+([\w$]+)/gm)]
    .map((match) => match[1]!));
  const lines = text.split(/\r?\n/);
  for (let line = 0; line < lines.length; line += 1) {
    const match = lines[line]!.match(/^[ \t]*(?:(?:export|declare)[ \t]+)*(?:const|let|var)[ \t]+(.+)$/);
    if (!match) continue;
    let declaration = match[1]!;
    let depth = 0;
    let quote = '';
    const scan = (value: string): void => {
      for (let index = 0; index < value.length; index += 1) {
        const char = value[index]!;
        if (quote) {
          if (char === quote && value[index - 1] !== '\\') quote = '';
        } else if (char === '"' || char === "'" || char === '`') quote = char;
        else if (char === '(' || char === '[' || char === '{') depth += 1;
        else if (char === ')' || char === ']' || char === '}') depth -= 1;
      }
    };
    scan(declaration);
    while (line + 1 < lines.length && (depth > 0 || declaration.trimEnd().endsWith(','))) {
      declaration += `\n${lines[++line]!}`;
      scan(lines[line]!);
    }
    let start = 0;
    depth = 0;
    quote = '';
    for (let index = 0; index <= declaration.length; index += 1) {
      const char = declaration[index] ?? ',';
      if (quote) {
        if (char === quote && declaration[index - 1] !== '\\') quote = '';
      } else if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') depth -= 1;
      else if (char === ',' && depth === 0) {
        const name = declaration.slice(start, index).match(/^\s*([\w$]+)(?:\s*:\s*[^=,;]+)?\s*(?:=|;|$)/)?.[1];
        if (name) names.add(name);
        start = index + 1;
      }
    }
  }
  return names;
}

function namedExportLists(text: string): Array<{ entries: Array<{ source: string; exported: string }>; module?: string }> {
  const lists: Array<{ entries: Array<{ source: string; exported: string }>; module?: string }> = [];
  for (const match of text.matchAll(/\bexport\s*(?:type\s+)?\{([^}]+)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    const entries = match[1]!.split(',').flatMap((entry) => {
      const parts = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map((part) => part.trim());
      const source = parts[0];
      const exported = parts.at(-1);
      return source && exported && /^[\w$]+$/.test(source) && /^[\w$]+$/.test(exported) ? [{ source, exported }] : [];
    });
    lists.push({ entries, ...(match[2] === undefined ? {} : { module: match[2] }) });
  }
  return lists;
}

function fileAtRef(repo: string, ref: string, path: string): string | undefined {
  try { return git(repo, ['show', `${ref}:${path}`]); } catch { return undefined; }
}

function modulePathAtRef(repo: string, ref: string, importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const requested = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const stem = requested.replace(/\.(?:mjs|cjs|jsx|js)$/i, '');
  const extensions = /\.mjs$/i.test(requested) ? ['.mts', '.ts', '.mjs']
    : /\.cjs$/i.test(requested) ? ['.cts', '.ts', '.cjs']
      : /\.jsx$/i.test(requested) ? ['.tsx', '.ts', '.jsx']
        : /\.js$/i.test(requested) ? ['.ts', '.tsx', '.mts', '.cts', '.js']
          : ['.ts', '.tsx', '.mts', '.cts', '.js'];
  const candidates = [requested, ...extensions.map((ext) => `${stem}${ext}`), ...['index.ts', 'index.tsx', 'index.mts', 'index.cts', 'index.js'].map((name) => `${stem}/${name}`)];
  for (const path of new Set(candidates)) {
    if (fileAtRef(repo, ref, path) !== undefined) return path;
  }
  return undefined;
}

function reexportPaths(repo: string, ref: string, path: string): string[] {
  const text = fileAtRef(repo, ref, path) ?? '';
  const paths: string[] = [];
  for (const match of text.matchAll(/\bexport\s*(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g)) {
    const resolved = modulePathAtRef(repo, ref, path, match[1]!);
    if (resolved) paths.push(resolved);
  }
  for (const { source } of importDeclarations(text).flatMap(({ imports }) => imports)) {
    const resolved = modulePathAtRef(repo, ref, path, source);
    if (resolved) paths.push(resolved);
  }
  return paths;
}

function moduleClosure(repo: string, ref: string, entry: string): string[] {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const child of reexportPaths(repo, ref, path)) visit(child);
  };
  visit(entry);
  return [...seen];
}

function exportedSymbolsAtRef(repo: string, ref: string, path: string, seen = new Set<string>()): Set<string> {
  if (seen.has(path)) return new Set();
  seen.add(path);
  const text = fileAtRef(repo, ref, path) ?? '';
  const symbols = exportedDeclarations(text);
  const local = localDeclarations(text);
  const imported = new Map(importDeclarations(text).flatMap(({ imports }) => imports).map((binding) => [binding.local, binding]));
  for (const list of namedExportLists(text)) {
    if (list.module) {
      const child = modulePathAtRef(repo, ref, path, list.module);
      if (!child) continue;
      const childSymbols = exportedSymbolsAtRef(repo, ref, child, new Set(seen));
      for (const entry of list.entries) if (childSymbols.has(entry.source)) symbols.add(entry.exported);
    } else {
      for (const entry of list.entries) {
        if (local.has(entry.source)) symbols.add(entry.exported);
        const binding = imported.get(entry.source);
        if (!binding) continue;
        const child = modulePathAtRef(repo, ref, path, binding.source);
        if (child && exportedSymbolsAtRef(repo, ref, child, new Set(seen)).has(binding.symbol)) symbols.add(entry.exported);
      }
    }
  }
  for (const match of text.matchAll(/\bexport\s*(?:type\s+)?\*\s*from\s*['"]([^'"]+)['"]/g)) {
    const child = modulePathAtRef(repo, ref, path, match[1]!);
    if (child) for (const symbol of exportedSymbolsAtRef(repo, ref, child, new Set(seen))) if (symbol !== 'default') symbols.add(symbol);
  }
  return symbols;
}

function conflictImportDeclarations(repo: string, importer: string, incomingSource: string): NamedImport[] {
  const combined = git(repo, ['diff', '--cc', '--unified=0', '--', importer]);
  const hunkLines: Array<{ start: number; count: number }> = [];
  for (const match of combined.matchAll(/^@@@ -\d+(?:,\d+)? -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@@/gm)) {
    hunkLines.push({ start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]) });
  }
  return importDeclarations(incomingSource).flatMap((declaration) => {
    if (!hunkLines.some(({ start, count }) => count > 0 && declaration.startLine < start - 1 + count && declaration.endLine >= start - 1)) return [];
    return declaration.imports;
  });
}

function dependencyPicksForConflict(repo: string, base: string, start: string, picks: string[], conflictFiles: string[]): CutBranchDependencyPick[] {
  const byCommit = new Map<string, CutBranchDependencyPick>();
  for (const importer of conflictFiles) {
    let current = '';
    let incoming = '';
    try { current = git(repo, ['show', `:2:${importer}`]); } catch { /* add/add conflict */ }
    try { incoming = git(repo, ['show', `:3:${importer}`]); } catch { continue; }
    const currentImports = new Set(importDeclarations(current).flatMap(({ imports }) => imports).map(({ source, symbol }) => `${source}\0${symbol}`));
    const incomingImports = conflictImportDeclarations(repo, importer, incoming);
    const changedImports = incomingImports.filter(({ source, symbol }) => !currentImports.has(`${source}\0${symbol}`));
    for (const { source, symbol } of changedImports) {
      const path = modulePathAtRef(repo, 'origin/main', importer, source);
      if (!path) continue;
      const present = exportedSymbolsAtRef(repo, start, path);
      if (present.has(symbol)) continue;
      const historyPaths = moduleClosure(repo, 'origin/main', path);
      const commits = git(repo, ['rev-list', '--reverse', `${base}..origin/main`, '--', ...historyPaths]).split('\n').filter(Boolean);
      for (const sha of commits) {
        if (picks.includes(sha)) continue;
        const parents = git(repo, ['rev-list', '--parents', '-n', '1', sha]).split(/\s+/);
        if (parents.length !== 2) continue;
        const before = exportedSymbolsAtRef(repo, `${sha}^`, path);
        const after = exportedSymbolsAtRef(repo, sha, path);
        if (before.has(symbol) || !after.has(symbol)) continue;
        const existing = byCommit.get(sha);
        if (existing) {
          if (!existing.symbols.includes(symbol)) existing.symbols.push(symbol);
        } else {
          byCommit.set(sha, { sha, path, symbols: [symbol] });
        }
        break;
      }
      if (byCommit.size >= 2) return [...byCommit.values()];
    }
  }
  return [...byCommit.values()];
}

/** Runs a proposed append only in a disposable worktree and reports definitions needed by its conflict imports. */
function simulateAppendDependencies(repo: string, base: string, start: string, picks: string[]): CutBranchDependencyPick[] {
  const temp = mkdtempSync(join(tmpdir(), 'release-cut-append-dry-run-'));
  const tree = join(temp, 'tree');
  let added = false;
  try {
    git(repo, ['worktree', 'add', '--detach', tree, start]);
    added = true;
    for (const sha of picks) {
      try { git(tree, ['cherry-pick', sha]); }
      catch (error) {
        const files = git(tree, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
        if (!files.length) throw error;
        return dependencyPicksForConflict(tree, base, start, picks, files);
      }
    }
    return [];
  } finally {
    try { if (added) git(repo, ['worktree', 'remove', '--force', tree]); }
    finally { rmSync(temp, { recursive: true, force: true }); }
  }
}

// git-spawn-allow: release branch operations happen only in an isolated temporary worktree; main is never checked out or changed.
function git(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (result.status !== 0 || result.error) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error || result.stdout || 'no output').toString().trim()}`);
  return result.stdout.trim();
}

function ancestor(repo: string, sha: string, ref: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', sha, ref], { cwd: repo, maxBuffer: SPAWN_SYNC_MAX_BUFFER });
  if (result.status !== 0 && result.status !== 1) throw new Error(`git merge-base failed: ${result.error || result.stderr || 'unknown'}`);
  return result.status === 0;
}

/** RELEASE-APPEND-BASE-AUTO: the first parent of a release-branch tip — the commit main was cut from when the branch carries only release-side commits. */
function firstParent(repo: string, sha: string): string | undefined {
  const parts = git(repo, ['rev-list', '--parents', '-n', '1', sha]).split(/\s+/);
  const parent = parts[1];
  return parent !== undefined && /^[0-9a-f]{40}$/i.test(parent) ? parent : undefined;
}

/** RELEASE-APPEND-BASE-AUTO: the main cut recorded by the run ledger's version-release node — its base field when present, else the first parent of its commit. Unresolvable records degrade to undefined so the caller keeps its refusal. */
function ledgerCut(repo: string, recorded: { commit?: unknown; base?: unknown; branch?: unknown } | undefined): string | undefined {
  if (!recorded) return undefined;
  try {
    if (typeof recorded.base === 'string' && /^[0-9a-f]{7,40}$/i.test(recorded.base)) return git(repo, ['rev-parse', '--verify', `${recorded.base}^{commit}`]);
    if (typeof recorded.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(recorded.commit)) return firstParent(repo, git(repo, ['rev-parse', '--verify', `${recorded.commit}^{commit}`]));
  } catch { return undefined; }
  return undefined;
}

export function cutReleaseBranch(opts: CutBranchOptions): { branch: string; commit: string | null; dryRun: boolean; dependencyPicks?: CutBranchDependencyPick[] } {
  const repo = resolve(opts.repoRoot ?? process.cwd());
  const branch = `release/${opts.version}`;
  const log = opts.log ?? console.log;
  const report = (event: 'created' | 'refused' | 'conflict' | 'appended' | 'base-resolved' | 'base-corrected', reason?: string, commit?: string, extra?: Record<string, string | string[]>) =>
    debug.log('release-loop.cut-branch', event, { version: opts.version, branch, ...(commit ? { commit } : {}), ...(reason ? { reason } : {}), ...extra });
  try {
    if (!isReleaseVersion(opts.version)) throw new Error(`invalid release version: ${opts.version}`);
    if (!opts.pick.length) throw new Error('at least one --pick commit is required');
    if (opts.base === undefined && !opts.append) throw new Error('--base is required without --append');
    for (const sha of [opts.base, ...opts.pick]) if (sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error(`invalid commit SHA: ${sha}`);
    git(repo, ['fetch', 'origin', 'main']);
    const remoteLine = git(repo, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    if (remoteLine && !opts.append) throw new Error(`${branch} already exists on origin — use --append to fast-forward more picks onto it`);
    if (!remoteLine && opts.append) throw new Error(`${branch} does not exist on origin — omit --append to create it`);
    if (spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo, maxBuffer: SPAWN_SYNC_MAX_BUFFER }).status === 0) throw new Error(`${branch} already exists locally`);
    let remoteTip: string | undefined;
    if (opts.append) {
      const advertised = remoteLine.split(/\s+/)[0] ?? '';
      if (!/^[0-9a-f]{40}$/i.test(advertised)) throw new Error(`${branch} remote tip is not a commit SHA`);
      // PR-HEAD-FETCH-STATELESS: «+» so a moved tracking ref is never refused as non-fast-forward; the CAS is the advertised-SHA check below.
      git(repo, ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      remoteTip = git(repo, ['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]);
      if (advertised !== remoteTip) throw new Error(`${branch} remote tip moved — fast-forward refused (no force push)`);
    }
    // RELEASE-APPEND-BASE-AUTO (OP 0.2.38): a cut commit lives only on the release branch, so the main cut is resolved
    // before the ancestor refusal — from the run ledger's version-release record, else the release tip's first parent.
    let base: string;
    if (opts.base !== undefined) {
      base = git(repo, ['rev-parse', '--verify', `${opts.base}^{commit}`]);
    } else {
      const fromLedger = ledgerCut(repo, opts.ledger?.());
      const ledgerCandidate = fromLedger !== undefined && ancestor(repo, fromLedger, 'origin/main') ? fromLedger : undefined;
      const candidate = ledgerCandidate ?? (remoteTip !== undefined ? firstParent(repo, remoteTip) : undefined);
      if (candidate === undefined || !ancestor(repo, candidate, 'origin/main'))
        throw new Error(`base ${candidate ?? remoteTip ?? branch} is not an ancestor of origin/main`);
      base = candidate;
      report('base-resolved', undefined, base, { source: ledgerCandidate !== undefined ? 'ledger' : 'first-parent' });
    }
    if (!ancestor(repo, base, 'origin/main')) {
      if (!opts.append) throw new Error(`base ${base} is not an ancestor of origin/main`);
      const parent = firstParent(repo, base);
      if (parent === undefined || !ancestor(repo, parent, 'origin/main')) throw new Error(`base ${base} is not an ancestor of origin/main`);
      log(`base ${base} 는 origin/main 에 없다 — 그 부모 ${parent} 를 쓰라 (auto-corrected)`);
      report('base-corrected', `그 부모 ${parent} 를 쓰라 — ${base} 는 origin/main 에 없다`, base, { parent });
      base = parent;
    }
    const picks = opts.pick.map((sha) => git(repo, ['rev-parse', '--verify', `${sha}^{commit}`]));
    for (const sha of picks) if (!ancestor(repo, sha, 'origin/main')) throw new Error(`pick ${sha} is not an ancestor of origin/main`);
    for (const sha of picks) if (ancestor(repo, sha, base)) throw new Error(`pick ${sha} is already in base ${base}`);
    if (new Set(picks).size !== picks.length) throw new Error('duplicate --pick commit');
    for (const sha of picks) if (git(repo, ['rev-list', '--parents', '-n', '1', sha]).split(' ').length !== 2) throw new Error(`pick ${sha} must have exactly one parent`);
    if (opts.append) for (const sha of picks) if (ancestor(repo, sha, remoteTip!)) throw new Error(`pick ${sha} is already in ${branch}`);
    const versionAt = remoteTip ?? base;
    const pkg = JSON.parse(git(repo, ['show', `${versionAt}:package.json`])) as { version?: unknown };
    if (pkg.version !== opts.version) throw new Error(`${opts.append ? 'release branch' : 'base'} package.json version ${pkg.version} is not ${opts.version}`);
    const start = remoteTip ?? base;
    log(`${branch}: ${start} + ${picks.join(' + ')}${opts.append ? ' (append)' : ''}${opts.dryRun ? ' (dry-run)' : ''}${base !== start ? ` · base ${base}` : ''}`);
    if (opts.dryRun) {
      if (!opts.append) return { branch, commit: null, dryRun: true };
      const dependencyPicks = simulateAppendDependencies(repo, base, start, picks);
      for (const dependency of dependencyPicks) log(`의존 pick 제안 · ${dependency.sha} · ${dependency.path} · ${dependency.symbols.join(', ')}`);
      return { branch, commit: null, dryRun: true, ...(dependencyPicks.length ? { dependencyPicks } : {}) };
    }
    const temp = mkdtempSync(join(tmpdir(), 'release-cut-branch-'));
    const tree = join(temp, 'tree');
    let added = false;
    let commit: string | undefined;
    try {
      git(repo, ['worktree', 'add', '--detach', tree, start]);
      added = true;
      for (const sha of picks) {
        try { git(tree, ['cherry-pick', sha]); }
        catch (error) {
          const files = git(tree, ['diff', '--name-only', '--diff-filter=U']);
          if (!files) throw error;
          report('conflict', `cherry-pick ${sha}`);
          throw new Error(`cherry-pick ${sha} 충돌 — 손으로 풀 곳: ${files.split('\n').join(', ')} (release/${opts.version} 가지는 만들지 않음)`);
        }
      }
      commit = git(tree, ['rev-parse', 'HEAD']);
      const finalPackage = JSON.parse(git(tree, ['show', 'HEAD:package.json'])) as { version?: unknown };
      if (finalPackage.version !== opts.version) throw new Error(`picked branch package.json version ${finalPackage.version} is not ${opts.version}`);
    } finally {
      try {
        if (added) git(repo, ['worktree', 'remove', '--force', tree]);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
    if (!commit) throw new Error('cherry-pick produced no commit');
    const lease = opts.append ? remoteTip! : '';
    let push: string;
    try {
      push = git(repo, ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:${lease}`, 'origin', `${commit}:refs/heads/${branch}`]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (opts.append && /stale info|rejected|non-fast-forward|failed to push/i.test(message)) {
        throw new Error(`${branch} remote tip moved — fast-forward refused (no force push)`);
      }
      throw error;
    }
    const landed = push.split('\n').some((line) => {
      const [flag, ref, summary] = line.split('\t');
      if (flag !== ' ' && flag !== '*') return false;
      if (!ref?.endsWith(`:refs/heads/${branch}`)) return false;
      if (!opts.append) return flag === '*' && summary === '[new branch]';
      const range = summary?.match(/^([0-9a-f]+)\.\.([0-9a-f]+)$/i);
      return flag === ' ' && !!range && remoteTip!.startsWith(range[1]!) && commit.startsWith(range[2]!);
    });
    if (!landed) throw new Error(opts.append
      ? `${branch} remote tip moved — fast-forward refused (no force push)`
      : `${branch} already exists on origin (push did not create a new branch)`);
    if (opts.append) report('appended', undefined, commit, { from: remoteTip!, to: commit, picks });
    else report('created', undefined, commit);
    log(`${branch} → ${commit}`);
    return { branch, commit, dryRun: false };
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('충돌'))) report('refused', error instanceof Error ? error.message : String(error));
    throw error;
  }
}
