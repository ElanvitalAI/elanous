import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

// SKILL-LITE1 (10-04): a skill ships alone — in the public pack and in a lite Pod there is no repository `src/` next to it.
// omni-crawl · omni-market · asset-attractiveness imported `src/cli/stdout-json.ts` and died at startup outside this repo.
export function importsLeavingSkill(skillsRoot: string): string[] {
  const out: string[] = [];
  for (const skill of readdirSync(skillsRoot)) {
    const skillDir = join(skillsRoot, skill);
    if (!statSync(skillDir).isDirectory()) continue;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(ts|tsx|mts|js|mjs)$/.test(name)) continue;
        for (const m of readFileSync(path, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
          if (relative(skillDir, resolve(dirname(path), m[1]!)).startsWith('..')) out.push(`${relative(skillsRoot, path)} -> ${m[1]}`);
        }
      }
    };
    walk(skillDir);
  }
  return out.sort();
}

test('no skill imports a file outside its own folder', () => {
  expect(importsLeavingSkill(join(import.meta.dir, '..', 'skills'))).toEqual([]);
});

test('the check catches a skill reaching into the repository src (manufactured negative)', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-self-contained-'));
  try {
    mkdirSync(join(root, 'demo', 'scripts'), { recursive: true });
    writeFileSync(join(root, 'demo', 'scripts', 'main.ts'), "import { writeStdoutJson } from '../../../src/cli/stdout-json.ts';\nimport { ok } from './local.ts';\n");
    writeFileSync(join(root, 'demo', 'scripts', 'local.ts'), 'export const ok = 1;\n');
    expect(importsLeavingSkill(root)).toEqual(['demo/scripts/main.ts -> ../../../src/cli/stdout-json.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
