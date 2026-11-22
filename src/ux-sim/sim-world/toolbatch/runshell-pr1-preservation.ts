import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchRunShell } from '../../../skills/tools/shell.js';
import { scriptCommandPolicy } from '../../../skills/tools/run-shell-script.js';
import type { SimWorldScenario } from '../types.js';

// Product script dispatch; fake hostname is confined to this universe and records each invocation.
export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'RUNSHELL-PR1-READ-PRESERVATION',
  title: 'read-local policy routing, actual child output and no-channel behavior remain unchanged',
  async run(ctx) {
    const root = join(ctx.universeRoot, 'pr1-read');
    const bin = join(root, 'bin');
    const calls = join(root, 'calls');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'hostname'), `#!/bin/sh\nprintf 'called\\n' >> '${calls}'\nprintf '{"name":"fixture"}'\n`);
    chmodSync(join(bin, 'hostname'), 0o700);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    try {
      const args = { script: [{ id: 'host', command: ['hostname'], select: ['name'] }], cwd: root, sandbox: 'off' };
      const noChannel = await dispatchRunShell(args);
      const before = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
      const policies: string[] = [];
      const result = await dispatchRunShell(args, { scriptApproval: async argv => {
        policies.push(scriptCommandPolicy(argv));
        return { allowed: true, priorHumanApproval: false };
      } });
      const step = (JSON.parse(result.stdout) as { steps: Array<{ outcome: string; exitCode: number; selected: { name: string }; stdoutSha256: string }> }).steps[0]!;
      const after = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
      const measured = { noChannel: noChannel.outcome, before, policies, outcome: result.outcome,
        exitCode: result.exitCode, stepOutcome: step.outcome, stepExitCode: step.exitCode,
        selected: step.selected, stdoutSha256: step.stdoutSha256, calls: after };
      ctx.recorder.event('runshell-pr1-read-preservation', measured);
      const hash = 'c04ab18e6ea42f6580a0a9f8da5d560d5e5a5ee13c45d27263e242befa64671d';
      return noChannel.outcome === 'denied' && before === '' && policies.join(',') === 'read-local'
        && result.outcome === 'exit' && result.exitCode === 0 && step.outcome === 'exit' && step.exitCode === 0
        && step.selected?.name === 'fixture' && step.stdoutSha256 === hash && after === 'called\n'
        ? { ok: true } : { ok: false, reason: 'read-local product behavior changed', diff: JSON.stringify(measured) };
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    }
  },
}];
