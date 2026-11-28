import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * GH-MIRROR-ORIGIN-URL-SAFE ratchet — `git remote get-url origin` follows url.*.insteadOf, so with the GH proxy fetch mirror on
 * it prints a local mirror path and a reader that parses a GitHub slug out of it refuses. Origin is read through the one door,
 * src/git-fs/origin-url.ts (raw `git config --get remote.origin.url`, else the push URL). The sites left below only test that an
 * origin exists, compare two local sim repos, or fetch from it (a mirror path is right there) — frozen per file, never more.
 * Comments and tests are excluded. Shrinking a count lowers BASELINE with it. Expectations are independent literals.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATTERN = /'remote',\s*'get-url',\s*'origin'|remote get-url origin/;
const BASELINE: Record<string, number> = {
  'scripts/release-loop/version-node.ts': 1,
  'src/git-fs/worktree.ts': 2,
  'src/self-implement/orchestrator.ts': 1,
  'src/task-orchestrator/surfaces/pod-image-source.ts': 1,
  'src/ux-sim/release-sim-rig.ts': 2,
  'src/ux-sim/temp-git-remote.ts': 1,
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'fixtures') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

test('no new `remote get-url origin` reader outside src/git-fs/origin-url.ts (raw origin URL door)', () => {
  const counts: Record<string, number> = {};
  for (const file of [...sources(join(REPO, 'src')), ...sources(join(REPO, 'scripts'))]) {
    const rel = relative(REPO, file);
    if (rel === 'src/git-fs/origin-url.ts') continue;
    const n = readFileSync(file, 'utf8').split('\n').filter((l) => !isComment(l) && PATTERN.test(l)).length;
    if (n) counts[rel] = n;
  }
  const grown = Object.entries(counts).filter(([f, n]) => n > (BASELINE[f] ?? 0)).map(([f, n]) => `${f}: ${n} > ${BASELINE[f] ?? 0}`);
  expect(grown).toEqual([]);
});
