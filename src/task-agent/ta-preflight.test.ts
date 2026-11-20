import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTasksCommands } from '../cli/tasks-cli.js';
import { simCli } from '../ux-sim/in-process-cli.js';
import { evaluateTaPreflight, parseHandShadowEvidence, renderTaPreflight, targetEvidenceMismatch, taPreflightReceipt, type TaPreflightEvidence } from './ta-preflight.js';

const sha = 'a'.repeat(40);
const dg = `sha256:${'b'.repeat(64)}`;
// 실제 발사 argv 리터럴(hand shadow 출력의 `harness say` 플래그) — 기대값은 제품 상수가 아니라 이 독립 리터럴.
const ARGV_CLOSED = ['harness', 'say', '--substrate', 'pod', '--no-auto-merge'];
const ARGV_MERGE_BY_HOST = ['harness', 'say', '--substrate', 'pod', '--merge-by-host'];
const good: TaPreflightEvidence = {
  cardId: 'card-1',
  source: { requestedPin: sha, childHead: sha, privateRepo: true },
  image: { expectedDigest: dg, observedDigest: dg },
  workOrder: { cellId: 'X', boundary: 'src/a.ts', budget: '6900s', contract: 'c', escalation: 'OP', unknownFields: [],
    owner: 'TC', card: 'card-1', noAutoMerge: true, budgetLimits: { timeSec: 6900, usdCap: 5 } },
  launchArgv: ARGV_CLOSED,
  mergePolicy: { taLandEnv: false, liveMovesProposeLand: false },
  owner: { card: 'TC', lease: 'TC', pod: 'TC' },
  limits: { wallClockSec: 6900, jobDeadlineSec: 10800, usdCap: 5 },
  launch: { cardClaimed: false, activeSameGoalRuns: 0, opHoldActive: false },
  entrance: { name: 'hand', groundingConfigured: true, groundingUrl: 'http://host.example:31415', groundingReachable: true },
};

test('all evidence present and consistent is READY', () => {
  const report = evaluateTaPreflight(good);
  expect(report.overall).toBe('READY');
  expect(report.summary).toEqual({ pass: 6, fail: 0, unmeasured: 0 });
});

test('missing order binding or numeric budget stays UNMEASURED', () => {
  const withoutBinding = evaluateTaPreflight({ ...good, workOrder: { ...good.workOrder!, owner: undefined } });
  expect(withoutBinding.conditions[2]!.status).toBe('UNMEASURED');
  const withoutBudget = evaluateTaPreflight({ ...good, workOrder: { ...good.workOrder!, budgetLimits: undefined } });
  expect(withoutBudget.conditions[3]!.status).toBe('UNMEASURED');
  const withoutMeasuredLimits = evaluateTaPreflight({ ...good, limits: undefined });
  expect(withoutMeasuredLimits.conditions[3]!.status).toBe('UNMEASURED');
  const wrongCard = evaluateTaPreflight({ ...good, workOrder: { ...good.workOrder!, card: 'other-card' } });
  expect(wrongCard.conditions[2]!.status).toBe('FAIL');
  expect(evaluateTaPreflight({ ...good, cardId: undefined }).conditions[2]!.status).toBe('UNMEASURED');
  const wrongBudget = evaluateTaPreflight({ ...good, workOrder: { ...good.workOrder!, budgetLimits: { timeSec: 600, usdCap: 5 } } });
  expect(wrongBudget.conditions[3]!.status).toBe('FAIL');
});

test('empty evidence never passes: every condition is UNMEASURED', () => {
  const report = evaluateTaPreflight({});
  expect(report.overall).toBe('NOT_READY');
  // ② 는 pin 필수라 증거가 아예 없어도 FAIL(no-pin 으로 통과해 버림) — ⑥ 증거 객체가 없으면 UNMEASURED(URL 부재도 확정 아님) → 나머지 5개는 UNMEASURED.
  expect(report.summary).toEqual({ pass: 0, fail: 1, unmeasured: 5 });
  expect(report.conditions[1]!.status).toBe('FAIL');
});

test('image stored but not consumed is not a PASS', () => {
  const report = evaluateTaPreflight({ ...good, image: { expectedDigest: dg, observedDigest: null } });
  expect(report.conditions[1]!.status).toBe('UNMEASURED');
  expect(report.overall).toBe('NOT_READY');
});

test('mismatches fail with a reason', () => {
  const report = evaluateTaPreflight({
    ...good,
    source: { requestedPin: sha, childHead: 'c'.repeat(40), privateRepo: true },
    workOrder: { ...good.workOrder!, budget: '모름', unknownFields: ['budget'] },
    owner: { card: 'MVP-B', lease: 'TC', pod: 'TC' },
    limits: { wallClockSec: 10800, jobDeadlineSec: 10800, usdCap: 5 },
    launch: { cardClaimed: false, activeSameGoalRuns: 0, opHoldActive: true },
    entrance: { name: 'say', groundingConfigured: false },
  });
  expect(report.conditions.map((c) => c.status)).toEqual(['FAIL', 'PASS', 'FAIL', 'FAIL', 'FAIL', 'FAIL']);
  expect(report.conditions[2]!.detail).toContain('budget');
  expect(renderTaPreflight(report)).toContain('NOT_READY');
});

test('missing limits stay UNMEASURED — usdCap alone never passes condition 4', () => {
  expect(evaluateTaPreflight({ ...good, limits: { usdCap: 5 } }).conditions[3]!.status).toBe('UNMEASURED');
  expect(evaluateTaPreflight({ ...good, limits: { wallClockSec: 6900, usdCap: 5 } }).conditions[3]!.status).toBe('UNMEASURED');
});

test('malformed evidence JSON never counts as measured', () => {
  const bad = (patch: Record<string, unknown>) => evaluateTaPreflight({ ...good, ...patch } as unknown as TaPreflightEvidence);
  // opHoldActive:0 / 'false' must not read as «no hold».
  for (const opHoldActive of [0, 'false', null, 1]) {
    expect(bad({ launch: { cardClaimed: false, activeSameGoalRuns: 0, opHoldActive } }).conditions[4]!.status).toBe('UNMEASURED');
  }
  for (const cardClaimed of [0, 'no']) {
    expect(bad({ launch: { cardClaimed, activeSameGoalRuns: 0, opHoldActive: false } }).conditions[4]!.status).toBe('UNMEASURED');
  }
  for (const activeSameGoalRuns of [-1, 1.5, '0', Number.NaN, null]) {
    expect(bad({ launch: { cardClaimed: false, activeSameGoalRuns, opHoldActive: false } }).conditions[4]!.status).toBe('UNMEASURED');
  }
  expect(bad({ launch: { cardClaimed: false, activeSameGoalRuns: 2, opHoldActive: false } }).conditions[4]!.status).toBe('FAIL');
  expect(bad({ launchArgv: 'harness say --no-auto-merge' }).conditions[2]!.status).toBe('UNMEASURED');
  expect(bad({ launchArgv: [1, 2] }).conditions[2]!.status).toBe('UNMEASURED');
  // groundingConfigured 가 불리언 true 가 아니면(1) «URL 설정»으로 읽지 않는다 → URL·정책 모두 없음 = FAIL(측정값으로 인정 안 함).
  expect(bad({ entrance: { name: 'hand', groundingConfigured: 1 } }).conditions[5]!.status).toBe('FAIL');
  expect(bad({ source: { requestedPin: sha, childHead: sha, privateRepo: 1 } }).conditions[0]!.status).toBe('UNMEASURED');
  expect(bad({ workOrder: { ...good.workOrder!, unknownFields: 'budget' } }).conditions[2]!.status).toBe('FAIL');
  expect(bad({}).overall).toBe('READY');
});

test('owner mismatch and auto-merge on fail condition 3', () => {
  expect(evaluateTaPreflight({ ...good, owner: { card: 'MVP-B', lease: 'TC', pod: 'TC' } }).conditions[2]!.detail).toContain('owner 불일치');
  expect(evaluateTaPreflight({ ...good, launchArgv: ARGV_MERGE_BY_HOST }).conditions[2]!.status).toBe('FAIL');
});

test('receipt hash is stable for equal evidence', () => {
  const a = taPreflightReceipt(good, evaluateTaPreflight(good));
  const b = taPreflightReceipt(good, evaluateTaPreflight(good));
  expect(a.sha256).toBe(b.sha256);
  expect(a.sha256).toMatch(/^[0-9a-f]{64}$/u);
});

test('tasks preflight CLI prints the table, writes a receipt and exits 1 when not READY', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-preflight-cli-'));
  const evidencePath = join(dir, 'evidence.json');
  const receiptPath = join(dir, 'r', 'receipt.json');
  writeFileSync(evidencePath, JSON.stringify({ cardId: 'card-1', image: { expectedDigest: dg, observedDigest: dg }, limits: { usdCap: 5 } }));
  const lines: string[] = [];
  const program = new Command().name('elanous').exitOverride();
  registerTasksCommands(program, { output: (line) => lines.push(line) });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', 'tasks', 'preflight', '--evidence', evidencePath, '--out', receiptPath, '--card', 'card-1']);
    expect(Number(process.exitCode)).toBe(1);
    expect(lines.join('\n')).toContain('NOT_READY');
    expect(lines.join('\n')).toContain('PASS       2.');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.report.overall).toBe('NOT_READY');
    expect(receipt.report.conditions[3].status).toBe('UNMEASURED');
    expect(receipt.evidence.limits).toEqual({ usdCap: 5 });
    expect(receipt.target).toEqual({ card: 'card-1' });
    expect(typeof receipt.createdAt).toBe('string');
    expect(receipt.defaultAssumed).toEqual({ wallClockSec: 6900, jobDeadlineSec: 10800 });
  } finally { process.exitCode = previous ?? 0; rmSync(dir, { recursive: true, force: true }); }
});

test('receipt target must match the evidence that was checked', () => {
  expect(targetEvidenceMismatch(good, { commit: sha, cell: 'X' })).toBeNull();
  expect(targetEvidenceMismatch(good, { card: 'card-1' })).toBeNull();
  expect(targetEvidenceMismatch(good, { card: 'other' })).toContain('--card');
  expect(targetEvidenceMismatch({ ...good, cardId: undefined }, { card: 'card-1' })).toContain('없음');
  expect(targetEvidenceMismatch(good, { commit: 'd'.repeat(40) })).toContain('--commit');
  expect(targetEvidenceMismatch(good, { cell: 'OTHER' })).toContain('--cell');
  // evidence lacking the field cannot vouch for the target
  expect(targetEvidenceMismatch({ ...good, source: undefined }, { commit: sha })).toContain('없음');
  expect(targetEvidenceMismatch({ ...good, workOrder: null }, { cell: 'X' })).toContain('없음');
});

test('JSON hand shadow binds its card and preserves the complete argv', () => {
  const argv = ['harness', 'say', '--substrate', 'pod', '--no-auto-merge', 'goal with spaces'];
  expect(parseHandShadowEvidence(JSON.stringify({ card: { id: 'card-1' }, move: { command: argv }, mode: 'shadow', launched: false })))
    .toEqual({ cardId: 'card-1', launchArgv: argv });
  expect(parseHandShadowEvidence(JSON.stringify({ card: { id: 'card-1' }, move: { command: argv }, mode: 'live', launched: true })))
    .toEqual({ cardId: null, launchArgv: null });
});

test('preflight uses JSON shadow card and argv and refuses a different target card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-shadow-json-'));
  const evidence = join(dir, 'evidence.json'), shadow = join(dir, 'shadow.json'), receipt = join(dir, 'receipt.json');
  const argv = ['harness', 'say', '--substrate', 'pod', '--no-auto-merge', 'goal with spaces'];
  const previous = process.exitCode;
  try {
    writeFileSync(evidence, JSON.stringify(good));
    writeFileSync(shadow, JSON.stringify({ card: { id: 'card-1' }, move: { command: argv }, mode: 'shadow', launched: false }));
    const lines: string[] = [], program = new Command().name('elanous').exitOverride();
    registerTasksCommands(program, { output: line => lines.push(line) });
    await program.parseAsync(['node', 'elanous', 'tasks', 'preflight', '--evidence', evidence, '--hand-shadow', shadow, '--out', receipt, '--card', 'other']);
    expect(lines.join('\n')).toContain('--card other');
    expect(() => readFileSync(receipt)).toThrow();
    const ok = new Command().name('elanous').exitOverride();
    registerTasksCommands(ok, { output: () => {} });
    await ok.parseAsync(['node', 'elanous', 'tasks', 'preflight', '--evidence', evidence, '--hand-shadow', shadow, '--out', receipt, '--card', 'card-1']);
    const saved = JSON.parse(readFileSync(receipt, 'utf8'));
    expect(saved.evidence.cardId).toBe('card-1');
    expect(saved.evidence.launchArgv).toEqual(argv);
  } finally { process.exitCode = previous ?? 0; rmSync(dir, { recursive: true, force: true }); }
});

// ── 점검표(표 시험) — ⑥ policy-off · ② pin 필수 · ①③ 정적 ⊕ fail-closed ──
const fcAll = { sourceHead: true, imageDigest: true };
const staticBase: TaPreflightEvidence = {
  cardId: 'card-1',
  source: { requestedPin: sha, childHead: null, privateRepo: true },
  image: { expectedDigest: dg, observedDigest: null },
  workOrder: good.workOrder,
  launchArgv: ARGV_CLOSED,
  mergePolicy: { taLandEnv: false, liveMovesProposeLand: false },
  owner: { card: 'TC', lease: 'TC', pod: 'TC' },
  limits: { wallClockSec: 6900, jobDeadlineSec: 10800, usdCap: 5 },
  launch: { cardClaimed: false, activeSameGoalRuns: 0, opHoldActive: false },
  entrance: { name: 'hand', groundingConfigured: false, groundingPolicy: { off: true, reason: 'CROWN D2 M2 토큰 중계 안 켬' } },
  failClosed: fcAll,
};
const idx = (id: 1 | 2 | 3 | 4 | 5 | 6): number => id - 1;

const rows: ReadonlyArray<{ no: number; name: string; evidence: TaPreflightEvidence; cond: 1 | 2 | 3 | 4 | 5 | 6; status: 'PASS' | 'FAIL' | 'UNMEASURED'; detail?: string }> = [
  { no: 1, name: '정적 모두 충족 → READY', evidence: staticBase, cond: 6, status: 'PASS', detail: 'policy-off' },
  { no: 2, name: '⑥ 정책 끔 사유 원문이 PASS 상세에 기록', evidence: staticBase, cond: 6, status: 'PASS', detail: 'CROWN D2 M2 토큰 중계 안 켬' },
  { no: 3, name: '⑥ URL 없음 + 정책 사유 없음 → FAIL', evidence: { ...staticBase, entrance: { name: 'hand', groundingConfigured: false } }, cond: 6, status: 'FAIL' },
  { no: 4, name: '⑥ 정책 off 인데 사유 빈 문자열 → FAIL', evidence: { ...staticBase, entrance: { name: 'hand', groundingConfigured: false, groundingPolicy: { off: true, reason: '  ' } } }, cond: 6, status: 'FAIL' },
  { no: 5, name: '⑥ URL 설정 + 안 닿음 → FAIL(정책 끔 주장이 있어도)', evidence: { ...staticBase, entrance: { name: 'hand', groundingUrl: 'http://host:1', groundingReachable: false, groundingPolicy: { off: true, reason: 'x' } } }, cond: 6, status: 'FAIL', detail: '닿지 않음' },
  { no: 6, name: '⑥ URL 설정 + 도달 미측정 → UNMEASURED(조용한 skip 금지)', evidence: { ...staticBase, entrance: { name: 'hand', groundingUrl: 'http://host:1' } }, cond: 6, status: 'UNMEASURED' },
  { no: 7, name: '② pin 없음 → FAIL(pin 필수)', evidence: { ...staticBase, image: { expectedDigest: null, observedDigest: null } }, cond: 2, status: 'FAIL', detail: 'pin 필수' },
  { no: 8, name: '② pin 형식 오류 → FAIL', evidence: { ...staticBase, image: { expectedDigest: 'latest', observedDigest: null } }, cond: 2, status: 'FAIL' },
  { no: 9, name: '①② fail-closed 코드 없음(주장 false) → UNMEASURED', evidence: { ...staticBase, failClosed: { sourceHead: false, imageDigest: false } }, cond: 1, status: 'UNMEASURED' },
  { no: 10, name: '③ critical «모름» 은 정적이어도 FAIL', evidence: { ...staticBase, workOrder: { ...good.workOrder!, budget: '모름', unknownFields: ['budget'] } }, cond: 3, status: 'FAIL', detail: 'budget' },
];

for (const row of rows) {
  test(`점검표 ${row.no}: ${row.name}`, () => {
    const c = evaluateTaPreflight(row.evidence).conditions[idx(row.cond)]!;
    expect(c.status).toBe(row.status);
    if (row.detail) expect(c.detail).toContain(row.detail);
  });
}

test('점검표: 정적 증거 전체 → READY · 정적 ①② PASS 상세에 fail-closed 코드 명시', () => {
  const report = evaluateTaPreflight(staticBase);
  expect(report.overall).toBe('READY');
  expect(report.conditions[idx(1)]!.detail).toContain('pod-source-head-mismatch');
  expect(report.conditions[idx(2)]!.detail).toContain('pod-image-digest-mismatch');
  expect(report.conditions[idx(3)]!.detail).toContain('owner=TC');
});

test('점검표: 관측 증거가 있으면 정적 경로를 타지 않는다(불일치는 여전히 FAIL)', () => {
  const r = evaluateTaPreflight({ ...staticBase, source: { requestedPin: sha, childHead: 'c'.repeat(40), privateRepo: true }, image: { expectedDigest: dg, observedDigest: `sha256:${'c'.repeat(64)}` } });
  expect(r.conditions[idx(1)]!.status).toBe('FAIL');
  expect(r.conditions[idx(2)]!.status).toBe('FAIL');
});

test('tasks preflight CLI: failClosed 는 증거 파일이 아니라 빌드의 모듈 확인으로 채운다(거짓 주장 덮어씀)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-preflight-static-'));
  const evidencePath = join(dir, 'e.json');
  const receiptPath = join(dir, 'r.json');
  writeFileSync(evidencePath, JSON.stringify({ ...staticBase, launchArgv: [...ARGV_CLOSED, '대상 경로: target.ts'], failClosed: { sourceHead: false, imageDigest: false } }));
  const lines: string[] = [];
  const program = new Command().name('elanous').exitOverride();
  const taskStatePath = join(dir, 'cards.json');
  writeFileSync(join(dir, 'target.ts'), '');
  writeFileSync(taskStatePath, JSON.stringify({ tasks: { 'card-1': { id: 'card-1', seat: 'TC', text: '대상 경로: target.ts', project: { target: dir }, status: 'handed', history: [] } } }));
  registerTasksCommands(program, { output: (line) => lines.push(line), taskStatePath,
    preflightActiveRuns: () => [], preflightHoldActive: () => false, preflightAllocation: () => null });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', 'tasks', 'preflight', '--evidence', evidencePath, '--out', receiptPath, '--commit', sha, '--cell', 'X']);
    expect(Number(process.exitCode ?? 0)).toBe(1);
    expect(lines.join('\n')).toContain('관측 호스트와 배정 발사 호스트 결속 미측정');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    expect(receipt.evidence.failClosed).toEqual({ sourceHead: true, imageDigest: true });
  } finally { process.exitCode = previous ?? 0; rmSync(dir, { recursive: true, force: true }); }
});

// ══ 축 곱 전체 칸 표 ══
// ⑥ 축 = 입구 × URL × groundingConfigured × 도달 × 정책 · ② 축 = pin 유무·형식 × 관측 digest × failClosed.
// 칸마다 기대값 1 · 시험 1. TA_AXES_MD=<path> 로 돌리면 이 표를 마크다운으로 내보낸다(PR 본문용 — 표와 시험이 같은 원천).
type Expect = 'PASS' | 'FAIL' | 'UNMEASURED';
type Ent = NonNullable<TaPreflightEvidence['entrance']>;
const URL1 = 'http://host.example:31415';
const REASON = ' CROWN D2 «M2 토큰 중계 안 켬» ';
const groundingCells: ReadonlyArray<{ id: string; entrance: Ent | undefined; expect: Expect; detail?: string }> = [
  { id: 'G01', entrance: undefined, expect: 'UNMEASURED' },
  { id: 'G02', entrance: { groundingConfigured: false }, expect: 'FAIL' },
  { id: 'G03', entrance: { name: 'say', groundingUrl: URL1, groundingReachable: true }, expect: 'FAIL', detail: '허용 입구' },
  { id: 'G04', entrance: { name: 'hand' }, expect: 'FAIL', detail: '정책 끔 사유도 없음' },
  { id: 'G05', entrance: { name: 'hand', groundingConfigured: false }, expect: 'FAIL' },
  { id: 'G06', entrance: { name: 'hand', groundingConfigured: 1 as unknown as boolean }, expect: 'FAIL' },
  { id: 'G07', entrance: { name: 'hand', groundingConfigured: false, groundingPolicy: { off: true, reason: REASON } }, expect: 'PASS', detail: `사유: ${REASON}` },
  { id: 'G08', entrance: { name: 'hand', groundingPolicy: { off: true, reason: REASON } }, expect: 'PASS' },
  { id: 'G09', entrance: { name: 'hand', groundingPolicy: { off: true, reason: '  ' } }, expect: 'FAIL' },
  { id: 'G10', entrance: { name: 'hand', groundingPolicy: { off: true } }, expect: 'FAIL' },
  { id: 'G11', entrance: { name: 'hand', groundingPolicy: { off: false, reason: REASON } }, expect: 'FAIL' },
  { id: 'G12', entrance: { name: 'hand', groundingPolicy: { off: 1 as unknown as boolean, reason: REASON } }, expect: 'FAIL' },
  { id: 'G13', entrance: { name: 'hand', groundingConfigured: true }, expect: 'UNMEASURED', detail: 'URL 문자열 증거 없음' },
  { id: 'G14', entrance: { name: 'hand', groundingConfigured: true, groundingReachable: true }, expect: 'UNMEASURED', detail: 'URL 문자열 증거 없음' },
  { id: 'G15', entrance: { name: 'hand', groundingConfigured: true, groundingReachable: false }, expect: 'FAIL', detail: '닿지 않음' },
  { id: 'G16', entrance: { name: 'hand', groundingUrl: URL1, groundingReachable: true }, expect: 'PASS', detail: '도달 확인' },
  { id: 'G17', entrance: { name: 'hand', groundingUrl: URL1, groundingReachable: false }, expect: 'FAIL', detail: '닿지 않음' },
  { id: 'G18', entrance: { name: 'hand', groundingUrl: URL1, groundingReachable: null }, expect: 'UNMEASURED', detail: '도달 미측정' },
  { id: 'G19', entrance: { name: 'hand', groundingUrl: URL1 }, expect: 'UNMEASURED', detail: '도달 미측정' },
  { id: 'G20', entrance: { name: 'hand', groundingConfigured: true, groundingUrl: URL1, groundingReachable: true }, expect: 'PASS' },
  { id: 'G21', entrance: { name: 'hand', groundingUrl: URL1, groundingReachable: false, groundingPolicy: { off: true, reason: REASON } }, expect: 'FAIL', detail: '닿지 않음' },
  { id: 'G22', entrance: { name: 'hand', groundingUrl: URL1, groundingReachable: null, groundingPolicy: { off: true, reason: REASON } }, expect: 'UNMEASURED' },
  { id: 'G23', entrance: { name: 'hand', groundingUrl: URL1, groundingReachable: true, groundingPolicy: { off: true, reason: REASON } }, expect: 'PASS' },
  { id: 'G24', entrance: { name: 'hand', groundingUrl: '   ', groundingConfigured: false, groundingPolicy: { off: true, reason: REASON } }, expect: 'PASS' },
];
for (const cell of groundingCells) {
  test(`축곱 ⑥ ${cell.id}`, () => {
    const c = evaluateTaPreflight({ ...staticBase, entrance: cell.entrance }).conditions[idx(6)]!;
    expect(c.status).toBe(cell.expect);
    if (cell.detail) expect(c.detail).toContain(cell.detail);
  });
}

type Img = TaPreflightEvidence['image'];
const dg2 = `sha256:${'c'.repeat(64)}`;
const imageCells: ReadonlyArray<{ id: string; image: Img | undefined; fc: boolean | undefined; expect: Expect; detail?: string }> = [
  { id: 'I01', image: undefined, fc: true, expect: 'FAIL', detail: 'pin 필수' },
  { id: 'I02', image: undefined, fc: false, expect: 'FAIL', detail: 'pin 필수' },
  { id: 'I03', image: { expectedDigest: null, observedDigest: null }, fc: true, expect: 'FAIL', detail: 'pin 필수' },
  { id: 'I04', image: { expectedDigest: null, observedDigest: null }, fc: false, expect: 'FAIL', detail: 'pin 필수' },
  { id: 'I05', image: { expectedDigest: 'latest', observedDigest: null }, fc: false, expect: 'FAIL', detail: '형식 오류' },
  { id: 'I06', image: { expectedDigest: 'latest', observedDigest: null }, fc: true, expect: 'FAIL', detail: '형식 오류' },
  { id: 'I07', image: { expectedDigest: dg, observedDigest: null }, fc: true, expect: 'PASS', detail: '정적' },
  { id: 'I08', image: { expectedDigest: dg, observedDigest: null }, fc: false, expect: 'UNMEASURED', detail: '코드 존재를 확인하지 못함' },
  { id: 'I09', image: { expectedDigest: dg, observedDigest: null }, fc: undefined, expect: 'UNMEASURED' },
  { id: 'I10', image: { expectedDigest: dg, observedDigest: dg }, fc: false, expect: 'PASS', detail: '소비 digest == 요청 pin' },
  { id: 'I11', image: { expectedDigest: dg, observedDigest: dg2 }, fc: true, expect: 'FAIL', detail: '소비 digest ≠ 요청 pin' },
  { id: 'I12', image: { expectedDigest: dg, observedDigest: 'abc' }, fc: true, expect: 'FAIL', detail: '형식 오류' },
  { id: 'I13', image: { expectedDigest: null, observedDigest: dg }, fc: true, expect: 'FAIL', detail: 'pin 필수' },
  { id: 'I14', image: { expectedDigest: 'x', observedDigest: dg }, fc: true, expect: 'FAIL', detail: '형식 오류' },
];
for (const cell of imageCells) {
  test(`축곱 ② ${cell.id}`, () => {
    const failClosed = { ...fcAll, imageDigest: cell.fc };
    const c = evaluateTaPreflight({ ...staticBase, image: cell.image, failClosed }).conditions[idx(2)]!;
    expect(c.status).toBe(cell.expect);
    if (cell.detail) expect(c.detail).toContain(cell.detail);
  });
}

// ── ①③④⑤ 입력 칸 × (있음·없음·형식 오류) 전체 칸 표 — 원칙: 증거 없음·형식 오류는 PASS 가 아니다 · 알려진 나쁨이 «모름»보다 먼저 ──
type Cell = { id: string; cond: 1 | 3 | 4 | 5; desc: string; evidence: TaPreflightEvidence; expect: Expect; detail?: string };
const srcEv = (source: TaPreflightEvidence['source'] | undefined, fc: boolean | 'missing' = true): TaPreflightEvidence => ({ ...staticBase, source, failClosed: fc === 'missing' ? { imageDigest: true } : { ...fcAll, sourceHead: fc } });
const ordEv = (patch: Partial<TaPreflightEvidence>): TaPreflightEvidence => ({ ...staticBase, ...patch });
const limEv = (limits: unknown): TaPreflightEvidence => ({ ...staticBase, limits: limits as TaPreflightEvidence['limits'] });
const lauEv = (launch: unknown): TaPreflightEvidence => ({ ...staticBase, launch: launch as TaPreflightEvidence['launch'] });
const ok = { requestedPin: sha, childHead: null, privateRepo: true } as const;
const cells: Cell[] = [
  // ① source — 입력: pin(없음·형식오류·정상) × childHead(없음·형식오류·다름·같음) × privateRepo(true·false·null·누락·비불리언) × failClosed
  { id: 'S01', cond: 1, desc: 'source 증거 없음', evidence: srcEv(undefined), expect: 'UNMEASURED' },
  { id: 'S02', cond: 1, desc: 'pin null', evidence: srcEv({ ...ok, requestedPin: null }), expect: 'UNMEASURED' },
  { id: 'S03', cond: 1, desc: 'pin 누락', evidence: srcEv({ childHead: null, privateRepo: true }), expect: 'UNMEASURED' },
  { id: 'S04', cond: 1, desc: 'pin 형식 오류(abc)', evidence: srcEv({ ...ok, requestedPin: 'abc' }), expect: 'FAIL', detail: '40자 소문자 hex' },
  { id: 'S05', cond: 1, desc: 'pin 형식 오류 + failClosed false', evidence: srcEv({ ...ok, requestedPin: 'abc' }, false), expect: 'FAIL' },
  { id: 'S06', cond: 1, desc: 'pin 대문자 hex', evidence: srcEv({ ...ok, requestedPin: 'A'.repeat(40) }), expect: 'FAIL' },
  { id: 'S07', cond: 1, desc: '정적: pin·private true·failClosed true', evidence: srcEv(ok), expect: 'PASS', detail: '정적' },
  { id: 'S08', cond: 1, desc: '정적: private null', evidence: srcEv({ ...ok, privateRepo: null }), expect: 'UNMEASURED', detail: 'private repo 증거 없음' },
  { id: 'S09', cond: 1, desc: '정적: private 누락', evidence: srcEv({ requestedPin: sha, childHead: null }), expect: 'UNMEASURED', detail: 'private repo 증거 없음' },
  { id: 'S10', cond: 1, desc: '정적: private 비불리언(1)', evidence: srcEv({ ...ok, privateRepo: 1 as unknown as boolean }), expect: 'UNMEASURED' },
  { id: 'S11', cond: 1, desc: '정적: private false', evidence: srcEv({ ...ok, privateRepo: false }), expect: 'FAIL' },
  { id: 'S12', cond: 1, desc: '정적: failClosed false', evidence: srcEv(ok, false), expect: 'UNMEASURED' },
  { id: 'S13', cond: 1, desc: '정적: failClosed 누락', evidence: srcEv(ok, 'missing'), expect: 'UNMEASURED' },
  { id: 'S14', cond: 1, desc: '정적: failClosed false + private null', evidence: srcEv({ ...ok, privateRepo: null }, false), expect: 'UNMEASURED' },
  { id: 'S15', cond: 1, desc: 'child 같음 · private true (failClosed 무관)', evidence: srcEv({ ...ok, childHead: sha }, false), expect: 'PASS', detail: '(private)' },
  { id: 'S16', cond: 1, desc: 'child 같음 · private null', evidence: srcEv({ ...ok, childHead: sha, privateRepo: null }), expect: 'UNMEASURED' },
  { id: 'S17', cond: 1, desc: 'child 같음 · private false', evidence: srcEv({ ...ok, childHead: sha, privateRepo: false }), expect: 'FAIL' },
  { id: 'S18', cond: 1, desc: 'child 같음 · private 비불리언', evidence: srcEv({ ...ok, childHead: sha, privateRepo: 'yes' as unknown as boolean }), expect: 'UNMEASURED' },
  { id: 'S19', cond: 1, desc: 'child 다름', evidence: srcEv({ ...ok, childHead: 'c'.repeat(40) }), expect: 'FAIL', detail: '≠ child' },
  { id: 'S20', cond: 1, desc: 'child 다름 + private null (나쁨 우선)', evidence: srcEv({ ...ok, childHead: 'c'.repeat(40), privateRepo: null }), expect: 'FAIL' },
  { id: 'S21', cond: 1, desc: 'child 형식 오류', evidence: srcEv({ ...ok, childHead: 'xyz' }), expect: 'FAIL', detail: 'child HEAD' },
  { id: 'S22', cond: 1, desc: 'child 공백뿐(=없음) → 정적 경로', evidence: srcEv({ ...ok, childHead: '  ' }), expect: 'PASS', detail: '정적' },
  // ③ 작업 지시서·자동 merge·owner
  { id: 'O01', cond: 3, desc: 'workOrder null', evidence: ordEv({ workOrder: null }), expect: 'UNMEASURED', detail: '지시서 없음' },
  { id: 'O02', cond: 3, desc: 'workOrder 누락', evidence: ordEv({ workOrder: undefined }), expect: 'UNMEASURED' },
  { id: 'O03', cond: 3, desc: 'boundary «모름» (unknownFields 에 포함)', evidence: ordEv({ workOrder: { ...good.workOrder!, unknownFields: ['boundary'] } }), expect: 'FAIL', detail: 'boundary' },
  { id: 'O04', cond: 3, desc: 'budget 공백', evidence: ordEv({ workOrder: { ...good.workOrder!, budget: '  ' } }), expect: 'FAIL', detail: 'budget' },
  { id: 'O05', cond: 3, desc: 'contract 누락', evidence: ordEv({ workOrder: { ...good.workOrder!, contract: undefined as unknown as string } }), expect: 'FAIL', detail: 'contract' },
  { id: 'O06', cond: 3, desc: 'escalation = 모름 상수', evidence: ordEv({ workOrder: { ...good.workOrder!, escalation: '모름' } }), expect: 'FAIL', detail: 'escalation' },
  { id: 'O07', cond: 3, desc: 'unknownFields 비배열(문자열)', evidence: ordEv({ workOrder: { ...good.workOrder!, unknownFields: 'budget' as unknown as string[] } }), expect: 'FAIL' },
  { id: 'O08', cond: 3, desc: 'unknownFields 누락', evidence: ordEv({ workOrder: { ...good.workOrder!, unknownFields: undefined as unknown as string[] } }), expect: 'FAIL' },
  { id: 'O09', cond: 3, desc: 'argv: --merge-by-host(호스트 재게이트 병합)', evidence: ordEv({ launchArgv: ARGV_MERGE_BY_HOST }), expect: 'FAIL', detail: '자동 병합 가능' },
  { id: 'O10', cond: 3, desc: 'argv: --merge-by-host + 지시서 없음 (나쁨 우선)', evidence: ordEv({ launchArgv: ARGV_MERGE_BY_HOST, workOrder: null }), expect: 'FAIL' },
  { id: 'O11', cond: 3, desc: 'argv null', evidence: ordEv({ launchArgv: null }), expect: 'UNMEASURED', detail: 'argv 없음' },
  { id: 'O12', cond: 3, desc: 'argv 누락', evidence: ordEv({ launchArgv: undefined }), expect: 'UNMEASURED' },
  { id: 'O13', cond: 3, desc: "argv 가 문자열(배열 아님)", evidence: ordEv({ launchArgv: 'harness say --no-auto-merge' as unknown as string[] }), expect: 'UNMEASURED' },
  { id: 'O14', cond: 3, desc: 'owner 전부 없음({})', evidence: ordEv({ owner: {} }), expect: 'UNMEASURED', detail: 'owner 증거 부족' },
  { id: 'O15', cond: 3, desc: 'owner 누락', evidence: ordEv({ owner: undefined }), expect: 'UNMEASURED' },
  { id: 'O16', cond: 3, desc: 'owner card 만', evidence: ordEv({ owner: { card: 'TC' } }), expect: 'UNMEASURED' },
  { id: 'O17', cond: 3, desc: 'owner pod 없음', evidence: ordEv({ owner: { card: 'TC', lease: 'TC' } }), expect: 'UNMEASURED' },
  { id: 'O18', cond: 3, desc: 'owner pod 공백', evidence: ordEv({ owner: { card: 'TC', lease: 'TC', pod: '  ' } }), expect: 'UNMEASURED' },
  { id: 'O19', cond: 3, desc: 'owner 셋 같음', evidence: ordEv({}), expect: 'PASS', detail: 'owner=TC' },
  { id: 'O20', cond: 3, desc: 'owner 불일치', evidence: ordEv({ owner: { card: 'MVP-B', lease: 'TC', pod: 'TC' } }), expect: 'FAIL', detail: 'owner 불일치' },
  { id: 'O21', cond: 3, desc: 'owner 없음 + failClosed 전부 true (코드 존재는 귀속 증거가 아니다)', evidence: ordEv({ owner: {}, failClosed: fcAll }), expect: 'UNMEASURED' },
  // ④ 시간·비용 — 숫자가 아닌 칸은 «측정 없음», 값이 불량이면 FAIL, 알려진 불량은 모름보다 먼저
  { id: 'L01', cond: 4, desc: 'limits 없음', evidence: limEv(undefined), expect: 'UNMEASURED' },
  { id: 'L02', cond: 4, desc: 'wall 누락', evidence: limEv({ jobDeadlineSec: 10800, usdCap: 5 }), expect: 'UNMEASURED' },
  { id: 'L03', cond: 4, desc: 'job 누락', evidence: limEv({ wallClockSec: 6900, usdCap: 5 }), expect: 'UNMEASURED' },
  { id: 'L04', cond: 4, desc: 'usd 누락', evidence: limEv({ wallClockSec: 6900, jobDeadlineSec: 10800 }), expect: 'UNMEASURED' },
  { id: 'L05', cond: 4, desc: 'wall null', evidence: limEv({ wallClockSec: null, jobDeadlineSec: 10800, usdCap: 5 }), expect: 'UNMEASURED' },
  { id: 'L06', cond: 4, desc: "wall '6900' 문자열", evidence: limEv({ wallClockSec: '6900', jobDeadlineSec: 10800, usdCap: 5 }), expect: 'UNMEASURED' },
  { id: 'L07', cond: 4, desc: 'wall NaN', evidence: limEv({ wallClockSec: Number.NaN, jobDeadlineSec: 10800, usdCap: 5 }), expect: 'UNMEASURED' },
  { id: 'L08', cond: 4, desc: 'usd Infinity', evidence: limEv({ wallClockSec: 6900, jobDeadlineSec: 10800, usdCap: Number.POSITIVE_INFINITY }), expect: 'UNMEASURED' },
  { id: 'L09', cond: 4, desc: 'wall 0', evidence: limEv({ wallClockSec: 0, jobDeadlineSec: 10800, usdCap: 5 }), expect: 'FAIL', detail: '0 이하' },
  { id: 'L10', cond: 4, desc: 'wall 음수', evidence: limEv({ wallClockSec: -1, jobDeadlineSec: 10800, usdCap: 5 }), expect: 'FAIL' },
  { id: 'L11', cond: 4, desc: 'usd 0', evidence: limEv({ wallClockSec: 6900, jobDeadlineSec: 10800, usdCap: 0 }), expect: 'FAIL' },
  { id: 'L12', cond: 4, desc: 'usd 음수', evidence: limEv({ wallClockSec: 6900, jobDeadlineSec: 10800, usdCap: -3 }), expect: 'FAIL' },
  { id: 'L13', cond: 4, desc: 'wall = job', evidence: limEv({ wallClockSec: 10800, jobDeadlineSec: 10800, usdCap: 5 }), expect: 'FAIL', detail: '≥ job' },
  { id: 'L14', cond: 4, desc: 'wall > job', evidence: limEv({ wallClockSec: 12000, jobDeadlineSec: 10800, usdCap: 5 }), expect: 'FAIL' },
  { id: 'L15', cond: 4, desc: 'job 0', evidence: limEv({ wallClockSec: 6900, jobDeadlineSec: 0, usdCap: 5 }), expect: 'FAIL' },
  { id: 'L16', cond: 4, desc: '정상', evidence: limEv({ wallClockSec: 6900, jobDeadlineSec: 10800, usdCap: 5 }), expect: 'PASS' },
  { id: 'L17', cond: 4, desc: '경계 wall 6900 < job 6901 · usd 0.01', evidence: { ...limEv({ wallClockSec: 6900, jobDeadlineSec: 6901, usdCap: 0.01 }), workOrder: { ...good.workOrder!, budgetLimits: { timeSec: 6900, usdCap: 0.01 } } }, expect: 'PASS' },
  { id: 'L18', cond: 4, desc: 'wall 0 + job·usd 누락 (나쁨 우선)', evidence: limEv({ wallClockSec: 0 }), expect: 'FAIL' },
  { id: 'L19', cond: 4, desc: 'wall ≥ job + usd 누락 (나쁨 우선)', evidence: limEv({ wallClockSec: 10800, jobDeadlineSec: 10800 }), expect: 'FAIL' },
  { id: 'L20', cond: 4, desc: 'wall·usd 정상 + job 누락', evidence: limEv({ wallClockSec: 6900, usdCap: 5 }), expect: 'UNMEASURED' },
  // ⑤ 중복·중지·hold
  { id: 'H01', cond: 5, desc: 'launch 없음', evidence: lauEv(undefined), expect: 'UNMEASURED' },
  { id: 'H02', cond: 5, desc: '전부 정상(hold false · claim 없음 · 활성 0)', evidence: lauEv({ opHoldActive: false, cardClaimed: false, activeSameGoalRuns: 0 }), expect: 'PASS' },
  { id: 'H03', cond: 5, desc: 'hold true', evidence: lauEv({ opHoldActive: true, cardClaimed: false, activeSameGoalRuns: 0 }), expect: 'FAIL', detail: 'OP hold' },
  { id: 'H04', cond: 5, desc: 'hold true + 나머지 누락 (나쁨 우선)', evidence: lauEv({ opHoldActive: true }), expect: 'FAIL' },
  { id: 'H05', cond: 5, desc: 'claim true + hold null (나쁨 우선)', evidence: lauEv({ opHoldActive: null, cardClaimed: true, activeSameGoalRuns: 0 }), expect: 'FAIL', detail: 'claim' },
  { id: 'H06', cond: 5, desc: '활성 2 + 나머지 누락 (나쁨 우선)', evidence: lauEv({ activeSameGoalRuns: 2 }), expect: 'FAIL', detail: '활성 run 2' },
  { id: 'H07', cond: 5, desc: 'hold null', evidence: lauEv({ opHoldActive: null, cardClaimed: false, activeSameGoalRuns: 0 }), expect: 'UNMEASURED' },
  { id: 'H08', cond: 5, desc: 'hold 누락', evidence: lauEv({ cardClaimed: false, activeSameGoalRuns: 0 }), expect: 'UNMEASURED' },
  { id: 'H09', cond: 5, desc: 'hold 0(비불리언)', evidence: lauEv({ opHoldActive: 0, cardClaimed: false, activeSameGoalRuns: 0 }), expect: 'UNMEASURED' },
  { id: 'H10', cond: 5, desc: "hold 'false' 문자열", evidence: lauEv({ opHoldActive: 'false', cardClaimed: false, activeSameGoalRuns: 0 }), expect: 'UNMEASURED' },
  { id: 'H11', cond: 5, desc: 'claim 누락', evidence: lauEv({ opHoldActive: false, activeSameGoalRuns: 0 }), expect: 'UNMEASURED' },
  { id: 'H12', cond: 5, desc: "claim 'no'", evidence: lauEv({ opHoldActive: false, cardClaimed: 'no', activeSameGoalRuns: 0 }), expect: 'UNMEASURED' },
  { id: 'H13', cond: 5, desc: 'active 누락', evidence: lauEv({ opHoldActive: false, cardClaimed: false }), expect: 'UNMEASURED' },
  { id: 'H14', cond: 5, desc: 'active -1', evidence: lauEv({ opHoldActive: false, cardClaimed: false, activeSameGoalRuns: -1 }), expect: 'UNMEASURED' },
  { id: 'H15', cond: 5, desc: 'active 1.5', evidence: lauEv({ opHoldActive: false, cardClaimed: false, activeSameGoalRuns: 1.5 }), expect: 'UNMEASURED' },
  { id: 'H16', cond: 5, desc: "active '0' 문자열", evidence: lauEv({ opHoldActive: false, cardClaimed: false, activeSameGoalRuns: '0' }), expect: 'UNMEASURED' },
  { id: 'H17', cond: 5, desc: 'active NaN', evidence: lauEv({ opHoldActive: false, cardClaimed: false, activeSameGoalRuns: Number.NaN }), expect: 'UNMEASURED' },
  { id: 'H18', cond: 5, desc: 'active null', evidence: lauEv({ opHoldActive: false, cardClaimed: false, activeSameGoalRuns: null }), expect: 'UNMEASURED' },
];
for (const cell of cells) {
  test(`축곱 ${'①②③④⑤⑥'[cell.cond - 1]} ${cell.id}`, () => {
    const c = evaluateTaPreflight(cell.evidence).conditions[idx(cell.cond)]!;
    expect(c.status).toBe(cell.expect);
    if (cell.detail) expect(c.detail).toContain(cell.detail);
  });
}

// ══ 판정 법칙 표 한 장 — 칸 × 값(정상 ok · 불량 bad · 없음/형식오류 missing) ══
// 법칙(제품 코드가 아니라 PR 에 적은 규칙): 불량이 하나라도 있으면 FAIL · 없고 미측정이 하나라도 있으면 UNMEASURED · 전부 정상이면 PASS.
// 칸마다 «단독 변형»과, 서로 다른 칸의 «모든 쌍»(알려진 불량 × 누락·형식오류 포함)을 이 법칙으로 시험한다 — 한 칸의 누락이 다른 칸의 불량을 숨기면 쌍 시험이 잡는다.
type Cls = 'ok' | 'bad' | 'missing';
type Variant = { label: string; cls: Cls; patch: (ev: TaPreflightEvidence) => TaPreflightEvidence };
type Field = { name: string; variants: Variant[] };
const lawOf = (classes: Cls[]): Expect => classes.includes('bad') ? 'FAIL' : classes.includes('missing') ? 'UNMEASURED' : 'PASS';
const withSource = (patch: Partial<NonNullable<TaPreflightEvidence['source']>>) => (ev: TaPreflightEvidence): TaPreflightEvidence => ({ ...ev, source: { ...ev.source, ...patch } });
const withFc = (patch: Partial<NonNullable<TaPreflightEvidence['failClosed']>>) => (ev: TaPreflightEvidence): TaPreflightEvidence => ({ ...ev, failClosed: { ...ev.failClosed, ...patch } });
const withImage = (patch: Partial<NonNullable<TaPreflightEvidence['image']>>) => (ev: TaPreflightEvidence): TaPreflightEvidence => ({ ...ev, image: { ...ev.image, ...patch } });
const withOwner = (owner: TaPreflightEvidence['owner']) => (ev: TaPreflightEvidence): TaPreflightEvidence => ({ ...ev, owner });
const withLimits = (patch: Record<string, unknown>) => (ev: TaPreflightEvidence): TaPreflightEvidence => ({ ...ev, limits: { ...ev.limits, ...patch } as TaPreflightEvidence['limits'] });
const withLaunch = (patch: Record<string, unknown>) => (ev: TaPreflightEvidence): TaPreflightEvidence => ({ ...ev, launch: { ...ev.launch, ...patch } as TaPreflightEvidence['launch'] });
const withEntrance = (e: Ent) => (ev: TaPreflightEvidence): TaPreflightEvidence => ({ ...ev, entrance: e });
const keep = (ev: TaPreflightEvidence): TaPreflightEvidence => ev;
const laws: ReadonlyArray<{ cond: 1 | 2 | 3 | 4 | 5 | 6; fields: Field[] }> = [
  { cond: 1, fields: [
    { name: 'pin', variants: [{ label: '정상', cls: 'ok', patch: keep }, { label: '없음', cls: 'missing', patch: withSource({ requestedPin: null }) }, { label: '형식 오류', cls: 'bad', patch: withSource({ requestedPin: 'abc' }) }] },
    { name: 'childHead', variants: [{ label: '없음(정적)', cls: 'ok', patch: keep }, { label: '형식 오류', cls: 'bad', patch: withSource({ childHead: 'xyz' }) }] },
    { name: 'privateRepo', variants: [{ label: 'true', cls: 'ok', patch: keep }, { label: 'false', cls: 'bad', patch: withSource({ privateRepo: false }) }, { label: 'null', cls: 'missing', patch: withSource({ privateRepo: null }) }, { label: '비불리언', cls: 'missing', patch: withSource({ privateRepo: 1 as unknown as boolean }) }] },
    { name: 'failClosed.sourceHead', variants: [{ label: 'true', cls: 'ok', patch: keep }, { label: 'false', cls: 'missing', patch: withFc({ sourceHead: false }) }, { label: '누락', cls: 'missing', patch: (ev) => ({ ...ev, failClosed: { imageDigest: true } }) }] },
  ] },
  { cond: 2, fields: [
    { name: 'pin', variants: [{ label: '정상', cls: 'ok', patch: keep }, { label: '없음', cls: 'bad', patch: withImage({ expectedDigest: null }) }, { label: '형식 오류', cls: 'bad', patch: withImage({ expectedDigest: 'latest' }) }] },
    { name: '관측 digest', variants: [{ label: '없음(정적)', cls: 'ok', patch: keep }, { label: '형식 오류', cls: 'bad', patch: withImage({ observedDigest: 'abc' }) }] },
    { name: 'failClosed.imageDigest', variants: [{ label: 'true', cls: 'ok', patch: keep }, { label: 'false', cls: 'missing', patch: withFc({ imageDigest: false }) }, { label: '누락', cls: 'missing', patch: (ev) => ({ ...ev, failClosed: { sourceHead: true } }) }] },
  ] },
  { cond: 3, fields: [
    { name: 'workOrder', variants: [{ label: '정상', cls: 'ok', patch: keep }, { label: '없음', cls: 'missing', patch: (ev) => ({ ...ev, workOrder: null }) }, { label: 'critical 모름', cls: 'bad', patch: (ev) => ({ ...ev, workOrder: { ...good.workOrder!, unknownFields: ['budget'] } }) }] },
    { name: '발사 argv', variants: [{ label: '--no-auto-merge', cls: 'ok', patch: keep }, { label: '--merge-by-host', cls: 'bad', patch: (ev) => ({ ...ev, launchArgv: ARGV_MERGE_BY_HOST }) }, { label: '플래그 없음(기본 자동 병합)', cls: 'bad', patch: (ev) => ({ ...ev, launchArgv: ['harness', 'say', '--substrate', 'pod'] }) }, { label: 'null', cls: 'missing', patch: (ev) => ({ ...ev, launchArgv: null }) }, { label: 'harness say 아님', cls: 'missing', patch: (ev) => ({ ...ev, launchArgv: ['ls', '-la'] }) }, { label: '명령 중간에 끼인 harness say', cls: 'missing', patch: (ev) => ({ ...ev, launchArgv: ['echo', 'harness', 'say', '--no-auto-merge'] }) }, { label: '-- 뒤의 --no-auto-merge', cls: 'bad', patch: (ev) => ({ ...ev, launchArgv: ['harness', 'say', '--', '--no-auto-merge'] }) }, { label: '문자열 토큰 아님', cls: 'missing', patch: (ev) => ({ ...ev, launchArgv: ['harness', 1 as unknown as string, 'say'] }) }] },
    { name: 'taLandEnv', variants: [{ label: 'false', cls: 'ok', patch: keep }, { label: 'true', cls: 'bad', patch: (ev) => ({ ...ev, mergePolicy: { ...ev.mergePolicy, taLandEnv: true } }) }, { label: '누락', cls: 'missing', patch: (ev) => ({ ...ev, mergePolicy: { liveMovesProposeLand: false } }) }, { label: 'null', cls: 'missing', patch: (ev) => ({ ...ev, mergePolicy: { ...ev.mergePolicy, taLandEnv: null } }) }, { label: "'false' 문자열", cls: 'missing', patch: (ev) => ({ ...ev, mergePolicy: { ...ev.mergePolicy, taLandEnv: 'false' as unknown as boolean } }) }] },
    { name: 'owner', variants: [{ label: '셋 같음', cls: 'ok', patch: keep }, { label: '있는 칸끼리 다름(pod 없음)', cls: 'bad', patch: withOwner({ card: 'A', lease: 'B' }) }, { label: '일부 없음', cls: 'missing', patch: withOwner({ card: 'TC', lease: 'TC' }) }, { label: '전부 없음', cls: 'missing', patch: withOwner({}) }, { label: '공백', cls: 'missing', patch: withOwner({ card: 'TC', lease: 'TC', pod: '  ' }) }] },
  ] },
  { cond: 4, fields: [
    { name: 'wallClockSec', variants: [{ label: '6900', cls: 'ok', patch: keep }, { label: '없음', cls: 'missing', patch: withLimits({ wallClockSec: undefined }) }, { label: "'6900' 문자열", cls: 'missing', patch: withLimits({ wallClockSec: '6900' }) }, { label: 'NaN', cls: 'missing', patch: withLimits({ wallClockSec: Number.NaN }) }, { label: '0', cls: 'bad', patch: withLimits({ wallClockSec: 0 }) }, { label: '-1', cls: 'bad', patch: withLimits({ wallClockSec: -1 }) }] },
    { name: 'jobDeadlineSec', variants: [{ label: '10800', cls: 'ok', patch: keep }, { label: '없음', cls: 'missing', patch: withLimits({ jobDeadlineSec: undefined }) }, { label: 'null', cls: 'missing', patch: withLimits({ jobDeadlineSec: null }) }, { label: '0', cls: 'bad', patch: withLimits({ jobDeadlineSec: 0 }) }, { label: '-5', cls: 'bad', patch: withLimits({ jobDeadlineSec: -5 }) }] },
    { name: 'usdCap', variants: [{ label: '5', cls: 'ok', patch: keep }, { label: '없음', cls: 'missing', patch: withLimits({ usdCap: undefined }) }, { label: 'Infinity', cls: 'missing', patch: withLimits({ usdCap: Number.POSITIVE_INFINITY }) }, { label: '0', cls: 'bad', patch: withLimits({ usdCap: 0 }) }, { label: '-3', cls: 'bad', patch: withLimits({ usdCap: -3 }) }] },
  ] },
  { cond: 5, fields: [
    { name: 'opHoldActive', variants: [{ label: 'false', cls: 'ok', patch: keep }, { label: 'true', cls: 'bad', patch: withLaunch({ opHoldActive: true }) }, { label: 'null', cls: 'missing', patch: withLaunch({ opHoldActive: null }) }, { label: '0(비불리언)', cls: 'missing', patch: withLaunch({ opHoldActive: 0 }) }] },
    { name: 'cardClaimed', variants: [{ label: 'false', cls: 'ok', patch: keep }, { label: 'true', cls: 'bad', patch: withLaunch({ cardClaimed: true }) }, { label: '누락', cls: 'missing', patch: withLaunch({ cardClaimed: undefined }) }, { label: "'no'", cls: 'missing', patch: withLaunch({ cardClaimed: 'no' }) }] },
    { name: 'activeSameGoalRuns', variants: [{ label: '0', cls: 'ok', patch: keep }, { label: '2', cls: 'bad', patch: withLaunch({ activeSameGoalRuns: 2 }) }, { label: '누락', cls: 'missing', patch: withLaunch({ activeSameGoalRuns: undefined }) }, { label: '-1', cls: 'missing', patch: withLaunch({ activeSameGoalRuns: -1 }) }, { label: "'0'", cls: 'missing', patch: withLaunch({ activeSameGoalRuns: '0' }) }] },
  ] },
  { cond: 6, fields: [
    { name: '입구', variants: [{ label: 'hand', cls: 'ok', patch: keep }, { label: 'say', cls: 'bad', patch: (ev) => ({ ...ev, entrance: { ...ev.entrance, name: 'say' } }) }, { label: '이름 없음', cls: 'missing', patch: (ev) => ({ ...ev, entrance: { ...ev.entrance, name: null } }) }] },
    { name: '그라운딩', variants: [
      { label: '정책 끔 + 사유', cls: 'ok', patch: keep },
      { label: 'URL 정상 + 도달 true', cls: 'ok', patch: (ev) => ({ ...ev, entrance: { ...ev.entrance, groundingPolicy: null, groundingUrl: URL1, groundingReachable: true } }) },
      { label: 'URL 형식 오류(garbage) + 도달 true', cls: 'bad', patch: (ev) => ({ ...ev, entrance: { ...ev.entrance, groundingPolicy: null, groundingUrl: 'garbage', groundingReachable: true } }) },
      { label: 'URL 정상 + 도달 false', cls: 'bad', patch: (ev) => ({ ...ev, entrance: { ...ev.entrance, groundingPolicy: null, groundingUrl: URL1, groundingReachable: false } }) },
      { label: 'URL 정상 + 도달 미측정', cls: 'missing', patch: (ev) => ({ ...ev, entrance: { ...ev.entrance, groundingPolicy: null, groundingUrl: URL1, groundingReachable: null } }) },
      { label: 'configured 만(URL 없음)', cls: 'missing', patch: (ev) => ({ ...ev, entrance: { ...ev.entrance, groundingPolicy: null, groundingConfigured: true } }) },
      { label: 'URL·정책 없음', cls: 'bad', patch: (ev) => ({ ...ev, entrance: { ...ev.entrance, groundingPolicy: null, groundingConfigured: false } }) },
      { label: '정책 off + 사유 공백', cls: 'bad', patch: (ev) => ({ ...ev, entrance: { ...ev.entrance, groundingPolicy: { off: true, reason: '  ' } } }) },
    ] },
  ] },
];
for (const law of laws) {
  const sym = '①②③④⑤⑥'[law.cond - 1]!;
  test(`법칙표 ${sym} 기준(전부 정상) → PASS`, () => {
    expect(evaluateTaPreflight(staticBase).conditions[idx(law.cond)]!.status).toBe('PASS');
  });
  for (const field of law.fields) {
    for (const v of field.variants) {
      test(`법칙표 ${sym} 단독 ${field.name}=${v.label} → ${lawOf([v.cls])}`, () => {
        expect(evaluateTaPreflight(v.patch(staticBase)).conditions[idx(law.cond)]!.status).toBe(lawOf([v.cls]));
      });
    }
  }
  for (let i = 0; i < law.fields.length; i += 1) {
    for (let j = i + 1; j < law.fields.length; j += 1) {
      for (const va of law.fields[i]!.variants) {
        for (const vb of law.fields[j]!.variants) {
          const expected = lawOf([va.cls, vb.cls]);
          test(`법칙표 ${sym} 쌍 ${law.fields[i]!.name}=${va.label} × ${law.fields[j]!.name}=${vb.label} → ${expected}`, () => {
            expect(evaluateTaPreflight(vb.patch(va.patch(staticBase))).conditions[idx(law.cond)]!.status).toBe(expected);
          });
        }
      }
    }
  }
}

// 리뷰어가 짚은 네 조합 + URL 형식(이름 붙인 칸)
test('법칙표 명시 — pin 누락 × privateRepo false → FAIL (알려진 private 위반을 숨기지 않는다)', () => {
  expect(evaluateTaPreflight(srcEv({ requestedPin: null, childHead: null, privateRepo: false })).conditions[idx(1)]!.status).toBe('FAIL');
});
test('법칙표 명시 — owner card≠lease(pod 없음) × 발사 argv 없음 → FAIL', () => {
  expect(evaluateTaPreflight({ ...staticBase, launchArgv: null, owner: { card: 'A', lease: 'B' } }).conditions[idx(3)]!.status).toBe('FAIL');
});
test('법칙표 명시 — jobDeadline 0 × wallClock 없음 → FAIL', () => {
  expect(evaluateTaPreflight(limEv({ jobDeadlineSec: 0, usdCap: 5 })).conditions[idx(4)]!.status).toBe('FAIL');
});
for (const [id, url, expected] of [['U01', 'garbage', 'FAIL'], ['U02', 'ftp://host.example/x', 'FAIL'], ['U03', 'http://', 'FAIL'], ['U04', '//host.example', 'FAIL'], ['U05', 'https://host.example:8443/path', 'PASS']] as const) {
  test(`법칙표 URL ${id}: groundingUrl=${JSON.stringify(url)} + 도달 true → ${expected}`, () => {
    const ev = { ...staticBase, entrance: { name: 'hand', groundingUrl: url, groundingReachable: true } };
    expect(evaluateTaPreflight(ev).conditions[idx(6)]!.status).toBe(expected);
  });
}

// ══ ③ merge 경로 판정표 — 발사 argv 플래그 × liveMoves(propose-land) 설정/미설정 (OP 요청 리터럴 표) ══
// 자동 병합이 «가능»하면 FAIL · 닫힘(--no-auto-merge 만)이면 PASS(이 칸) · argv 없음/명령 아님은 UNMEASURED. 사유는 병합 주체(호스트/TA).
type MergeCell = { id: string; argv: unknown; taLandEnv: unknown; liveMoves: boolean; expect: Expect; detail?: string };
const OMIT = Symbol('omit');
const mergeCells: MergeCell[] = [
  { id: 'M01', argv: ['harness', 'say', '--substrate', 'pod', '--no-auto-merge'], taLandEnv: false, liveMoves: false, expect: 'PASS' },
  { id: 'M02', argv: ['harness', 'say', '--substrate', 'pod', '--no-auto-merge'], taLandEnv: false, liveMoves: true, expect: 'PASS' },
  { id: 'M03', argv: ['harness', 'say', '--substrate', 'pod', '--merge-by-host'], taLandEnv: false, liveMoves: false, expect: 'FAIL', detail: 'liveMoves propose-land 미설정' },
  { id: 'M04', argv: ['harness', 'say', '--substrate', 'pod', '--merge-by-host'], taLandEnv: false, liveMoves: true, expect: 'FAIL', detail: '호스트가 재게이트 뒤 병합' },
  { id: 'M05', argv: ['harness', 'say', '--substrate', 'pod', '--merge-by-host'], taLandEnv: true, liveMoves: true, expect: 'FAIL', detail: 'TA propose-land 이 병합' },
  { id: 'M06', argv: ['harness', 'say', '--substrate', 'pod', '--merge-by-host'], taLandEnv: true, liveMoves: false, expect: 'FAIL', detail: 'liveMoves propose-land 미설정' },
  { id: 'M07', argv: ['harness', 'say', '--substrate', 'pod'], taLandEnv: false, liveMoves: false, expect: 'FAIL', detail: '--no-auto-merge 없음' },
  { id: 'M08', argv: ['harness', 'say', '--substrate', 'pod'], taLandEnv: false, liveMoves: true, expect: 'FAIL', detail: '--no-auto-merge 없음' },
  { id: 'M09', argv: ['harness', 'say', '--substrate', 'pod', '--no-auto-merge', '--merge-by-host'], taLandEnv: false, liveMoves: false, expect: 'FAIL', detail: '병합 인자가 우선' },
  { id: 'M10', argv: ['harness', 'say', '--substrate', 'pod', '--no-auto-merge', '--auto-merge'], taLandEnv: false, liveMoves: true, expect: 'FAIL', detail: '자동 병합(--auto-merge)' },
  { id: 'M11', argv: ['harness', 'say', '--substrate', 'pod', '--no-auto-merge'], taLandEnv: true, liveMoves: true, expect: 'FAIL', detail: 'TA propose-land 이 병합' },
  { id: 'M12', argv: ['harness', 'say', '--substrate', 'pod', '--no-auto-merge'], taLandEnv: true, liveMoves: false, expect: 'FAIL', detail: 'liveMoves propose-land 미설정이면 호스트가 병합' },
  { id: 'M13', argv: null, taLandEnv: false, liveMoves: false, expect: 'UNMEASURED', detail: 'argv 없음' },
  { id: 'M14', argv: [], taLandEnv: false, liveMoves: true, expect: 'UNMEASURED' },
  { id: 'M15', argv: ['ls', '-la'], taLandEnv: false, liveMoves: false, expect: 'UNMEASURED', detail: '시작하는 명령이 아님' },
  { id: 'M16', argv: ['elanous', 'harness', 'say', '--substrate', 'pod', '--no-auto-merge'], taLandEnv: false, liveMoves: false, expect: 'PASS' },
  // 없음·형식 오류 행(r3 리뷰) — taLandEnv: 불리언만 값 · argv: 명령 위치·옵션 경계
  { id: 'M17', argv: ARGV_CLOSED, taLandEnv: OMIT, liveMoves: false, expect: 'UNMEASURED', detail: '--ta-land(발사 env) 여부 증거 없음' },
  { id: 'M18', argv: ARGV_CLOSED, taLandEnv: null, liveMoves: false, expect: 'UNMEASURED' },
  { id: 'M19', argv: ARGV_CLOSED, taLandEnv: 'false', liveMoves: false, expect: 'UNMEASURED', detail: '불리언 아님' },
  { id: 'M20', argv: ARGV_CLOSED, taLandEnv: 0, liveMoves: true, expect: 'UNMEASURED' },
  { id: 'M21', argv: ARGV_MERGE_BY_HOST, taLandEnv: OMIT, liveMoves: false, expect: 'FAIL', detail: '자동 병합 가능' },
  { id: 'M22', argv: ['harness', 'say', '--substrate', 'pod'], taLandEnv: null, liveMoves: false, expect: 'FAIL', detail: '--no-auto-merge 없음' },
  { id: 'M23', argv: ['echo', 'harness', 'say', '--no-auto-merge'], taLandEnv: false, liveMoves: false, expect: 'UNMEASURED', detail: '시작하는 명령이 아님' },
  { id: 'M24', argv: ['harness', 'say', '--', '--no-auto-merge'], taLandEnv: false, liveMoves: false, expect: 'FAIL', detail: '--no-auto-merge 없음' },
  { id: 'M25', argv: ['harness', 'say', '--no-auto-merge', '--', '--merge-by-host'], taLandEnv: false, liveMoves: false, expect: 'PASS' },
  { id: 'M26', argv: ['harness', 1, 'say'], taLandEnv: false, liveMoves: false, expect: 'UNMEASURED', detail: '형식 오류' },
  { id: 'M27', argv: 'harness say --no-auto-merge', taLandEnv: false, liveMoves: false, expect: 'UNMEASURED', detail: '형식 오류' },
  { id: 'M28', argv: ['sh', '-c', 'harness say --no-auto-merge'], taLandEnv: false, liveMoves: false, expect: 'UNMEASURED', detail: '시작하는 명령이 아님' },
  { id: 'M29', argv: ['elanous', 'harness', 'say', '--merge-by-host'], taLandEnv: false, liveMoves: true, expect: 'FAIL', detail: '자동 병합 가능' },
  { id: 'M30', argv: ARGV_CLOSED, taLandEnv: true, liveMoves: true, expect: 'FAIL', detail: '--ta-land' },
  { id: 'M31', argv: undefined, taLandEnv: true, liveMoves: true, expect: 'FAIL', detail: '--ta-land' },
  { id: 'M32', argv: undefined, taLandEnv: OMIT, liveMoves: false, expect: 'UNMEASURED', detail: 'argv 없음' },
];
for (const cell of mergeCells) {
  test(`merge판정표 ${cell.id}: ${JSON.stringify(cell.argv) ?? '(argv 없음)'} · ta-land=${cell.taLandEnv === OMIT ? '(누락)' : JSON.stringify(cell.taLandEnv)} · liveMoves=${cell.liveMoves} → ${cell.expect}`, () => {
    const mergePolicy = (cell.taLandEnv === OMIT ? { liveMovesProposeLand: cell.liveMoves } : { taLandEnv: cell.taLandEnv, liveMovesProposeLand: cell.liveMoves }) as TaPreflightEvidence['mergePolicy'];
    const ev: TaPreflightEvidence = { ...staticBase, launchArgv: cell.argv as TaPreflightEvidence['launchArgv'], mergePolicy };
    const c = evaluateTaPreflight(ev).conditions[idx(3)]!;
    expect(c.status).toBe(cell.expect);
    if (cell.detail) expect(c.detail).toContain(cell.detail);
  });
}

// 실프로세스 — hand shadow 를 실제로 띄워 출력을 파일로 저장하고, 그 파일로 preflight 를 실제로 띄운다(simCli spawn).
async function shadowThenPreflight(handArgs: string[]): Promise<{ handOut: string; preflightOut: string; code: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'ta-preflight-shadow-'));
  try {
    const hand = await simCli(['tasks', 'hand', ...handArgs], { mode: 'spawn', allowPaths: [['tasks', 'hand']], timeoutMs: 120_000 });
    const shadowPath = join(dir, 'shadow.txt');
    writeFileSync(shadowPath, hand.stdout);
    const evidencePath = join(dir, 'e.json');
    const { launchArgv: _omit, ...rest } = staticBase;
    const card = parseHandShadowEvidence(hand.stdout).cardId;
    writeFileSync(evidencePath, JSON.stringify({ ...rest, workOrder: { ...rest.workOrder!, card } }));
    const pre = await simCli(['tasks', 'preflight', '--evidence', evidencePath, '--hand-shadow', shadowPath], { mode: 'spawn', allowPaths: [['tasks', 'preflight']], timeoutMs: 120_000 });
    return { handOut: hand.stdout, preflightOut: pre.stdout, code: pre.exitCode };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('실프로세스: hand shadow(--no-auto-merge) → preflight --hand-shadow 는 ③ PASS(merge 경로 닫힘)', async () => {
  const r = await shadowThenPreflight(['ship it', '--no-auto-merge']);
  expect(r.handOut).toContain('harness say --substrate pod --no-auto-merge');
  expect(r.preflightOut).toMatch(/UNMEASURED +3\. 작업 지시서 · 귀속 · 자동 merge 0 — 카드\/lease\/Pod owner 증거 부족/);
  expect(r.preflightOut).toMatch(/UNMEASURED +5\./u);
  expect(r.code).toBe(1);
}, 400_000);

test('실프로세스: hand shadow(옵션 없음 = --merge-by-host) → preflight --hand-shadow 는 ③ FAIL(자동 병합 가능)', async () => {
  const r = await shadowThenPreflight(['ship it']);
  expect(r.handOut).toContain('harness say --substrate pod --merge-by-host');
  expect(r.preflightOut).toMatch(/FAIL {7}3\. 작업 지시서 · 귀속 · 자동 merge 0 — .*자동 병합 가능 — 호스트가 재게이트 뒤 병합/);
  expect(r.code).toBe(1);
}, 400_000);

test('축곱 표 마크다운 내보내기(TA_AXES_MD)', () => {
  const out = process.env.TA_AXES_MD;
  if (!out) return;
  const ent = (e: Ent | undefined) => e === undefined ? '(입구 증거 없음)' : [`입구=${e.name ?? '없음'}`, `url=${e.groundingUrl === undefined ? '없음' : JSON.stringify(e.groundingUrl)}`, `configured=${String(e.groundingConfigured)}`, `도달=${String(e.groundingReachable)}`, `정책=${e.groundingPolicy ? `off=${String(e.groundingPolicy.off)} 사유=${e.groundingPolicy.reason === undefined ? '없음' : JSON.stringify(e.groundingPolicy.reason)}` : '없음'}`].join(' · ');
  const img = (i: Img | undefined) => i === undefined ? '(이미지 증거 없음)' : `pin=${i.expectedDigest === null ? '없음' : i.expectedDigest === dg ? '유효' : JSON.stringify(i.expectedDigest)} · 관측=${i.observedDigest === null ? '없음' : i.observedDigest === dg ? '=pin' : i.observedDigest === dg2 ? '≠pin' : JSON.stringify(i.observedDigest)}`;
  const lines = ['### ⑥ 그라운딩 축 곱', '| 칸 | 입력 | 기대 | 시험 |', '|---|---|---|---|',
    ...groundingCells.map((c) => `| ${c.id} | ${ent(c.entrance)} | ${c.expect}${c.detail ? ` (${c.detail.replaceAll('|', '/')})` : ''} | 축곱 ⑥ ${c.id} |`), '',
    '### ② 이미지 축 곱', '| 칸 | 입력 | failClosed.imageDigest | 기대 | 시험 |', '|---|---|---|---|---|',
    ...imageCells.map((c) => `| ${c.id} | ${img(c.image)} | ${String(c.fc)} | ${c.expect}${c.detail ? ` (${c.detail})` : ''} | 축곱 ② ${c.id} |`),
    ...([[1, '① 소스'], [3, '③ 작업 지시서·귀속·자동 merge'], [4, '④ 시간·비용'], [5, '⑤ 중복·중지·hold']] as const).flatMap(([n, title]) => ['', `### ${title} 축 곱`, '| 칸 | 입력 | 기대 | 시험 |', '|---|---|---|---|', ...cells.filter((c) => c.cond === n).map((c) => `| ${c.id} | ${c.desc} | ${c.expect}${c.detail ? ` (${c.detail})` : ''} | 축곱 ${'①②③④⑤⑥'[n - 1]} ${c.id} |`)])];
  const lawLines = ['### 판정 법칙표 — 칸 × 값(ok 정상 · bad 불량 · missing 없음/형식오류)', '법칙: **bad 하나라도 → FAIL · 없고 missing 하나라도 → UNMEASURED · 전부 ok → PASS**. 단독·모든 쌍을 시험(칸이 달라도 알려진 불량이 누락에 가려지지 않음).', '',
    '| 조건 | 칸 | 값 → 분류 |', '|---|---|---|',
    ...laws.flatMap((law) => law.fields.map((f) => `| ${'①②③④⑤⑥'[law.cond - 1]} | ${f.name} | ${f.variants.map((v) => `${v.label}→${v.cls}`).join(' · ')} |`)), ''];
  writeFileSync(out, `${[...lawLines, ...lines].join('\n')}\n`);
});

// 실프로세스 — simCli 의 명시적 process boundary(mode: 'spawn')로 bin 을 실제로 띄운다(R-LIVE10 단일 창구). 기대값은 제품 상수가 아니라 아래 독립 리터럴.
async function runPreflightProcess(evidence: unknown): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'ta-preflight-proc-'));
  const evidencePath = join(dir, 'e.json');
  writeFileSync(evidencePath, JSON.stringify(evidence));
  try {
    const r = await simCli(['tasks', 'preflight', '--evidence', evidencePath], { mode: 'spawn', allowPaths: [['tasks', 'preflight']], timeoutMs: 120_000 });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('실프로세스: tasks preflight — 카드 미관측은 UNMEASURED, failClosed 거짓 주장은 빌드가 덮어쓴다', async () => {
  const r = await runPreflightProcess({ ...staticBase, failClosed: { sourceHead: false, imageDigest: false } });
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toMatch(/UNMEASURED +5\./u);
  expect(r.stdout).toMatch(/PASS {7}1\. private repo \+ child 실제 HEAD — 정적: pin a{12} /);
  expect(r.stdout).toMatch(/UNMEASURED +6\. 단일 입구 · 그라운딩 — 관측 호스트와 배정 발사 호스트 결속 미측정/);
}, 150_000);

test('실프로세스: tasks preflight — 증거 한 칸이 빠지면 NOT_READY exit 1 (소스 private 증거 없음 → ① UNMEASURED)', async () => {
  const r = await runPreflightProcess({ ...staticBase, source: { requestedPin: sha, childHead: null, privateRepo: null } });
  expect(r.exitCode).toBe(1);
  expect(r.stdout).toMatch(/UNMEASURED 1\. private repo \+ child 실제 HEAD — private repo 증거 없음/);
  expect(r.stdout).toMatch(/UNMEASURED +5\./u);
}, 150_000);
