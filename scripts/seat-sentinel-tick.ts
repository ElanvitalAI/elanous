#!/usr/bin/env bun
// SEAT-IDLE-STALL-SENTINEL — 틱 한 번(관측 → 판정 → 사건 · 처방은 기본 제안만). 상주하지 않는다.
//   bun scripts/seat-sentinel-tick.ts [--json]
// 실행(깨움·«계속» 입력)은 ELANOUS_SEAT_SENTINEL_ACTUATE=1 일 때만이고, 기본은 꺼짐(그림자).
// 1분 일정은 이 칸에서 등록하지 않는다 — 그래프 러너 루프로 감싸는 후속 칸(src/seat-loop/seat-sentinel-tick.ts 머리말).
import { runSeatSentinelTick } from '../src/seat-loop/seat-sentinel-tick.js';

const json = process.argv.includes('--json');
const tick = await runSeatSentinelTick();
if (json) {
  process.stdout.write(JSON.stringify(tick) + '\n');
} else {
  const findings = tick.results.filter((row) => row.verdict !== 'ok');
  process.stdout.write(`seat-sentinel ${tick.at} · ${tick.actuate ? 'live' : 'shadow'} · seats ${tick.results.length} · findings ${findings.length}\n`);
  for (const row of findings)
    process.stdout.write(`  ${row.seat.padEnd(12)} ${row.verdict.padEnd(11)} → ${row.prescription} (${row.reason})\n`);
}
