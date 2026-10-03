// HS1 — a run must be stoppable from the moment its ID exists. A real child process writes the record the way the
// orchestrator now does right after resolving the run ID, then waits (pod planning / image sync); the real
// `stopHarnessRun` must find it through pid.json, with the start-time guard intact.
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultHarnessStopDeps, readPidRecordFrom, stopHarnessRun } from '../harness/harness-stop.js';

test('a run that has only written its early pid record is found by harness stop (dry run)', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'hs1-runs-'));
  const runId = 'run-hs1-early-0001';
  const module = join(import.meta.dir, 'orchestrate.ts');
  const child = Bun.spawn(['bun', '-e', `import(${JSON.stringify(module)}).then((m) => { m.writeRunPidRecord(${JSON.stringify(runId)}, ${JSON.stringify(runsDir)}, null); console.log('ready'); setInterval(() => {}, 1000); })`],
    { stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('ready');
    const record = readPidRecordFrom(runsDir, runId);
    expect(record?.pid).toBe(child.pid);
    const result = await stopHarnessRun(runId, defaultHarnessStopDeps({
      readPidRecord: (id) => readPidRecordFrom(runsDir, id),
      readGoalPath: () => null,
      scanProcesses: () => ({ status: 'ok', candidates: [] }),
      kubeContexts: () => [],
      kubectl: () => ({ status: 0, stdout: '', stderr: '' }),
    }), [], true);
    expect(result.process).toBe('dry-run');
    expect(result.pid).toBe(child.pid);
    expect(result).toMatchObject({ pidRecordFound: true });
  } finally {
    child.kill('SIGKILL');
    rmSync(runsDir, { recursive: true, force: true });
  }
}, 30_000);
