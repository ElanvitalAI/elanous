import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Isolated source/JUnit pair for replaying census oracle classification without a live gate. */
export function createCensusOracleAxisWorld(): { root: string; gateDir: string; writeSource: (source: string) => void; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'census-oracle-axis-world-'));
  const gateDir = join(root, 'gate');
  mkdirSync(gateDir);
  const cases = [
    ['oracle.test.ts', 'resume preserves terminal and graph state'],
    ['oracle.test.ts', 'declaration without a verdict'],
    ['oracle.test.ts', 'ordinary method is not a verdict'],
    ['oracle.test.ts', 'expect object method is not a verdict'],
    ['oracle.test.ts', 'uncalled helper is not a verdict'],
    ['oracle.test.ts', 'assert object method is not a verdict'],
    ['oracle.test.ts', 'uncalled object method is not a verdict'],
    ['oracle.test.ts', 'invoked callback is a verdict'],
    ['oracle.test.ts', 'empty callback is not a verdict'],
    ['oracle.test.ts', 'immediate function is a verdict'],
    ['oracle.test.ts', 'failed before verdict', 'failed'],
    ['oracle.test.ts', 'stale annotation is not coverage'],
    ['oracle.test.ts', 'separated annotation is not coverage'],
    ['oracle.test.ts', 'custom matcher is a verdict'],
    ['oracle.test.ts', 'declared but skipped', 'skipped'],
    ['oracle.test.ts', 'unclassified assertion'],
    ['oracle.test.ts', 'unmatched name'],
    ['missing.test.ts', 'missing source'],
  ];
  writeFileSync(join(gateDir, 'cases.junit.xml'), `<testsuite>${cases.map(([file, name, result]) => `<testcase file="${file}" name="${name}" classname="" time="0">${result === 'skipped' ? '<skipped/>' : result === 'failed' ? '<failure/>' : ''}</testcase>`).join('')}</testsuite>`);
  return {
    root,
    gateDir,
    writeSource: (source) => writeFileSync(join(root, 'oracle.test.ts'), source),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
