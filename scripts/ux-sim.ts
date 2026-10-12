#!/usr/bin/env bun
// ── 턴 UX 시뮬레이터 CLI ─────────────────────────────────────────────────────
//
// 대표 지시(2026-08-19): *"시뮬레이션을 최대한 효율적으로 하는 mock 을 개발해주세요"*
//
// 사용:
//   bun scripts/ux-sim.ts                          # 전 국면을 한 번에
//   bun scripts/ux-sim.ts streaming --queue 2      # 한 국면 · 큐 2건
//   bun scripts/ux-sim.ts --list                   # 국면 목록
//   bun scripts/ux-sim.ts --esc 3                  # ⭐ 자식 3개가 도는 상태에서 ESC 시나리오
//   bun scripts/ux-sim.ts --computer-use capture-stalls # 브라우저 없이 캡처 매달림 관측
//   bun scripts/ux-sim.ts --computer-use normal --from-run <runId> # 기록 관측을 재생
//   bun scripts/ux-sim.ts --computer-use normal --from-run <runId> --save-trajectory <name> # 이름으로 저장
//   bun scripts/ux-sim.ts --computer-use normal --trajectory <name> # 저장한 궤적을 재생
//   bun scripts/ux-sim.ts --list-trajectories # 저장한 궤적과 출처 목록
//   bun scripts/ux-sim.ts --fault cred-expiry # 결함 주입: grok 구독 만료 임박 × 갱신 결과 → 디스패처·발사 판정
//   bun scripts/ux-sim.ts --fault pod-death   # 결함 주입: PARTIAL 줄을 남긴 Pod 가 SIGTERM 으로 지워짐 → 호스트 재방출 판정
//   bun scripts/ux-sim.ts --fault pool-cap    # 결함 주입: --pod-pool 에 :N 이 빠진 풀 → 승인 판정(limitedBy)
//
// ⛔ 이 CLI 는 «실제 위젯 render()» 를 부른다 — 흉내 렌더러가 아니다.
import { simRenderLogFrame } from '../src/ux-sim/render-frame.js';
import { simTypeaheadState, type TurnPhase, type TurnSimSpec } from '../src/ux-sim/turn-states.js';
import { renderTurnTypeaheadQueueRow, renderTurnTypeaheadEcho } from '../src/chat/turn-typeahead.js';

const PHASES: TurnPhase[] = [
  'idle', 'thinking', 'streaming', 'streaming-with-subagents', 'harness-child', 'interrupted',
];

const argv = process.argv.slice(2);

// ⛔⭐ 모르는 인자를 «조용히 삼키지» 않는다 — 이름을 대고 거부한다.
//
//  🚨 2026-08-27 실측: `--trajectory-list`(오타 · 실제는 `--list-trajectories`)를 쳤더니
//     ***rc=0 · 산출 138행***으로 «전 국면이 그냥 돌았다». 사람은 「그 입구가 없다」를
//     ***영영 모른다*** — 오늘 이 저장소가 같은 함정을 다른 도구에서 이미 한 번 고쳤다.
//  ⛔ 그래서 「알려진 플래그」를 «한 곳»에 두고, 그 밖의 `--` 인자는 거부한다.
const KNOWN_FLAGS = new Set([
  '--list', '--list-trajectories', '--computer-use', '--trajectory', '--from-run',
  '--save-trajectory', '--esc', '--queue', '--width', '--height', '--draft', '--fault',
]);
{
  const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a.split('=')[0]));
  if (unknown.length > 0) {
    console.error(`⛔ 모르는 인자다: ${unknown.join(' ')}`);
    console.error(`   아는 것: ${[...KNOWN_FLAGS].sort().join(' · ')}`);
    console.error('   국면 목록은 --list 로 본다.');
    process.exit(2);
  }
}
if (argv.includes('--list')) { console.log([...PHASES, 'computer-use: normal | capture-stalls | capture-fails | target-missing'].join('\n')); process.exit(0); }

{
  // `--fault=<이름>` 꼴도 받는다 — KNOWN_FLAGS 는 등호 꼴을 통과시키므로 여기서 놓치면 조용히 기본 국면으로 빠진다.
  const eq = argv.find((a) => a.startsWith('--fault='));
  if (eq) argv.splice(argv.indexOf(eq), 1, '--fault', eq.slice('--fault='.length));
}
if (argv.includes('--fault')) {
  const fault = argv[argv.indexOf('--fault') + 1];
  if (fault === 'cred-expiry') {
    const { credExpirySweep, renderCredExpiry } = await import('../src/ux-sim/fault-cred-expiry.js');
    console.log(renderCredExpiry(credExpirySweep()).join('\n'));
    process.exit(0);
  }
  if (fault === 'pod-death') {
    const { simPodDeath, renderPodDeath } = await import('../src/ux-sim/fault-pod-death.js');
    console.log(renderPodDeath(simPodDeath()).join('\n'));
    process.exit(0);
  }
  if (fault === 'pool-cap') {
    const { poolCapSweep, renderPoolCap } = await import('../src/ux-sim/fault-pool-cap.js');
    console.log(renderPoolCap(poolCapSweep()).join('\n'));
    process.exit(0);
  }
  console.error(`⛔ 모르는 결함이다: ${fault ?? '(없음)'} — 아는 것: cred-expiry · pod-death · pool-cap`);
  process.exit(2);
}

if (argv.includes('--list-trajectories')) {
  const { listSavedBrowserActionTrajectories } = await import('../src/harness/browser-trajectory.js');
  const saved = listSavedBrowserActionTrajectories();
  if (saved.length === 0) console.log('(저장한 브라우저 궤적 없음)');
  for (const entry of saved) console.log(`${entry.name}\trunId=${entry.source.runId}\tsavedAt=${entry.savedAt}\tsteps=${entry.trajectory.length}`);
  process.exit(0);
}

if (argv.includes('--computer-use')) {
  const { simComputerUse } = await import('../src/ux-sim/computer-use.js');
  const scenario = argv[argv.indexOf('--computer-use') + 1] ?? 'normal';
  if (!['normal', 'capture-stalls', 'capture-fails', 'target-missing'].includes(scenario)) {
    console.error(`unknown computer-use scenario: ${scenario}`);
    process.exit(2);
  }
  const { readBrowserActionTrajectory, readSavedBrowserActionTrajectory, saveBrowserActionTrajectory } = await import('../src/harness/browser-trajectory.js');
  const optionValue = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index < 0) return undefined;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      console.error(`${flag} requires a name`);
      process.exit(2);
    }
    return value;
  };
  const requestedRunId = optionValue('--from-run');
  const requestedName = optionValue('--trajectory');
  const saveName = optionValue('--save-trajectory');
  if (requestedRunId !== undefined && requestedName !== undefined) {
    console.error('choose exactly one trajectory source: --from-run or --trajectory');
    process.exit(2);
  }
  if (saveName !== undefined && requestedRunId === undefined) {
    console.error('--save-trajectory requires --from-run');
    process.exit(2);
  }
  let trajectory: readonly { target: string; coordinates: { x: number; y: number } }[] | undefined;
  let simulationRunId: string | undefined;
  if (requestedName !== undefined) {
    try {
      const saved = readSavedBrowserActionTrajectory(requestedName);
      trajectory = saved.trajectory;
      simulationRunId = saved.source.runId;
      console.log(`저장 궤적                     ${saved.name} (runId=${saved.source.runId}; savedAt=${saved.savedAt})`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else if (requestedRunId !== undefined) {
    const replay = readBrowserActionTrajectory(requestedRunId);
    if (replay.status !== 'ready') {
      console.error(`no replayable browser actions for runId ${requestedRunId} (${replay.status}; observed=${replay.observedRows})`);
      process.exit(1);
    }
    trajectory = replay.trajectory;
    simulationRunId = replay.runId;
    if (saveName !== undefined) {
      const saved = saveBrowserActionTrajectory(saveName, replay);
      console.log(`저장 궤적                     ${saved.name} (runId=${saved.source.runId}; savedAt=${saved.savedAt})`);
    }
  }
  const result = await simComputerUse({
    scenario: scenario as 'normal' | 'capture-stalls' | 'capture-fails' | 'target-missing',
    trajectory: trajectory ?? [{ target: '#ux-sim-target', coordinates: { x: 320, y: 180 } }],
    captureTimeoutMs: 20,
    runId: simulationRunId ?? 'ux-sim-cli',
    personaId: 'ux-sim-persona',
  });
  const lastObservation = result.observations.at(-1);
  const lastAction = result.actions.at(-1);
  console.log(`\n\x1b[1m━━ 컴퓨터 유즈 · ${result.scenario} ━━\x1b[0m`);
  console.log(`  관측한 궤적                  ${result.observations.map(observation => observation.target).join(' → ') || '(관측 전 실패)'}`);
  console.log(`  좌표                         ${lastObservation?.coordinates ? `${lastObservation.coordinates.x}, ${lastObservation.coordinates.y}` : '(관측 전 실패)'}`);
  console.log(`  화면참조(attachmentRef)      ${lastObservation?.attachmentRef ?? '(없음)'}`);
  console.log(`  captureOutcome               ${result.captureOutcome}`);
  console.log(`  runId                        ${lastObservation?.runId ?? '(없음)'}`);
  console.log(`  personaId                    ${lastObservation?.personaId ?? '(없음)'}`);
  console.log(`  귀속(attribution)            ${result.attribution.status === 'not-observed' ? '(관측 전 실패 · not-observed)' : `${result.attribution.attribution.kind} · ${result.attribution.attribution.entryPoint}`}`);
  console.log(`  디스패처 결과                ${lastAction?.ok ? 'ok' : `${lastAction?.reason ?? 'none'}: ${lastAction?.error ?? ''}`}`);
  process.exit(0);
}

// ── ⭐ ESC 시나리오 — 라이브에선 「자식이 도는 순간」을 잡느라 판당 3~5분이 들었다 ──
if (argv.includes('--esc')) {
  const { simEscGate } = await import('../src/ux-sim/interaction.js');
  const children = Number(argv[argv.indexOf('--esc') + 1]) || 0;
  const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(28)} ${String(value)}`);
  console.log(`\n\x1b[1m━━ ESC 시나리오 · 도는 자식 ${children}개 ━━\x1b[0m`);

  const s = simEscGate({ runningChildren: children });
  s.esc();
  line('ESC ① → 모달이 떴나', s.isOpen() ? '✅ 예' : '⛔ 아니오(즉시 중단 경로)');
  line('ESC ① → 턴이 죽었나', s.abortCtrl.signal.aborted ? '✅ 예' : '아직');
  if (s.isOpen()) {
    s.esc();
    await s.settle();
    line('ESC ② → 턴이 죽었나', s.abortCtrl.signal.aborted ? '✅ 예 (A2)' : '⛔ 아니오 — 연타로 안 죽는다');
  }
  await s.settle();
  line('취소의 «뜻»', s.abortReason() ?? '(없음)');
  line('자식 핸드오프 호출', `${s.handoffCalls}회 (R4a · 고아 방지)`);

  const keep = simEscGate({ runningChildren: Math.max(1, children) });
  keep.esc(); keep.key('n'); await keep.settle();
  line('`n` 철회 → 턴이 사나', keep.abortCtrl.signal.aborted ? '⛔ 죽었다' : '✅ 산다');
  line('`n` 철회 → 핸드오프', `${keep.handoffCalls}회 (0이어야 한다)`);
  process.exit(0);
}

const nArg = (flag: string, dflt: number): number => {
  const i = argv.indexOf(flag);
  if (i < 0) return dflt;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) ? n : dflt;
};
const queuedCount = nArg('--queue', 0);
const width = nArg('--width', 120);
const height = nArg('--height', 18);
const picked = argv.find((a) => (PHASES as string[]).includes(a)) as TurnPhase | undefined;
const phases = picked ? [picked] : PHASES;

for (const phase of phases) {
  const spec: TurnSimSpec = {
    phase,
    children: 2,
    queued: Array.from({ length: queuedCount }, (_, i) => `대기 발화 ${i + 1}`),
    ...(argv.includes('--draft') ? { draft: '치던 중' } : {}),
  };
  const ta = simTypeaheadState(spec);
  const queueRow = renderTurnTypeaheadQueueRow(ta, width - 6);
  const frame = simRenderLogFrame(spec, {
    width, height,
    ...(queueRow ? { extraState: { queueRow } } : {}),
  });
  console.log(`\n\x1b[1m━━ ${phase}${queuedCount ? ` · 큐 ${queuedCount}건` : ''} ━━\x1b[0m`);
  console.log(frame.text);
  console.log(`\x1b[2m  [컴포저 에코] ❯ ${renderTurnTypeaheadEcho(ta, width - 4)}\x1b[0m`);
  console.log(`\x1b[2m  [큐 행 공급값] ${queueRow ?? '(없음)'}\x1b[0m`);
  console.log(`\x1b[2m  [큐 행이 프레임에 «보이나»] ${queueRow && frame.text.includes(queueRow.slice(0, 12)) ? '✅ 예' : '⛔ 아니오'}\x1b[0m`);
}
