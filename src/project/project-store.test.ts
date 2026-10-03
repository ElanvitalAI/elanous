import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { createProject, getProject, listProjects, ProjectStore, suggestProjectForFolder } from './project-store.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'elanous-project-store-'));
  setElanousConfigDir(root);
});
afterEach(() => {
  resetElanousConfigDir();
  rmSync(root, { recursive: true, force: true });
});

test('create stores a complete YAML project in the config root and get/list reload it', () => {
  const folder = join(root, 'workspace');
  const created = createProject({ name: 'Alice: notes', primaryFolder: folder });
  expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(created.createdAt).toBeTruthy();
  expect(parse(readFileSync(join(root, 'projects', `${created.id}.yaml`), 'utf8'))).toEqual(created);
  expect(readdirSync(join(root, 'projects'))).toEqual([`${created.id}.yaml`]);
  expect(new ProjectStore(root).get(created.id)).toEqual(created);
  expect(getProject(created.id)).toEqual(created);
  expect(listProjects()).toEqual([created]);
  const withoutFolder = createProject({ name: 'Unscoped' });
  expect(withoutFolder).not.toHaveProperty('primaryFolder');
  expect(listProjects()).toHaveLength(2);
});

test('rejects invalid paths and malformed data without writing outside the config root', () => {
  expect(() => createProject({ name: 'wrong', primaryFolder: '../elsewhere' })).toThrow('invalid project record');
  expect(() => createProject({ name: '  ' })).toThrow('invalid project record');
  expect(listProjects()).toEqual([]);
  expect(getProject('../bad')).toBeNull();
  expect(getProject('not-an-id')).toBeNull();
  const created = createProject({ name: 'valid' });
  writeFileSync(join(root, 'projects', `${created.id}.yaml`), `id: ${created.id}\nname: valid\ncreatedAt: ${created.createdAt}\nprimaryFolder: relative\n`);
  expect(() => getProject(created.id)).toThrow('invalid project record');
});

test('folder suggestion uses the deepest ancestor, not string prefixes, and logs only match status', () => {
  const parent = createProject({ name: 'Parent', primaryFolder: join(root, 'work') });
  const child = createProject({ name: 'Child', primaryFolder: join(root, 'work', 'app') });
  createProject({ name: 'Similar', primaryFolder: join(root, 'workspace') });
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    expect(suggestProjectForFolder(join(root, 'work', 'app', 'src'))).toEqual(child);
    expect(suggestProjectForFolder(join(root, 'work', 'other'))).toEqual(parent);
    expect(suggestProjectForFolder(join(root, 'working'))).toBeNull();
    expect(log.mock.calls.filter(([category]) => category === 'project.suggestion').map(([, event, data]) => [event, data]))
      .toEqual([['checked', { matched: true }], ['checked', { matched: true }], ['checked', { matched: false }]]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(root);
    expect(JSON.stringify(log.mock.calls)).not.toContain('Child');
    expect(() => suggestProjectForFolder('relative')).toThrow('folder must be absolute');
  } finally { log.mockRestore(); }
});

test('rejects a persisted id that disagrees with its safe filename', () => {
  const first = createProject({ name: 'first' });
  const second = createProject({ name: 'second' });
  writeFileSync(join(root, 'projects', `${first.id}.yaml`), readFileSync(join(root, 'projects', `${second.id}.yaml`)));
  expect(() => getProject(first.id)).toThrow('project id does not match filename');
});

test('folder suggestion matches through a symlinked root (macOS /var → /private/var)', () => {
  const { mkdirSync, symlinkSync } = require('node:fs') as typeof import('node:fs');
  const realDir = join(root, 'real', 'proj');
  mkdirSync(join(realDir, 'src'), { recursive: true });
  symlinkSync(join(root, 'real'), join(root, 'link'));
  // Stored through the link, asked through the real path — and the other way round.
  const viaLink = createProject({ name: 'Linked', primaryFolder: join(root, 'link', 'proj') });
  expect(suggestProjectForFolder(join(realDir, 'src'))?.id).toBe(viaLink.id);
  expect(suggestProjectForFolder(join(root, 'link', 'proj', 'src'))?.id).toBe(viaLink.id);
});
