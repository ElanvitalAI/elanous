import { expect, test } from 'bun:test';
import { buildNextTuiHelpLines, NEXT_TUI_INPUT_CONTEXT, resolveNextTuiRoute } from '../core/registry.js';
import { runNextTuiMissionBranchRoute, type MissionSlashContext, type MissionWatchPoll } from './mission.js';

test('/mission is generated into help and attached through its lazy branch module', async () => {
  const help = buildNextTuiHelpLines(NEXT_TUI_INPUT_CONTEXT).join('\n');
  expect(help).toContain('/mission — 미션 목록·진행·브리핑');
  const route = resolveNextTuiRoute('/mission trace run-1', NEXT_TUI_INPUT_CONTEXT);
  expect(route?.branchHost).toBe('mission');
  expect(route?.branchModule).toBe('./slash/mission.js');
  const branch = await import(new URL('./mission.js', import.meta.url).href);
  expect(branch.runNextTuiMissionBranchRoute).toBe(runNextTuiMissionBranchRoute);
});

test('/mission branch forwards approve and its run watcher polls trace state', async () => {
  const calls: Record<string, unknown>[] = [];
  let runPoll: MissionWatchPoll | undefined;
  const context: MissionSlashContext = {
    chatLines: [],
    setChatScrollOffset: () => {},
    muted: (value) => value,
    accent: (value) => value,
    text: (value) => value,
    error: (value) => value,
    success: (value) => value,
    warning: (value) => value,
    info: (value) => value,
    subtext: (value) => value,
    missionTui: {
      startReadyWatch: () => {},
      startRunWatch: (id, poll) => { expect(id).toBe('apm_test'); runPoll = poll; },
    },
  };
  const dispatch = async (args: Record<string, unknown>): Promise<unknown> => {
    calls.push(args);
    if (args.action === 'approve') return { note: 'started' };
    return { mission: { status: 'running' }, rollup: { total: 1, ok: 0, stale: 0, error: 0, active: 1, pending: 0 } };
  };

  await runNextTuiMissionBranchRoute('/mission approve apm_test', context, dispatch);
  expect(calls[0]).toMatchObject({ action: 'approve', id: 'apm_test', via: 'tui' });
  expect(runPoll).toBeDefined();
  const snapshot = await runPoll!();
  expect(calls[1]).toMatchObject({ action: 'trace', id: 'apm_test' });
  expect(snapshot).toMatchObject({ message: '미션 apm_test: running · 파생 1 · ✅0 ⏰0 ❌0 🔵1 ⏳0', outcome: 'pending' });
});
