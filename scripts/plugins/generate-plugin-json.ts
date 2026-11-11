import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compilePluginYaml } from '../../src/plugins/core/plugin-yaml.js';

function pluginDirectories(root: string, check: boolean): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    const yamlPath = join(dir, 'plugin.yaml');
    const jsonPath = join(dir, 'plugin.json');
    const generatedGraphManifest = check && existsSync(jsonPath) && (() => {
      try {
        const manifest = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
          extensions?: { 'ai.elanous'?: { graphManifests?: unknown } };
        };
        return manifest.extensions?.['ai.elanous']?.graphManifests !== undefined;
      } catch { return false; }
    })();
    if (existsSync(yamlPath) || generatedGraphManifest) found.push(dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') visit(join(dir, entry.name));
    }
  };
  visit(root);
  return found;
}

export function run(args: string[]): number {
  const check = args.includes('--check');
  const roots: string[] = [];
  const positionalRoots: string[] = [];
  const pluginDirs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--check') continue;
    if (arg === '--plugin-dir' || arg === '--plugin-root') {
      const target = args[++index];
      if (!target) {
        process.stderr.write(`${arg} requires a path\n`);
        return 2;
      }
      (arg === '--plugin-dir' ? pluginDirs : roots).push(resolve(target));
      continue;
    }
    // Preserve the original positional root behavior. Use --plugin-dir when a
    // particular directory must be present and checked even without manifests.
    positionalRoots.push(resolve(arg));
  }
  if (!roots.length && !positionalRoots.length && !pluginDirs.length) {
    process.stderr.write('usage: bun scripts/plugins/generate-plugin-json.ts [--check] [--plugin-dir <path>]... [--plugin-root <path>]...\n');
    return 2;
  }
  const directories = [
    ...pluginDirs,
    ...roots.flatMap(root => pluginDirectories(root, check)),
    ...positionalRoots.flatMap(root => {
      const found = pluginDirectories(root, check);
      if (found.length) return found;
      // Legacy positional targets with no authoring/generated source must not
      // silently succeed; a legacy plugin.json is outside this YAML compiler.
      return existsSync(join(root, 'plugin.json')) ? [] : [root];
    }),
  ];
  if (!directories.length) {
    if (check) {
      process.stdout.write('checked 0 plugin manifests; no generated graph manifests need a YAML source\n');
      return 0;
    }
    process.stderr.write('no plugin.yaml files found\n');
    return 1;
  }
  let stale = 0;
  for (const dir of directories) {
    if (!existsSync(join(dir, 'plugin.yaml'))) {
      process.stderr.write(`${join(dir, 'plugin.yaml')}: required source missing; generated manifest cannot be checked or written\n`);
      stale++;
      continue;
    }
    const generated = compilePluginYaml(dir);
    const target = join(dir, 'plugin.json');
    const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    if (current === generated) continue;
    if (check) {
      process.stderr.write(`${target}: stale or missing generated manifest\n`);
      stale++;
    } else {
      writeFileSync(target, generated, 'utf8');
      process.stdout.write(`${target}: generated\n`);
    }
  }
  if (stale) return 1;
  process.stdout.write(`${check ? 'checked' : 'generated'} ${directories.length} plugin manifest(s)\n`);
  return 0;
}

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
