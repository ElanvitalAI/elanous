import { randomUUID } from 'node:crypto';
import { realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

export type ScopedTypecheckConfig = { config: string; cleanup: () => void };

/** Extend the original project while replacing its root files with paths present in this tree. */
export function writeScopedTypecheckConfig(
  cwd: string,
  config: string,
  files: readonly string[],
): ScopedTypecheckConfig | null {
  const root = realpathSync(cwd);
  const original = resolve(root, config);
  const projectDir = dirname(original);
  const roots = new Set<string>();
  for (const file of files) {
    const candidate = resolve(root, file);
    const withinRoot = relative(root, candidate);
    if (!withinRoot || withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
      const actual = realpathSync(candidate);
      const actualRelative = relative(root, actual);
      if (actualRelative === '..' || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) continue;
      roots.add(relative(projectDir, candidate).split(sep).join('/'));
    } catch { /* Deleted or unreadable files are not roots in this tree. */ }
  }
  if (roots.size === 0) return null;

  // The project may include ambient declarations without importing them. Retain the
  // declaration roots selected by this tree's own config before clearing `include`.
  const parsed = ts.readConfigFile(original, ts.sys.readFile);
  if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  const project = ts.parseJsonConfigFileContent(parsed.config, ts.sys, projectDir, undefined, original);
  for (const file of project.fileNames) {
    if (!/\.d\.[cm]?ts$/.test(file)) continue;
    const candidate = resolve(file);
    const withinRoot = relative(root, candidate);
    if (withinRoot === '..' || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) continue;
    if (!statSync(candidate).isFile()) continue;
    roots.add(relative(projectDir, candidate).split(sep).join('/'));
  }

  const path = join(projectDir, `.elanous-typecheck-scope-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify({ extends: original, files: [...roots], include: [], exclude: [] }, null, 2)}\n`, { flag: 'wx' });
  return { config: path, cleanup: () => rmSync(path, { force: true }) };
}
