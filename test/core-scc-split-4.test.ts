import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import type { AcpServerHandle } from '../src/acp/server.js';
import type { PreviewTapServerHandle } from '../src/web-terminal/preview-tap-registry.js';
import { SELF_COGNITION_TOOL_NAMES, SELF_COGNITION_MCP_CATALOG_ENTRIES } from '../src/tool-runtime/self-cognition-catalog.js';
import { nativeToolCatalog } from '../src/native-tool-catalog.js';

const root = resolve(import.meta.dir, '..');
const source = (path: string) => readFileSync(resolve(root, path), 'utf8');

function importsOf(text: string): string[] {
  const imports = ts.preProcessFile(text, true, true).importedFiles.map(file => file.fileName);
  for (const match of text.matchAll(/\btypeof\s+import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!imports.includes(match[1]!)) imports.push(match[1]!);
  }
  return imports;
}

// The real ACP handle must be assignable to the registry's local structural contract.
const h: PreviewTapServerHandle = {} as AcpServerHandle;
void h;

describe('CORE-SCC-SPLIT-4 import boundary', () => {
  test('native catalog imports the metadata leaf, not the runtime implementation', () => {
    const imports = importsOf(source('src/native-tool-catalog.ts'));
    expect(imports.filter(path => path === './tool-runtime/self-cognition-catalog.js')).toHaveLength(1);
    expect(imports.filter(path => path === './tool-runtime/self-cognition-runtimes.js')).toHaveLength(0);
  });

  test('preview tap registry imports no ACP server (including type-only and typeof import)', () => {
    const text = source('src/web-terminal/preview-tap-registry.ts');
    expect(importsOf(text).filter(path => path === '../acp/server.js')).toHaveLength(0);
    const injected = `import type { AcpServerHandle } from '../acp/server.js';\n${text}`;
    expect(importsOf(injected).filter(path => path === '../acp/server.js')).toHaveLength(1);
    expect(importsOf(`${text}\ntype Coupled = typeof import('../acp/server.js');`)
      .filter(path => path === '../acp/server.js')).toHaveLength(1);
  });

  test('preprocessing detects the former native catalog import', () => {
    const injected = `import { SELF_COGNITION_MCP_CATALOG_ENTRIES } from './tool-runtime/self-cognition-runtimes.js';`;
    expect(importsOf(injected).filter(path => path === './tool-runtime/self-cognition-runtimes.js')).toHaveLength(1);
  });

  test('metadata leaf imports no repository modules and its standalone tsc graph has exactly one src file', () => {
    const leaf = 'src/tool-runtime/self-cognition-catalog.ts';
    expect(importsOf(source(leaf))).toEqual([]);
    const result = spawnSync(resolve(root, 'node_modules/.bin/tsc'), [
      '--noEmit', '--listFilesOnly', '--skipLibCheck', '--module', 'nodenext',
      '--moduleResolution', 'nodenext', '--target', 'es2022', leaf,
    ], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const srcFiles = result.stdout.split(/\r?\n/).map(path => relative(root, path))
      .filter(path => path.startsWith('src/') && path.endsWith('.ts'));
    expect(srcFiles).toEqual([leaf]);
    console.log(`self-cognition-catalog standalone tsc repository src files: ${srcFiles.length}`);
  });

  test('the five MCP names and their metadata are unchanged in the native catalog', () => {
    expect(SELF_COGNITION_TOOL_NAMES).toEqual([
      'self_recall', 'logs_query', 'ops_status', 'memory_recall', 'context_now',
    ]);
    for (const entry of SELF_COGNITION_MCP_CATALOG_ENTRIES) {
      expect(nativeToolCatalog.find(tool => tool.id === entry.id)).toEqual(entry);
      expect(entry).toMatchObject({
        aliases: [entry.id], host: ['mcp'], safety: ['read-only'],
        kind: 'other', intentScope: 'ops-ui', supportsParallel: true, defaultEnabled: true,
      });
    }
  });
});
