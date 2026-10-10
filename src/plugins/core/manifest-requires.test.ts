import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginManifestFromDir, parsePluginManifest } from './manifest.js';
import type { PluginDependency } from './types.js';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('plugin.json declares knowledge packs alongside existing requires and dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-plugin-requires-'));
  directories.push(dir);
  const requires: PluginDependency = {
    elanous: '>=0.3.0', tools: ['ffmpeg'], optionalTools: ['bun'],
    optionalPython: ['numpy'], knowledgePacks: ['sales', 'policy'],
  };
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
    id: 'sample', version: '1.0.0',
    extensions: { 'ai.elanous': { requires } },
    dependencies: { widgets: ['chart'], plugins: ['other'] },
  }));
  const { manifest } = loadPluginManifestFromDir(dir, { id: 'sample' });
  expect(manifest.requires).toEqual(requires);
  expect(manifest.dependencies).toEqual({ widgets: ['chart'], plugins: ['other'] });
});

test('top-level requires is parsed without replacing the existing dependency fields', () => {
  const manifest = parsePluginManifest({ id: 'sample', requires: { knowledgePacks: ['sales'] },
    dependencies: { widgets: ['chart'], plugins: ['other'] } });
  expect(manifest.requires).toEqual({ knowledgePacks: ['sales'] });
  expect(manifest.dependencies).toEqual({ widgets: ['chart'], plugins: ['other'] });
  expect(parsePluginManifest({ id: 'legacy', dependencies: { widgets: ['chart'] } }).requires).toBeUndefined();
});

test('requires.knowledgePacks must be an array of non-empty strings', () => {
  for (const knowledgePacks of ['sales', [42], ['  ']]) {
    expect(() => parsePluginManifest({ id: 'sample', requires: { knowledgePacks } })).toThrow();
  }
});
