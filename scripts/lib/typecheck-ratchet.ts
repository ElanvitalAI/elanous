import { resolve } from 'node:path';
import ts from 'typescript';

/** Select root files affected by changed TypeScript files through the resolved reverse-import graph.
 * Paths in rootNames are preserved for the compiler; changed paths may be relative to cwd.
 * This is selection only: the caller owns project scope, hub policy and compiler execution.
 */
export function selectAffectedRootNames(
  rootNames: readonly string[],
  changedFiles: ReadonlySet<string>,
  compilerOptions: ts.CompilerOptions,
  host: ts.ModuleResolutionHost = ts.sys,
  cwd = process.cwd(),
): string[] {
  const absolute = (file: string) => resolve(cwd, file);
  const roots = new Set(rootNames.map(absolute));
  const queue = [...changedFiles].filter((file) => /\.[cm]?tsx?$/.test(file)).map(absolute);
  // No changed TypeScript file: nothing can be affected, so the dependency graph is never read.
  if (queue.length === 0) return [];
  const reverse = new Map<string, Set<string>>();
  const pending = [...roots];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = host.readFile?.(file);
    if (source === undefined) throw new Error(`Cannot read typecheck root dependency: ${file}`);
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const dependency = ts.resolveModuleName(imported.fileName, file, compilerOptions, host).resolvedModule?.resolvedFileName;
      if (!dependency) continue;
      const path = absolute(dependency);
      if (!reverse.has(path)) reverse.set(path, new Set());
      reverse.get(path)!.add(file);
      if (!visited.has(path)) pending.push(path);
    }
  }

  // A deleted module cannot be resolved from the current tree. Without a previous
  // dependency graph, an empty reverse edge is not evidence that no root imports it.
  if (queue.some((file) => !host.fileExists(file))) return [...rootNames];
  const affected = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (affected.has(file)) continue;
    affected.add(file);
    for (const importer of reverse.get(file) ?? []) queue.push(importer);
  }
  return rootNames.filter((file) => affected.has(absolute(file)));
}
