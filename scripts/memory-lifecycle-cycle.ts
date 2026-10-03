#!/usr/bin/env bun
// ── 기억 생애주기 회고 루프 (REM/미엘린) · 새벽 idle 크론 · 2026-07-10 ─────────
//
// 대표 지적: 세션 대량 정비 후 회고 루프가 전혀 안 돌았다 — M1-M5 기억 생애주기 코드는
// 있으나 스케줄 배선이 없었다. 이 스크립트가 그 루프를 복구한다(decay→consolidate→
// archive→prune·전 단계 arm·대표 승인). 새벽 수면창(idle)에 1회.
//   등록: elanous schedule create --cron '0 3 * * *' --command 'scripts/memory-lifecycle-cycle.ts'

import { ensureCronNodePath } from '../src/domains/cron-path.js';
ensureCronNodePath();

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openSurfaceEventsDb, applyMemoryDecay, pruneStaleEvents } from '../src/domains/surface-events.js';
import { activeRecallReplay } from '../src/domains/memory-replay.js';
import { retrievalInducedForgetting } from '../src/domains/memory-rif.js';
import { debug } from '../src/debug/log.js';
import { openKnowledgeDb, defaultEmbed, pruneKnowledge } from '../src/domains/knowledge.js';
import { getUserConfig } from '../src/user-config.js';
import { promoteSessionRecaps, consolidateEpisodes } from '../src/domains/memory-consolidate.js';
import { ensureArchiveTable, archiveColdEvents } from '../src/domains/memory-archive.js';
import { runMemoryLifecycle, summarizeLifecycle } from '../src/domains/memory-lifecycle.js';
import { recordAutonomousActionSafe } from '../src/domains/autonomy-log.js';
import { sendOutbound } from '../src/domains/outbound-alert.js';

const LOG = join(homedir(), '.elanous/conatus/memory_lifecycle.log');
function log(s: string): void {
  console.log(s);
  try { if (!existsSync(dirname(LOG))) mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`); } catch { /* */ }
}

async function main(): Promise<void> {
  log('=== memory-lifecycle 시작 (REM/미엘린 회고 루프) ===');
  const sdb = openSurfaceEventsDb();
  const kdb = openKnowledgeDb();
  ensureArchiveTable(sdb);
  try {
    const report = await runMemoryLifecycle({
      replay: () => activeRecallReplay(sdb),                                // 축B 활동의존 replay(decay 前·중요/신규 강화)
      decay: () => applyMemoryDecay(sdb),                                   // M1 tier 재계산(강등만)
      rif: () => retrievalInducedForgetting(sdb),                          // 축B RIF 경쟁 억제(decay 後·archive 前)
      recaps: () => promoteSessionRecaps(sdb),                             // M4 세션 recap(증분 consolidated=0)
      consolidate: () => consolidateEpisodes(sdb, kdb, { embed: defaultEmbed }), // M3 에피소드 umbrella
      archive: () => archiveColdEvents(sdb),                              // M2 Glacier(cold→S3·복원가능)
      pruneEvents: () => pruneStaleEvents(sdb),                           // 오래+안중요+미회상만
      pruneKnowledge: () => pruneKnowledge(kdb),
    });
    const summary = summarizeLifecycle(report);
    log(`결과: ${summary}`);
    for (const e of report.errors) log(`  단계오류 ${e.stage}: ${e.error}`);

    // ★ Layer1 회고 조정 sweep(C4·2026-07-18) — 완료됐지만 mission.retro 각인이 없는 미션을
    //   backfill 회고(C1 안착 + C2 피드백). 미션 완료훅 무결합·reconciliation 패턴으로 회고 루프를
    //   닫는다(미션 완료 다음 사이클에 자기치유). config missionRetroSweep=false 면 skip(기본 ON·읽기+각인만).
    const retroSweepCfg = getUserConfig().raw?.autopilot as { missionRetroSweep?: unknown } | undefined;
    if (retroSweepCfg?.missionRetroSweep !== false) {
      try {
        const { sweepMissionRetrospectives } = await import('../src/autopilot/mission-retrospect.js');
        const sweep = await sweepMissionRetrospectives({ db: sdb });
        log(`미션 회고 sweep: 신규 각인 ${sweep.retrospected.length}·skip ${sweep.skipped}(scan ${sweep.scanned})`);
      } catch (e) { log(`미션 회고 sweep 오류: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // ★ Layer2 Taste D2 — surface_events(kind:'taste') → knowledge.db(kind:'taste') 임베딩
    //   미러(관측→모델·계획서 §9#2). 매일 sdb+kdb 열린 이 루프가 주기 sync 최적 지점. config
    //   OFF(taste 미수집)면 no-op. 실패는 fail-soft(기억 루프 무차단).
    if (getUserConfig().taste?.captureEnabled) {
      try {
        const { syncTasteVectors } = await import('../src/domains/taste-model.js');
        const ts = await syncTasteVectors({ surfaceDb: sdb, knowledgeDb: kdb, embed: defaultEmbed });
        log(`taste 벡터 sync: 신규 ${ts.embedded}·skip ${ts.skipped}`);

        // ★ P6 능동 제안 gate — sync 직후 창발 테마 제안(config proposeEnabled 게이트·기본 OFF).
        //   ★ gate 는 제안만 — 미션 생성/승인은 대표(HITL). 신규 제안을 텔레그램(report)으로 표면화.
        if (getUserConfig().taste?.proposeEnabled) {
          const { runProposalGate } = await import('../src/domains/taste-propose.js');
          const proposals = runProposalGate({ surfaceDb: sdb, knowledgeDb: kdb });
          if (proposals.length) {
            const body = proposals.map((p, i) => `${i + 1}. ${p.label} (강도 ${p.score.toFixed(2)})\n   ${p.rationale}`).join('\n\n');
            const msg = `💡 taste 제안 ${proposals.length}건 — 반복 관심에서 창발한 미션 후보입니다.\n(제안일 뿐 미션 생성 아님 · 승인/기각: \`/taste approve <테마>\` · \`/taste reject <테마>\`)\n\n${body}`;
            try { sendOutbound(msg, 'ops-report'); } catch (e) { log(`taste 제안 발송 오류: ${e instanceof Error ? e.message : String(e)}`); }
            log(`taste 제안 표면화: ${proposals.length}건`);
          }
        }
      } catch (e) { log(`taste sync/제안 오류: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // 제1원칙 — 사이클을 logs.db 로 관측(현재 console.log 만 → `elanous logs --category memory.lifecycle`).
    try {
      debug.log('memory.lifecycle', 'cycle', {
        summary,
        replayStrengthened: report.replay?.strengthened ?? 0,
        consolidated: report.consolidate?.consolidated ?? 0,
        archived: report.archive?.archived ?? 0,
        errors: report.errors.length,
      });
    } catch { /* fail-open */ }

    // 회고 요약 발송(report 채널·야간무음 게이트) — 실제 뭔가 정리됐을 때만.
    const changed = (report.recaps?.promoted ?? 0) + (report.consolidate?.consolidated ?? 0)
      + (report.archive?.archived ?? 0) + (report.prunedEvents ?? 0);
    if (changed > 0) {
      try { sendOutbound(`🧠 기억 회고(새벽) — ${summary}`, 'ops-report'); } catch (e) { log(`발송 오류: ${e instanceof Error ? e.message : String(e)}`); }
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
  } finally { sdb.close(); kdb.close(); }
}

main().catch((e) => { log(`치명 오류: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
