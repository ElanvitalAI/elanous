#!/usr/bin/env bun
// ── 기억 생애주기 회고 루프 (REM/미엘린) · 새벽 idle 크론 · 2026-07-10 ─────────
//
// 대표 지적: 세션 대량 정비 후 회고 루프가 전혀 안 돌았다 — M1-M5 기억 생애주기 코드는
// 있으나 스케줄 배선이 없었다. 이 스크립트가 그 루프를 복구한다(decay→consolidate→
// archive→prune·전 단계 arm·대표 승인). 새벽 수면창(idle)에 1회.
//   등록: elanous schedule create --cron '0 3 * * *' --command 'scripts/memory-lifecycle-cycle.ts'

import { ensureCronNodePath } from '../src/domains/cron-path.js';
ensureCronNodePath();

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openSurfaceEventsDb, pruneStaleEvents } from '../src/domains/surface-events.js';
import { calibrateStabilityDays, decayWithEffectCounts, measureStabilityAges, type DecayEffectCounts, type StabilityFn } from '../src/domains/memory-stability-calibration.js';
import { activeRecallReplay } from '../src/domains/memory-replay.js';
import { retrievalInducedForgetting } from '../src/domains/memory-rif.js';
import { debug } from '../src/debug/log.js';
import { openKnowledgeDb, defaultEmbed, pruneKnowledge } from '../src/domains/knowledge.js';
import { getUserConfig } from '../src/user-config.js';
import { promoteSessionRecaps, consolidateEpisodes } from '../src/domains/memory-consolidate.js';
import { ensureArchiveTable, archiveColdEvents, type ArchiveS3Deps } from '../src/domains/memory-archive.js';
import { runMemoryLifecycle, summarizeLifecycle, runAllCleanups } from '../src/domains/memory-lifecycle.js';
import { recordAutonomousActionSafe } from '../src/domains/autonomy-log.js';
import { sendOutbound } from '../src/domains/outbound-alert.js';

const LOG = join(homedir(), '.elanous/conatus/memory_lifecycle.log');
function log(s: string): void {
  console.log(s);
  try { if (!existsSync(dirname(LOG))) mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`); } catch { /* */ }
}

async function main(): Promise<void> {
  // 관측 — cron-run 래퍼의 logs.db 싱크는 «래퍼 프로세스» 에만 붙는다(자식은 별도 프로세스).
  //   이 자식이 스스로 싱크를 달아야 debug.log('memory.lifecycle') 가 logs.db 에 남는다(fail-open).
  let offSink: (() => void) | null = null;
  try {
    const { registerLogStoreSink, setLogInstanceName } = await import('../src/mss/logging/log-store.js');
    const lc = getUserConfig().logs;
    setLogInstanceName(lc.instanceName);
    offSink = registerLogStoreSink((s) => debug.registerSink(s), 'scheduler', lc.retention);
  } catch { /* fail-open */ }
  log('=== memory-lifecycle 시작 (REM/미엘린 회고 루프) ===');
  // ★ 오프라인 가짜 어댑터 주입 seam (JUD-B #120295 · OP #120302 — #39418 보안 HOLD 이행 · 2026-11-21).
  //   ELANOUS_CYCLE_OFFLINE=<dir> 설정 시 실 S3(aws cli)·임베딩(LLM)·발송 어댑터를 «구성조차 하지
  //   않고» 오프라인 가짜로 먼저 주입한다(시뮬 장치 먼저). 가짜 호출은 <dir>/offline-adapter-ledger.json
  //   에 남는다 — 실 사이클·SQLite 단언은 그대로 두고 «실제 외부 호출 0» 을 원문으로 증명하는 장치.
  //   env 미설정 시 현행 동작 그대로(실 default 어댑터 — 크론 실환경).
  const offlineDir = process.env.ELANOUS_CYCLE_OFFLINE;
  let offlineArchive: ArchiveS3Deps | undefined;
  let offlineEmbed: typeof defaultEmbed | undefined;
  let offlineSend: ((text: string, kind: string) => boolean) | undefined;
  if (offlineDir) {
    try { mkdirSync(offlineDir, { recursive: true }); } catch { /* 원장 dir 생성 실패 → flush 도 try 안 */ }
    const ledger = { archive: { available: 0, put: 0, get: 0 }, embed: 0, outbound: 0, messages: [] as string[] };
    const flush = (): void => {
      try { writeFileSync(join(offlineDir, 'offline-adapter-ledger.json'), JSON.stringify(ledger)); } catch { /* */ }
    };
    offlineArchive = {
      available: () => { ledger.archive.available++; flush(); return true; },  // 오프라인 가짜 — 이관 경로를 실측하게 항상 사용 가능
      put: () => { ledger.archive.put++; flush(); },                          // 본문은 가짜 원장만 — 실 S3(aws cli) 0호출
      get: () => { ledger.archive.get++; flush(); return null; },
    };
    offlineEmbed = async () => { ledger.embed++; flush(); return { vector: new Float32Array(0), model: 'offline-fake' }; };
    offlineSend = (text, kind) => { ledger.outbound++; ledger.messages.push(`${kind}: ${text}`); flush(); return true; };
  }
  // 싱크 등록 뒤 «전 경로» 를 한 try 로 감싼다 — DB open·본 작업·close 어디서 던져도 finally 가 싱크를 해제한다.
  let sdb: ReturnType<typeof openSurfaceEventsDb> | null = null;
  let kdb: ReturnType<typeof openKnowledgeDb> | null = null;
  let effect: Record<string, number | null> | undefined;
  try {
    const db = (sdb = openSurfaceEventsDb());
    const kn = (kdb = openKnowledgeDb());
    ensureArchiveTable(db);
    // ★ M1 stability 보정 노드(2026-11-21 · MEM-STABILITY-DAYS-CALIBRATION) — ≈22일 승격 기준을
    //   이벤트 나이 실측 분포로 재보정하고(보정 근거 표 로그) 그 곡선을 decay 에 적용.
    //   보정 실패는 fail-soft(기본 곡선 stabilityDays) — 사이클은 무관하게 진행.
    let calibratedStability: StabilityFn | undefined;
    // ★ M1 효과 수치는 decay 경계(decay 직전/직후 같은 행 집합)로만 집계한다(JUD HOLD 2026-11-21).
    //   replay 전 스냅샷 + 전체 사이클 뒤 대조는 RIF 의 tier 변경이 섞이고 archive/prune 으로
    //   사라진 행은 빠져 decay 효과를 왜곡한다. decay thunk 안에서 경계 수치를 저장한다.
    let decayEffects: DecayEffectCounts | undefined;
    try {
      const calibration = calibrateStabilityDays(measureStabilityAges(db));
      calibratedStability = calibration.stability;
      log(`[M1 보정] source=${calibration.source} · λ=${calibration.lambda} · 표본 ${calibration.measured.events}(회상 ${calibration.measured.recalledEvents})`);
      for (const r of calibration.rationale) log(`  [M1 보정 근거] ${r.row} | 관측 ${r.observed} | 판정 ${r.decision}`);
      debug.log('memory.lifecycle', 'stability-calibration', { source: calibration.source, lambda: calibration.lambda, measured: calibration.measured });
    } catch (e) { log(`M1 보정 오류(기본 곡선): ${e instanceof Error ? e.message : String(e)}`); }
    const report = await runMemoryLifecycle({
      replay: () => activeRecallReplay(db),                                // 축B 활동의존 replay(decay 前·중요/신규 강화)
      decay: () => {                                                      // M1 tier 재계산(강등만·보정 곡선) — 경계 효과 수치 동시 저장
        const r = decayWithEffectCounts(db, { stability: calibratedStability });
        decayEffects = r.effects;
        return r.decay;
      },
      rif: () => retrievalInducedForgetting(db),                          // 축B RIF 경쟁 억제(decay 後·archive 前)
      recaps: () => promoteSessionRecaps(db),                             // M4 세션 recap(증분 consolidated=0)
      consolidate: () => consolidateEpisodes(db, kn, { embed: offlineEmbed ?? defaultEmbed }), // M3 에피소드 umbrella
      archive: () => archiveColdEvents(db, offlineArchive),              // M2 Glacier(cold→S3·복원가능)
      pruneEvents: () => pruneStaleEvents(db),                           // 오래+안중요+미회상만
      pruneKnowledge: () => pruneKnowledge(kn),
    });
    const summary = summarizeLifecycle(report);
    log(`결과: ${summary}`);
    for (const e of report.errors) log(`  단계오류 ${e.stage}: ${e.error}`);

    // ★ M1 효과 수치 노드 — decay 경계(decay 직전/직후 같은 행 집합)의 승격·강등·보존 건수.
    //   decay thunk 안에서 저장된 경계 수치만 쓴다 — 전체 사이클 뒤 대조가 아니다(JUD HOLD 2026-11-21).
    if (decayEffects) {
      log(`[M1 효과 수치] 승격 ${decayEffects.promoted} · 강등 ${decayEffects.demoted} · 보존 ${decayEffects.retained}`);
      debug.log('memory.lifecycle', 'decay-effect', decayEffects);
    } else {
      log('[M1 효과 수치] decay 미실행(실패) — 경계 집계 없음');
    }

    // ★ Layer1 회고 조정 sweep(C4·2026-07-18) — 완료됐지만 mission.retro 각인이 없는 미션을
    //   backfill 회고(C1 안착 + C2 피드백). 미션 완료훅 무결합·reconciliation 패턴으로 회고 루프를
    //   닫는다(미션 완료 다음 사이클에 자기치유). config missionRetroSweep=false 면 skip(기본 ON·읽기+각인만).
    const retroSweepCfg = getUserConfig().raw?.autopilot as { missionRetroSweep?: unknown } | undefined;
    if (retroSweepCfg?.missionRetroSweep !== false) {
      try {
        const { sweepMissionRetrospectives } = await import('../src/autopilot/mission-retrospect.js');
        const sweep = await sweepMissionRetrospectives({ db });
        log(`미션 회고 sweep: 신규 각인 ${sweep.retrospected.length}·skip ${sweep.skipped}(scan ${sweep.scanned})`);
      } catch (e) { log(`미션 회고 sweep 오류: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // ★ Layer2 Taste D2 — surface_events(kind:'taste') → knowledge.db(kind:'taste') 임베딩
    //   미러(관측→모델·계획서 §9#2). 매일 sdb+kdb 열린 이 루프가 주기 sync 최적 지점. config
    //   OFF(taste 미수집)면 no-op. 실패는 fail-soft(기억 루프 무차단).
    if (getUserConfig().taste?.captureEnabled) {
      try {
        const { syncTasteVectors } = await import('../src/domains/taste-model.js');
        const ts = await syncTasteVectors({ surfaceDb: db, knowledgeDb: kn, embed: offlineEmbed ?? defaultEmbed });
        log(`taste 벡터 sync: 신규 ${ts.embedded}·skip ${ts.skipped}`);

        // ★ P6 능동 제안 gate — sync 직후 창발 테마 제안(config proposeEnabled 게이트·기본 OFF).
        //   ★ gate 는 제안만 — 미션 생성/승인은 대표(HITL). 신규 제안을 텔레그램(report)으로 표면화.
        if (getUserConfig().taste?.proposeEnabled) {
          const { runProposalGate } = await import('../src/domains/taste-propose.js');
          const proposals = runProposalGate({ surfaceDb: db, knowledgeDb: kn });
          if (proposals.length) {
            const body = proposals.map((p, i) => `${i + 1}. ${p.label} (강도 ${p.score.toFixed(2)})\n   ${p.rationale}`).join('\n\n');
            const msg = `💡 taste 제안 ${proposals.length}건 — 반복 관심에서 창발한 미션 후보입니다.\n(제안일 뿐 미션 생성 아님 · 승인/기각: \`/taste approve <테마>\` · \`/taste reject <테마>\`)\n\n${body}`;
            try { (offlineSend ?? sendOutbound)(msg, 'ops-report'); } catch (e) { log(`taste 제안 발송 오류: ${e instanceof Error ? e.message : String(e)}`); }
            log(`taste 제안 표면화: ${proposals.length}건`);
          }
        }
      } catch (e) { log(`taste sync/제안 오류: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // A failed stage is unknown, not a measured zero. No promotion-candidate count is available yet.
    effect = {
      replayStrengthened: report.replay?.strengthened ?? null,
      decayChanged: report.decay?.changed ?? null,
      hot: report.decay?.hot ?? null,
      warm: report.decay?.warm ?? null,
      cold: report.decay?.cold ?? null,
      consolidated: report.consolidate?.consolidated ?? null,
      archived: report.archive?.archived ?? null,
      prunedEvents: report.prunedEvents,
      promotionCandidates: null,
      errors: report.errors.length,
    };
    // 제1원칙 — 사이클을 logs.db 로 관측(현재 console.log 만 → `elanous logs --category memory.lifecycle`).
    try {
      debug.log('memory.lifecycle', 'cycle', { summary, ...effect });
    } catch { /* fail-open */ }

    // 회고 요약 발송(report 채널·야간무음 게이트) — 실제 뭔가 정리됐을 때만.
    const changed = (report.recaps?.promoted ?? 0) + (report.consolidate?.consolidated ?? 0)
      + (report.archive?.archived ?? 0) + (report.prunedEvents ?? 0);
    if (changed > 0) {
      try { (offlineSend ?? sendOutbound)(`🧠 기억 회고(새벽) — ${summary}`, 'ops-report'); } catch (e) { log(`발송 오류: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // 자율행동 회상 로깅(autopilot P0.2) — 회고 루프도 자율행동.
    recordAutonomousActionSafe({
      loop: 'replay', // 기억 리플레이(REM/미엘린) 루프

      action: '기억 생애주기 1 사이클(decay·consolidate·archive·prune)',
      rationale: '세션/기억/로그 증분 회고 — 흐린 기억 압축·cold 이관·stale 정리(미엘린/중요 보존)',
      outcome: summary,
      refs: { log: LOG },
    });
    log('=== memory-lifecycle 완료 ===');
  } finally {
    // open/close/해제 각각 독립 — 하나가 던져도 나머지는 끝까지 돈다.
    const errs = runAllCleanups([
      { name: 'close-surface-db', fn: () => sdb?.close() },
      { name: 'close-knowledge-db', fn: () => kdb?.close() },
      { name: 'unregister-sink', fn: () => offSink?.() },
    ]);
    for (const e of errs) log(`정리 오류 ${e.stage}: ${e.error}`);
  }
  // Graph consumers read the last line after cleanup; cleanup diagnostics must not follow it.
  if (effect) console.log(JSON.stringify(effect));
}

main().catch((e) => { log(`치명 오류: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
