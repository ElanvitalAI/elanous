import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { handleMissionsList } from '../nexus/api/missions.js';
import { createMission } from './mission.js';
import { TaskStore } from './store.js';

test('mission project filter persists and composes with status; absent filter preserves legacy list', () => {
  const store = new TaskStore({ path: ':memory:' });
  try {
    const a = createMission({ title: 'project A', source: { kind: 'manual' }, projectId: 'a', status: 'active' });
    const b = createMission({ title: 'project B', source: { kind: 'manual' }, projectId: 'b', status: 'active' });
    const legacy = createMission({ title: 'legacy', source: { kind: 'manual' } });
    for (const m of [a, b, legacy]) store.saveMission(m);
    expect(store.getMission(a.id)?.projectId).toBe('a');
    expect(store.listMissions({ projectId: 'a' }).map(m => m.id)).toEqual([a.id]);
    expect(store.listMissions({ projectId: 'a', status: 'planning' })).toEqual([]);
    expect(store.listMissions().map(m => m.id)).toEqual([a.id, b.id, legacy.id]);
    expect(store.getMission(legacy.id)?.projectId).toBeUndefined();
  } finally { store.close(); }
});

test('opening a pre-project mission database adds nullable project filter without changing existing missions', () => {
  const root = mkdtempSync(join(tmpdir(), 'project-missions-migrate-'));
  const path = join(root, 'missions.db');
  try {
    const oldStore = new TaskStore({ path, noWal: true });
    const legacy = createMission({ title: 'old mission', source: { kind: 'manual' } });
    oldStore.saveMission(legacy);
    oldStore.close();
    const db = new Database(path);
    db.exec('DROP INDEX idx_tox_missions_project');
    db.exec('ALTER TABLE tox_missions DROP COLUMN project_id');
    db.close();
    const migrated = new TaskStore({ path, noWal: true });
    try {
      expect(migrated.getMission(legacy.id)?.title).toBe('old mission');
      expect(migrated.getMission(legacy.id)?.projectId).toBeUndefined();
      const assigned = createMission({ title: 'new mission', source: { kind: 'manual' }, projectId: 'a' });
      migrated.saveMission(assigned);
      expect(migrated.listMissions({ projectId: 'a' }).map(m => m.id)).toEqual([assigned.id]);
      expect(migrated.listMissions()).toHaveLength(2);
    } finally { migrated.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GET /v1/missions filters by projectId on the server and omitting it returns all', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-missions-api-'));
  try {
    setElanousConfigDir(root);
    const store = new TaskStore();
    try {
      store.saveMission(createMission({ title: 'a', source: { kind: 'manual' }, projectId: 'a' }));
      store.saveMission(createMission({ title: 'b', source: { kind: 'manual' }, projectId: 'b' }));
      store.saveMission(createMission({ title: 'unassigned', source: { kind: 'manual' } }));
    } finally { store.close(); }
    const get = async (query: string) => (await handleMissionsList(new Request(`http://localhost/v1/missions${query}`), { noAuth: true }).json()) as { total: number; missions: Array<{ projectId?: string }> };
    expect(await get('?projectId=a')).toMatchObject({ total: 1, missions: [{ projectId: 'a' }] });
    expect((await get('')).total).toBe(3);
  } finally { resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});
