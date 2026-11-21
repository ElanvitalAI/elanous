import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { registerTasksCommands } from '../cli/tasks-cli.js';
import { DEFAULT_MAX_HARD_WAIT_SEC } from '../self-implement/headless-elanous-driver.js';
import { buildWorkOrder, hashWorkOrderContent } from './work-order-build.js';
import { parseWorkOrder, parseWorkOrderBudget, TA_PILOT_MAX_WALL_SEC, taPodDeadlineSeconds, workOrderBudgetFailureReason } from './work-order.js';
import { handTask } from './task-hand.js';
import { criticalUnknownFields } from './work-order.js';

test('TA-WO-FIELDS: work-order build copies owner, card and merge policy from the selected card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-order-card-'));
  const out = join(dir, 'order.json'), statePath = join(dir, 'cards.json');
  writeFileSync(statePath, JSON.stringify({ tasks: { 'ta-test-card': { id: 'ta-test-card', seat: 'TC',
    checklistId: 'CELL', checklistVersion: '0.3.30', noAutoMerge: true, status: 'handed', history: [] } } }));
  const program = new Command().exitOverride();
  const previousExit = process.exitCode;
  registerTasksCommands(program, { taskStatePath: statePath, output: () => {},
    workOrderChecklist: (version) => ({ version, released: '', dev: '', history: [], items: [{
      id: 'CELL', title: '대상 경로: src/task-agent/task-hand.ts', status: 'yellow', priority: 'P1', updatedAt: '', updatedBy: '',
    }] }) });
  try {
    await program.parseAsync(['node', 'eln', 'tasks', 'work-order', 'build', '--checklist', 'CELL', '--version', '0.3.30',
      '--card', 'ta-test-card', '--budget', 'time=3600s usd=3 tier=low pod=node-c rework=1', '--out', out]);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ owner: 'TC', card: 'ta-test-card', noAutoMerge: true,
      budget: 'time=3600s usd=3 tier=low pod=node-c rework=1', budgetLimits: { timeSec: 3600, usdCap: 3 } }); // 출처: #97932 독립 지시서 예산 픽스처.
    expect(JSON.parse(readFileSync(statePath, 'utf8')).tasks['ta-test-card'].budgetLimits)
      .toEqual({ timeSec: 3600, usdCap: 3 }); // 출처: #97791 위 카드와 지시서의 동일 예산.
    const parsed = parseWorkOrder(readFileSync(out, 'utf8'));
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(hashWorkOrderContent(parsed.order, 'rev')).not.toBe(hashWorkOrderContent({ ...parsed.order, card: 'other-card' }, 'rev'));
    const shadow = await handTask({ id: 'ta-test-card', text: '대상 경로: src/task-agent/task-hand.ts', seat: 'TC',
      checklistId: 'CELL', checklistVersion: '0.3.30', noAutoMerge: true, workOrder: parsed.order,
      statePath: join(dir, 'new-cards.json'), prelaunchInspector: () => ({ reason: 'completion-not-code-pr' }), launcher: () => {} });
    expect(shadow.card.budgetLimits).toEqual({ timeSec: 3600, usdCap: 3 }); // 출처: #97791 위 지시서의 동일 예산.
    const original = readFileSync(out, 'utf8');
    await program.parseAsync(['node', 'eln', 'tasks', 'work-order', 'build', '--checklist', 'CELL', '--version', '0.3.30',
      '--card', 'ta-test-card', '--budget', 'time=3600s usd=4', '--out', out]);
    expect(process.exitCode).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).tasks['ta-test-card'].budgetLimits)
      .toEqual({ timeSec: 3600, usdCap: 3 }); // 출처: #97791 위 카드의 기존 예산은 충돌 시 유지.
    const pristine = { id: 'ta-test-card', seat: 'TC', checklistId: 'CELL', checklistVersion: '0.3.30',
      noAutoMerge: true, status: 'handed', history: [] };
    writeFileSync(statePath, JSON.stringify({ tasks: { 'ta-test-card': pristine } }));
    process.exitCode = 0;
    await program.parseAsync(['node', 'eln', 'tasks', 'work-order', 'build', '--checklist', 'CELL', '--version', '0.3.30',
      '--card', 'ta-test-card', '--budget', 'time=3600s usd=3', '--out', dir]);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).tasks['ta-test-card']).toEqual(pristine);
  } finally { process.exitCode = previousExit ?? 0; rmSync(dir, { recursive: true, force: true }); }
});

test('ENTRANCE-WORK-ORDER-BUILD core fills the nine fields and lists unknown values', () => {
  const order = buildWorkOrder({ cellId: 'ENTRANCE-WORK-ORDER-BUILD', version: '0.2.35' });
  expect(order).toMatchObject({
    cellId: 'ENTRANCE-WORK-ORDER-BUILD',
    lifeId: '모름',
    version: '0.2.35',
    priority: '모름',
    peers: '모름',
  });
  expect(order).toMatchObject({
    landBy: '모름', identityTags: '모름', verdictSignal: '모름', contract: '모름',
    boundary: '모름', budget: '모름', precedents: '모름', escalation: '모름',
  });
  expect(order.unknownFields).toEqual(['lifeId', 'landBy', 'identityTags', 'priority', 'verdictSignal', 'contract', 'boundary', 'budget', 'peers', 'precedents', 'escalation']);
  expect(Object.keys(order)).toEqual(['cellId', 'lifeId', 'version', 'landBy', 'identityTags', 'priority', 'verdictSignal', 'contract', 'boundary', 'budget', 'peers', 'precedents', 'escalation', 'unknownFields']);
});

test('ENTRANCE-WORK-ORDER-BUILD core preserves caller supplied life identity', () => {
  const order = buildWorkOrder({ cellId: 'CELL', version: '0.2.35', lifeId: 'life-17', priority: 'P0', peers: 'PARENT-A' });
  expect(order).toMatchObject({ lifeId: 'life-17', priority: 'P0', peers: 'PARENT-A' });
  expect(order.unknownFields).not.toContain('lifeId');
  expect(order.unknownFields).not.toContain('priority');
  expect(order.unknownFields).not.toContain('peers');
});

test('tasks work-order build reads the selected checklist and writes normalized fields with missing paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-order-cli-'));
  const out = join(dir, 'nested', 'order.work-order.json');
  const missingPath = join(dir, 'absent.ts');
  const lines: string[] = [];
  const program = new Command().name('elanous').exitOverride();
  registerTasksCommands(program, {
    output: (line) => lines.push(line),
    workOrderChecklist: (version) => ({ version, released: '', dev: '', history: [], items: [{
      id: 'ENTRANCE-WORK-ORDER-BUILD', title: `대상 경로: src/task-agent/work-order-build.ts · ${missingPath}`,
      status: 'yellow', priority: 'P0', updatedAt: '', updatedBy: '',
    }] }),
  });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', 'tasks', 'work-order', 'build', '--checklist', 'ENTRANCE-WORK-ORDER-BUILD', '--version', '0.2.35', '--out', out]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(lines).toEqual([out]);
    const order = JSON.parse(readFileSync(out, 'utf8'));
    expect(order).toMatchObject({ cellId: 'ENTRANCE-WORK-ORDER-BUILD', version: '0.2.35', priority: 'P0',
      boundary: `대상 경로: src/task-agent/work-order-build.ts · ${missingPath}\nboundary.missing: ${missingPath}`,
      landBy: '모름', identityTags: '모름', verdictSignal: '모름', contract: '모름',
      budget: '모름', peers: '모름', precedents: '모름', escalation: '모름' });
    expect(order.unknownFields).toEqual(['lifeId', 'landBy', 'identityTags', 'verdictSignal', 'contract', 'budget', 'peers', 'precedents', 'escalation']);
    expect(Object.keys(order)).toEqual(Object.keys(buildWorkOrder({ cellId: 'ENTRANCE-WORK-ORDER-BUILD', version: '0.2.35' })));
  } finally { process.exitCode = previous ?? 0; rmSync(dir, { recursive: true, force: true }); }
});

test('isolated production elanous entry reads the on-disk checklist and writes a work order', async () => {
  const repo = resolve(import.meta.dir, '../..');
  const dir = mkdtempSync(join(tmpdir(), 'work-order-entry-'));
  const version = '0.2.35';
  const cellId = 'ENTRANCE-WORK-ORDER-BUILD';
  // Exact first line from the live 0.2.35 checklist; keep its ` · ` path separators under regression.
  const checklistTargetLine = '대상 경로: src/cli/tasks-cli.ts · src/task-agent/work-order-build.ts · src/task-agent/work-order-build.test.ts';
  const missingPath = join(dir, 'absent-work-order-proof.ts');
  const checklistDir = join(dir, 'release', version);
  const out = join(dir, 'orders', 'entry.work-order.json');
  mkdirSync(checklistDir, { recursive: true });
  writeFileSync(join(checklistDir, 'checklist.json'), JSON.stringify({ version, released: '', dev: version, history: [], items: [{
    id: cellId, title: `${checklistTargetLine} · ${missingPath}\n현재 계약: 원문 보존`,
    status: 'yellow', priority: 'P0', updatedAt: '2026-10-20T00:00:00Z', updatedBy: 'OP',
  }] }));
  try {
    const child = Bun.spawn([process.execPath, join(repo, 'bin/elanous.mjs'), `--test=${dir}`, 'tasks', 'work-order', 'build',
      '--checklist', cellId, '--version', version, '--out', out], { cwd: repo, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ELANOUS_STATE_DIR: dir } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stdout: stdout.trim() }).toEqual({ exit: 0, stdout: out });
    expect(stderr).not.toContain('Error:');
    const order = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(order)).toEqual(Object.keys(buildWorkOrder({ cellId, version })));
    expect(order).toMatchObject({ cellId, version, priority: 'P0',
      boundary: `${checklistTargetLine} · ${missingPath}\nboundary.missing: ${missingPath}`,
      lifeId: '모름', landBy: '모름', identityTags: '모름', verdictSignal: '모름', contract: '모름',
      budget: '모름', peers: '모름', precedents: '모름', escalation: '모름' });
    expect(order.unknownFields).toEqual(['lifeId', 'landBy', 'identityTags', 'verdictSignal', 'contract', 'budget', 'peers', 'precedents', 'escalation']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);


test('ENTRANCE-WORKORDER-REPLAY-HASH: equivalent producers share a revision-scoped content hash', () => {
  const dispatcherOrder = buildWorkOrder({
    cellId: 'ENTRANCE-WORKORDER-REPLAY-HASH', version: '0.2.46', priority: 'P1',
    boundary: 'src/task-agent/work-order-build.ts',
  });
  const coordinatorOrder = buildWorkOrder({
    boundary: ' src/task-agent/work-order-build.ts ', priority: ' P1 ',
    version: '0.2.46', cellId: 'ENTRANCE-WORKORDER-REPLAY-HASH',
  });
  const revision = '2026-11-02T12:00:00.000Z';
  const dispatcherHash = hashWorkOrderContent(dispatcherOrder, revision);
  const coordinatorHash = hashWorkOrderContent(coordinatorOrder, revision);

  expect(dispatcherHash).toBe(coordinatorHash);
  expect(dispatcherHash).toMatch(/^[a-f0-9]{64}$/);
  expect(dispatcherHash).not.toContain('src/task-agent/work-order-build.ts');
  expect(hashWorkOrderContent(buildWorkOrder({
    cellId: 'ENTRANCE-WORKORDER-REPLAY-HASH', version: '0.2.46', priority: 'P0',
    boundary: 'src/task-agent/work-order-build.ts',
  }), revision)).not.toBe(dispatcherHash);
  expect(hashWorkOrderContent(dispatcherOrder, `${revision}-changed`)).not.toBe(dispatcherHash);

  const withDependencies = (dependencies: NonNullable<typeof dispatcherOrder.dependencies>) => ({ ...dispatcherOrder, dependencies });
  const first = { cell: 'CELL-A', state: 'green', observedAt: '2026-11-02T10:00:00Z' };
  const second = { cell: 'CELL-B', state: 'yellow', observedAt: '2026-11-02T11:00:00Z' };
  const orderedHash = hashWorkOrderContent(withDependencies([first, second]), revision);
  expect(hashWorkOrderContent(withDependencies([second, first]), revision)).toBe(orderedHash);
  expect(hashWorkOrderContent(withDependencies([{ ...second, state: 'green' }, first]), revision)).not.toBe(orderedHash);
});

test('TA-WORK-ORDER budget/contract/escalation inputs fill the critical fields; missing ones are reported', () => {
  const bare = buildWorkOrder({ cellId: 'X', version: '0.3.28' });
  expect(criticalUnknownFields(bare)).toEqual(['boundary', 'budget', 'contract', 'escalation']);
  const filled = buildWorkOrder({ cellId: 'X', version: '0.3.28', boundary: 'src/a.ts', budget: 'time=6900s tier=low', contract: 'c', escalation: 'OP' });
  expect(filled).toMatchObject({ budget: 'time=6900s tier=low', contract: 'c', escalation: 'OP' });
  expect(criticalUnknownFields(filled)).toEqual([]);
  expect(buildWorkOrder({ cellId: 'X', version: '0.3.28', budget: 'b' }).unknownFields).not.toContain('budget');
});

// ── 예산 문법 — 기대값은 독립 리터럴. time 은 «선언 그대로» 정수 초(부동소수·허용오차 없음), usd 는 센트 단위 ──
test('the pilot wall-clock cap is 6900 and equals the child default hard wait', () => {
  expect(TA_PILOT_MAX_WALL_SEC).toBe(6900);
  expect(DEFAULT_MAX_HARD_WAIT_SEC).toBe(6900);
});

test('budget time table: declared integer seconds in 1..6900 only', () => {
  const sec = (time: string): number | null => { const r = parseWorkOrderBudget(`time=${time} usd=1`); return r.ok ? r.timeSec : null; };
  const accepted: Array<[string, number]> = [['1s', 1], ['1', 1], ['60s', 60], ['6900', 6900], ['6900s', 6900], ['6900.0s', 6900], ['6900.000000000000s', 6900],
    ['115m', 6900], ['1.5h', 5400], ['0.5h', 1800], ['0.25m', 15], ['0.5m', 30], ['1.25m', 75], ['1.9h', 6840]];
  for (const [time, expected] of accepted) expect([time, sec(time)]).toEqual([time, expected]);
  const rejected = ['0', '0s', '0.5', '0.5s', '0.999s', '1.0001s', '6900.4s', '6900.0000000001s', '6900.000000000001s', '6901s', '6901', '116m', '1.92h', '2h',
    '0.001m', '0.0000000001h', '1e3s', '+60s', '-1', '60S', '1H', '60sec', '1hr', '1d', '', '.5s', '5.s', '1234567s'];
  for (const time of rejected) expect([time, sec(time)]).toEqual([time, null]);
  expect(parseWorkOrderBudget('time=6900.0000000001s usd=5')).toMatchObject({ ok: false, reason: 'budget-time-noninteger' });
});

test('budget usd table: positive cents, at most two decimals, finite', () => {
  const ok = (usd: string): boolean => parseWorkOrderBudget(`time=60s usd=${usd}`).ok;
  for (const usd of ['0.01', '0.1', '1', '5', '5.5', '5.50', '5.05', '100.99', '999999999.99', '000.01']) expect([usd, ok(usd)]).toEqual([usd, true]);
  for (const usd of ['0', '0.0', '0.00', '0.001', '1.234', '5.', '.5', '-1', '1e3', 'Infinity', 'NaN', '9999999999', '9'.repeat(400), '', 'abc', '1,5']) expect([usd.slice(0, 8), ok(usd)]).toEqual([usd.slice(0, 8), false]);
});

test('budget grammar: duplicates, extra keys, malformed declarations, whitespace and case are rejected, never ignored', () => {
  const ok = (budget: string): boolean => parseWorkOrderBudget(budget).ok;
  for (const budget of ['time=60s usd=1', 'usd=1 time=60s', 'time=60s,usd=1', 'time=60s·usd=1', 'time=60s;usd=1', '  time=60s   usd=1  ']) expect([budget, ok(budget)]).toEqual([budget, true]);
  const rejected = ['time=7200s time=60s usd=1', 'time=60s time=7200s usd=1', 'time=60s usd=abc usd=5', 'time=60s usd=5 usd=abc', 'time=60s usd=1 usd=1',
    'time=60s usd=1 calls=5', 'time=60s usd=1 tier=low tier=high',
    'time= usd=1', 'time=60s usd=', 'time = 60s usd=1', 'time=60s usd=1 extra', '시간 4h usd=1 time=60s', 'time=60s usd=1 =5',
    'TIME=60s usd=1', 'time=60s USD=1', 'Time=60s usd=1', 'time=60s', 'usd=1', '', '모름'];
  for (const budget of rejected) expect([budget, ok(budget)]).toEqual([budget, false]);
  expect(parseWorkOrderBudget('time=60s usd=1 tier=low pod=node-c rework=1')).toMatchObject({ ok: true, timeSec: 60 }); // 출처: #97932 허용 발사 설정 픽스처.
  expect(parseWorkOrderBudget('time=60s usd=1 unknown=value')).toMatchObject({ ok: false, reason: 'budget-key-not-allowed' });
  expect(parseWorkOrderBudget('time=7200s time=60s usd=1')).toMatchObject({ ok: false, reason: 'budget-duplicate-key' });
});

test('taPodDeadlineSeconds: only an integer wall in 1..6900 narrows the Job (wall + 300s grace)', () => {
  expect(taPodDeadlineSeconds({ ELANOUS_TA_WALL_SEC: '60' })).toBe(360);
  expect(taPodDeadlineSeconds({ ELANOUS_TA_WALL_SEC: '6900' })).toBe(7200);
  for (const raw of [undefined, '', '0', '6901', '-1', '1.5', ' 60', '60s', '1e3', '00000', '99999']) expect([raw, taPodDeadlineSeconds({ ELANOUS_TA_WALL_SEC: raw })]).toEqual([raw, undefined]);
});


test('TA-BUDGET-WALL ①: buildWorkOrder 는 무효 예산을 관용한다(budgetLimits 생략) — 벽은 handTask 발사 경계에서 난다', () => {
  const input = { cellId: 'TA-BUDGET-WALL', version: '0.3.31', priority: 'P0', boundary: 'src/task-agent/task-hand.ts', budget: 'time=1800s usd=1', contract: 'focused 0 fail', escalation: 'OP' };
  const ok = buildWorkOrder(input);
  expect(ok.budgetLimits).toEqual({ timeSec: 1800, usdCap: 1 });
  // 서 계약(TA-WORK-ORDER·COORD-ENTRANCE-FOLD): 상한을 못 만드는 예산은 build 가 관용(budgetLimits 생략) — 거부는 handTask 발사 경계(③④)에서 난다.
  expect(buildWorkOrder({ ...input, budget: 'time=6900s tier=low' }).budgetLimits).toBeUndefined();
  expect(buildWorkOrder({ ...input, budget: 'time=7200s usd=1' }).budgetLimits).toBeUndefined();
  expect(buildWorkOrder({ ...input, budget: undefined }).budgetLimits).toBeUndefined();
  expect(workOrderBudgetFailureReason('time=6900s tier=low')).toContain('usd');
  expect(workOrderBudgetFailureReason('time=7200s usd=1')).toBeDefined();
});
