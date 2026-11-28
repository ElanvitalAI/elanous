// GH-DOOR-SPAWN ratchet (GH-PROXY-LAYER) — scanner literals + the tree may not grow over the frozen baseline.
// Runs on every land through the ratchet preflight (scripts/ratchets/*.test.ts).
import { describe, expect, test } from 'bun:test';
import { BASELINE_PATH, countSource, DOOR_FILES, growth, readBaseline, scanRepo, shrink, total } from './gh-door-spawn';

describe('gh-door-spawn scanner', () => {
  test('counts direct gh child starts, one per line', () => {
    expect(countSource(`const r = spawnSync('gh', ['pr', 'view', '1']);`)).toBe(1);
    expect(countSource(`execFileSync("gh", args, { encoding: 'utf8' });`)).toBe(1);
    expect(countSource('const p = Bun.spawn([`gh`, "api", "rate_limit"]);')).toBe(1);
    expect(countSource(`const p = Bun.spawnSync(['gh', 'pr', 'list']);`)).toBe(1);
    expect(countSource(`child = spawn( 'gh', args, { stdio: 'pipe' });`)).toBe(1);
    expect(countSource(`execSync('gh pr list --json number');`)).toBe(1);
    expect(countSource(`spawnSync('gh', a);\nspawnSync('gh', b);`)).toBe(2);
  });

  test('ignores comments, other binaries and the gateway call', () => {
    expect(countSource(`// spawnSync('gh', ['pr', 'view'])`)).toBe(0);
    expect(countSource(` * execFileSync('gh', args)`)).toBe(0);
    expect(countSource(`spawnSync('git', ['fetch']); // spawnSync('gh', x)`)).toBe(0);
    expect(countSource(`spawnSync('ghq', ['list']);`)).toBe(0);
    expect(countSource(`runGhCliWithResult(['pr', 'view', '1']);`)).toBe(0);
    expect(countSource(`execSync('ghost run');`)).toBe(0);
  });

  test('growth and shrink are per file', () => {
    expect(growth({ 'src/a.ts': 2, 'src/new.ts': 1 }, { 'src/a.ts': 2 })).toEqual(['src/new.ts 1 > 0']);
    expect(growth({ 'src/a.ts': 3 }, { 'src/a.ts': 2 })).toEqual(['src/a.ts 3 > 2']);
    expect(growth({ 'src/a.ts': 1 }, { 'src/a.ts': 2 })).toEqual([]);
    expect(shrink({ 'src/a.ts': 1, 'src/new.ts': 4 }, { 'src/a.ts': 2, 'src/gone.ts': 1 })).toEqual({ 'src/a.ts': 1 });
  });
});

describe('gh-door-spawn tree', () => {
  test('no file spawns gh directly more often than the frozen baseline', () => {
    const now = scanRepo();
    const base = readBaseline(BASELINE_PATH);
    expect(base.schema).toBe(1);
    expect(growth(now, base.counts)).toEqual([]);
    expect(total(now)).toBeLessThanOrEqual(total(base.counts));
  });

  test('the door files are exempt and never listed in the baseline', () => {
    expect([...DOOR_FILES].sort()).toEqual(['src/git-fs/gh-cli.ts', 'src/kit/gh-proxy/door.ts']);
    const base = readBaseline(BASELINE_PATH);
    for (const f of DOOR_FILES) expect(base.counts[f]).toBeUndefined();
  });
});
