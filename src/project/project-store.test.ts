import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { debug } from '../debug/log.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { anonymousExport, anonymousToken, createProject, getProject, listProjects, ProjectStore, relationsOf, suggestProjectForFolder } from './project-store.js';

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

test('rejects unknown relation type or a target that is not a project id as an invalid project record', () => {
  const created = createProject({ name: 'Source' });
  const other = createProject({ name: 'Other' });
  const file = join(root, 'projects', `${created.id}.yaml`);
  const base = { id: created.id, name: created.name, createdAt: created.createdAt };
  writeFileSync(file, stringify({ ...base, relations: [{ type: 'blockedBy', target: other.id }] }));
  expect(() => getProject(created.id)).toThrow('invalid project record');
  writeFileSync(file, stringify({ ...base, relations: [{ type: 'dependsOn', target: 'not-an-id' }] }));
  expect(() => getProject(created.id)).toThrow('invalid project record');
});

test('rejects a self-edge and a duplicate type+target pair as an invalid project record', () => {
  const created = createProject({ name: 'Source' });
  const other = createProject({ name: 'Other' });
  const file = join(root, 'projects', `${created.id}.yaml`);
  const base = { id: created.id, name: created.name, createdAt: created.createdAt };
  writeFileSync(file, stringify({ ...base, relations: [{ type: 'partOf', target: created.id }] }));
  expect(() => getProject(created.id)).toThrow('invalid project record');
  writeFileSync(file, stringify({
    ...base,
    relations: [
      { type: 'dependsOn', target: other.id },
      { type: 'dependsOn', target: other.id },
    ],
  }));
  expect(() => getProject(created.id)).toThrow('invalid project record');
});

test('reads legacy yaml without relations unchanged', () => {
  const created = createProject({ name: 'Legacy' });
  writeFileSync(
    join(root, 'projects', `${created.id}.yaml`),
    stringify({ id: created.id, name: created.name, createdAt: created.createdAt }),
  );
  const loaded = getProject(created.id);
  expect(loaded).toEqual({ id: created.id, name: created.name, createdAt: created.createdAt });
  expect(loaded).not.toHaveProperty('relations');
  expect(relationsOf(loaded!)).toEqual([]);
});

test('round-trips all four relation types through save and read', () => {
  const created = createProject({ name: 'Hub' });
  const a = createProject({ name: 'A' });
  const b = createProject({ name: 'B' });
  const c = createProject({ name: 'C' });
  const d = createProject({ name: 'D' });
  const relations = [
    { type: 'dependsOn' as const, target: a.id },
    { type: 'derivedFrom' as const, target: b.id },
    { type: 'partOf' as const, target: c.id },
    { type: 'deploysTo' as const, target: d.id },
  ];
  const record = { id: created.id, name: created.name, createdAt: created.createdAt, relations };
  writeFileSync(join(root, 'projects', `${created.id}.yaml`), stringify(record));
  const loaded = getProject(created.id);
  expect(loaded).toEqual(record);
  expect(relationsOf(loaded!)).toEqual(relations);
  expect(listProjects().find(item => item.id === created.id)).toEqual(record);
});

test('TENANT-BOUNDARY: 고객 프로젝트 원장은 익명 내보내기만 나간다', () => {
  const secret = 'Acme 트레이딩';
  const folder = '/home/acme/private/trading';
  const created = createProject({ name: secret, primaryFolder: folder });
  const other = createProject({ name: 'Other' });
  const exported = anonymousExport({ ...created, relations: [{ type: 'dependsOn' as const, target: other.id }] });

  expect(JSON.stringify(exported)).not.toContain(secret);
  expect(JSON.stringify(exported)).not.toContain('acme');
  expect(exported.id).toBe(created.id);
  expect(exported.createdAt).toBe(created.createdAt);
  expect(exported.name).toMatch(/^project-[0-9a-f]{16}$/);
  expect(exported.primaryFolder).toMatch(/^folder-[0-9a-f]{16}$/);
  expect(exported.relations).toEqual([{ type: 'dependsOn', target: other.id }]);

  const b = createProject({ name: 'B' });
  expect(anonymousExport(created).name).toBe(exported.name);
  expect(anonymousExport(created).name).not.toBe(anonymousExport(b).name);
  expect('primaryFolder' in anonymousExport(b)).toBe(false);
});

test('TENANT-BOUNDARY: 익명 토큰 salt는 설치별 비밀로 저장되고 다른 설치와 연결되지 않는다', () => {
  const token = anonymousToken('project', 'low-entropy project name');
  const secretPath = join(root, 'tenant-boundary-secret');
  expect(readFileSync(secretPath)).toHaveLength(32);
  expect(statSync(secretPath).mode & 0o777).toBe(0o600);

  const otherRoot = mkdtempSync(join(tmpdir(), 'elanous-project-store-other-install-'));
  try {
    setElanousConfigDir(otherRoot);
    expect(anonymousToken('project', 'low-entropy project name')).not.toBe(token);
  } finally {
    setElanousConfigDir(root);
    rmSync(otherRoot, { recursive: true, force: true });
  }
});
