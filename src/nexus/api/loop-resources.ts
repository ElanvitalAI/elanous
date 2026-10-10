import { defaultListHarnessProcesses } from '../../harness/harness-cli-command.js';
import { devVersion, listChecklist } from '../../release-loop/checklist.js';
import { listSchedules } from '../../release-loop/release-schedule.js';
import { releaseLedgerRoot } from '../../instance/resolve.js';
import { getUserConfig, ORCHESTRATOR_DEFAULTS } from '../../user-config.js';
import { seatOfTree, trafficTick, TRAFFIC_SEATS, type TrafficCell, type TrafficResult } from '../../loops/orchestrator/traffic.js';
import { finishAdvice, measureFinish } from '../../loops/orchestrator/finish-rate.js';
import { jsonResponse } from './json-response.js';

/** Read-only snapshot of the same ORCH traffic decision used by the scheduled tick. */
export function observeLoopResources(deps: {
  now?: Date;
  processes?: ReturnType<typeof defaultListHarnessProcesses>;
  version?: string;
  openCells?: readonly TrafficCell[];
  nextRound?: readonly TrafficCell[];
  totalSlots?: number;
} = {}): TrafficResult {
  const now = deps.now ?? new Date();
  const cfg = getUserConfig().loops?.orchestrator ?? ORCHESTRATOR_DEFAULTS;
  const observation = deps.processes ?? defaultListHarnessProcesses();
  if (observation.status !== 'ok') throw new Error(`process observation ${observation.status}`);
  const version = deps.version ?? devVersion().replace(/-dev\.\d+$/, '');
  const upcoming = deps.nextRound === undefined ? listSchedules(releaseLedgerRoot()).filter(row => Date.parse(row.cutAt) > now.getTime())
    .sort((a, b) => Date.parse(a.cutAt) - Date.parse(b.cutAt)) : [];
  const currentIndex = upcoming.findIndex(row => row.version === version);
  const nextVersion = currentIndex < 0 ? upcoming[0]?.version : upcoming[currentIndex + 1]?.version;
  const totalSlots = deps.totalSlots ?? finishAdvice(measureFinish({}, now),
    TRAFFIC_SEATS.reduce((sum, seat) => sum + cfg.seatCaps[seat], 0)).launchSlots;
  return trafficTick({
    processes: observation.records.map(process => ({ ...process, seat: seatOfTree(process.cwdStatus === 'unknown' ? undefined : process.cwd, cfg) })),
    now, caps: cfg.seatCaps, openCells: deps.openCells ?? listChecklist(version).items, totalSlots,
    ...(deps.nextRound !== undefined ? { nextRound: deps.nextRound }
      : nextVersion ? { nextRound: listChecklist(nextVersion).items } : {}),
    retainQueuedCells: true,
  });
}

export function handleLoopResourcesGet(observe: () => TrafficResult = observeLoopResources): Response {
  try { return jsonResponse({ resource: observe() }); }
  catch { return jsonResponse({ error: 'resource-unavailable' }, 503); }
}
