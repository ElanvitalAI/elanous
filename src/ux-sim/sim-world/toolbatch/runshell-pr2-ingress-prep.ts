// Preparation: no claim of PR-2 coverage until run on the PR head.
// Run in a dedicated, isolated sim process: this resets global runtime/approval state.
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { registerToolRuntime, dispatchToolByName, _resetToolRuntimeRegistryForTest } from '../../../tool-runtime/registry.js';
import { runShellRuntime } from '../../../tool-runtime/run-shell-runtime.js';
import { setShellApprover, setAuditSinkForTesting } from '../../../shell-primitive/index.js';
import { _resetApprovalCacheForTesting } from '../../../shell-primitive/approval-cache.js';
import type { SimWorldScenario } from '../types.js';

export const simWorldScenarios: readonly SimWorldScenario[] = [{
  id: 'RUNSHELL-PR2-UNAPPROVED-INGRESS',
  title: 'unapproved product ingress does not execute a marker command',
  async run(ctx) {
    // Fresh directory avoids false positives from a prior simulation run.
    const cwd = mkdtempSync(join(ctx.universeRoot, 'pr2-ingress-'));
    const control = join(cwd, 'control');
    const marker = join(cwd, 'unapproved');
    _resetToolRuntimeRegistryForTest();
    _resetApprovalCacheForTesting();
    setShellApprover(null);
    setAuditSinkForTesting(() => {});
    registerToolRuntime(runShellRuntime);
    try {
      const controlResult = await dispatchToolByName('RunShell',
        { command: ['/usr/bin/touch', control], cwd, approval: 'always' }, { surface: 'skill' });
      const controlExists = existsSync(control);
      const result = await dispatchToolByName('RunShell',
        { command: ['/usr/bin/touch', marker], cwd }, { surface: 'skill' });
      const markerExists = existsSync(marker);
      // Registry-level rejections need not have RunShell-specific fields.
      const controlOutcome = 'outcome' in controlResult ? controlResult.outcome : undefined;
      const outcome = 'outcome' in result ? result.outcome : undefined;
      const exitCode = 'exitCode' in result ? result.exitCode : undefined;
      const measured = { controlOutcome, controlExists, outcome, exitCode, markerExists };
      ctx.recorder.event('runshell-pr2-unapproved-ingress', measured);
      return controlOutcome === 'denied' && !controlExists && outcome === 'denied' && !markerExists
        ? { ok: true }
        : { ok: false, reason: 'unapproved product ingress was not denied', diff: JSON.stringify(measured) };
    } finally {
      _resetToolRuntimeRegistryForTest();
      _resetApprovalCacheForTesting();
      setShellApprover(null);
      setAuditSinkForTesting(null);
    }
  },
}];
