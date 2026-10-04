import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { dispatchSkillExec } from '../../tool-runtime/skill-exec-runtime.js';
import { jsonResponse } from './json-response.js';

export const SKILL_EXEC_PATH = '/v1/skills/exec';

type SkillJob = {
  id: string;
  skill: string;
  status: 'running' | 'done' | 'rejected' | 'failed';
  updatedAt: number;
  ok?: boolean;
  output?: string;
  reason?: 'not-allowlisted';
  error?: string;
};

type SkillExecDeps = {
  rootDir?: string;
  exec?: typeof dispatchSkillExec;
  now?: () => number;
};

export function createSkillExecJobs({ rootDir = effectiveInstanceRoot(), exec = dispatchSkillExec, now = Date.now }: SkillExecDeps = {}) {
  const base = join(rootDir, 'skill-exec');
  const active = new Set<string>();
  const unavailable = new Set<string>();
  const file = (id: string) => join(base, `${id}.json`);
  const save = (job: SkillJob) => {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    chmodSync(base, 0o700);
    writeFileSync(file(job.id), JSON.stringify(job), { mode: 0o600 });
    chmodSync(file(job.id), 0o600);
  };

  return {
    async post(req: Request): Promise<Response> {
      let body: unknown;
      try { body = await req.json(); } catch { body = null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResponse({ error: 'bad_request' }, 400);
      const { skill, task } = body as Record<string, unknown>;
      if (typeof skill !== 'string' || !skill.trim() || typeof task !== 'string' || !task.trim() || task.length > 4000) {
        return jsonResponse({ error: 'bad_request' }, 400);
      }
      const id = randomUUID();
      const update = (status: SkillJob['status'], fields: Partial<Pick<SkillJob, 'ok' | 'output' | 'reason' | 'error'>> = {}) =>
        save({ id, skill, status, updatedAt: now(), ...fields });
      update('running');
      active.add(id);
      debug.log('skill-exec.pwa', 'started', { id, skill });
      setTimeout(() => {
        void (async () => {
          try {
            const result = await exec({ skill, task });
            if (!result.ok && result.output.startsWith(`자동 실행 대상 아님: ${skill}.`)) {
              update('rejected', { reason: 'not-allowlisted' });
              debug.log('skill-exec.pwa', 'rejected', { id, skill });
            } else {
              update('done', { ok: result.ok, output: result.output.slice(0, 20_000) });
              debug.log('skill-exec.pwa', 'done', { id, skill });
            }
          } catch {
            try {
              update('failed', { error: 'skill-exec-failed' });
            } catch {
              unavailable.add(id);
            }
            debug.log('skill-exec.pwa', 'failed', { id, skill });
          } finally {
            active.delete(id);
          }
        })().catch(() => {
          unavailable.add(id);
          active.delete(id);
        });
      });
      return jsonResponse({ id }, 202);
    },
    get(id: string): Response {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return jsonResponse({ error: 'not-found' }, 404);
      if (unavailable.has(id)) return jsonResponse({ id, status: 'failed', error: 'skill-exec-failed' });
      let job: SkillJob;
      try { job = JSON.parse(readFileSync(file(id), 'utf8')) as SkillJob; }
      catch { return jsonResponse({ error: 'not-found' }, 404); }
      if (job.id !== id) return jsonResponse({ error: 'not-found' }, 404);
      if (job.status === 'running' && !active.has(id)) return jsonResponse({ id, status: 'failed', error: 'daemon-restarted' });
      const { status, ok, output, reason, error } = job;
      return jsonResponse({ id, status, ...(ok !== undefined ? { ok } : {}), ...(output !== undefined ? { output } : {}), ...(reason ? { reason } : {}), ...(error ? { error } : {}) });
    },
  };
}

export type SkillExecJobs = ReturnType<typeof createSkillExecJobs>;
