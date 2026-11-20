// CHECKLIST-E4-RUN-RECEIPT — test-host entry for `release checklist evidence run` (dispatched by the HQ host over ssh at its commit).
// The receipt belongs in THIS host's operational logs.db (OP #112782 — E4 reads it there via the registry), so the stamp is the
// operational root, not the gate-remote scratch state or the checkout's tree-derived test universe. The test child itself still
// runs in its own fresh universe with the allow-listed env (runInIsolatedUniverse).
import { prodInstanceRoot } from '../instance/resolve.js';

process.env.ELANOUS_STATE_DIR = prodInstanceRoot();
process.env.ELANOUS_STATE_DIR_SOURCE = 'explicit';

const [{ runEvidenceReceipt, runInIsolatedUniverse }, { CHECKLIST_EVIDENCE_RUN_EVENT }, { debug }, { hqLocalHostName }, { registerStandaloneLogSink }] = await Promise.all([
  import('./checklist-evidence-run.js'),
  import('./checklist.js'),
  import('../debug/log.js'),
  import('../hq/hq.js'),
  import('../domains/standalone-log-sink.js'),
]);
await registerStandaloneLogSink('release-checklist');
// The child env is rebuilt from PATH·LANG only (evidenceRunEnv); nothing else of this process reaches it.
process.exitCode = runEvidenceReceipt(process.argv.slice(2), {
  execute: (argv, cwd) => runInIsolatedUniverse(argv, cwd),
  log: (data) => debug.log('release.checklist', CHECKLIST_EVIDENCE_RUN_EVENT, data),
  selfReportedHost: () => hqLocalHostName(),
  now: () => new Date(),
  cwd: process.cwd(),
  print: (line) => { process.stdout.write(`${line}\n`); },
});
