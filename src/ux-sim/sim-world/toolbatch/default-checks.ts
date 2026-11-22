import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dispatchRunShell } from '../../../skills/tools/shell.js';
import type { OpThirtyMinuteSources } from '../../../cli/ops-30m-check.js';
import type { SimWorldDeviceDef, SimWorldScenario } from '../types.js';

const sources = (): OpThirtyMinuteSources => ({
  mainLog: Array.from({ length: 8 }, (_, i) => `fixture-main-${i}`).join('\n'),
  mainPackage: '{"version":"0.3.33-dev.0"}',
  checklist: '{"green":9,"yellow":2,"red":0,"done":3}',
  trainLog: '11-22 08:00 [train-manager] tick base=fixture queue=2',
  reviewQueue: 'pr\tengine\tclaimedBy\tstatus\n2026-11-19T19:55\tHAND-ELN-ELS-MCP\t39071\t[ELS-OP-ALLOW-RULE]\tclaim:\topen\thead c64e4bcef5d\tGATES:진행중\n38148\tterra-third\tOP\tskip · OP 가 이미 띄움/수리 대기\n',
  landingSubLog: '',
});

export const simWorldDevices: readonly SimWorldDeviceDef<{ sources: typeof sources }>[] = [{
  id: 'OP-30M-FAKE-SOURCES', title: 'fixed main history, checklist, train tick and review queue for OP checks',
  create: () => ({ sources }),
}];

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'RUNSHELL-DEFAULT-OP-30M', title: 'OP 30-minute check source parity through ordinary and scripted RunShell',
  devices: ['OP-30M-FAKE-SOURCES'],
  async run(ctx) {
    const { sources: makeSources } = ctx.device<{ sources: typeof sources }>('OP-30M-FAKE-SOURCES');
    const fixtureDir = join(ctx.universeRoot, 'fixtures');
    const binDir = join(ctx.universeRoot, 'bin');
    mkdirSync(fixtureDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const fixtureFile = join(fixtureDir, 'op-30m-sources.json');
    writeFileSync(fixtureFile, JSON.stringify(makeSources()));
    const repo = resolve(import.meta.dir, '../../../..');
    const cli = join(binDir, 'eln');
    writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${join(repo, 'bin', 'elanous.mjs')}' '--test=${ctx.universeRoot}' "$@"\n`);
    chmodSync(cli, 0o700);
    const originalPath = process.env.PATH;
    const originalState = process.env.ELANOUS_STATE_DIR;
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;
    process.env.ELANOUS_STATE_DIR = ctx.universeRoot;
    try {
      // Simulate only the policy broker's allow response, never human approval.
      const approval = async () => ({ allowed: true, priorHumanApproval: false });
      const bundled = await dispatchRunShell({ check: '30-minute', checkSeat: 'OP', checkVersion: '0.3.33', checkPreviousGreen: 6 },
        { availableToolNames: [], scriptApproval: approval });
      const report = JSON.parse(bundled.stdout) as { inbox?: { status: string; count: number | null; complete: boolean }; steps: Array<{ id: string; selected?: Record<string, unknown>; exitCode: number | null; truncated: boolean }> };
      const observed = report.steps.find((step) => step.id === 'op_check')?.selected;
      const required = report.inbox?.status === 'unknown' && report.inbox.count === null && report.inbox.complete === false
        && report.steps.map((step) => step.id).join(',') === 'inbox,op_check,cost'
        && report.steps.every((step) => step.exitCode === 0);
      const incomplete = observed?.complete === false && observed.reviewUnclaimed === 0 && observed.malformedQueueRows === 0 && observed.legacyQueueRows === 1
        && observed.unclaimedUnknownQueueRows === 0 && observed.landingSubObserved === false
        && observed.landings30m === 8 && observed.green === 9 && observed.greenDelta === 3;
      ctx.recorder.event('op-check-30m', { required, incomplete, steps: report.steps.map((step) => step.id),
        reviewUnclaimed: observed?.reviewUnclaimed, landingSubObserved: observed?.landingSubObserved });
      return required && incomplete && bundled.exitCode === 0 ? { ok: true } : { ok: false,
        diff: `required=${required} incomplete=${incomplete} expected true` };
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = originalState;
    }
  },
}];
