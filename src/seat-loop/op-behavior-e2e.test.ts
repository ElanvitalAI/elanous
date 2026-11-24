// OP-BEHAVIOR-E2E (OP 배정 P0 · 0.3.34 «시뮬 월드·테스트 우주·이벤트 합성으로 확인» — 시나리오 하네스 먼저 PR)
// 실제 eln Next TUI 를 격리 우주에 띄워 실사고를 이벤트로 주입하고 원장에서 점수화하는
// e2e 하네스의 시험. 1차(op-behavior-sim.ts)가 자리 턴을 정책 함수로 시뮬한 것과 달리
// 이층은 진짜 제품 경로(부팅→MsgStore 우편→깨움 턴→도구 경계→debug 원장)를 그대로 돌리고
// 외부 모델만 test-fake-llm 로 갈음한다(격리 무대 env — 진짜 TUI PTY 시험들과 같은 패턴).
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import {
  BASELINE_POLICY,
  type E2EUniverse,
  type FakeLlmPreset,
  captureIndexOf,
  compareRuns,
  createE2EUniverse,
  e2eScoredRun,
  incidentSeatItems,
  policyPreset,
  readSeatApprovalRows,
  readTurnLifeRows,
  readUsageRows,
  rmE2EUniverse,
  runE2EStage,
  seedIncidentMail,
  type SeatPtyStep,
  toSimScore,
} from './op-behavior-e2e.js';

test('격리 우주 + 폭주 3통 시드 — 실제 MsgStore 에 3행(원장 원문)', () => {
  const uni = createE2EUniverse();
  try {
    const plans = seedIncidentMail(uni, 'mail-flood-30', { count: 3 });
    expect(plans).toHaveLength(3);
    expect(new Set(plans.map((p) => p.marker)).size).toBe(3);
    const store = new MsgStore(uni.msgDb);
    try {
      const rows = store.listByRecipient(uni.seat);
      expect(rows).toHaveLength(3);
      expect(rows.every((message) => message.body.includes('폭주 우편'))).toBe(true);
    } finally { store.close(); }
  } finally { rmE2EUniverse(uni); }
});

test('결정급 질문 시드 — CEO 발신 우편 1행(원장 원문)', () => {
  const uni = createE2EUniverse();
  try {
    const plans = seedIncidentMail(uni, 'crown-question');
    expect(plans).toHaveLength(1);
    expect(plans[0]!.from).toBe('CEO');
    const store = new MsgStore(uni.msgDb);
    try {
      const rows = store.listByRecipient(uni.seat);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toContain('sim-crown-decision');
    } finally { store.close(); }
  } finally { rmE2EUniverse(uni); }
});

test('원장 관측 → SimScore 어댑터 — 턴·인터럽트 짝짓기·턴당 토큰 원문 계측', async () => {
  const uni = createE2EUniverse();
  try {
    const dir = uni.ledgerDirs[0]!;
    mkdirSync(dir, { recursive: true });
    const log = join(dir, 'debug-fixture.log');
    const rows = [
      { category: 'turn-life', event: 'turn-life:turn-start', data: { door: 'human' } },
      { category: 'turn-life', event: 'turn-life:turn-end', data: {} },
      { category: 'turn-life', event: 'turn-life:turn-start', data: { door: 'queue' } },
      { category: 'llm.usage', event: 'llm-usage', data: { inputTokens: 900, outputTokens: 40 } },
      { category: 'llm.usage', event: 'llm-usage', data: { inputTokens: 300, outputTokens: 20 } },
      { category: 'llm.usage', event: 'llm-usage', data: { measured: false } },
    ];
    writeFileSync(log, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const turnLife = await readTurnLifeRows(uni);
    expect(turnLife.map((row) => row.event)).toEqual([
      'turn-life:turn-start', 'turn-life:turn-end', 'turn-life:turn-start',
    ]);
    const usage = await readUsageRows(uni);
    expect(usage).toEqual([
      { inputTokens: 900, outputTokens: 40 },
      { inputTokens: 300, outputTokens: 20 },
    ]);
    const score = toSimScore({ turnLife, usage, mailsSeeded: 3, mailsDelivered: 2, asksObserved: 1, approvalFrames: 1 });
    expect(score.turns).toBe(2);                    // turn-start 행 수
    expect(score.interrupts).toBe(1);                // 시작만 있고 끝 없는 턴 1
    expect(score.humanQuestions).toBe(1);           // HarnessAskUser 실제 호출 1
    expect(score.inputTokensPerTurn).toBe(600);      // (900+300)/2
    expect(score.processedRequests).toBe(2);
    expect(score.unattemptedRequests).toBe(1);
  } finally { rmE2EUniverse(uni); }
});

test('e2e 점수 → 1차 비교표 재사용 — 같은 표 어휘로 전후 숫자', () => {
  const baseline = e2eScoredRun('mail-flood-30', { turns: 3, inputTokensPerTurn: 1200, unattemptedRequests: 1 });
  const contract = e2eScoredRun('mail-flood-30', { turns: 1, inputTokensPerTurn: 1200, processedRequests: 3 });
  const table = compareRuns([baseline], [contract]);
  const joined = table.join('\n');
  expect(joined).toContain('| mail-flood-30 | 턴 수 | 3 | 1 |');
  expect(joined).toContain('| mail-flood-30 | 미시도 우편 | 1 | 0 |');
  expect(joined).toContain('| mail-flood-30 | 처리 완료(done) | 0 | 3 |');
});

test('정책 프리셋 — 기준선(한 통씩·사람에게 물음) vs 계약(묶음·자결)의 fake-LLM 동작 차이', () => {
  const markers = ['sim-mail-01', 'sim-mail-02', 'sim-mail-03'];
  const baseline = policyPreset(BASELINE_POLICY, 'mail-flood-30', markers);
  const contract = policyPreset({ bundleMail: true, askHuman: false, retryDeferred: true }, 'mail-flood-30', markers);
  expect(baseline.responseRules?.length).toBe(3);
  expect(baseline.responseRules?.[0]!.text).toContain('OPBSE2E_BASELINE_ONE');
  expect(contract.responseRules?.[0]!.text).toContain('OPBSE2E_CONTRACT_BUNDLE');
  const crownBaseline = policyPreset(BASELINE_POLICY, 'crown-question', ['sim-crown-decision']);
  const crownContract = policyPreset({ bundleMail: true, askHuman: false, retryDeferred: true }, 'crown-question', ['sim-crown-decision']);
  expect(crownBaseline.toolCall?.name).toBe('HarnessAskUser');
  expect(crownBaseline.toolCall?.when).toBe('sim-crown-decision');
  expect(crownContract.toolCall).toBeUndefined();
  expect(crownContract.response).toContain('OPBSE2E_CROWN_SELF_DECIDE');
});

// ── 실제 TUI PTY 스테이지(격리 우주 · fake 공급자) ──

test('실제 TUI e2e — 폭주 3통이 도착 경로(벨→노티스→깨움 턴)를 타고 전부 턴에 닿는다(전달 0유실) · 토큰 원장 실측', async () => {
  // r2 실측 교정(17:34): 부팅 전 시드 3통은 관측 기준선에 묻혀 노티스 1개만 나왔다(delivered 1/3) —
  // «폭주 도착» 사고의 정본은 시동 뒤 도착이다(c4 seed7 판: store.post → 깨움 턴 전달, node-b GREEN 2회).
  // 3통을 순차 투입해 각각의 도착→노티스→깨움 턴→모델 요청을 잰다(사람 턴 선행 = 부트레이스 게이트 · 최초 16s = 관측 기준선 안정).
  const uni = createE2EUniverse();
  try {
    const items = incidentSeatItems('mail-flood-30').slice(0, 3);
    const markers = items.map((item) => item.id);
    const postMail = (index: number) => {
      const item = items[index]!;
      const store = new MsgStore(uni.msgDb);
      try { store.post({ from: 'TC', to: uni.seat, body: `${item.title} — ${item.text} [${item.id}]`, intent: 'alert', priority: 100 }); }
      finally { store.close(); }
    };
    const preset = policyPreset(BASELINE_POLICY, 'mail-flood-30', markers);
    let baselineStartedAt = 0;
    const steps: SeatPtyStep[] = [
      { label: 'person first Enter', text: 'opbse2e-person-first',
        until: () => captureIndexOf(uni, 'opbse2e-person-first').found, timeoutMs: 30_000 },
      { label: 'mail baseline (관측 기준선 안정)', timeoutMs: 25_000,
        until: () => { baselineStartedAt ||= Date.now(); return Date.now() - baselineStartedAt >= 16_000; } },
    ];
    markers.forEach((marker, index) => {
      let posted = false;
      steps.push({ label: `flood-mail-${index + 1}`, timeoutMs: 60_000,
        until: () => { if (!posted) { posted = true; postMail(index); } return captureIndexOf(uni, marker).found; } });
    });
    const run = await runE2EStage(uni, preset, { steps });
    expect(run.exitCode).toBe(0);
    const delivered = markers.filter((marker) => captureIndexOf(uni, marker).found).length;
    expect(delivered).toBe(3);
    const usage = await readUsageRows(uni);
    expect(usage.length).toBeGreaterThanOrEqual(3);
    const turnLife = await readTurnLifeRows(uni);
    const score = toSimScore({ turnLife, usage, mailsSeeded: 3, mailsDelivered: 3, asksObserved: 0, approvalFrames: 0 });
    expect(score.turns).toBeGreaterThanOrEqual(3);
    expect(score.inputTokensPerTurn).toBeGreaterThan(0);
    expect(score.unattemptedRequests).toBe(0);
  } finally { rmE2EUniverse(uni); }
}, 240_000);

test('실제 TUI e2e — 좌석 승인 경계: 무인 자리는 자녀가 플래그한 위험 명령을 프롬프트 없이 감사 기록과 함께 자동 승인한다(SEAT-APPROVAL-DEFAULT-ALLOW)', async () => {
  // r4 원인 판명(18:5x): 승인 요청은 자녀(에이전트) 휴리스틱이 플래그한 명령만 부모(TUI)로 올라온다
  // (local-chat-turn.ts isShellApprovalCallMessage · pkill -f 무매치 는 자녀가 플래그하지 않아 그냥 실행됐다 — r4 ✓ Bash 원문).
  // 좌석 모드의 실제 승인 계약 = 자녀가 플래그한 rm -rf 급 명령도 좌석 정책이 default-allow 로
  // 감사 기록(seat.approval auto-approved)과 함께 자동 승인 — 프롬프트 인터럽트 0 이 비좌석 기준선과의 차이다.
  // (프롬프트+기본 Enter 거부 기준선은 선례 entry-shell-approval-pty 가 잰다.) OP 전용 문(ask-op)은
  // 정책 단층에서 별도 실측(seat-approval-policy — pkill·gh pr merge → ask-op)하고, 본 무대에서는
  // «자녀 플래그 ∩ OP_ONLY» 조합이 비어 닿지 않는다 — 0.3.35 실제 공급자 실행(#135500) FU 로 남긴다.
  const uni = createE2EUniverse();
  try {
    const target = join(uni.seatRoot, 'approval-target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'keep.txt'), 'sentinel');
    const command = `rm -rf '${target}'`;
    const preset: FakeLlmPreset = {
      response: 'OPBSE2E_APPROVAL_DONE.',
      toolCall: { when: 'approval fixture', name: 'Bash', args: { command } },
    };
    let approvalSettleStartedAt = 0;
    const run = await runE2EStage(uni, preset, {
      steps: [
        { label: 'auto-approve-run', text: 'approval fixture',
          until: (screen) => screen.includes('Turn done'), timeoutMs: 60_000 },
        // r8 RCA: 크라운 시험의 ask-answer-settle 와 같은 8s 안정 단계 — turn-end 원장 플러시 경합 대기.
        { label: 'approval-ledger-settle', timeoutMs: 15_000,
          until: () => { approvalSettleStartedAt ||= Date.now(); return Date.now() - approvalSettleStartedAt >= 8_000; } },
      ],
    });
    expect(run.exitCode).toBe(0);
    expect(existsSync(join(target, 'keep.txt'))).toBe(false);                       // ① 명령 실행 실측(파일 소멸)
    expect(run.frames.some((frame) => frame.screen.includes('Bash approval'))).toBe(false);  // ② 프롬프트 인터럽트 0
    const approvals = await readSeatApprovalRows(uni);                             // ③ 감사 기록 원장 실측
    const autoApproved = approvals.find((row) => row.event === 'auto-approved');
    expect(autoApproved).toBeDefined();
    expect(JSON.stringify(autoApproved?.data)).toContain('default-allow');
    const score = toSimScore({ turnLife: await readTurnLifeRows(uni), usage: await readUsageRows(uni), mailsSeeded: 0,
      mailsDelivered: 0, asksObserved: 0, approvalFrames: 0 });
    expect(score.interrupts).toBe(0);
    expect(score.humanQuestions).toBe(0);
  } finally { rmE2EUniverse(uni); }
}, 150_000);

test('실제 TUI e2e — 결정급 질문(기준선): 좌석 모드 HarnessAskUser 실제 호출 원장 실측(물음 1)', async () => {
  // r4 실측 교정(17:41): 시드 우편이 사람 턴·깨움 턴에서 두 번 도달해 ask 가 2행이 됐다(received 2) —
  // 이 시험의 목적은 «모델이 결정급 질문을 사람에게 물었다» 는 호출 원장 실측(세션 전사 HarnessAskUser 행 = 1)이므로
  // 시드 없이 사람 턴 입력만으로 단일 ask 를 잰다(우편 도착 경로는 폭주 시험이 잰다). ask 자동완결은 r2 실측.
  const uni = createE2EUniverse();
  try {
    const preset: FakeLlmPreset = {
      response: 'OPBSE2E_CROWN_ASKED.',
      toolCall: { when: 'sim-crown-decision', name: 'HarnessAskUser',
        args: { questions: ['0.3.34 컷 연기 여부 — 되돌릴 수 있는 결정입니다. 연기할까요?'] } },
    };
    // r6 실측 교정(18:5x): ask 자동완결의 답변이 두 번째 턴을 열고, 첫 'Turn done' 직후 무대를 종료하면
    // 그 턴의 turn-end 원장행이 못 쓰여 시작 2·끝 1(interrupts 1)로 측정됐다 — 8s 안정 단계로 흐름 전체와
    // 원장 플러시를 마무리한 뒤 종료한다.
    let askSettleStartedAt = 0;
    const run = await runE2EStage(uni, preset, {
      steps: [
        { label: 'crown-ask-served', text: 'sim-crown-decision',
          until: (screen) => screen.includes('Turn done'), timeoutMs: 60_000 },
        { label: 'ask-answer-settle', timeoutMs: 15_000,
          until: () => { askSettleStartedAt ||= Date.now(); return Date.now() - askSettleStartedAt >= 8_000; } },
      ],
    });
    expect(run.exitCode).toBe(0);
    const sessionFile = readdirSync(join(uni.seatRoot, 'sessions')).find((name) => name.endsWith('.jsonl'));
    if (!sessionFile) throw new Error('missing session transcript');
    const askRows = readFileSync(join(uni.seatRoot, 'sessions', sessionFile), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { toolName?: string })
      .filter((row) => row.toolName === 'HarnessAskUser');
    expect(askRows).toHaveLength(1);
    const score = toSimScore({ turnLife: await readTurnLifeRows(uni), usage: await readUsageRows(uni),
      mailsSeeded: 0, mailsDelivered: 0, asksObserved: askRows.length, approvalFrames: 0 });
    expect(score.humanQuestions).toBe(1);
    expect(score.interrupts).toBe(0);
  } finally { rmE2EUniverse(uni); }
}, 150_000);

// 미사용 가져오기 경고 방지 — E2EUniverse 타입은 스테이지 사양 문서의 노출 타입이다.
export type _E2EUniverseRef = E2EUniverse;
