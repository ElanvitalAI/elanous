import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { createDevProxyRuntimeRef } from './admin-dev-proxy.js';
import { routeRequest, type NexusHttpServerOpts } from './http-server.js';
import { createSkillExecJobs, type SkillExecJobs } from './skill-exec-route.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const auth = { authorization: 'Bearer owner-token' };
const path = '/v1/skills/exec';
type Exec = NonNullable<Parameters<typeof createSkillExecJobs>[0]>['exec'];
function fixture(exec: Exec) {
  const rootDir = mkdtempSync(join(tmpdir(), 'skill-exec-api-'));
  roots.push(rootDir);
  return { rootDir, jobs: createSkillExecJobs({ rootDir, exec, now: () => 1234 }) };
}
function dispatch(jobs: SkillExecJobs, url: string, init: RequestInit = {}) {
  const opts = { metaApi: { bearerToken: 'owner-token', noAuth: false }, skillExec: jobs } as unknown as NexusHttpServerOpts;
  return routeRequest(new Request(`http://nexus.test${url}`, init), opts, {} as never, null, createDevProxyRuntimeRef());
}
function post(jobs: SkillExecJobs, body: unknown) {
  return dispatch(jobs, path, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
async function poll(jobs: SkillExecJobs, id: string) {
  const response = await dispatch(jobs, `${path}/${id}`, { headers: auth });
  return { response, body: await response?.json() as { id: string; status: string; ok?: boolean; output?: string; reason?: string; error?: string } };
}
async function until(jobs: SkillExecJobs, id: string, status: string) {
  for (let i = 0; i < 100; i++) {
    const result = await poll(jobs, id);
    if (result.body.status === status) return result;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`job did not reach ${status}`);
}

test('POST accepts immediately, GET reaches running then done with bounded output, private ledger and metadata-only observation', async () => {
  let release!: (result: { skill: string; ok: boolean; output: string }) => void;
  const pending = new Promise<{ skill: string; ok: boolean; output: string }>(resolve => { release = resolve; });
  const calls: unknown[] = [];
  const { rootDir, jobs } = fixture(async args => { calls.push(args); return pending; });
  const task = 'private task text';
  const skill = 'named-skill';
  const response = await post(jobs, { skill, task });
  expect(response?.status).toBe(202);
  const { id } = await response!.json() as { id: string };
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect((await poll(jobs, id)).body).toEqual({ id, status: 'running' });
  expect(calls).toEqual([]);
  const ledgerPath = join(rootDir, 'skill-exec', `${id}.json`);
  expect(statSync(join(rootDir, 'skill-exec')).mode & 0o777).toBe(0o700);
  expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
  await new Promise(resolve => setTimeout(resolve, 1));
  expect(calls).toEqual([{ skill, task }]);
  const output = 'secret output ' + 'x'.repeat(20_100);
  release({ skill, ok: true, output });
  expect((await until(jobs, id, 'done')).body).toEqual({ id, status: 'done', ok: true, output: output.slice(0, 20_000) });
  expect(JSON.parse(readFileSync(ledgerPath, 'utf8'))).toMatchObject({ id, skill, status: 'done', ok: true, output: output.slice(0, 20_000) });
  expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);
  const events = debug.events(100).filter(e => e.category === 'skill-exec.pwa' && (e.data as { id?: string } | undefined)?.id === id);
  expect(events.map(e => e.event)).toEqual(['started', 'done']);
  expect(events.map(e => e.data)).toEqual([{ id, skill }, { id, skill }]);
  expect(JSON.stringify(events)).not.toContain(task);
  expect(JSON.stringify(events)).not.toContain('secret output');
});

test('exec result alone determines rejection versus ordinary unsuccessful completion', async () => {
  const { jobs: rejected } = fixture(async ({ skill }) => ({ skill, ok: false, output: `자동 실행 대상 아님: ${skill}. 대신 skill-hint 경로를 사용하세요.` }));
  const rejectedId = (await (await post(rejected, { skill: 'blocked', task: 'go' }))!.json() as { id: string }).id;
  expect((await until(rejected, rejectedId, 'rejected')).body).toEqual({ id: rejectedId, status: 'rejected', reason: 'not-allowlisted' });
  const { jobs: other } = fixture(async ({ skill }) => ({ skill, ok: false, output: 'research failed' }));
  const otherId = (await (await post(other, { skill: 'allowed', task: 'go' }))!.json() as { id: string }).id;
  expect((await until(other, otherId, 'done')).body).toEqual({ id: otherId, status: 'done', ok: false, output: 'research failed' });
  for (const [id, event] of [[rejectedId, 'rejected'], [otherId, 'done']]) {
    expect(debug.events(100).filter(e => e.category === 'skill-exec.pwa' && (e.data as { id?: string } | undefined)?.id === id).map(e => e.event)).toEqual(['started', event]);
  }
});

test('exceptions fail with fixed error and never leak exception text into ledger or observation', async () => {
  const secret = 'private exception detail';
  const { rootDir, jobs } = fixture(async () => { throw new Error(secret); });
  const id = (await (await post(jobs, { skill: 'allowed', task: 'private task' }))!.json() as { id: string }).id;
  expect((await until(jobs, id, 'failed')).body).toEqual({ id, status: 'failed', error: 'skill-exec-failed' });
  const ledger = readFileSync(join(rootDir, 'skill-exec', `${id}.json`), 'utf8');
  expect(ledger).not.toContain(secret);
  expect(JSON.parse(ledger)).toMatchObject({ id, status: 'failed', error: 'skill-exec-failed' });
  const events = debug.events(100).filter(e => e.category === 'skill-exec.pwa' && (e.data as { id?: string } | undefined)?.id === id);
  expect(events.map(e => e.event)).toEqual(['started', 'failed']);
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(events)).not.toContain('private task');
});

test('invalid body, absent auth, nonexistent id and extra path never execute', async () => {
  let calls = 0;
  const { jobs } = fixture(async ({ skill }) => { calls++; return { skill, ok: true, output: 'ok' }; });
  for (const body of [{ skill: '', task: 'go' }, { skill: '  ', task: 'go' }, { skill: 'x', task: '' }, { skill: 'x', task: 'x'.repeat(4001) }, { skill: 5, task: 'go' }, { skill: 'x', task: null }]) {
    expect((await post(jobs, body))?.status).toBe(400);
  }
  expect((await dispatch(jobs, path, { method: 'POST', body: JSON.stringify({ skill: 'x', task: 'go' }) }))?.status).toBe(401);
  const id = '550e8400-e29b-41d4-a716-446655440000';
  expect((await dispatch(jobs, `${path}/${id}`))?.status).toBe(401);
  expect((await poll(jobs, id)).response?.status).toBe(404);
  expect((await poll(jobs, '../outside')).response?.status).toBe(404);
  expect((await dispatch(jobs, `${path}/${id}/extra`, { headers: auth }))?.status).toBe(404);
  expect(calls).toBe(0);
});

test('another daemon running ledger is reported as failed without modifying disk', async () => {
  const { jobs, rootDir } = fixture(async ({ skill }) => ({ skill, ok: true, output: 'unused' }));
  const id = '550e8400-e29b-41d4-a716-446655440000';
  const ledgerPath = join(rootDir, 'skill-exec', `${id}.json`);
  mkdirSync(join(rootDir, 'skill-exec'), { recursive: true });
  const ledger = JSON.stringify({ id, skill: 'named', status: 'running', updatedAt: 1234 });
  writeFileSync(ledgerPath, ledger);
  expect((await poll(jobs, id)).body).toEqual({ id, status: 'failed', error: 'daemon-restarted' });
  expect(readFileSync(ledgerPath, 'utf8')).toBe(ledger);
});
