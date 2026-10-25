import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listMemories, saveMemory } from '../memory.js';
import {
  applyClaudeMemoryImport, collectClaudeMemoryFiles,
  type ClaudeMemoryStoreDeps,
} from './claude-memory-import.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function claudeProjectsFixture(): { root: string; projects: string; memoryRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'claude-memory-import-'));
  roots.push(root);
  const projects = join(root, '.claude', 'projects');
  const projectMemory = join(projects, '-home-ubuntu-elanous', 'memory');
  mkdirSync(projectMemory, { recursive: true });
  writeFileSync(join(projectMemory, 'landing-train.md'), [
    '---',
    'name: landing-train',
    'description: 착지 열차는 OP 만 발사한다',
    'type: feedback',
    '---',
    '',
    '착지 열차 발사 권한은 OP 에 있다.',
  ].join('\n'));
  writeFileSync(join(projectMemory, 'MEMORY.md'), '# index\n');
  return { root, projects, memoryRoot: join(root, 'memory') };
}

/** 생산 호출자(`elanous memory import-claude`)가 넘기는 저장소 deps 와 같은 모양. */
function storeDeps(memoryRoot: string): ClaudeMemoryStoreDeps {
  return {
    list: () => listMemories({}, memoryRoot).map(entry => ({ id: entry.id, name: entry.name })),
    save: record => { saveMemory(record, memoryRoot); },
  };
}

test('the memory import-claude path reads claude memory files into the curated store', () => {
  const { projects, memoryRoot } = claudeProjectsFixture();
  const asOf = '2026-10-14T09:00:00.000Z';

  const first = applyClaudeMemoryImport(collectClaudeMemoryFiles(projects), { asOf }, storeDeps(memoryRoot));
  expect({ saved: first.saved, updated: first.updated, imported: first.items.length })
    .toEqual({ saved: 1, updated: 0, imported: 1 });

  const stored = listMemories({}, memoryRoot);
  expect(stored.map(entry => entry.name)).toEqual(['landing-train']);
  expect(stored[0]!.type).toBe('feedback');
  expect(stored[0]!.description).toBe('착지 열차는 OP 만 발사한다');
  expect(stored[0]!.body).toContain('«10-14 기준»');
  expect(stored[0]!.body).toContain('elanous://claude-memory/landing-train');
  expect(stored[0]!.body).toContain('착지 열차 발사 권한은 OP 에 있다.');
});

test('re-importing the same claude memory overwrites by name instead of duplicating', () => {
  const { projects, memoryRoot } = claudeProjectsFixture();
  const files = () => collectClaudeMemoryFiles(projects);

  applyClaudeMemoryImport(files(), { asOf: '2026-10-14T09:00:00.000Z' }, storeDeps(memoryRoot));
  const again = applyClaudeMemoryImport(files(), { asOf: '2026-10-15T09:00:00.000Z' }, storeDeps(memoryRoot));
  expect({ saved: again.saved, updated: again.updated }).toEqual({ saved: 0, updated: 1 });

  const stored = listMemories({}, memoryRoot);
  expect(stored.length).toBe(1);
  expect(stored[0]!.body).toContain('«10-15 기준»');
});

test('projects root stray markdown is not imported as a memory', () => {
  const { projects } = claudeProjectsFixture();
  writeFileSync(join(projects, 'stray.md'), '---\nname: stray\ntype: fact\n---\n');
  expect(collectClaudeMemoryFiles(projects).map(file => file.path.endsWith('landing-train.md'))).toEqual([true]);
});
