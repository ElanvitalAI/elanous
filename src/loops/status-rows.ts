import { loopCronVerdict, type LoopCronVerdict } from './verdict';

const VERDICT_LABEL: Record<LoopCronVerdict, LoopRow['verdict']> = {
  alive: '살아 있음', late: '늦음', failed: '실패', off: '꺼짐',
};

export interface LoopSchedule {
  id: string;
  name: string;
  source: string;
  category: string | null;
  domain: string | null;
  runVia: string | null;
  cron: string | null;
  intervalMs: number | null;
  state: 'live' | 'firing' | 'stale' | 'off';
  next: string[];
  lastRun: { at: string; status: string | null; exit: number | null } | null;
}

export interface LoopRow {
  id: string;
  name: string;
  layer: string;
  owner: string;
  mode: string;
  lastRun: string | null;
  verdict: '살아 있음' | '늦음' | '실패' | '꺼짐' | '판정 불가';
}

export const LOOP_SCHEDULES_PATH = '/v1/schedules?includeOff=1';
export const LOOPS_PATH = '/v1/dashboard/loops';

interface RecordedLoop {
  name: string;
  label: string;
  category?: string;
  armed: boolean | null;
  last: { at: string; status: string } | null;
}

export async function loadLoopRows(fetchJson: (path: string) => Promise<unknown>, now: number): Promise<LoopRow[]> {
  const [schedulesResult, loopsResult] = await Promise.allSettled([
    fetchJson(LOOP_SCHEDULES_PATH), fetchJson(LOOPS_PATH),
  ]);
  const schedules = schedulesResult.status === 'fulfilled' ? (schedulesResult.value as { schedules?: unknown })?.schedules : null;
  const loops = loopsResult.status === 'fulfilled' ? (loopsResult.value as { loops?: { loops?: unknown } | null })?.loops?.loops : null;
  if (!Array.isArray(schedules) && !Array.isArray(loops)) throw new Error('loop registries unavailable');
  if (!Array.isArray(schedules)) throw new Error('스케줄 레지스트리 조회 실패');
  if (!Array.isArray(loops)) throw new Error('루프 레지스트리 조회 실패');
  // These registries have different ID namespaces even when labels match.
  const rows = loopRows(schedules as LoopSchedule[], now).map((row) => ({ ...row, id: `schedule:${row.id}` }));
  for (const loop of loops as RecordedLoop[]) {
    const last = loop.last ? Date.parse(loop.last.at) : NaN;
    const verdict = loopCronVerdict({
      enabled: loop.armed !== false,
      lastRunAt: loop.last?.at ?? null,
      lastStatus: loop.last?.status.toLowerCase() ?? null,
      intervalMs: null,
    }, now);
    rows.push({
      id: `loop:${loop.name}`, name: loop.label, layer: loop.category ?? '루프', owner: '미지정',
      mode: loop.armed === null ? '관측' : loop.armed ? 'armed' : 'off',
      lastRun: Number.isFinite(last) ? loop.last!.at : null,
      verdict: verdict === 'alive' ? '판정 불가' : VERDICT_LABEL[verdict],
    });
  }
  return rows;
}

export function createLoopRowsRefresh(
  fetchJson: (path: string) => Promise<unknown>,
  onResult: (result: { rows: LoopRow[]; state: 'ready' | 'error' }) => void,
  clock: () => number = Date.now,
) {
  let sequence = 0;
  let active = true;
  return {
    async refresh() {
      const request = ++sequence;
      try {
        const rows = await loadLoopRows(fetchJson, clock());
        if (active && request === sequence) onResult({ rows, state: 'ready' });
      } catch {
        if (active && request === sequence) onResult({ rows: [], state: 'error' });
      }
    },
    dispose() { active = false; },
  };
}

export function loopRows(schedules: readonly LoopSchedule[], now: number): LoopRow[] {
  return schedules.map((schedule) => {
    const last = schedule.lastRun ? Date.parse(schedule.lastRun.at) : NaN;
    const sharedVerdict = loopCronVerdict({
      enabled: schedule.state !== 'off',
      lastRunAt: schedule.lastRun?.at ?? null,
      lastStatus: schedule.lastRun?.exit != null && schedule.lastRun.exit !== 0
        ? 'failed' : schedule.lastRun?.status != null && !['ok', 'success', 'completed'].includes(schedule.lastRun.status.toLowerCase())
          ? 'failed' : schedule.lastRun?.status?.toLowerCase() ?? null,
      intervalMs: schedule.cron ? null : schedule.intervalMs,
      // A cron uses daemon calendar state; fixed intervals use the 2× interval rule.
      ...(schedule.cron ? { scheduleState: schedule.state } : {}),
    }, now);
    const noCadence = !schedule.cron && !(schedule.intervalMs && schedule.intervalMs > 0);
    const verdict = sharedVerdict === 'alive' && (!Number.isFinite(last) || noCadence)
      ? '판정 불가' : VERDICT_LABEL[sharedVerdict];
    return {
      id: schedule.id,
      name: schedule.name,
      layer: schedule.domain || schedule.category || schedule.source,
      owner: '미지정',
      mode: schedule.runVia || schedule.source,
      lastRun: Number.isFinite(last) ? schedule.lastRun!.at : null,
      verdict,
    };
  });
}
