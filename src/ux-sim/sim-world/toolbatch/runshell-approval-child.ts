// Isolated simulation child. Its trust anchor is supplied at process startup by its fake parent.
import { dispatchRunShell } from '../../../skills/tools/shell.js';

const result = await dispatchRunShell({ cwd: process.env.SIM_ROOT, script: [{ id: 'cluster', command: ['kubectl', 'get', 'pods', '-n', 'default', '-o', 'json'], select: ['kind'] }] }, {
  sessionId: 'sim-runshell-session',
  scriptApproval: async () => ({ allowed: true, priorHumanApproval: true }),
});
process.send?.({ type: 'sim.result', result });
process.disconnect?.();
