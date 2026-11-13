/** Compare the installed-plugin ledger with the package bytes it names.
 *
 * A manifest declaration is not proof that a runtime tool is exposed. The
 * report keeps file-backed assets, code entry points, and declarations apart.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadPluginManifestFromDir } from '../src/plugins/core/manifest.js';

type LedgerRow = { market: string; name: string; version: string };
export type PluginTruth = {
  key: string;
  declared: string[];
  providedFiles: string[];
  codeEntry: 'present' | 'absent' | 'undeclared';
  runtimeClaims: string[];
  problems: string[];
};
export type RegistryTruth = { root: string; status: 'pass' | 'fail' | 'unmeasured'; plugins: PluginTruth[]; problems: string[] };

function packagePath(base: string, name: string): string | null {
  if (!name || isAbsolute(name)) return null;
  const path = resolve(base, name);
  const rel = relative(base, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  if (existsSync(path)) {
    const actual = relative(realpathSync(base), realpathSync(path));
    if (!actual || actual === '..' || actual.startsWith(`..${sep}`)) return null;
  }
  return path;
}

function skillFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === 'SKILL.md') found.push(path);
    if (entry.isDirectory()) found.push(...skillFiles(path));
  }
  return found;
}

function fileBacked(base: string, path: string, label: string, result: PluginTruth): void {
  const resolved = packagePath(base, path);
  if (!resolved || !existsSync(resolved) || !statSync(resolved).isFile()) result.problems.push(`${label}: missing file ${path}`);
  else result.providedFiles.push(label);
}

function directoryBacked(base: string, path: string, label: string, result: PluginTruth): string | null {
  const resolved = packagePath(base, path);
  if (!resolved || !existsSync(resolved) || !statSync(resolved).isDirectory()) {
    result.problems.push(`${label}: missing directory ${path}`);
    return null;
  }
  result.providedFiles.push(label);
  return resolved;
}

export function auditPluginRegistry(root: string): RegistryTruth {
  const absoluteRoot = resolve(root);
  const ledgerPath = join(absoluteRoot, 'plugins', 'installed.json');
  const report: RegistryTruth = { root: absoluteRoot, status: 'unmeasured', plugins: [], problems: [] };
  if (!existsSync(ledgerPath)) return report;
  let rows: unknown;
  try { rows = JSON.parse(readFileSync(ledgerPath, 'utf8')); }
  catch { report.problems.push('installed.json: invalid JSON'); report.status = 'fail'; return report; }
  if (!Array.isArray(rows) || !rows.every(row => row && typeof row === 'object'
    && typeof row.market === 'string' && typeof row.name === 'string' && typeof row.version === 'string')) {
    report.problems.push('installed.json: invalid rows'); report.status = 'fail'; return report;
  }
  const seen = new Set<string>();
  for (const row of rows as LedgerRow[]) {
    const key = `${row.market}/${row.name}/${row.version}`;
    const result: PluginTruth = { key, declared: [], providedFiles: [], codeEntry: 'undeclared', runtimeClaims: [], problems: [] };
    report.plugins.push(result);
    if (seen.has(key)) result.problems.push('duplicate ledger row');
    seen.add(key);
    const base = packagePath(join(absoluteRoot, 'plugins'), key);
    if (!base || !existsSync(base) || !statSync(base).isDirectory()) {
      result.problems.push('installed package missing');
      continue;
    }
    try {
      // Inspect the authoring YAML as well as generated JSON. A directory
      // declaration is evidence only when its packaged SKILL.md exists; even
      // malformed YAML must report the missing asset instead of a bare parse
      // error that hides the package defect.
      const yamlPath = join(base, 'plugin.yaml');
      if (existsSync(yamlPath)) {
        const yaml = parseYaml(readFileSync(yamlPath, 'utf8')) as Record<string, unknown> | null;
        if (yaml && typeof yaml.skills === 'string') {
          result.declared.push(`skill-root:${yaml.skills}`);
          const declaredDir = directoryBacked(base, yaml.skills, 'skill-root', result);
          if (declaredDir) {
            const files = skillFiles(declaredDir);
            if (!files.length) result.problems.push('skill-root: no SKILL.md provided');
            for (const file of files) result.providedFiles.push(`skill-file:${relative(base, file)}`);
          }
        }
      }
      const loaded = loadPluginManifestFromDir(base, { id: row.name, version: row.version, allowClaudeManifest: true });
      const manifest = loaded.manifest;
      if (loaded.inferred || manifest.id !== row.name || manifest.version !== row.version) {
        result.problems.push('manifest identity does not match ledger');
        continue;
      }
      const source = loaded.path ? readFileSync(loaded.path, 'utf8') : '';
      const raw = loaded.path?.endsWith('.json') ? JSON.parse(source) as Record<string, unknown> : {};
      const declaredMain = typeof raw.main === 'string' || (loaded.path?.endsWith('.yaml') && /^\s*main\s*:/m.test(source));
      const entry = packagePath(base, manifest.main);
      if (entry && existsSync(entry) && statSync(entry).isFile()) result.codeEntry = 'present';
      else if (declaredMain) result.codeEntry = 'absent';
      if (declaredMain) result.declared.push('code-entry');
      if (result.codeEntry === 'absent') result.problems.push(`code-entry: missing file ${manifest.main}`);
      const contributions = manifest.contributes;
      for (const kind of ['commands', 'aiTools', 'agents', 'hooks', 'missions', 'routes', 'workflows'] as const) {
        if (contributions[kind]?.length) {
          result.declared.push(`${kind}:${contributions[kind]!.length}`);
          result.runtimeClaims.push(kind);
        }
      }
      for (const [kind, paths] of Object.entries({
        graph: contributions.graphs ?? [], node: contributions.nodes ?? [], vocab: contributions.vocab ?? [],
      })) for (const path of paths) {
        result.declared.push(`${kind}:${path}`);
        fileBacked(base, path, `${kind}:${path}`, result);
      }
      const skillRoot = typeof raw.skills === 'string' ? raw.skills
        : existsSync(join(base, 'skills')) ? './skills' : null;
      const skillDir = skillRoot ? directoryBacked(base, skillRoot, 'skill-root', result) : null;
      if (skillDir) {
        const files = skillFiles(skillDir);
        if (!files.length) result.problems.push('skill-root: no SKILL.md provided');
        for (const file of files) result.providedFiles.push(`skill-file:${relative(base, file)}`);
      }
      for (const skill of contributions.skills ?? []) {
        const id = typeof skill.id === 'string' ? skill.id : typeof skill.name === 'string' ? skill.name : null;
        if (!id) continue;
        result.declared.push(`skill:${id}`);
        if (typeof skill.path === 'string') fileBacked(base, skill.path, `skill:${id}`, result);
        else if (skillDir) fileBacked(base, join(skillRoot!, id, 'SKILL.md'), `skill:${id}`, result);
        else result.problems.push(`skill:${id}: no package path`);
      }
      if (!result.providedFiles.length && result.codeEntry !== 'present') result.problems.push('package provides no verified file or code entry');
    } catch (error) {
      result.problems.push(`manifest unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  report.status = report.plugins.length === 0 ? 'unmeasured'
    : report.problems.length || report.plugins.some(plugin => plugin.problems.length) ? 'fail'
    : report.plugins.some(plugin => plugin.runtimeClaims.length || plugin.codeEntry === 'present') ? 'unmeasured' : 'pass';
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  if (rootIndex < 0 || !args[rootIndex + 1] || args.length !== 2) {
    console.error('usage: bun scripts/plugin-registry-truth.ts --root <state-root>');
    process.exit(2);
  }
  const report = auditPluginRegistry(args[rootIndex + 1]!);
  console.log(JSON.stringify(report));
  if (report.status !== 'pass') process.exitCode = 1;
}
