import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

type GraphFiles = {
  readFile?: (path: string) => string;
  listFiles?: (cwd: string) => string[];
};

function sourceFiles(cwd: string): string[] {
  const files: string[] = [];
  for (const root of ['apps/pwa/src', 'src']) {
    const walk = (dir: string): void => {
      let entries;
      try { entries = readdirSync(join(cwd, dir), { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory() && !['node_modules', '.next'].includes(entry.name)) walk(path);
        else if (entry.isFile() && /\.(?:ts|tsx|js)$/.test(path)) files.push(path);
      }
    };
    walk(root);
  }
  return files;
}

/** PWA source entrypoints and the transitive relative imports they resolve inside repository src/. */
export function pwaReachableSrcFiles(cwd: string, { readFile = (path) => readFileSync(path, 'utf8'), listFiles = sourceFiles }: GraphFiles = {}): Set<string> {
  const root = resolve(cwd);
  const available = new Set(listFiles(cwd).map((file) => file.replaceAll('\\', '/').replace(/^\.\//, '')));
  const reached = new Set<string>();
  const visited = new Set<string>();
  // Start from everything apps/pwa/tsconfig.json `include`s — its `src/**/*.ts(x)` also matches *.test.* files, and the Next
  // build type-checks them. Excluding tests hid the real entry (tool-result-chain.test.ts → src/nexus/api/meta-api → most of src).
  const queue = [...available].filter((file) => /^apps\/pwa\/src\/.*\.tsx?$/.test(file));
  const imports = /\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  while (queue.length) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (file.startsWith('src/')) reached.add(file);
    let content: string;
    try { content = readFile(join(root, file)); }
    catch { continue; }
    for (const match of content.matchAll(imports)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      const target = resolve(root, dirname(file), specifier);
      const base = relative(root, target).split(sep).join('/');
      if (!base.startsWith('src/')) continue;
      const candidates = /\.js$/.test(base)
        // A real .js file wins over a same-named .ts source (the actual resolution order).
        ? [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base.slice(0, -3)}/index.ts`, `${base.slice(0, -3)}/index.tsx`, `${base.slice(0, -3)}/index.js`]
        : /\.tsx?$/.test(base) ? [base] : [base + '.ts', base + '.tsx', base + '.js', base + '/index.ts', base + '/index.tsx', base + '/index.js'];
      const resolved = candidates.find((candidate) => available.has(candidate));
      if (resolved) {
        if (!visited.has(resolved)) queue.push(resolved);
      } else {
        // An import of a deleted src file must still trigger the build that reports it.
        for (const candidate of candidates) reached.add(candidate);
      }
    }
  }
  return reached;
}
