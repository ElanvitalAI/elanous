// POD-LIFECYCLE-STAGES — Pod 하나가 끝날 때 `pod.lifecycle stages` 한 줄: 잰 단계만 stages · 못 잰 단계는 missing.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { POD_LIFECYCLE_STAGES, SI_TASK_POD_LIFECYCLE_STAGES, emitPodLifecycle, gatePodLifecycleEvent, gatePodOutcome, parseSiTaskPodStages, siTaskPodLifecycleEvent, siTaskPodStageShell } from './pod-lifecycle-stages.js';
import { podJobManifest, podSelfImplementSpawn as realPodSelfImplementSpawn, podJobName, type Kubectl } from './self-implement-pod.js';
import type { UserConfig } from '../../user-config.js';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });
function captureLog() {
  const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  spies.push(spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: unknown) => { events.push({ category, event, data: data as Record<string, unknown> }); }) as typeof debug.log));
  return events;
}

// A gate shard as pod-0.json holds it (#27xxx GATE-WARM-BOOT-STAGES · readGatePodLifecycle).
const PHASE = { admissionStart: '2026-10-16T00:00:00.000Z', admissionEnd: '2026-10-16T00:00:01.000Z', poolPlaced: '2026-10-16T00:00:02.000Z', jobReturned: '2026-10-16T00:05:00.000Z', artifactsRead: '2026-10-16T00:05:01.000Z' };
const K8S = { podCreated: '2026-10-16T00:00:03Z', podScheduled: '2026-10-16T00:00:04Z', childStart: '2026-10-16T00:00:06Z', childEnd: '2026-10-16T00:04:59Z' };
const T0 = Date.parse('2026-10-16T00:00:06Z') / 1000;
const POD = { 'prep-start': T0, 'clone-end': T0 + 20, 'shell-start': T0 + 20, 'deps-start': T0 + 21, 'deps-end': T0 + 51, 'test-start': T0 + 51, 'test-end': T0 + 290, 'shell-end': T0 + 291 };

test('gate: the shard json values become create · schedule · clone · deps · test in ms; mirror and delete are missing', () => {
  const event = gatePodLifecycleEvent({ runId: 'run-1', podJob: 'gate-abc', host: 'k3d-elanous-pool', shard: 'pod-0', attemptId: 'att-1', phaseTimes: PHASE, podStages: POD, podLifecycle: K8S, outcome: 'pass' });
  expect(event).toEqual({ runId: 'run-1', podJob: 'gate-abc', host: 'k3d-elanous-pool', kind: 'gate', outcome: 'pass', shard: 'pod-0', attemptId: 'att-1',
    stages: [
      { stage: 'create', start: Date.parse(PHASE.poolPlaced), end: Date.parse(K8S.podCreated), clock: 'mixed' },
      { stage: 'schedule', start: Date.parse(K8S.podCreated), end: Date.parse(K8S.podScheduled), clock: 'k8s' },
      { stage: 'clone', start: T0 * 1000, end: (T0 + 20) * 1000, clock: 'pod' },
      { stage: 'deps', start: (T0 + 21) * 1000, end: (T0 + 51) * 1000, clock: 'pod' },
      { stage: 'test', start: (T0 + 51) * 1000, end: (T0 + 290) * 1000, clock: 'pod' },
    ],
    missing: ['mirror', 'delete'] });
});

test('gate: a stage with only one end, or a clock that runs backwards, is missing — never a made-up 0 s', () => {
  // prep-start is absent when the container age is unknown (gate-boot-stages) · no k8s lifecycle when the Pod read failed.
  const { 'prep-start': _prep, ...noPrep } = POD;
  const event = gatePodLifecycleEvent({ shard: 'pod-1', phaseTimes: { admissionEnd: PHASE.admissionEnd }, podStages: { ...noPrep, 'test-end': T0 + 40 }, outcome: 'fail' });
  expect(event.stages.map((s) => s.stage)).toEqual(['deps']);
  expect(event.missing).toEqual(['create', 'schedule', 'clone', 'mirror', 'test', 'delete']);
  expect(event.stages.every((s) => s.end >= s.start)).toBe(true);
  expect(event).toMatchObject({ runId: null, podJob: null, host: null });
  // A zero-length stage that was measured stays a stage (0 s ≠ missing).
  const zero = gatePodLifecycleEvent({ shard: 'pod-2', podStages: { 'deps-start': T0, 'deps-end': T0 }, outcome: 'pass' });
  expect(zero.stages).toEqual([{ stage: 'deps', start: T0 * 1000, end: T0 * 1000, clock: 'pod' }]);
  expect(zero.missing).not.toContain('deps');
  // Nothing at all: every stage is missing, none in stages.
  const none = gatePodLifecycleEvent({ shard: 'pod-3', outcome: 'job-failed' });
  expect(none.stages).toEqual([]);
  expect(none.missing).toEqual([...POD_LIFECYCLE_STAGES]);
});

test('gate outcome follows the verdict order', () => {
  expect(gatePodOutcome({ jobFailed: true, stalled: true, timedOut: true, rc: 0 })).toBe('job-failed');
  expect(gatePodOutcome({ jobFailed: false, stalled: true, timedOut: true, rc: 0 })).toBe('stall');
  expect(gatePodOutcome({ jobFailed: false, stalled: false, timedOut: true, rc: 0 })).toBe('timeout');
  expect(gatePodOutcome({ jobFailed: false, stalled: false, timedOut: false, rc: undefined })).toBe('no-verdict');
  expect(gatePodOutcome({ jobFailed: false, stalled: false, timedOut: false, rc: 0 })).toBe('pass');
  expect(gatePodOutcome({ jobFailed: false, stalled: false, timedOut: false, rc: 1 })).toBe('fail');
});

test('si-task: without Pod markers every stage is missing and the watched span rides beside the stages, not as one', () => {
  const event = siTaskPodLifecycleEvent({ runId: 'run-c', podJob: 'si-x', host: 'ctx', watchStart: 1000, watchEnd: 61_000, outcome: 'complete' });
  expect(event).toEqual({ runId: 'run-c', podJob: 'si-x', host: 'ctx', kind: 'si-task', stages: [], missing: [...SI_TASK_POD_LIFECYCLE_STAGES], outcome: 'complete', watch: { start: 1000, end: 61_000, clock: 'host' } });
  expect(siTaskPodLifecycleEvent({ podJob: 'si-y', watchStart: 5, watchEnd: 4, outcome: 'failed' })).not.toHaveProperty('watch');
});

test('emit writes one pod.lifecycle «stages» line and swallows a failing sink', () => {
  const events = captureLog();
  emitPodLifecycle(siTaskPodLifecycleEvent({ podJob: 'si-z', outcome: 'aborted' }));
  expect(events).toEqual([{ category: 'pod.lifecycle', event: 'stages', data: expect.objectContaining({ kind: 'si-task', podJob: 'si-z', outcome: 'aborted' }) }]);
  expect(() => emitPodLifecycle(siTaskPodLifecycleEvent({ podJob: 'si-z', outcome: 'x' }), () => { throw new Error('sink down'); })).not.toThrow();
});

const CREDS = () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_x' });
const podSelfImplementSpawn: typeof realPodSelfImplementSpawn = (options = {}) =>
  realPodSelfImplementSpawn({ budgetSnapshot: () => undefined, fallbackConfig: () => ({ llm: {} }) as UserConfig, ...options });

test('si-task: a finished Job emits the line once — job name, host context, child run id, outcome, all stages missing', async () => {
  const events = captureLog();
  const kubectl: Kubectl = (args) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: `${JSON.stringify({ stage: 'done', ok: true })}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const before = Date.now();
  await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'pod-lifecycle' }).done;
  const lines = events.filter((e) => e.category === 'pod.lifecycle' && e.event === 'stages');
  expect(lines).toHaveLength(1);
  const data = lines[0]!.data;
  expect(data).toMatchObject({ kind: 'si-task', podJob: podJobName('pod-lifecycle'), outcome: 'complete', stages: [], missing: [...SI_TASK_POD_LIFECYCLE_STAGES] });
  expect(String(data.runId)).toMatch(/^run-/);
  const watch = data.watch as { start: number; end: number; clock: string };
  expect(watch.clock).toBe('host');
  expect(watch.start).toBeGreaterThanOrEqual(before);
  expect(watch.end).toBeGreaterThanOrEqual(watch.start);
  // It rides beside job-finished, the event it summarises.
  const finished = events.findIndex((e) => e.category === 'self-implement.pod' && e.event === 'job-finished');
  expect(finished).toBeGreaterThanOrEqual(0);
  expect(events.indexOf(lines[0]!)).toBe(finished + 1);
});

// SI-POD-STAGE-MARKERS — the si-task Pod shell prints `ELANOUS_POD_STAGE <stage> <start|end> <epoch s>`; the host reads them from the Job log.
test('si-task markers: the shell line prints the marker the parser reads; unknown or malformed lines are dropped, the first value wins (child output comes after the shell markers)', () => {
  expect(siTaskPodStageShell('clone', 'start')).toBe(`printf 'ELANOUS_POD_STAGE clone start %s\\n' "$(date +%s)" || true`);
  const printed = Bun.spawnSync(['bash', '-c', siTaskPodStageShell('run', 'end')]).stdout.toString();
  expect(Object.keys(parseSiTaskPodStages(printed))).toEqual(['run-end']);
  const logs = ['ELANOUS_POD_STAGE clone start 100', 'ELANOUS_POD_STAGE mirror start 101\r', 'ELANOUS_POD_STAGE test start 102', 'ELANOUS_POD_STAGE run middle 103',
    'ELANOUS_POD_STAGE run start x', ' ELANOUS_POD_STAGE run start 104', 'ELANOUS_POD_STAGE run start 105', 'ELANOUS_POD_STAGE run start 106',
    'ELANOUS_POD_STAGE deps start 107', 'ELANOUS_POD_STAGE deps end 108', 'noise'].join('\n');
  expect(parseSiTaskPodStages(logs)).toEqual({ 'clone-start': 100, 'mirror-start': 101, 'run-start': 105 });
  expect(parseSiTaskPodStages(undefined)).toEqual({});
});

test('si-task markers: clone · mirror · run become pod-clock stages in ms; a start without an end (failed clone, skipped mirror, SIGTERM) stays missing', () => {
  const full = siTaskPodLifecycleEvent({ podJob: 'si-a', outcome: 'complete', podStages: { 'clone-start': 10, 'mirror-start': 11, 'mirror-end': 14, 'clone-end': 20, 'run-start': 21, 'run-end': 900 } });
  expect(full.stages).toEqual([
    { stage: 'clone', start: 10_000, end: 20_000, clock: 'pod' },
    { stage: 'mirror', start: 11_000, end: 14_000, clock: 'pod' },
    { stage: 'run', start: 21_000, end: 900_000, clock: 'pod' },
  ]);
  expect(full.missing).toEqual(['create', 'schedule', 'deps', 'delete']);
  const skipped = siTaskPodLifecycleEvent({ podJob: 'si-b', outcome: 'failed', podStages: { 'clone-start': 10, 'mirror-start': 11, 'clone-end': 30, 'run-start': 31 } });
  expect(skipped.stages.map((s) => s.stage)).toEqual(['clone']);
  expect(skipped.missing).toEqual(['create', 'schedule', 'mirror', 'deps', 'run', 'delete']);
  const backwards = siTaskPodLifecycleEvent({ podJob: 'si-c', outcome: 'complete', podStages: { 'run-start': 50, 'run-end': 40 } });
  expect(backwards.stages).toEqual([]);
  // deps has no install step in the si-task Job — even a deps pair handed in directly stays missing.
  const deps = siTaskPodLifecycleEvent({ podJob: 'si-d', outcome: 'complete', podStages: { 'deps-start': 1, 'deps-end': 2 } });
  expect(deps.stages).toEqual([]);
  expect(deps.missing).toContain('deps');
  // The gate order is unchanged: si-task swaps `test` for `run`, gate keeps `test`.
  expect(POD_LIFECYCLE_STAGES).toContain('test');
  expect(SI_TASK_POD_LIFECYCLE_STAGES).not.toContain('test');
});

test('si-task: a finished Job with stage markers in its log fills clone · mirror · run on the pod.lifecycle line', async () => {
  const events = captureLog();
  const podLog = ['ELANOUS_POD_STAGE clone start 1000', 'ELANOUS_POD_STAGE mirror start 1001', 'ELANOUS_POD_STAGE mirror end 1003', 'ELANOUS_POD_SOURCE_VIA mirror',
    'ELANOUS_POD_STAGE clone end 1005', 'ELANOUS_POD_STAGE run start 1006', 'ELANOUS_POD_STAGE run end 1600',
    // The child's own output (cat /tmp/si.out) comes after the shell markers — a marker-shaped line there does not override them.
    'ELANOUS_POD_STAGE run start 1', 'ELANOUS_POD_STAGE run end 2', JSON.stringify({ stage: 'done', ok: true })].join('\n');
  const kubectl: Kubectl = (args) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: `${podLog}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'pod-lifecycle-marks' }).done;
  const lines = events.filter((e) => e.category === 'pod.lifecycle' && e.event === 'stages');
  expect(lines).toHaveLength(1);
  expect(lines[0]!.data).toMatchObject({ kind: 'si-task', outcome: 'complete',
    stages: [{ stage: 'clone', start: 1_000_000, end: 1_005_000, clock: 'pod' }, { stage: 'mirror', start: 1_001_000, end: 1_003_000, clock: 'pod' }, { stage: 'run', start: 1_006_000, end: 1_600_000, clock: 'pod' }],
    missing: ['create', 'schedule', 'deps', 'delete'] });
});

test('si-task Job shell: run end sits right after `rc=$?` on every branch — post-processing (flatten · repair export · author line) is not in run', () => {
  const base = { name: 'si-t', namespace: 'test', image: 'image', repoUrl: 'https://example.invalid/r', args: [] as string[], passEnv: [] as string[], deadlineSeconds: 60 };
  const runEnd = siTaskPodStageShell('run', 'end');
  const scripts = {
    implement: podJobManifest(base),
    goal: podJobManifest({ ...base, goalDoc: 'docs/goals/x.md' }),
    author: podJobManifest({ ...base, authorSentence: true }),
    repair: podJobManifest({ ...base, source: { kind: 'pr', number: 7 }, repairCommitOnly: { pr: 7, baseHead: 'a'.repeat(40) } }),
  };
  for (const [branch, job] of Object.entries(scripts)) {
    const script = ((job as any).spec.template.spec.containers[0].args as string[]).at(-1)!;
    expect(script.split(runEnd).length - 1, branch).toBe(1);
    expect(script, branch).toContain(`wait "$si_pid"; rc=$?; ${runEnd}`);
    expect(script.indexOf(siTaskPodStageShell('run', 'start')), branch).toBeLessThan(script.indexOf('& si_pid=$!'));
    expect(script.indexOf(runEnd), branch).toBeLessThan(script.indexOf('cat /tmp/si.out'));
  }
});

test('si-task: when the full Job log cannot be read, a tail with a child-printed run start does not make a run span — every stage is missing', async () => {
  const events = captureLog();
  // The tail lost the real clone/mirror/run start; a child line `run start 100` sits after the real `run end 200`.
  const tail = ['ELANOUS_POD_STAGE run end 200', 'ELANOUS_POD_STAGE run start 100', JSON.stringify({ stage: 'done', ok: true })].join('\n');
  const kubectl: Kubectl = (args) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
    if (args.includes('logs')) {
      if (args.some((a) => a.startsWith('--tail=') || a.startsWith('--since='))) return { status: 0, stdout: `${tail}\n`, stderr: '' };
      return { status: 1, stdout: '', stderr: 'full log unavailable' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 'pod-lifecycle-tail-only' }).done;
  const lines = events.filter((e) => e.category === 'pod.lifecycle' && e.event === 'stages');
  expect(lines).toHaveLength(1);
  expect(lines[0]!.data).toMatchObject({ kind: 'si-task', stages: [], missing: [...SI_TASK_POD_LIFECYCLE_STAGES] });
});
