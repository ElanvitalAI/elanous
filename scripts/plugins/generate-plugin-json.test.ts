import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './generate-plugin-json.js';

test('parity check rejects a generated graph manifest whose plugin.yaml source was deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-yaml-source-missing-'));
  try {
    mkdirSync(join(root, 'absorb'));
    writeFileSync(join(root, 'absorb', 'plugin.json'), JSON.stringify({
      extensions: { 'ai.elanous': { graphManifests: { 'absorb-brief': {} } } },
    }));
    expect(run(['--check', root])).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('parity check rejects an explicitly targeted empty plugin directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-yaml-empty-target-'));
  try {
    expect(run(['--check', '--plugin-dir', root])).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy positional plugin-dir check rejects a missing source', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-yaml-positional-target-'));
  try {
    expect(run(['--check', root])).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('parity check rejects an explicitly targeted plugin directory with graph subdirectories but no manifests', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-yaml-empty-graph-target-'));
  try {
    mkdirSync(join(root, 'graph'));
    expect(run(['--check', '--plugin-dir', root])).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('generation mode fails when an explicitly targeted source is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-yaml-generate-missing-source-'));
  try {
    expect(run(['--plugin-dir', root])).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a legacy root plugin.json does not hide nested YAML plugin manifests', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-yaml-nested-root-'));
  const nested = join(root, 'absorb');
  try {
    mkdirSync(nested);
    mkdirSync(join(nested, 'graph'));
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'legacy-root', version: '1.0.0' }));
    writeFileSync(join(nested, 'plugin.yaml'), [
      'apiVersion: elanous.dev/plugin/v2',
      'id: absorb',
      'name: Absorb',
      'version: 1.0.0',
      'graphs: [./graph/brief.yaml]',
      'capabilities: [llm-judge]',
      '',
    ].join('\n'));
    writeFileSync(join(nested, 'graph/brief.yaml'), [
      'apiVersion: elanous.dev/graph/v2',
      'graph: { id: absorb-brief, version: 1.0.0, layer: flow, purpose: "Absorb fixture" }',
      '',
    ].join('\n'));
    expect(run([nested])).toBe(0);
    expect(run(['--check', root])).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('positional plugin root checks YAML manifests at both root and child directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-yaml-root-and-child-'));
  const child = join(root, 'child');
  try {
    for (const dir of [root, child]) {
      mkdirSync(join(dir, 'graph'), { recursive: true });
      writeFileSync(join(dir, 'plugin.yaml'), [
        'apiVersion: elanous.dev/plugin/v2',
        `id: ${dir === root ? 'absorb-root' : 'absorb-child'}`,
        'name: Absorb',
        'version: 1.0.0',
        'graphs: [./graph/brief.yaml]',
        'capabilities: [llm-judge]',
        '',
      ].join('\n'));
      writeFileSync(join(dir, 'graph/brief.yaml'), [
        'apiVersion: elanous.dev/graph/v2',
        `graph: { id: ${dir === root ? 'absorb-root' : 'absorb-child'}-brief, version: 1.0.0, layer: flow, purpose: "Absorb fixture" }`,
        '',
      ].join('\n'));
    }
    expect(run([root])).toBe(0);
    expect(run(['--check', root])).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
