import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_MAINTENANCE_CRON } from './repo-maintenance.js';

export const REPO_MAINTENANCE_SCHEDULE_COMMAND = 'nice -n 10 bun scripts/hq-repo-maintenance-cycle.ts';
type CommandResult = { status: number | null; stdout: string; stderr: string };
type CommandRunner = (file: string, args: string[]) => CommandResult;

const defaultRunner: CommandRunner = (file, args) => {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? result.error?.message ?? '' };
};

export function installHqRepoMaintenanceSchedule(
  run: CommandRunner = defaultRunner,
  lockPath = join(homedir(), 'elanous-hq', 'seat-state', 'OP', 'hq-repo-maintenance-schedule.lock'),
): { status: 'already-installed' | 'installed' } {
  mkdirSync(dirname(lockPath), { recursive: true });
  try { mkdirSync(lockPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('HQ repo maintenance schedule installer lock exists at ' + lockPath + '; inspect owner.json and confirm its pid is gone before removing a stale lock');
    throw error;
  }
  try {
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: Date.now() }) + '\n', { flag: 'wx', mode: 0o600 });
  const listed = run('eln', ['schedule', 'list', '--json']);
  if (listed.status !== 0) throw new Error('cannot inspect schedules: ' + listed.stderr.trim().slice(0, 500));
  let schedules: unknown;
  try { schedules = (JSON.parse(listed.stdout) as { schedules?: unknown }).schedules; } catch {
    throw new Error('schedule list returned invalid JSON');
  }
  if (!Array.isArray(schedules)) throw new Error('schedule list omitted schedules');
  const matching = schedules.filter((item) => item && typeof item === 'object'
    && [Reflect.get(item, 'command'), Reflect.get(item, 'command_full')].some((value) =>
      typeof value === 'string' && value.includes('scripts/hq-repo-maintenance-cycle.ts')));
  const exactRunner = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') return false;
    const commands = [Reflect.get(item, 'command'), Reflect.get(item, 'command_full')];
    return commands.some((value) => {
      if (typeof value !== 'string' || value.includes('--install-schedule')) return false;
      const withoutLog = value.trim().replace(/\s+(?:>>?|2>>?)\s+[^&]+?(?:\s+2>&1)?$/u, '').trim();
      const parts = withoutLog.split(/\s*&&\s*/u).map((part) => part.trim());
      if (parts.length === 1) return parts[0] === REPO_MAINTENANCE_SCHEDULE_COMMAND;
      return parts.length === 2 && /^cd\s+.+$/u.test(parts[0]!) && parts[1] === REPO_MAINTENANCE_SCHEDULE_COMMAND;
    });
  };
  if (matching.length) {
    if (matching.length === 1 && exactRunner(matching[0])
      && Reflect.get(matching[0], 'cron') === REPO_MAINTENANCE_CRON
      && Reflect.get(matching[0], 'enabled') === true) return { status: 'already-installed' };
    throw new Error('a disabled, duplicate, or differently scheduled HQ repo maintenance job exists; inspect it before changing schedules');
  }
  const created = run('eln', ['schedule', 'create', '--cron', REPO_MAINTENANCE_CRON,
    '--command', REPO_MAINTENANCE_SCHEDULE_COMMAND, '--json']);
  if (created.status !== 0) throw new Error('schedule creation failed: ' + created.stderr.trim().slice(0, 500));
  return { status: 'installed' };
  } finally { rmSync(lockPath, { recursive: true, force: true }); }
}
