import { afterAll, beforeAll, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';
import { reconcileLateLaunchFailure } from '../task-agent/late-launch-failure.js';

const supervisorPath = fileURLToPath(new URL('./task-launch-supervisor.ts', import.meta.url));

let stateDir: string;
const priorStateDir = process.env.ELANOUS_STATE_DIR;

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'stdio-retain-state-'));
  process.env.ELANOUS_STATE_DIR = stateDir;
});

afterAll(() => {
  if (priorStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = priorStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

async function retain() {
  return import('./task-launch-supervisor.js');
}

test('late supervisor failure marks only its bound launched card failed', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  const statePath = join(scratch, 'cards.json');
  const stderrPath = join(scratch, 'run-retain-late.stderr');
  writeFileSync(statePath, JSON.stringify({ tasks: {
    'ta-late': { id: 'ta-late', status: 'launched', runId: 'run-retain-late', history: [] },
    'ta-other': { id: 'ta-other', status: 'launched', runId: 'run-other', history: [] },
  } }));
  const fd = openSync(stderrPath, 'w');
  try {
    const child = nodeSpawn(process.execPath, [supervisorPath, scratch, String(process.pid), process.execPath, '-e',
      "process.stderr.write('error: late exit\\n'); process.exit(2)"], {
      stdio: ['ignore', 'ignore', fd], env: { ...process.env, ELANOUS_TASK_CARD_ID: 'ta-late', ELANOUS_TASK_STATE_PATH: statePath },
    });
    await new Promise<void>((done) => child.once('exit', () => done()));
    const cards = JSON.parse(readFileSync(statePath, 'utf8')).tasks;
    expect(cards['ta-late'].status).toBe('launch-failed');
    expect(cards['ta-late'].history.at(-1).detail).toContain('late exit');
    expect(cards['ta-other'].status).toBe('launched');
    expect(stopLines('run-retain-late')).toHaveLength(1);
  } finally {
    closeSync(fd);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('late failure reconciliation handles a stop before card binding and never overwrites a newer run', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  const statePath = join(scratch, 'cards.json');
  try {
    writeFileSync(join(scratch, 'run-retain-race.stderr'), 'error: raced exit\n');
    const ledgerDir = join(stateDir, 'run-ledger');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(join(ledgerDir, 'run-retain-race.jsonl'), `${JSON.stringify({ timestamp: new Date().toISOString(),
      runId: 'run-retain-race', event: 'stop', data: { cause: 'existing child stop' } })}\n`);
    writeFileSync(statePath, JSON.stringify({ tasks: { 'ta-race': { id: 'ta-race', status: 'handed', history: [] } } }));
    const previousCard = process.env.ELANOUS_TASK_CARD_ID, previousPath = process.env.ELANOUS_TASK_STATE_PATH;
    process.env.ELANOUS_TASK_CARD_ID = 'ta-race'; process.env.ELANOUS_TASK_STATE_PATH = statePath;
    try { await (await retain()).retainLaunchFailureEvidence(scratch, 2); }
    finally {
      if (previousCard === undefined) delete process.env.ELANOUS_TASK_CARD_ID; else process.env.ELANOUS_TASK_CARD_ID = previousCard;
      if (previousPath === undefined) delete process.env.ELANOUS_TASK_STATE_PATH; else process.env.ELANOUS_TASK_STATE_PATH = previousPath;
    }
    writeFileSync(statePath, JSON.stringify({ tasks: { 'ta-race': { id: 'ta-race', status: 'launched', runId: 'run-newer', history: [] } } }));
    reconcileLateLaunchFailure(statePath, 'ta-race', 'run-retain-race');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).tasks['ta-race'].status).toBe('launched');
    writeFileSync(statePath, JSON.stringify({ tasks: { 'ta-race': { id: 'ta-race', status: 'launched', runId: 'run-retain-race', history: [] } } }));
    reconcileLateLaunchFailure(statePath, 'ta-race', 'run-retain-race');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).tasks['ta-race'].status).toBe('launch-failed');
    expect(stopLines('run-retain-race')).toHaveLength(1);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

function stopLines(runId: string): Array<{ event: string; data: Record<string, unknown> }> {
  const ledger = join(stateDir, 'run-ledger', `${runId}.jsonl`);
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.event === 'stop');
}

// The real 2026-11-18 16:14 failure: `harness say` exit 2, gate pool exclusivity, card stayed «launched».
const GATE_EXCLUSIVITY_STDERR = '[harness] substrate=pod pool=pool-aws1@aws1:12#k3d-elanous-registry:5050 (env)\n❌ [harness] release gate pool exclusivity: task-pod-pool-has-no-host-outside-release-gate-pool\nPod 실행 여부 또는 종료 이유를 확인하지 못했다\n';

test('TA-LAUNCH-STDIO-EVIDENCE-RETAIN: a nonzero child keeps its stderr tail and writes exactly one stop line', async () => {
  const { retainLaunchFailureEvidence } = await retain();
  const scratch = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  try {
    writeFileSync(join(scratch, 'run-retain-0001.stderr'), GATE_EXCLUSIVITY_STDERR);
    await retainLaunchFailureEvidence(scratch, 2);
    const retainedPath = join(stateDir, 'run-ledger', 'launch-failures', 'run-retain-0001.stderr');
    expect(existsSync(retainedPath)).toBe(true);
    expect(readFileSync(retainedPath, 'utf8')).toBe(GATE_EXCLUSIVITY_STDERR);
    const retainedRunDir = join(stateDir, 'run-ledger', 'launch-failures', 'run-retain-0001');
    expect(existsSync(join(retainedRunDir, 'run-retain-0001.stderr'))).toBe(true);
    expect(readFileSync(join(retainedRunDir, 'run-retain-0001.stderr'), 'utf8')).toBe(GATE_EXCLUSIVITY_STDERR);
    const stops = stopLines('run-retain-0001');
    expect(stops.length).toBe(1);
    expect(stops[0].data.class).toBe('launch-failed');
    expect(stops[0].data.cause).toContain('child rc=2');
    expect(stops[0].data.cause).toContain('release gate pool exclusivity');
    expect(stops[0].data.evidenceRef).toBe(`file:${retainedRunDir}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('TA-LAUNCH-STDIO-EVIDENCE-RETAIN: a pre-existing stop line wins the race — no second line, stderr still retained', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  try {
    writeFileSync(join(scratch, 'run-retain-0002.stderr'), 'error: the launcher early-window path already recorded a stop\n');
    const ledgerDir = join(stateDir, 'run-ledger');
    mkdirSync(ledgerDir, { recursive: true });
    const seed = { timestamp: new Date().toISOString(), runId: 'run-retain-0002', event: 'stop', data: { class: 'launch-failed', site: 'launch-failed', cause: 'child rc=2: early window', evidenceRef: 'run-ledger:run-retain-0002:stop', nextMove: 'x' } };
    writeFileSync(join(ledgerDir, 'run-retain-0002.jsonl'), `${JSON.stringify(seed)}\n`);
    const { retainLaunchFailureEvidence } = await retain();
    await retainLaunchFailureEvidence(scratch, 2);
    expect(stopLines('run-retain-0002').length).toBe(1);
    expect(stopLines('run-retain-0002')[0].data.cause).toContain('early window');
    expect(existsSync(join(ledgerDir, 'launch-failures', 'run-retain-0002.stderr'))).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('TA-LAUNCH-STDIO-EVIDENCE-RETAIN: a warning line before the fatal error does not replace the cause', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  try {
    writeFileSync(join(scratch, 'run-retain-0003.stderr'), '[dev] ⚠️ advisory warning line\n❌ fatal: the real cause\n');
    const { retainLaunchFailureEvidence } = await retain();
    await retainLaunchFailureEvidence(scratch, 3);
    const stops = stopLines('run-retain-0003');
    expect(stops.length).toBe(1);
    expect(stops[0].data.cause).toContain('fatal: the real cause');
    expect(stops[0].data.cause).not.toContain('advisory');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('TA-LAUNCH-STDIO-EVIDENCE-RETAIN: oversized stderr keeps only the last 16 KiB', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  try {
    writeFileSync(join(scratch, 'run-retain-0004.stderr'), `${'x'.repeat(20_000)}\n❌ tail marker\n`);
    const { retainLaunchFailureEvidence } = await retain();
    await retainLaunchFailureEvidence(scratch, 1);
    const retainedPath = join(stateDir, 'run-ledger', 'launch-failures', 'run-retain-0004.stderr');
    expect(statSync(retainedPath).size).toBe(16 * 1024);
    expect(readFileSync(retainedPath, 'utf8').endsWith('❌ tail marker\n')).toBe(true);
    expect(stopLines('run-retain-0004')[0].data.cause).toContain('tail marker');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('TA-LAUNCH-STDIO-EVIDENCE-RETAIN: exit code 0 retains nothing', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  try {
    writeFileSync(join(scratch, 'run-retain-0005.stderr'), 'all fine\n');
    const { retainLaunchFailureEvidence } = await retain();
    await retainLaunchFailureEvidence(scratch, 0);
    expect(existsSync(join(stateDir, 'run-ledger', 'launch-failures', 'run-retain-0005.stderr'))).toBe(false);
    expect(existsSync(join(stateDir, 'run-ledger', 'launch-failures', 'run-retain-0005'))).toBe(false);
    expect(stopLines('run-retain-0005').length).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('TA-LAUNCH-STDIO-EVIDENCE-RETAIN: a live supervisor process retains the evidence of its dying child (wiring)', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'tasks-cli-launch-'));
  const stderrPath = join(scratch, 'run-retain-0006.stderr');
  const fd = openSync(stderrPath, 'w');
  let child: ReturnType<typeof nodeSpawn>;
  try {
    child = nodeSpawn(process.execPath, [supervisorPath, scratch, String(process.pid), process.execPath, '-e',
      "process.stderr.write('[harness] say\\n❌ wiring: supervisor retains this\\n'); process.exit(2);"],
      { detached: true, stdio: ['ignore', 'ignore', fd] });
    child.unref();
    await new Promise<void>((done) => child.once('exit', () => done()));
  } finally {
    try { closeSync(fd); } catch { /* the child keeps its own copy */ }
  }
  const retainedPath = join(stateDir, 'run-ledger', 'launch-failures', 'run-retain-0006.stderr');
  for (let i = 0; i < 50 && !existsSync(retainedPath); i++) await new Promise((done) => setTimeout(done, 100));
  expect(existsSync(retainedPath)).toBe(true);
  expect(readFileSync(retainedPath, 'utf8')).toContain('wiring: supervisor retains this');
  // Terra should-fix: wait for the ledger stop line itself, not only the retained file.
  for (let i = 0; i < 50 && stopLines('run-retain-0006').length === 0; i++) await new Promise((done) => setTimeout(done, 100));
  expect(stopLines('run-retain-0006')[0].data.cause).toContain('wiring: supervisor retains this');
  expect(existsSync(join(stateDir, 'run-ledger', 'launch-failures', 'run-retain-0006', 'run-retain-0006.stderr'))).toBe(true);
  rmSync(scratch, { recursive: true, force: true });
});
