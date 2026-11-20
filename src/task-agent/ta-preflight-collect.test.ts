// 증거 수집기 시험 — 기대값을 수집기·제품 상수로 만들지 않는다. 원장은 «실제 생산자»(podSelfImplementSpawn · kubectl 가짜 클러스터)가
// 쓴 것을 읽고, 기대값은 이 파일의 독립 리터럴(sha·digest)이다.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTasksCommands } from '../cli/tasks-cli.js';
import { loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
import { podJobName, podSelfImplementSpawn, type Kubectl } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { collectRuntimePreflightEvidence, evidenceFromRunLedger, mergeCollectedEvidence, observeTargetPaths } from './ta-preflight-collect.js';
import { evaluateTaPreflight } from './ta-preflight.js';
import type { RunLedgerEntry } from '../self-implement/run-ledger.js';

const PIN_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const PIN_DIGEST = `sha256:${'c'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'d'.repeat(64)}`;

test('target paths are observed inside the selected card project', () => {
  const root = mkdtempSync(join(tmpdir(), 'preflight-target-'));
  try {
    writeFileSync(join(root, 'present.ts'), '');
    expect(observeTargetPaths({ text: '대상 경로: present.ts', project: { target: root } })).toBe(true);
    expect(observeTargetPaths({ text: '대상 경로: missing.ts', project: { target: root } })).toBeNull();
    expect(observeTargetPaths({ text: 'label absent', project: { target: root } })).toBe(false);
    expect(observeTargetPaths({ text: '대상 경로: ../outside.ts', project: { target: root } })).toBe(false);
    symlinkSync(tmpdir(), join(root, 'escape'));
    expect(observeTargetPaths({ text: '대상 경로: escape/.', project: { target: root } })).toBe(false);
    expect(observeTargetPaths({ text: '대상 경로: present.ts' })).toBeNull();
    expect(observeTargetPaths(null)).toBeNull();
    expect(evaluateTaPreflight({ entrance: { name: 'hand', targetPathsValid: null, groundingPolicy: { off: true, reason: 'policy' } } }).conditions[5]?.status).toBe('UNMEASURED');
    expect(evaluateTaPreflight({ entrance: { name: 'hand', targetPathsValid: false, groundingPolicy: { off: true, reason: 'policy' } } }).conditions[5]?.status).toBe('FAIL');
    expect(evaluateTaPreflight({ entrance: { name: 'hand', targetPathsValid: true, targetHostBound: null, groundingPolicy: { off: true, reason: 'policy' } } }).conditions[5]?.status).toBe('UNMEASURED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('runtime collection measures the selected card claim and active runs; unknown is not zero', () => {
  const card = { id: 'ta-collect', seat: 'TC', status: 'handed' as const, history: [] };
  expect(collectRuntimePreflightEvidence({ card, activeRuns: [], opHoldActive: false }).owner.card).toBe('TC');
  expect(collectRuntimePreflightEvidence({ card: null, activeRuns: 'unknown', opHoldActive: null }).owner.card).toBeNull();
  expect(collectRuntimePreflightEvidence({ card, activeRuns: [], opHoldActive: false }).launch)
    .toMatchObject({ cardClaimed: false, activeSameGoalRuns: 0, opHoldActive: false }); // 출처: #98174 격리 카드·빈 원장 픽스처.
  expect(collectRuntimePreflightEvidence({ card: { ...card, history: [{ event: 'preflight-live-claim' }] }, activeRuns: 'unknown', opHoldActive: null }).launch)
    .toMatchObject({ cardClaimed: true, activeSameGoalRuns: null, opHoldActive: null });
  expect(collectRuntimePreflightEvidence({ card: null, activeRuns: 'unknown', opHoldActive: false }).launch)
    .toMatchObject({ cardClaimed: null, activeSameGoalRuns: null });
  expect(collectRuntimePreflightEvidence({ card: { ...card, runId: 'run-existing' }, activeRuns: ['run-existing'], opHoldActive: false }).launch)
    .toMatchObject({ cardClaimed: true, activeSameGoalRuns: 1 }); // 출처: #98174 위 run 하나를 보유한 카드 픽스처.
});

test('preflight CLI reads card claim and exact-goal run observation, preserving unknown on query failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preflight-auto-'));
  const statePath = join(root, 'tasks.json'), evidencePath = join(root, 'evidence.json');
  const id = 'ta-autocollect', text = 'synthetic goal';
  const writeCard = (history: unknown[]) => writeFileSync(statePath, JSON.stringify({ tasks: {
    [id]: { id, seat: 'TC', text, status: 'handed', history },
  } }));
  writeCard([]);
  writeFileSync(evidencePath, JSON.stringify({ cardId: id, launchArgv: ['harness', 'say', text] }));
  const previous = process.exitCode;
  const run = async (active: (goalId: string) => readonly string[] | 'unknown') => {
    const lines: string[] = []; const program = new Command().name('elanous').exitOverride();
    registerTasksCommands(program, { taskStatePath: statePath, output: line => lines.push(line),
      preflightActiveRuns: active, preflightHoldActive: () => false, preflightAllocation: () => null });
    await program.parseAsync(['node', 'eln', 'tasks', 'preflight', '--evidence', evidencePath, '--card', id]);
    return lines.join('\n');
  };
  try {
    let observedGoal = '';
    expect(await run((goal) => { observedGoal = goal; return []; })).toMatch(/PASS +5\./u);
    expect(observedGoal).toBe(`request-${createHash('sha256').update(text).digest('hex').slice(0, 32)}`);
    expect(await run(() => { throw new Error('ledger unavailable'); })).toMatch(/UNMEASURED +5\./u);
    writeCard([{ event: 'preflight-live-claim' }]);
    expect(await run(() => [])).toMatch(/FAIL +5\./u);
  } finally { process.exitCode = previous ?? 0; rmSync(root, { recursive: true, force: true }); }
});

test('preflight records only the observed allocation and drops a supplied claim on failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preflight-alloc-'));
  const statePath = join(root, 'tasks.json'), evidencePath = join(root, 'evidence.json'), receiptPath = join(root, 'receipt.json');
  const id = 'ta-allocation';
  writeFileSync(statePath, JSON.stringify({ tasks: { [id]: { id, text: 'goal', status: 'handed', history: [] } } }));
  writeFileSync(evidencePath, JSON.stringify({ cardId: id, allocation: { host: 'fake', allocationId: 'fake', expiresAt: 9999 } }));
  const previous = process.exitCode;
  try {
    for (const allocation of [{ host: 'node-c', allocationId: 'alloc-test', expiresAt: 2000 }, null]) {
      const program = new Command().name('elanous').exitOverride();
      registerTasksCommands(program, { taskStatePath: statePath, output: () => {}, preflightActiveRuns: () => [],
        preflightHoldActive: () => false, preflightAllocation: () => allocation });
      await program.parseAsync(['node', 'eln', 'tasks', 'preflight', '--evidence', evidencePath, '--card', id, '--out', receiptPath]);
      expect(JSON.parse(readFileSync(receiptPath, 'utf8')).evidence.allocation).toEqual(allocation);
    }
  } finally { process.exitCode = previous ?? 0; rmSync(root, { recursive: true, force: true }); }
});

test('preflight without card cannot trust supplied launch observations for cell or commit receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preflight-no-card-'));
  const evidencePath = join(root, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify({ workOrder: { cellId: 'cell-1', boundary: 'src/a.ts', budget: 'time=3600s usd=3', contract: 'c', escalation: 'OP', unknownFields: [], owner: 'TC', card: 'card-1', noAutoMerge: true }, launchArgv: ['harness', 'say', '--no-auto-merge'], mergePolicy: { taLandEnv: false }, source: { requestedPin: 'a'.repeat(40) }, owner: { card: 'TC', lease: 'TC', pod: 'TC' }, launch: { cardClaimed: false, activeSameGoalRuns: 0, opHoldActive: false } }));
  const previous = process.exitCode;
  try {
    for (const target of [['--cell', 'cell-1'], ['--commit', 'a'.repeat(40)]]) {
      const lines: string[] = [];
      const program = new Command().name('elanous').exitOverride();
      registerTasksCommands(program, { taskStatePath: join(root, 'tasks.json'), output: line => lines.push(line),
        preflightActiveRuns: () => [], preflightHoldActive: () => false, preflightAllocation: () => null });
      await program.parseAsync(['node', 'eln', 'tasks', 'preflight', '--evidence', evidencePath, ...target]);
      expect(lines.join('\n')).toMatch(/UNMEASURED +5\./u);
      expect(lines.join('\n')).toContain('카드/lease/Pod owner 증거 부족');
    }
  } finally { process.exitCode = previous ?? 0; rmSync(root, { recursive: true, force: true }); }
});

interface CanaryOptions { logs: string; imageID: string | null; tag: string }

/** 실제 생산자 경로로 canary 런을 돌려 run 원장을 만든다. */
async function canary(root: string, o: CanaryOptions): Promise<string> {
  const runId = `run-collect-${o.tag}`;
  const spaceId = `collect-${o.tag}`;
  const job = podJobName(spaceId);
  const kubectl: Kubectl = (args) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
    if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
    if (args.some((arg) => arg.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('pods') && args.includes('json')) {
      const items = [{ metadata: { name: `${job}-x`, uid: 'u1', creationTimestamp: '2026-11-18T00:00:00Z', ownerReferences: [{ kind: 'Job', name: job }] },
        status: { containerStatuses: [{ name: 'child', ...(o.imageID ? { imageID: o.imageID } : {}) }] } }];
      return { status: 0, stdout: JSON.stringify({ items }), stderr: '' };
    }
    if (args.includes('logs')) return { status: 0, stdout: o.logs, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  await podSelfImplementSpawn({ kubectl, source: { kind: 'commit', sha: PIN_SHA }, imageDigestPin: PIN_DIGEST,
    credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }),
    env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: runId } })({ feature: 'x', spaceId }).done;
  return runId;
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'ta-collect-'));
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a matching canary run: the real ledger yields the child HEAD and the consumed digest', () => withRoot(async (root) => {
  const runId = await canary(root, { tag: 'ok', logs: `ELANOUS_POD_SOURCE commit ${PIN_SHA}\nchild done\n`, imageID: `docker://reg/x@${PIN_DIGEST}` });
  const entries = loadRunLedger(runId, runLedgerDir(root));
  expect(entries).not.toBeNull();
  const collected = evidenceFromRunLedger(entries!);
  expect(collected.source).toEqual({ requestedPin: PIN_SHA, childHead: PIN_SHA });
  expect(collected.image).toEqual({ expectedDigest: PIN_DIGEST, observedDigest: PIN_DIGEST });
  expect(collected.notes).toEqual([]);
}), 30_000);

test('a mismatching canary run is passed through as-is (the checker FAILs it); missing observations stay null', () => withRoot(async (root) => {
  const bad = await canary(root, { tag: 'bad', logs: `ELANOUS_POD_SOURCE commit ${OTHER_SHA}\n`, imageID: `docker://reg/x@${OTHER_DIGEST}` });
  const collected = evidenceFromRunLedger(loadRunLedger(bad, runLedgerDir(root))!);
  expect(collected.source).toEqual({ requestedPin: PIN_SHA, childHead: OTHER_SHA });
  expect(collected.image).toEqual({ expectedDigest: PIN_DIGEST, observedDigest: OTHER_DIGEST });
  const none = await canary(root, { tag: 'none', logs: 'child done\n', imageID: null });
  const missing = evidenceFromRunLedger(loadRunLedger(none, runLedgerDir(root))!);
  expect(missing.source).toEqual({ requestedPin: PIN_SHA, childHead: null });
  expect(missing.image).toEqual({ expectedDigest: PIN_DIGEST, observedDigest: null });
}), 30_000);

test('an empty ledger collects nothing and says so; explicit evidence wins over collected values', () => {
  const empty = evidenceFromRunLedger([]);
  expect(empty.source).toBeUndefined();
  expect(empty.image).toBeUndefined();
  expect(empty.notes.join('\n')).toMatch(/pod-source-head-check[\s\S]*pod-image-digest/u);
  const merged = mergeCollectedEvidence({ source: { privateRepo: true, childHead: PIN_SHA } }, { source: { requestedPin: PIN_SHA, childHead: OTHER_SHA }, malformed: [], notes: [] });
  expect(merged.source).toEqual({ requestedPin: PIN_SHA, childHead: PIN_SHA, privateRepo: true });
});

test('tasks preflight --from-run reads a real canary ledger: ① ② measured, the rest UNMEASURED; a missing ledger is refused', () => withRoot(async (root) => {
  const runId = await canary(root, { tag: 'cli', logs: `ELANOUS_POD_SOURCE commit ${PIN_SHA}\n`, imageID: `docker://reg/x@${PIN_DIGEST}` });
  const evidencePath = join(root, 'evidence.json');
  writeFileSync(evidencePath, JSON.stringify({ source: { privateRepo: true } }));
  const lines: string[] = [];
  const program = new Command().name('elanous').exitOverride();
  registerTasksCommands(program, { output: (line) => lines.push(line), preflightLedgerDir: runLedgerDir(root) });
  const prevCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await program.parseAsync(['node', 'elanous', 'tasks', 'preflight', '--evidence', evidencePath, '--from-run', runId]);
    expect(lines.join('\n')).toMatch(/PASS +1\./u);
    expect(lines.join('\n')).toMatch(/PASS +2\./u);
    expect(lines.join('\n')).toMatch(/UNMEASURED +3\./u);
    expect(Number(process.exitCode)).toBe(1);
    lines.length = 0;
    process.exitCode = undefined;
    await program.parseAsync(['node', 'elanous', 'tasks', 'preflight', '--evidence', evidencePath, '--from-run', 'run-no-such']);
    expect(lines.join('\n')).toContain('run 원장을 읽지 못했다');
    expect(Number(process.exitCode)).toBe(1);
  } finally { process.exitCode = prevCode ?? 0; }
}), 30_000);

// ── 판정 표(#38394 와 같은 용어): 칸 × (있음 · 없음 · 형식 오류) — 기대값은 아래 독립 리터럴 ──
// 형식 오류는 «미관측»과 섞이지 않는다: 원값 일부가 증거에 실려 검사기가 FAIL, 미관측만 null → UNMEASURED.
test('a real canary whose child HEAD / imageID are malformed is flagged malformed (FAIL), not collapsed into unobserved (UNMEASURED)', () => withRoot(async (root) => {
  const longSha = 'e'.repeat(64);
  const run = await canary(root, { tag: 'mal', logs: `ELANOUS_POD_SOURCE commit ${longSha}\n`, imageID: 'docker://reg/x@sha256:not-a-digest' });
  const collected = evidenceFromRunLedger(loadRunLedger(run, runLedgerDir(root))!);
  expect(collected.malformed).toEqual(['source.childHead', 'image.observedDigest']);
  expect(collected.source?.childHead).toBe(longSha);
  expect(collected.image?.observedDigest).toBe('docker://reg/x@sha256:not-a-digest');
  expect(collected.notes.join('\n')).toMatch(/형식 오류\(malformed\): source\.childHead=/u);
  expect(collected.notes.join('\n')).toMatch(/형식 오류\(malformed\): image\.observedDigest=/u);
  const report = evaluateTaPreflight(mergeCollectedEvidence({ source: { privateRepo: true } }, collected));
  expect(report.conditions[0]!.status).toBe('FAIL');
  expect(report.conditions[1]!.status).toBe('FAIL');
  // 같은 canary 에서 값이 «없는» 경우는 UNMEASURED — 형식 오류와 갈린다
  const none = await canary(root, { tag: 'abs', logs: 'child done\n', imageID: null });
  const absent = evidenceFromRunLedger(loadRunLedger(none, runLedgerDir(root))!);
  expect(absent.malformed).toEqual([]);
  expect(absent.notes.join('\n')).toMatch(/미관측: source\.childHead/u);
  expect(absent.notes.join('\n')).toMatch(/미관측: image\.observedDigest/u);
  const absentReport = evaluateTaPreflight(mergeCollectedEvidence({ source: { privateRepo: true } }, absent));
  expect(absentReport.conditions[0]!.status).toBe('UNMEASURED');
  expect(absentReport.conditions[1]!.status).toBe('UNMEASURED');
}), 30_000);

// 원장 오염·구버전 행 같은 «생산자가 만들지 않는» 입력은 방어용으로 행을 직접 넣는다(입력 픽스처일 뿐 기대값은 독립 리터럴).
const row = (event: string, data: Record<string, unknown>): RunLedgerEntry => ({ runId: 'run-table', event, data });
const P = PIN_SHA;
const D = PIN_DIGEST;
// ② 열: #38394(«② pin 필수», 11-18 08:39)가 이 표(#38396, 08:26) 뒤에 착지 — 이미지 digest pin 이 없는 줄은 ② 가 UNMEASURED 가
// 아니라 FAIL(«요청 pin 없음 — no-pin 으로 통과해 버림»). MAIN-BASELINE-RED-CLEAR.
const cases: Array<{ name: string; entries: RunLedgerEntry[]; source?: { requestedPin: string; childHead: string | null }; image?: { expectedDigest: string; observedDigest: string | null }; malformed: string[]; status: ['PASS' | 'FAIL' | 'UNMEASURED', 'PASS' | 'FAIL' | 'UNMEASURED'] }> = [
  { name: '①② 값 있음·일치', entries: [row('pod-source-head-check', { pinned: P, received: P }), row('pod-image-digest', { digestPin: D, digest: D, final: true })], source: { requestedPin: P, childHead: P }, image: { expectedDigest: D, observedDigest: D }, malformed: [], status: ['PASS', 'PASS'] },
  { name: '① received 없음(null)', entries: [row('pod-source-head-check', { pinned: P, received: null })], source: { requestedPin: P, childHead: null }, malformed: [], status: ['UNMEASURED', 'FAIL'] },
  { name: '① received 빈 문자열 = 없음', entries: [row('pod-source-head-check', { pinned: P, received: '  ' })], source: { requestedPin: P, childHead: null }, malformed: [], status: ['UNMEASURED', 'FAIL'] },
  { name: '① received 형식 오류(짧은 hex)', entries: [row('pod-source-head-check', { pinned: P, received: 'abc123' })], source: { requestedPin: P, childHead: 'abc123' }, malformed: ['source.childHead'], status: ['FAIL', 'FAIL'] },
  { name: '① received 형식 오류(숫자)', entries: [row('pod-source-head-check', { pinned: P, received: 12345 })], source: { requestedPin: P, childHead: 'number:12345' }, malformed: ['source.childHead'], status: ['FAIL', 'FAIL'] },
  { name: '① received 대문자 hex = 정규화돼 있음', entries: [row('pod-source-head-check', { pinned: P, received: P.toUpperCase() })], source: { requestedPin: P, childHead: P }, malformed: [], status: ['PASS', 'FAIL'] },
  { name: '① pinned 없음 → 수집 안 함', entries: [row('pod-source-head-check', { pinned: null, received: P })], malformed: [], status: ['UNMEASURED', 'FAIL'] },
  { name: '① pinned 형식 오류', entries: [row('pod-source-head-check', { pinned: 'zz', received: P })], source: { requestedPin: 'zz', childHead: P }, malformed: ['source.requestedPin'], status: ['FAIL', 'FAIL'] },
  { name: '② digest 없음(null)·nonstandard 사유 없음', entries: [row('pod-image-digest', { digestPin: D, digest: null, final: true })], image: { expectedDigest: D, observedDigest: null }, malformed: [], status: ['UNMEASURED', 'UNMEASURED'] },
  { name: '② digest 형식 오류(문자열)', entries: [row('pod-image-digest', { digestPin: D, digest: 'sha256:xyz', final: true })], image: { expectedDigest: D, observedDigest: 'sha256:xyz' }, malformed: ['image.observedDigest'], status: ['UNMEASURED', 'FAIL'] },
  { name: '② digest null + nonstandard-image-id + imageID 원값 = 형식 오류', entries: [row('pod-image-digest', { digestPin: D, digest: null, digestUnavailable: 'nonstandard-image-id', imageID: 'weird-id', final: true })], image: { expectedDigest: D, observedDigest: 'weird-id' }, malformed: ['image.observedDigest'], status: ['UNMEASURED', 'FAIL'] },
  { name: '② digestPin 없음 → 수집 안 함', entries: [row('pod-image-digest', { digestPin: null, digest: D, final: true })], malformed: [], status: ['UNMEASURED', 'FAIL'] },
  { name: '② digestPin 형식 오류', entries: [row('pod-image-digest', { digestPin: 'sha256:short', digest: D, final: true })], image: { expectedDigest: 'sha256:short', observedDigest: D }, malformed: ['image.expectedDigest'], status: ['UNMEASURED', 'FAIL'] },
];
for (const c of cases) {
  test(`판정 표 · ${c.name}`, () => {
    const collected = evidenceFromRunLedger(c.entries);
    expect(collected.source).toEqual(c.source);
    expect(collected.image).toEqual(c.image);
    expect(collected.malformed).toEqual(c.malformed);
    // 형식 오류는 반드시 수집 메모에도 나온다
    for (const field of c.malformed) expect(collected.notes.join('\n')).toContain(`형식 오류(malformed): ${field}=`);
    const report = evaluateTaPreflight(mergeCollectedEvidence({ source: { privateRepo: true } }, collected));
    expect([report.conditions[0]!.status, report.conditions[1]!.status]).toEqual(c.status);
  });
}
