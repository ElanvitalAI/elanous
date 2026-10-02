import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSkillIndex, skillIndexProblems } from '../../skills/index.js';
import { handleSkillProblems } from './skill-problems.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) { try { chmodSync(join(d, 'locked', 'SKILL.md'), 0o644); } catch { /* none */ } rmSync(d, { recursive: true, force: true }); } });
const meta = { bearerToken: 'owner-secret', noAuth: false };
const req = (path: string, method = 'GET', body?: unknown, auth = true) => new Request(`http://localhost${path}`, {
  method, headers: auth ? { authorization: 'Bearer owner-secret', 'sec-fetch-site': 'cross-site' } : { 'sec-fetch-site': 'cross-site' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('SK2 PWA — owner sees problems without paths, repairs a fixable one; others are refused', async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  const dir = mkdtempSync(join(tmpdir(), 'skill-problems-api-')); dirs.push(dir);
  mkdirSync(join(dir, 'locked'), { recursive: true });
  const path = join(dir, 'locked', 'SKILL.md');
  writeFileSync(path, '---\nname: locked\ndescription: ok\n---\n');
  chmodSync(path, 0o000);
  const deps = { problems: () => { buildSkillIndex([dir]); return skillIndexProblems().filter((p) => p.dir === dir); } };
  expect((await handleSkillProblems(req('/v1/skills/problems', 'GET', undefined, false), meta, deps)).status).toBe(401);
  const listed = await (await handleSkillProblems(req('/v1/skills/problems'), meta, deps)).json() as { items: Array<{ id: string; name: string; fixable: boolean }> };
  expect(listed.items.map((i) => [i.name, i.fixable])).toEqual([['locked', true]]);
  expect(JSON.stringify(listed)).not.toContain(dir);
  expect((await handleSkillProblems(req('/v1/skills/problems/repair', 'POST', { id: 'nope' }), meta, deps)).status).toBe(404);
  const fixed = await handleSkillProblems(req('/v1/skills/problems/repair', 'POST', { id: listed.items[0]!.id }), meta, deps);
  expect(fixed.status).toBe(200);
  const after = await (await handleSkillProblems(req('/v1/skills/problems'), meta, deps)).json() as { items: unknown[] };
  expect(after.items).toEqual([]);
});
