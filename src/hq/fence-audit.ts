// Read-only HQ fence inventory: use the installed crontab, never install a proposed replacement.
import { debug } from '../debug/log.js';
import { FENCE_ROLES } from './hq.js';
import { inventoryCrontab, listSchedules, openSchedulesDb, parseCronLine, readCrontab } from '../domains/schedule-registry.js';
import { cronLaunchedActionsWithFence, listAllLoops, shellSegments, type LoopRegistryOptions } from '../loops/registry.js';

type SuggestedRole = 'cron' | 'seat-loop' | 'release-run' | 'conatus' | 'git-push' | 'ledger-cli' | 'unknown';
export interface UnfencedCron {
  raw: string;
  cron: string;
  command: string;
  recommendedRole: SuggestedRole;
  suggestedLine: string;
  /** Unknown roles are not executable fence arguments; the operator must choose a role. */
  manualReview?: true;
}

/** Only infer a specific role where the launched command names that activity. */
function roleFor(command: string): SuggestedRole {
  const launched = shellSegments(command).map(segment => segment.replace(/^cd\s+\S+\s*&&\s*/, '').replace(/(?:^|\s)(?:--message|--label|--note)\s+(?:'[^']*'|"[^"]*")/g, '')).join(' ');
  if (/(?:^|[\s;&|])(?:\S*\/)?git\s+push\b|(?:^|[\s/])git-push\b|tree-sync\.sh\b/i.test(launched)) return 'git-push';
  if (/(?:^|[\s/])(?:seat-loop|(?:op|tc|mk|ux)-seat|coord-bridge)(?:[.\s/-]|$)/i.test(launched)) return 'seat-loop';
  if (/(?:^|[\s/])(?:release-run|landing-heal)(?:[.\s/-]|$)|\brelease\s+(?:run|publish|place|rebalance)\b/i.test(launched)) return 'release-run';
  if (/(?:^|[\s/])conatus(?:[.\s/-]|$)/i.test(launched)) return 'conatus';
  if (/\b(?:ledger|checklist)\s+(?:set|write|update|add|create|delete)\b|(?:^|[\s/])ledger-cli(?:[.\s/-]|$)/i.test(launched)) return 'ledger-cli';
  if (/(?:^|[\s/])(?:steward|draft-cleanup|test-diet|contract-coordinator|market-posture|mission-request-judge)(?:[.\s/-]|$)/i.test(launched)) return 'cron';
  if (/\b(?:graph\s+run|harness\s+queue\s+tick|card\s+intake-scan|flow\s+tick)\b/i.test(launched)) return 'cron';
  return 'unknown';
}

const READ_ONLY = /^(?:hq (?:heartbeat|arbiter-check|seen|lease status|fence-audit)|(?:logs|config) (?:query|get|list)|loop (?:status|list)|card list|harness queue list)(?: |$)/i;
/** `hq fence --role <x>` with a role the CLI rejects never runs the payload fenced. */
function isFenceRole(role: string | undefined): boolean {
  return !!role && (FENCE_ROLES as readonly string[]).includes(role);
}
function isReadOnly(script: string, args: string[]): boolean {
  if (/^(?:cd|echo|printf|date|true)$/.test(script.split('/').pop() ?? '')) return true;
  if (!/^(?:elanous|elanous\.mjs|eln)$/.test(script.split('/').pop() ?? '')) return false;
  return READ_ONLY.test(args.slice(0, 3).join(' '));
}
const quote = (command: string) => `'${command.replaceAll("'", "'\"'\"'")}'`;

/** Reuse the installed loop inventory without touching the production schedule DB. A registry fenceRole
 * may describe only one job or segment, so each launched action is checked independently below. */
export function hqFenceAudit(deps: {
  read?: () => string;
  loops?: typeof listAllLoops;
  loopOptions?: LoopRegistryOptions;
  log?: typeof debug.log;
} = {}): UnfencedCron[] {
  const text = (deps.read ?? readCrontab)();
  const parsed = text.split('\n').map(raw => ({ raw, job: parseCronLine(raw) })).filter(
    (entry): entry is { raw: string; job: { cron: string; command: string } } => entry.job !== null,
  );
  // Inventory into an in-memory registry so the production schedule DB is never written by an audit.
  let schedules: ReturnType<typeof listSchedules> = [];
  try {
    const db = openSchedulesDb(':memory:');
    try {
      inventoryCrontab(db, { crontab: text });
      schedules = listSchedules(db);
    } finally { db.close(); }
  } catch { /* schedule metadata is advisory; the installed crontab is the source */ }
  // Registry rows are hints only: a fenceRole on one segment must not hide an unfenced sibling.
  // A broken graph or schedule inventory must not prevent auditing the installed crontab.
  let loops: ReturnType<typeof listAllLoops> = [];
  try { loops = (deps.loops ?? listAllLoops)({ ...deps.loopOptions, schedules }); } catch { /* cron inspection remains available */ }
  const results: UnfencedCron[] = [];
  for (const { raw, job: { cron, command } } of parsed) {
    const launches = cronLaunchedActionsWithFence(command);
    const unfenced = launches.filter(({ script, args, fenceRole }) => script && !isFenceRole(fenceRole) && !isReadOnly(script, args));
    if (!unfenced.length) continue;
    const unfencedCommand = unfenced.map(({ script, args }) => [script, ...args].join(' ')).join(' ; ');
    const registered = loops.find(loop => loop.cron === cron && loop.command === command);
    // An unfenced registered orchestrator can supply a role for an opaque launch.
    // If the aggregate inventory carries a fenceRole from another segment, do not
    // borrow that segment's classification for the unfenced sibling.
    const inferred = roleFor(unfencedCommand);
    const recommendedRole = inferred === 'unknown' && registered?.kind === 'orchestrator' && !registered.fenceRole ? 'cron' : inferred;
    results.push({ raw, cron, command, recommendedRole,
      ...(recommendedRole === 'unknown' ? { manualReview: true as const } : {}),
      suggestedLine: recommendedRole === 'unknown'
        ? `# manual review (unknown role): ${cron} ${command}`
        : `${cron} hq-fence ${recommendedRole} ${quote(command)}` });
  }
  try { (deps.log ?? debug.log.bind(debug))('hq.fence-audit', 'listed', {
    unfenced: results.length, unknownRole: results.filter(row => row.recommendedRole === 'unknown').length,
  }); } catch { /* observation is fail-soft */ }
  return results;
}
