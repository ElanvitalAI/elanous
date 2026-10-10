import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import { sendOutbound } from '../domains/outbound-alert.js';
import { releaseLedgerRoot } from '../instance/resolve.js';
import { runLightRc, type LightRcResult } from './light-rc.js';
import { listSchedules, type ReleaseSchedule } from './release-schedule.js';

export type StepId = 'rc-7h' | 'rc-150m';
export type RehearsalOutcome = 'ok' | 'regression' | 'unmeasured' | 'error' | 'no-checkout' | 'checkout-dirty' | 'superseded' | 'interrupted';
export type RehearsalPlan =
  | { status: 'no-schedule' }
  | { status: 'not-yet'; version: string; cutAt: string; nextStepAt: string }
  | { status: 'due'; version: string; cutAt: string; run: StepId | null; supersede: StepId[] }
  | { status: 'nothing-due'; version: string; cutAt: string };

const steps = [{ id: 'rc-7h', minutes: 420 }, { id: 'rc-150m', minutes: 150 }] as const;
const minute = 60_000;

/** Only the earliest future cut is eligible. A missed early step is never run back-to-back with the late step. */
export function planRehearsal(schedules: readonly ReleaseSchedule[], now: Date, stamps: Readonly<Partial<Record<StepId, boolean>>>): RehearsalPlan {
  const current = now.getTime();
  if (!Number.isFinite(current)) throw new Error('now must be a valid date');
  const schedule = schedules.filter(row => Number.isFinite(Date.parse(row.cutAt)) && Date.parse(row.cutAt) > current)
    .sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt) || a.version.localeCompare(b.version))[0];
  if (!schedule) return { status: 'no-schedule' };
  const { version, cutAt } = schedule;
  const cut = Date.parse(cutAt);
  const open = steps.filter(step => !stamps[step.id]);
  if (!open.length) return { status: 'nothing-due', version, cutAt };
  if (current >= cut - 45 * minute) return { status: 'due', version, cutAt, run: null, supersede: open.map(step => step.id) };
  if (current >= cut - 150 * minute) {
    return { status: 'due', version, cutAt, run: stamps['rc-150m'] ? null : 'rc-150m', supersede: stamps['rc-7h'] ? [] : ['rc-7h'] };
  }
  const due = open.filter(step => current >= cut - step.minutes * minute);
  if (due.length) return { status: 'due', version, cutAt, run: due[0]!.id, supersede: [] };
  return { status: 'not-yet', version, cutAt, nextStepAt: new Date(cut - open[0]!.minutes * minute).toISOString() };
}

export interface RehearsalStamp {
  version: string;
  step: StepId;
  cutAt: string;
  outcome: RehearsalOutcome | 'running';
  startedAt: string;
  endedAt?: string;
  sha?: string;
  summary?: string;
  regressionFiles?: string[];
  result?: LightRcResult;
  notifiedAt?: string;
  ownerPid?: number;
}

export interface RehearsalOptions {
  apply?: boolean;
  checkout?: string;
  ledgerRoot?: string;
}

export interface RehearsalDeps {
  now?: () => Date;
  schedules?: (root: string) => ReleaseSchedule[];
  lightRc?: (version: string, checkout: string) => Promise<LightRcResult>;
  notify?: (text: string) => void | boolean | Promise<void | boolean>;
  git?: (args: string[], cwd: string) => { rc: number | null; stdout: string; stderr?: string };
}

export type RehearsalTickResult = RehearsalPlan & { applied?: boolean; stamps?: RehearsalStamp[]; notificationFailures?: number };

function stampPath(root: string, version: string, step: StepId): string {
  if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(version)) throw new Error(`invalid release version: ${version}`);
  return join(root, 'release', version, 'rehearsal', `${step}.json`);
}

const defaultGit: NonNullable<RehearsalDeps['git']> = (args, cwd) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { rc: run.error ? null : run.status, stdout: run.stdout ?? '', stderr: run.error ? String(run.error) : run.stderr ?? '' };
};

function gitResult(git: NonNullable<RehearsalDeps['git']>, args: string[], checkout: string): string {
  const result = git(args, checkout);
  if (result.rc !== 0) throw new Error(`git ${args.join(' ')} rc=${result.rc}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function oneLine(text: string): string { return text.replace(/\s+/g, ' ').trim(); }

function outcomeLine(stamp: RehearsalStamp): string {
  const head = `${stamp.outcome === 'regression' || stamp.outcome === 'error' || stamp.outcome === 'interrupted' ? '⛔' : '🧪'} 리허설 ${stamp.version} ${stamp.step} · ${stamp.outcome}`;
  if (stamp.outcome === 'no-checkout') return `${head} · ELANOUS_REHEARSAL_GIT_CWD=<깨끗한 체크아웃> 설정 필요`;
  if (stamp.outcome === 'checkout-dirty') return `${head} · 체크아웃 변경을 보존했다`;
  if (!stamp.result) return `${head}${stamp.summary ? ` · ${stamp.summary}` : ''}`;
  const result = stamp.result;
  const duration = Math.max(0, Math.round((Date.parse(stamp.endedAt!) - Date.parse(stamp.startedAt)) / minute));
  return `${head} · 새 회귀 ${result.introduced ?? '못 쟀다'} · 기존 ${result.preexisting ?? '못 쟀다'} · 미분류 ${result.unclassified ?? '못 쟀다'} · ${result.remote ?? 'local'} · ${duration}분${stamp.outcome === 'error' ? ` · gate rc ${result.gateExitCode}${!result.ok ? ' · RC 실패' : ''}` : ''}${stamp.regressionFiles?.length ? ` · 파일 ${stamp.regressionFiles.slice(0, 3).join(', ')}` : ''}`;
}

function persistStamp(path: string, stamp: RehearsalStamp): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(stamp)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** A stamp that cannot be parsed (e.g. written by an older build that crashed mid-write) is reported, never re-run. */
function readStampFile(path: string): RehearsalStamp | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as RehearsalStamp; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    debug.log('release.rehearsal', 'stamp-unreadable', { path, error: oneLine(String(error)) });
    return null;
  }
}

function ownerIsDead(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function aged(startedAt: string, now: number): boolean {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && now - started > 15 * minute;
}

/**
 * Exclusive lock without ever removing another process's lock. Generation `<base>`, `<base>.1`, … is created with
 * wx and carries `{ pid, token }`. A generation whose holder is gone (or an empty/unreadable one older than a
 * minute — a crash inside the create) is skipped, never unlinked, so two contenders recovering the same dead lock
 * still race on one wx create. A live, fresh-unreadable holder stops the scan (fail closed; a later tick retries).
 * There is no generation cap: a dead generation only exists after a crash, so the scan is always finite.
 * Returns a release function that removes only the acquired generation.
 */
function acquireGenerationLock(base: string): { release: () => void } | null {
  const contents = JSON.stringify({ pid: process.pid, token: randomUUID() });
  for (let generation = 0; ; generation++) {
    const path = generation ? `${base}.${generation}` : base;
    try { writeFileSync(path, contents, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: { pid?: number } | null = null;
      try { holder = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number }; } catch { holder = null; }
      if (holder) { if (ownerIsDead(holder.pid)) continue; return null; }
      try { if (Date.now() - statSync(path).mtimeMs > minute) continue; }
      catch (inner) { if ((inner as NodeJS.ErrnoException).code === 'ENOENT') { generation--; continue; } }
      return null;
    }
    return {
      // Only this process ever writes or removes this generation, so removing it is race-free.
      release: () => { try { if (readFileSync(path, 'utf8') === contents) unlinkSync(path); } catch (inner) { if ((inner as NodeJS.ErrnoException).code !== 'ENOENT') throw inner; } },
    };
  }
}

/** A notification lock only fences delivery, never the RC claim. A living sender is never evicted for elapsed time alone. */
async function deliverStamp(path: string, notify: NonNullable<RehearsalDeps['notify']>, now: NonNullable<RehearsalDeps['now']>): Promise<boolean> {
  const lock = acquireGenerationLock(`${path}.notify.lock`);
  if (!lock) return false;
  try {
    const stamp = JSON.parse(readFileSync(path, 'utf8')) as RehearsalStamp;
    if (!stamp.endedAt || stamp.notifiedAt) return true;
    try {
      if (await notify(outcomeLine(stamp)) === false) {
        debug.log('release.rehearsal', 'notify-failed', { version: stamp.version, step: stamp.step, outcome: stamp.outcome });
        return false;
      }
      stamp.notifiedAt = now().toISOString();
      persistStamp(path, stamp);
      return true;
    } catch (error) {
      debug.log('release.rehearsal', 'notify-failed', { version: stamp.version, step: stamp.step, outcome: stamp.outcome, error: oneLine(String(error)) });
      return false;
    }
  } finally {
    lock.release();
  }
}

/**
 * The running→interrupted transition is exclusive: only the tick holding the interrupt lock may re-read and rewrite
 * the stamp, so a loser never writes from its stale read and cannot clobber the winner's `notifiedAt`.
 */
function interruptStamp(path: string, saved: RehearsalStamp, now: Date): RehearsalStamp | null {
  const lock = acquireGenerationLock(`${path}.interrupt.lock`);
  if (!lock) {
    debug.log('release.rehearsal', 'step-claimed-elsewhere', { version: saved.version, step: saved.step, outcome: 'interrupted' });
    return null;
  }
  try {
    const latest = JSON.parse(readFileSync(path, 'utf8')) as RehearsalStamp;
    if (latest.outcome !== 'running' || latest.endedAt || latest.startedAt !== saved.startedAt || latest.ownerPid !== saved.ownerPid || !ownerIsDead(latest.ownerPid)) return null;
    latest.outcome = 'interrupted';
    latest.endedAt = now.toISOString();
    latest.summary = '실행 프로세스 종료 · RC 재실행 안 함';
    persistStamp(path, latest);
    return latest;
  } finally {
    lock.release();
  }
}

/** wx claim is permanent per version/step; a crashed run is reported as interrupted without running RC twice. */
export async function runRehearsalTick(opts: RehearsalOptions = {}, deps: RehearsalDeps = {}): Promise<RehearsalTickResult> {
  const root = opts.ledgerRoot ?? releaseLedgerRoot();
  const now = (deps.now ?? (() => new Date()))();
  const schedules = (deps.schedules ?? listSchedules)(root);
  if (!Number.isFinite(now.getTime())) throw new Error('now must be a valid date');
  const candidate = planRehearsal(schedules, now, {});
  const stamps = candidate.status !== 'no-schedule'
    ? Object.fromEntries(steps.map(step => [step.id, existsSync(stampPath(root, candidate.version, step.id))])) as Partial<Record<StepId, boolean>> : {};
  const plan = planRehearsal(schedules, now, stamps);
  debug.log('release.rehearsal', 'tick', { ...plan, apply: !!opts.apply });
  if (!opts.apply) return plan;
  const written: RehearsalStamp[] = [];
  const notify = deps.notify ?? ((text: string) => sendOutbound(text, 'op-report'));
  const clock = deps.now ?? (() => new Date());
  let notificationFailures = 0;
  const releaseDir = join(root, 'release');
  const versions = existsSync(releaseDir) ? readdirSync(releaseDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
  for (const version of versions) {
    if (!/^\d+\.\d+\.\d+(?:-(?:rc|alpha|beta)\.\d+)?$/.test(version)) continue;
    for (const step of steps) {
      const path = stampPath(root, version, step.id);
      if (!existsSync(path)) continue;
      const saved = readStampFile(path);
      if (!saved) continue;
      if (saved.outcome === 'running' && !saved.endedAt && aged(saved.startedAt, now.getTime()) && ownerIsDead(saved.ownerPid)) {
        const interrupted = interruptStamp(path, saved, now);
        if (interrupted) {
          written.push(interrupted);
          debug.log('release.rehearsal', 'step-done', { version, step: step.id, outcome: 'interrupted', summary: interrupted.summary });
        }
      }
      const pending = readStampFile(path);
      if (pending?.endedAt && !pending.notifiedAt && !await deliverStamp(path, notify, clock)) notificationFailures++;
    }
  }
  if (plan.status !== 'due') return { ...plan, ...(written.length ? { stamps: written, applied: true } : {}), notificationFailures };
  const claim = (step: StepId): { path: string; stamp: RehearsalStamp } | null => {
    const path = stampPath(root, plan.version, step);
    mkdirSync(dirname(path), { recursive: true });
    const stamp: RehearsalStamp = { version: plan.version, cutAt: plan.cutAt, step, outcome: 'running', startedAt: now.toISOString(), ownerPid: process.pid };
    // Crash-safe exclusive create: the complete JSON is written to a private temp file, then hard-linked into
    // place. link(2) fails with EEXIST like wx, but the stamp can never be observed empty or half-written.
    const temp = `${path}.${process.pid}.${randomUUID()}.claim.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(stamp)}\n`, { mode: 0o600 });
      linkSync(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      debug.log('release.rehearsal', 'step-claimed-elsewhere', { version: plan.version, step, outcome: 'running' });
      return null;
    } finally {
      try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { path, stamp };
  };
  const finish = async (path: string, stamp: RehearsalStamp): Promise<void> => {
    stamp.endedAt = (deps.now ?? (() => new Date()))().toISOString();
    persistStamp(path, stamp);
    written.push(stamp);
    debug.log('release.rehearsal', stamp.outcome === 'superseded' ? 'step-superseded' : 'step-done', { version: stamp.version, step: stamp.step, outcome: stamp.outcome, sha: stamp.sha, summary: stamp.summary });
    if (!await deliverStamp(path, notify, clock)) notificationFailures++;
  };
  for (const step of plan.supersede) {
    const claimed = claim(step);
    if (claimed) { claimed.stamp.outcome = 'superseded'; await finish(claimed.path, claimed.stamp); }
  }
  if (plan.run) {
    const claimed = claim(plan.run);
    if (claimed) {
      const { path, stamp } = claimed;
      debug.log('release.rehearsal', 'step-start', { version: plan.version, step: plan.run, outcome: 'running' });
      try {
        const checkout = opts.checkout?.trim() || process.env.ELANOUS_REHEARSAL_GIT_CWD?.trim();
        if (!checkout) stamp.outcome = 'no-checkout';
        else {
          const git = deps.git ?? defaultGit;
          const status = gitResult(git, ['status', '--porcelain'], checkout);
          if (status) stamp.outcome = 'checkout-dirty';
          else {
            gitResult(git, ['fetch', '-q', 'origin', 'main'], checkout);
            gitResult(git, ['checkout', '-q', '--detach', 'origin/main'], checkout);
            stamp.sha = gitResult(git, ['rev-parse', 'HEAD'], checkout);
            if (!stamp.sha) throw new Error('git rev-parse HEAD returned no sha');
            const regressionFiles: string[] = [];
            const result = await (deps.lightRc ?? ((version, cwd) => runLightRc(version, { ledgerRoot: root, log: (line) => {
              for (const entry of line.split(/\r?\n/)) {
                const file = /^- introduced: (.+?)(?: > |$)/.exec(entry)?.[1];
                if (file && regressionFiles.length < 3) regressionFiles.push(file);
              }
              console.error(line);
            } }, { cwd })))(plan.version, checkout);
            stamp.result = result;
            if (regressionFiles.length) stamp.regressionFiles = regressionFiles;
            stamp.outcome = result.introduced === null || result.unclassified === null ? 'unmeasured'
              : result.introduced > 0 ? 'regression'
              : result.unclassified > 0 ? 'unmeasured'
              : !result.ok || result.gateExitCode !== 0 ? 'error' : 'ok';
            stamp.summary = oneLine(`introduced ${result.introduced} · preexisting ${result.preexisting ?? 'unmeasured'} · unclassified ${result.unclassified} · ${result.remote ?? 'local'} · gate rc ${result.gateExitCode}${!result.ok ? ' · RC 실패' : ''}`);
          }
        }
      } catch (error) {
        stamp.outcome = 'error';
        stamp.summary = oneLine(String(error instanceof Error ? error.message : error).split(/\r?\n/, 1)[0] ?? 'unknown error');
      }
      await finish(path, stamp);
    }
  }
  return { ...plan, applied: true, stamps: written, notificationFailures };
}
