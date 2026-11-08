import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanTrackedCliSpawnSites } from './cli-spawn-sites.js';

const repo = resolve(import.meta.dir, '..');
const base = process.argv[2] ?? 'origin/main';
const baseTree = join(tmpdir(), `cli-spawn-baseline-${randomUUID()}`);
const baselinePath = join(repo, 'test/cli-spawn-allowlist-baseline.json');
const allowlistPath = join(repo, 'test/cli-spawn-allowlist.json');
const contractPath = join(repo, 'test/rules-contract.test.ts');

function git(...args: string[]): void {
  execFileSync('bun', ['bin/elanous.mjs', 'git', ...args], { cwd: repo, stdio: 'inherit' });
}

function sortedObject(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

let worktreeAdded = false;
try {
  git('worktree', 'add', '--detach', baseTree, base);
  worktreeAdded = true;
  const baseCounts = scanTrackedCliSpawnSites(baseTree).counts;
  const currentCounts = scanTrackedCliSpawnSites(repo).counts;
  const growth = [...currentCounts].filter(([file, count]) => count > (baseCounts.get(file) ?? 0));
  if (growth.length) throw new Error(`branch has new direct CLI spawn sites over ${base}: ${growth.map(([file, count]) => `${file}=${count}>${baseCounts.get(file) ?? 0}`).join(', ')}`);

  const baselineText = `${JSON.stringify(sortedObject(baseCounts), null, 2)}\n`;
  const allowlistText = `${JSON.stringify(sortedObject(currentCounts), null, 2)}\n`;
  const digest = createHash('sha256').update(baselineText).digest('hex');
  const contract = readFileSync(contractPath, 'utf8');
  const updatedContract = contract.replace(/const baselineDigest = '[a-f0-9]{64}';/, `const baselineDigest = '${digest}';`);
  if (updatedContract === contract && !contract.includes(`const baselineDigest = '${digest}';`)) {
    throw new Error('rules-contract.ts baselineDigest anchor missing');
  }
  writeFileSync(baselinePath, baselineText);
  writeFileSync(allowlistPath, allowlistText);
  writeFileSync(contractPath, updatedContract);
  console.log(`R-LIVE10 baseline refreshed from ${base}: ${baseCounts.size} baseline files; allowlist ${currentCounts.size} files; sha256=${digest}`);
} finally {
  if (worktreeAdded) git('worktree', 'remove', '--force', baseTree);
}
