// Read-only inventory of work tied to the current HQ host before moving it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { inventoryCrontab, listSchedules, openSchedulesDb, parseCronLine } from '../domains/schedule-registry.js';
import { cronLaunchedActionsWithFence, listAllLoops, type AllLoopEntry, type LoopRegistryOptions } from '../loops/registry.js';
import { defaultSshRunner, type SshRunner } from './lease.js';
import { FENCE_ROLES } from './hq.js';

type Measurement<T> = { status: 'measured'; value: T } | { status: '못 잼'; reason: string };
interface MovePlan {
  to: string;
  from: string | null;
  unfencedCron: Measurement<Array<{ raw: string; cron: string; command: string }>>;
  hostLoops: Measurement<AllLoopEntry[]>;
  targetHost: Measurement<{ exists: boolean; name: string | null }>;
  nexusLaunchd: Measurement<{ present: boolean; measuredOn: 'local' }>;
}

type CommandResult = { status: number | null; stdout: string; stderr: string };
interface MovePlanDeps {
  crontab?: () => CommandResult;
  loops?: typeof listAllLoops;
  loopOptions?: LoopRegistryOptions;
  ssh?: SshRunner;
  launchctl?: () => CommandResult;
  localHost?: () => string;
  hostFile?: string;
}

const measured = <T>(value: T): Measurement<T> => ({ status: 'measured', value });
const unknown = <T>(reason: string): Measurement<T> => ({ status: '못 잼', reason });
const run = (command: string, args: string[]): CommandResult => {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, env: process.env });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// Only known HQ jobs qualify by script name; a random scripts/*.ts is not HQ work.
const HQ_SCRIPTS = new Set([
  'steward.ts', 'draft-cleanup.ts', 'test-diet.ts', 'contract-coordinator.ts',
  'market-posture.ts', 'mission-request-judge.ts',
]);
function isHqAction(script: string): boolean {
  if (/(?:^|\/)(?:eln|elanous|elanous\.mjs)$/i.test(script)) return true;
  if (/(?:^|\/)\.elanous(?:\/|$)/i.test(script)) return true;
  const match = script.match(/(?:^|\/)scripts\/([^/\s]+\.ts)$/);
  return !!match && HQ_SCRIPTS.has(match[1]!);
}

export function hqMovePlan(to: string, deps: MovePlanDeps = {}): MovePlan {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(to) || to.includes('..')) throw new Error('hq move-plan: invalid host');
  let unfencedCron: MovePlan['unfencedCron'];
  let hostLoops: MovePlan['hostLoops'];
  let localName: string | undefined;
  let localHostError: string | undefined;
  try {
    const value = readFileSync(deps.hostFile ?? join(homedir(), '.elanous-hq', 'host'), 'utf8');
    const name = value.endsWith('\n') ? value.slice(0, -1) : value;
    if (!name || name !== name.trim() || /[\r\n]/.test(name)) throw new Error('invalid local HQ host file');
    localName = name;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') localHostError = message(error); }
  const from = deps.localHost?.() ?? localName ?? null;
  let text = '';
  try {
    const r = (deps.crontab ?? (() => run('crontab', ['-l'])))();
    if (r.status !== 0 && !(r.status === 1 && /no crontab for /i.test(r.stderr))) {
      throw new Error(r.stderr.trim() || `crontab -l exit=${r.status}`);
    }
    text = r.status === 0 ? r.stdout : '';
    const rows = text.split('\n').map(raw => ({ raw, parsed: parseCronLine(raw) }))
      .filter((row): row is { raw: string; parsed: { cron: string; command: string } } => row.parsed !== null);
    unfencedCron = measured(rows.filter(({ parsed }) =>
      cronLaunchedActionsWithFence(parsed.command).some(action =>
        !!action.script && !(FENCE_ROLES as readonly string[]).includes(action.fenceRole ?? '')
        && isHqAction(action.script)))
      .map(({ raw, parsed }) => ({ raw, cron: parsed.cron, command: parsed.command })));
  } catch (error) { unfencedCron = unknown(message(error)); }
  try {
    if (unfencedCron.status !== 'measured') throw new Error(unfencedCron.reason);
    // The registry accepts an already-inventoried schedule set. Never open the production DB.
    const db = openSchedulesDb(':memory:');
    let schedules: ReturnType<typeof listSchedules>;
    try { inventoryCrontab(db, { crontab: text }); schedules = listSchedules(db); }
    finally { db.close(); }
    if (localHostError) throw new Error(localHostError);
    if (!from) throw new Error('local HQ host identity not confirmed (~/.elanous-hq/host missing)');
    // Cron rows use os.hostname(); match that label only after confirming this machine's HQ identity.
    const names = new Set([from, hostname()]);
    hostLoops = measured((deps.loops ?? listAllLoops)({ ...deps.loopOptions, schedules })
      .filter(loop => !!loop.host && names.has(loop.host)));
  } catch (error) { hostLoops = unknown(message(error)); }
  let targetHost: MovePlan['targetHost'];
  try {
    const r = (deps.ssh ?? defaultSshRunner)(to,
      'if [ -f "$HOME/.elanous-hq/host" ]; then printf "present\\n"; cat "$HOME/.elanous-hq/host"; elif [ ! -e "$HOME/.elanous-hq/host" ]; then printf "absent\\n"; else exit 2; fi');
    if (r.status !== 0) throw new Error(r.stderr.trim() || `ssh exit=${r.status}`);
    const [presence, ...lines] = r.stdout.split('\n');
    if (presence === 'absent') targetHost = measured({ exists: false, name: null });
    else if (presence === 'present' && lines.join('\n').trim() && !/[\r\n]/.test(lines.join('\n').trim()))
      targetHost = measured({ exists: true, name: lines.join('\n').trim() });
    else throw new Error('target host file unreadable or empty');
  } catch (error) { targetHost = unknown(message(error)); }
  let nexusLaunchd: MovePlan['nexusLaunchd'];
  try {
    const r = (deps.launchctl ?? (() => run('launchctl', ['list', 'com.elanous.nexus'])))();
    if (r.status === 0) nexusLaunchd = measured({ present: true, measuredOn: 'local' });
    else if (r.status !== null && /Could not find service|service not found|not found/i.test(r.stderr)) nexusLaunchd = measured({ present: false, measuredOn: 'local' });
    else throw new Error(r.stderr.trim() || `launchctl exit=${r.status}`);
  } catch (error) { nexusLaunchd = unknown(message(error)); }
  return { to, from, unfencedCron, hostLoops, targetHost, nexusLaunchd };
}

export function formatMovePlan(plan: MovePlan): string {
  const lines = [`hq move-plan: ${plan.from ?? '못 잼'} → ${plan.to} (read-only)`];
  const section = <T>(name: string, result: Measurement<T>, render: (value: T) => string[]) => {
    lines.push(`${name}: ${result.status === 'measured' ? '' : `못 잼 (${result.reason})`}`.trimEnd());
    if (result.status === 'measured') lines.push(...render(result.value));
  };
  section('① unfenced elanous crontab', plan.unfencedCron, rows => rows.length ? rows.map(row => `  ${row.raw}`) : ['  none']);
  section('② local host loops (loop status --all)', plan.hostLoops, rows => rows.length ? rows.map(row => `  ${row.id} · ${row.host} · ${row.title}`) : ['  none']);
  section('③ target ~/.elanous-hq/host', plan.targetHost, host => [`  ${host.exists ? host.name : 'absent'}`]);
  section('④ local launchd com.elanous.nexus', plan.nexusLaunchd, service => [`  ${service.present ? 'present' : 'absent'} (measured on local machine)`]);
  return lines.join('\n');
}
