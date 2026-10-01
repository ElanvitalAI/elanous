import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePlugin, validatePluginDir } from './plugin-maker.js';
import { listInstalledPlugins } from '../install/plugin-install.js';

const dirs: string[] = [];
const previous = process.env.ELANOUS_STATE_DIR;
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-maker-'));
  dirs.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  return root;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previous;
});

function twoNodesFor(dir: string, name: string): void {
  const graph = join(dir, 'graphs', `${name}.yaml`);
  writeFileSync(graph, readFileSync(graph, 'utf8')
    .replace("  - { node_id: done,", "  - { node_id: second, kind: agent, recipe: 'cmd:second', max_visits: 1 }\n  - { node_id: done,")
    .replace('map: { ok: done, fail: failed } }', 'map: { ok: second, fail: failed } }\n  - { from: second, on: outcome, map: { ok: done, fail: failed } }'));
  writeFileSync(join(dir, 'graphs', 'recipes.yaml'), 'main:\n  command: \'bun "$ELANOUS_GRAPH_DIR/run-step.ts" main\'\n  timeout_ms: 120000\nsecond:\n  command: \'bun "$ELANOUS_GRAPH_DIR/run-step.ts" second\'\n  timeout_ms: 120000\n');
  writeFileSync(join(dir, 'examples', 'input.json'), '{"phrase":"hello"}\n');
}

function twoNodes(dir: string): void { twoNodesFor(dir, 'sample'); }

test('fake codex writes two nodes; installed graph runs real runner with example input and six timings', async () => {
  const root = temp();
  let calls = 0;
  const result = await makePlugin({ request: 'sample', name: 'sample', parentDir: join(root, 'plugins-local'), run: true,
    deps: { codex: async (dir, prompt) => { calls++; expect(prompt).toContain('요청 원문:\nsample'); twoNodes(dir); } } });
  expect(result.errors).toEqual([]);
  expect(calls).toBe(1);
  expect(result.status).toBe('ran');
  expect(result.runStatus).toBe('done');
  expect(result.timings).toEqual({ scaffold: expect.any(Number), write: expect.any(Number), validate: expect.any(Number), install: expect.any(Number), run: expect.any(Number) });
  expect(result.graph).toContain(join('plugins', 'local', 'sample', '0.1.0', 'graphs', 'sample.yaml'));
  expect(listInstalledPlugins(root).map(item => item.name)).toEqual(['sample']);
});

test('missing cmd:score is reported and repaired exactly once', async () => {
  const root = temp();
  let calls = 0;
  const result = await makePlugin({ request: 'score', name: 'score-plugin', parentDir: join(root, 'plugins-local'), deps: {
    codex: async (dir, prompt) => {
      calls++;
      if (calls === 1) writeFileSync(join(dir, 'graphs', 'score-plugin.yaml'), readFileSync(join(dir, 'graphs', 'score-plugin.yaml'), 'utf8').replace('cmd:main', 'cmd:score'));
      else { expect(prompt).toContain('recipe score 없음'); twoNodesFor(dir, 'score-plugin'); writeFileSync(join(dir, 'graphs', 'recipes.yaml'), 'score:\n  command: \'bun "$ELANOUS_GRAPH_DIR/run-step.ts" score\'\n  timeout_ms: 120000\nsecond:\n  command: \'bun "$ELANOUS_GRAPH_DIR/run-step.ts" second\'\n  timeout_ms: 120000\n'); }
    },
  } });
  expect(calls).toBe(2);
  expect(result.status).toBe('installed');
  expect(result.errors).toEqual([]);
  expect(result.timings.repair).toEqual(expect.any(Number));
  expect(result.runStatus).toBeUndefined();
});

test('still missing recipe after repair leaves folder and never installs', async () => {
  const root = temp();
  let calls = 0;
  const result = await makePlugin({ request: 'score', name: 'broken', parentDir: join(root, 'plugins-local'), deps: {
    codex: async dir => { calls++; writeFileSync(join(dir, 'graphs', 'broken.yaml'), readFileSync(join(dir, 'graphs', 'broken.yaml'), 'utf8').replace('cmd:main', 'cmd:score')); },
  } });
  expect(calls).toBe(2);
  expect(result.status).toBe('failed');
  expect(result.errors).toContain('recipe score 없음');
  expect(existsSync(result.dir)).toBe(true);
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('src import and widened capabilities cause validation errors', async () => {
  const root = temp();
  const result = await makePlugin({ request: 'unsafe', name: 'unsafe', parentDir: join(root, 'plugins-local'), deps: {
    codex: async dir => {
      writeFileSync(join(dir, 'graphs', 'run-step.ts'), "import bad from '../../../src/secret';\nconsole.log(bad);\n");
      const manifest = join(dir, 'plugin.json');
      writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('"proc:elanous"', '"proc:elanous", "network"'));
    },
  } });
  expect(result.status).toBe('failed');
  expect(result.errors.join('\n')).toContain('src import 금지');
  expect(result.errors.join('\n')).toContain('capabilities');
  expect(await validatePluginDir(result.dir)).toEqual(result.errors);
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('invalid run-step syntax is caught before install and passed to repair', async () => {
  const root = temp();
  let calls = 0;
  const result = await makePlugin({ request: 'syntax', name: 'syntax', parentDir: join(root, 'plugins-local'), deps: {
    codex: async (dir, prompt) => {
      calls++;
      if (calls === 2) expect(prompt).toContain('run-step.ts 문법 오류');
      writeFileSync(join(dir, 'graphs', 'run-step.ts'), 'const broken = ;\n');
    },
  } });
  expect(calls).toBe(2);
  expect(result.status).toBe('failed');
  expect(result.errors.join(' ')).toContain('run-step.ts 문법 오류');
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('manifest top-level capabilities cannot override the fixed extension permissions', async () => {
  const root = temp();
  const result = await makePlugin({ request: 'override', name: 'override', parentDir: join(root, 'plugins-local'), deps: {
    codex: async dir => {
      const file = join(dir, 'plugin.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.capabilities = ['network'];
      writeFileSync(file, JSON.stringify(manifest));
    },
  } });
  expect(result.status).toBe('failed');
  expect(result.errors.join(' ')).toContain('덮어쓰기 금지');
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('named directory cannot target repository plugins', async () => {
  const root = temp();
  await expect(makePlugin({ request: 'no repo write', name: 'no-repo', parentDir: join(import.meta.dir, '../../../plugins'),
    deps: { codex: async () => { throw new Error('must not invoke codex'); } } })).rejects.toThrow('repository plugins/');
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('symlink parent into repository plugins is rejected before any write or codex call', async () => {
  const root = temp();
  const link = join(root, 'linked-plugins');
  symlinkSync(join(import.meta.dir, '../../../plugins'), link, 'dir');
  let calls = 0;
  await expect(makePlugin({ request: 'no repo write', name: 'link-guard-check', parentDir: link,
    deps: { codex: async () => { calls++; } } })).rejects.toThrow('repository plugins/');
  expect(calls).toBe(0);
  expect(existsSync(join(link, 'link-guard-check'))).toBe(false);
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('unchanged single-node scaffold fails after one repair and never installs', async () => {
  const root = temp();
  let calls = 0;
  const result = await makePlugin({ request: 'unchanged', name: 'unchanged', parentDir: join(root, 'plugins-local'),
    deps: { codex: async (_dir, prompt) => { calls++; if (calls === 2) expect(prompt).toContain('실행 노드는 2~6개여야 한다: 1개'); } } });
  expect(calls).toBe(2);
  expect(result.status).toBe('failed');
  expect(result.errors).toContain('실행 노드는 2~6개여야 한다: 1개');
  expect(existsSync(result.dir)).toBe(true);
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('seven execution nodes are rejected after repair without installation', async () => {
  const root = temp();
  let calls = 0;
  const result = await makePlugin({ request: 'too many', name: 'too-many', parentDir: join(root, 'plugins-local'), deps: {
    codex: async dir => {
      calls++;
      if (calls !== 1) return;
      const graph = join(dir, 'graphs', 'too-many.yaml');
      const text = readFileSync(graph, 'utf8');
      writeFileSync(graph, text.replace('  - { node_id: done,', Array.from({ length: 6 }, (_, i) => `  - { node_id: extra${i}, kind: agent, recipe: 'cmd:main', max_visits: 1 }`).join('\n') + '\n  - { node_id: done,'));
    },
  } });
  expect(calls).toBe(2);
  expect(result.status).toBe('failed');
  expect(result.errors).toContain('실행 노드는 2~6개여야 한다: 7개');
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('six execution nodes are accepted at the upper boundary', async () => {
  const root = temp();
  const result = await makePlugin({ request: 'upper bound', name: 'upper-bound', parentDir: join(root, 'plugins-local'), deps: {
    codex: async dir => {
      const graph = join(dir, 'graphs', 'upper-bound.yaml');
      const text = readFileSync(graph, 'utf8');
      writeFileSync(graph, text.replace('  - { node_id: done,', Array.from({ length: 5 }, (_, i) => `  - { node_id: extra${i}, kind: agent, recipe: 'cmd:main', max_visits: 1 }`).join('\n') + '\n  - { node_id: done,'));
    },
  } });
  expect(result.status).toBe('installed');
  expect(result.errors).toEqual([]);
  expect(listInstalledPlugins(root).map(item => item.name)).toEqual(['upper-bound']);
});

test('run failure keeps the installation and returns failed with runStatus', async () => {
  const root = temp();
  const result = await makePlugin({ request: 'error-on-run', name: 'error-on-run', parentDir: join(root, 'plugins-local'), run: true, deps: {
    codex: async dir => { twoNodesFor(dir, 'error-on-run'); }, runGraph: async () => { throw new Error('run unavailable'); },
  } });
  expect(result.status).toBe('failed');
  expect(result.errors).toContain('run unavailable');
  expect(listInstalledPlugins(root).map(item => item.name)).toEqual(['error-on-run']);
});

test('without --run never calls graph runner and leaves runStatus absent', async () => {
  const root = temp();
  let runs = 0;
  const result = await makePlugin({ request: 'local-only', name: 'local-only', parentDir: join(root, 'plugins-local'), deps: {
    codex: async dir => { twoNodesFor(dir, 'local-only'); }, runGraph: async () => { runs++; throw new Error('unexpected run'); },
  } });
  expect(result.status).toBe('installed');
  expect(runs).toBe(0);
  expect(result.runStatus).toBeUndefined();
  expect(result.timings.run).toBeUndefined();
});

test('existing name refuses before codex without overwriting', async () => {
  const root = temp();
  const parent = join(root, 'plugins-local');
  mkdirSync(join(parent, 'taken'), { recursive: true });
  let calls = 0;
  await expect(makePlugin({ request: 'anything', name: 'taken', parentDir: parent, deps: { codex: async () => { calls++; } } })).rejects.toThrow('already exists');
  expect(calls).toBe(0);
});

test('codexWrite leaves no run debris a fresh plugin cannot be installed with', async () => {
  const { chmodSync, existsSync: exists, mkdtempSync: mkd, mkdirSync: mkdir, readdirSync: ls, rmSync: rm, writeFileSync: write } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: j } = await import('node:path');
  const { codexWrite } = await import('./plugin-maker.js');
  const root = mkd(j(tmp(), 'codex-debris-'));
  const fake = j(root, 'fake-codex');
  // Stands in for codex: writes the requested file, the -o message, and the debug tree an elanous child leaves in cwd.
  write(fake, `#!/bin/sh
out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
echo done > "$out"; echo node > nodes.yaml
mkdir -p .elanous/debug && echo log > .elanous/debug/debug-1.log && ln -sf "$PWD/.elanous/debug/debug-1.log" .elanous/debug/latest
`);
  chmodSync(fake, 0o755);
  try {
    const fresh = j(root, 'fresh'); mkdir(fresh);
    await codexWrite(fresh, 'write a node', fake);
    expect(ls(fresh).sort()).toEqual(['nodes.yaml']);
    const kept = j(root, 'kept'); mkdir(j(kept, '.elanous'), { recursive: true }); write(j(kept, '.elanous', 'mine.txt'), 'x');
    await codexWrite(kept, 'write a node', fake);
    expect(exists(j(kept, '.elanous', 'mine.txt'))).toBe(true);
  } finally { rm(root, { recursive: true, force: true }); }
});
