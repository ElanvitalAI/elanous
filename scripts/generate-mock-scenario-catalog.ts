import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMockScenarioCatalogFromRoot } from '../src/ux-sim/mock-scenario-catalog.js';

const DEFAULT_REPO_ROOT = resolve(import.meta.dir, '..');
const OUTPUT_PATH = 'src/ux-sim/mock-scenario-catalog.json';

export function buildMockScenarioCatalog(repoRoot = DEFAULT_REPO_ROOT): ReturnType<typeof loadMockScenarioCatalogFromRoot> {
  return loadMockScenarioCatalogFromRoot(repoRoot);
}

export function renderMockScenarioCatalog(repoRoot = DEFAULT_REPO_ROOT): string {
  return `${JSON.stringify(buildMockScenarioCatalog(repoRoot), null, 2)}\n`;
}

if (import.meta.main) {
  const output = resolve(DEFAULT_REPO_ROOT, OUTPUT_PATH);
  const generated = renderMockScenarioCatalog();
  if (process.argv.includes('--check')) {
    if (renderMockScenarioCatalog() !== generated) throw new Error('mock scenario fragment output is not deterministic');
    console.log('mock scenario fragments pass schema, duplicate-ID, and deterministic-output checks');
  } else {
    writeFileSync(output, generated);
    console.log(`generated ${OUTPUT_PATH}`);
  }
}
