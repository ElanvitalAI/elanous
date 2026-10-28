#!/usr/bin/env bun
/** Conservative multi-entrypoint reachability inventory. This command NEVER deletes files. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface RootGroup { name: string; roots: string[]; configuration?: string }
export interface ModuleGap { importer: string; specifier: string; kind: 'unresolved' | 'dynamic' }
export interface GroupResult { name: string; roots: string[]; reachable: string[]; gaps: ModuleGap[] }
export interface ReachabilityReport {
  schemaVersion: 1;
  trackedFiles: number;
  groups: GroupResult[];
  unionReachable: string[];
  unknownKeep: string[];
  unresolved: ModuleGap[];
  dynamic: ModuleGap[];
  /** Never interpreted as safe-to-delete: configuration/runtime loaders cannot be exhaustively statically enumerated. */
  unclassifiedKeep: string[];
  overlaps: Record<string, string[]>;
  deletions: 0;
}

const moduleFile = (p: string) => /\.[cm]?[jt]sx?$/.test(p);
const testFile = (p: string) => /(?:^|\/)(?:__tests__|__fixtures__|test|tests|fixtures)\//.test(p) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p);
const normalized = (p: string) => p.replaceAll('\\', '/');
const sorted = (items: Iterable<string>) => [...new Set(items)].sort();

export function trackedModules(root: string): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    .toString().split('\0').filter(moduleFile).filter(Boolean).map(normalized).sort();
}

function loadOptions(config: string | undefined, root: string): ts.CompilerOptions {
  if (!config || !existsSync(join(root, config))) return { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true };
  const filename = join(root, config);
  const source = ts.readConfigFile(filename, ts.sys.readFile);
  if (source.error) throw new Error(ts.flattenDiagnosticMessageText(source.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(source.config, ts.sys, dirname(filename), undefined, filename);
  if (parsed.errors.length) throw new Error(parsed.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n'));
  return parsed.options;
}

export function inventoryRoots(root: string, files: readonly string[]): RootGroup[] {
  const groups: RootGroup[] = [
    { name: 'cli', roots: ['bin/elanous.mjs', 'src/index.ts', 'src/light-cli.ts'], configuration: 'tsconfig.json' },
    { name: 'scripts', roots: files.filter(p => p.startsWith('scripts/') && !testFile(p)), configuration: 'tsconfig.json' },
    { name: 'pwa', roots: files.filter(p => /^apps\/pwa\/src\/(app\/(?:.*\/)?(?:page|layout|route|loading|error|not-found|template|default)|middleware|instrumentation)\.[jt]sx?$/.test(p)), configuration: 'apps/pwa/tsconfig.json' },
    { name: 'desktop', roots: ['apps/desktop/src/main.ts'], configuration: 'apps/desktop/tsconfig.json' },
  ];
  for (const app of sorted(files.filter(p => /^apps\/[^/]+\/src\/(?:main|index)\.[jt]sx?$/.test(p)))) {
    if (app.startsWith('apps/desktop/') || app.startsWith('apps/pwa/')) continue;
    groups.push({ name: `app:${app.split('/')[1]}`, roots: [app], configuration: `apps/${app.split('/')[1]}/tsconfig.json` });
  }
  // Manifest-declared paths are roots even when no TS import refers to them.
  const manifests = execFileSync('git', ['ls-files', '-z', '--', 'plugins/*/plugin.json', 'plugins/*/manifest.json'], { cwd: root }).toString().split('\0').filter(Boolean);
  const plugins: string[] = [];
  for (const path of manifests) {
    const manifest = JSON.parse(readFileSync(join(root, path), 'utf8')) as { entry?: string; main?: string };
    const declared = manifest.entry ?? manifest.main;
    if (!declared) continue;
    const entry = normalized(join(dirname(path), declared));
    // Missing manifest entries remain roots and become explicit unresolved/unknown gaps.
    plugins.push(entry);
  }
  groups.push({ name: 'plugins', roots: sorted(plugins), configuration: 'tsconfig.json' });
  // Runtime loaders and independently launched ACP boot are not necessarily in the CLI's import graph.
  groups.push({ name: 'runtime', roots: ['src/boot/acp-server.ts', 'src/plugin-declarative/discovery.ts', 'src/self-implement/graph-catalog.ts', 'src/graph-runner/runner.ts'], configuration: 'tsconfig.json' });
  return groups;
}

export function analyzeReachability(root: string, files: readonly string[], groups: readonly RootGroup[]): ReachabilityReport {
  const tracked = new Set(files.map(normalized));
  const cache = new Map<string, ts.SourceFile>();
  const results: GroupResult[] = [];
  const unknown = new Set<string>();
  for (const group of groups) {
    const options = loadOptions(group.configuration, root);
    const reachable = new Set<string>();
    const gaps: ModuleGap[] = [];
    const queue = [...group.roots];
    const host = ts.createCompilerHost(options, true);
    const moduleCache = ts.createModuleResolutionCache(root, s => s, options);
    while (queue.length) {
      const path = queue.pop()!;
      if (reachable.has(path)) continue;
      if (!tracked.has(path)) {
        gaps.push({ importer: `(root:${group.name})`, specifier: path, kind: 'unresolved' });
        unknown.add(path);
        continue;
      }
      reachable.add(path);
      const absolute = join(root, path);
      let source = cache.get(path);
      if (!source) {
        source = ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        cache.set(path, source);
      }
      const inspect = (specifier: ts.Expression) => {
        if (!ts.isStringLiteralLike(specifier)) {
          gaps.push({ importer: path, specifier: specifier.getText(source), kind: 'dynamic' }); unknown.add(path); return;
        }
        const text = specifier.text;
        const resolved = ts.resolveModuleName(text, absolute, options, host, moduleCache).resolvedModule?.resolvedFileName;
        const name = resolved ? normalized(relative(root, resolved)) : '';
        if (name && tracked.has(name)) queue.push(name);
        else if (text.startsWith('.') || text.startsWith('/') || text.startsWith('@/')) {
          gaps.push({ importer: path, specifier: text, kind: 'unresolved' }); unknown.add(path);
        }
        // External packages are outside the tracked-source deletion domain.
      };
      const walk = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) inspect(node.moduleSpecifier);
        else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) inspect(node.moduleReference.expression);
        else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          if (node.arguments[0]) inspect(node.arguments[0]);
          else { gaps.push({ importer: path, specifier: '(missing argument)', kind: 'dynamic' }); unknown.add(path); }
        }
        ts.forEachChild(node, walk);
      };
      walk(source);
    }
    results.push({ name: group.name, roots: sorted(group.roots), reachable: sorted(reachable), gaps });
  }
  const uses = new Map<string, string[]>();
  for (const group of results) for (const p of group.reachable) uses.set(p, [...(uses.get(p) ?? []), group.name]);
  const gaps = results.flatMap(r => r.gaps);
  const uniqueGaps = (kind: ModuleGap['kind']) => [...new Map(gaps.filter(g => g.kind === kind).map(g => [`${g.importer}\0${g.specifier}`, g])).values()]
    .sort((a, b) => a.importer.localeCompare(b.importer) || a.specifier.localeCompare(b.specifier));
  // The rest are *not* dead code: lazy/config/graph/plugin discovery and non-TS launchers are open-world inputs.
  const unclassified = files.filter(p => !uses.has(p));
  return {
    schemaVersion: 1, trackedFiles: files.length, groups: results,
    unionReachable: sorted(uses.keys()), unknownKeep: sorted([...unknown, ...unclassified]),
    unresolved: uniqueGaps('unresolved'), dynamic: uniqueGaps('dynamic'),
    unclassifiedKeep: sorted(unclassified),
    overlaps: Object.fromEntries([...uses].filter(([, v]) => v.length > 1).sort(([a], [b]) => a.localeCompare(b))),
    deletions: 0,
  };
}

export function renderMarkdown(report: ReachabilityReport): string {
  const lines = ['# Multi-entrypoint reachability inventory', '', 'This is an observation, not a safe-to-delete list. Deletions: 0.', '',
    `Tracked source: ${report.trackedFiles}; union reachable: ${report.unionReachable.length}; unknown/keep: ${report.unknownKeep.length}; unresolved: ${report.unresolved.length}; dynamic: ${report.dynamic.length}.`, '',
    '| Root family | roots | reachable | unknown edges |', '|---|---:|---:|---:|'];
  for (const g of report.groups) lines.push(`| ${g.name} | ${g.roots.length} | ${g.reachable.length} | ${g.gaps.length} |`);
  lines.push('', 'Unclassified source, dynamic imports, configuration/graph loaders and resolution gaps remain unknown/keep; no deletion candidate is asserted.', '');
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? '.');
  const files = trackedModules(root);
  const report = analyzeReachability(root, files, inventoryRoots(root, files));
  const json = JSON.stringify(report, null, 2);
  if (process.argv.includes('--json')) process.stdout.write(json + '\n');
  else if (process.argv.includes('--md')) process.stdout.write(renderMarkdown(report));
  else if (process.argv.includes('--output')) {
    const index = process.argv.indexOf('--output');
    const target = process.argv[index + 1];
    if (!target || target.startsWith('--')) throw new Error('--output requires a path');
    const output = resolve(target);
    writeFileSync(output + '.json', json + '\n');
    writeFileSync(output + '.md', renderMarkdown(report));
    console.log(`report: ${output}.json / ${output}.md`);
  } else process.stdout.write(renderMarkdown(report));
}
