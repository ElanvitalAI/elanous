#!/usr/bin/env bun
// ── Signal Digest Cycle — 적응형 투자 A3 (2026-07-11) ──────────────────────────
//
// batch 로 라우팅된 신호(권고 watch·routine)를 정규 스케줄에 1회 다이제스트로 모아 발송.
// interrupt(즉시)와 분리 — 신호별 즉시 알림 스팸을 제거하고 아침/장중/마감 배치로 낸다(대표 §0).
//
// ★ shadow 기본(무발송·미소진·미리보기 로그). `--live` 로만 실제 발송+digested 소진.
//   발송 성공분만 소진(실패 시 다음 사이클 재시도). 크론=schedule 도구(3회/일).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { SignalPool } from '../src/domains/signal-pool.js';
import { runDigest, runCommunityBuzzDigest } from '../src/domains/signal-router.js';
import { sendOutbound } from '../src/domains/outbound-alert.js';
import { createDigestPhotoSender } from './signal-digest-photo.js';
import { ensureCronNodePath } from '../src/domains/cron-path.js';
import { unknownCronFlag } from '../src/domains/cron-flag-contract.js';

const unknownFlag = unknownCronFlag(process.argv, { boolean: ['--live'], valued: [] });
if (unknownFlag) {
  console.error(`⛔ 모르는 플래그: ${unknownFlag}`);
  process.exit(1);
}

ensureCronNodePath();

const LOG = join(homedir(), '.elanous/conatus/signal_digest_cycle.log');
const LIVE = process.argv.includes('--live');

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.error(line);
  try { appendFileSync(LOG, line + '\n'); } catch { /* fail-soft */ }
}

async function main(): Promise<void> {
  const pool = new SignalPool();
  try {
    const d = await runDigest(pool, LIVE ? { send: sendOutbound, sendPhoto: createDigestPhotoSender() } : {});
    log(`[${d.mode}] 다이제스트 대기 ${d.count} · 발송 ${d.sent}`);
    if (!LIVE && d.count > 0) {
      log(`  ▶ [digest shadow]\n${d.preview}`);
    }

    // P5 — 커뮤니티 버즈 요약(S2·급증 미만). 라우팅 경로 밖 S2 커뮤니티를 가시화(대표 지시).
    //   read-only·창 기반. shadow 기본, --live 로만 실제 발송.
    const b = runCommunityBuzzDigest(pool, LIVE ? { send: sendOutbound, windowHours: 8 } : { windowHours: 8 });
    log(`[${b.mode}] 커뮤니티 버즈 서사 ${b.count} · 발송 ${b.sent}`);
    if (!LIVE && b.count > 0) {
      log(`  ▶ [buzz shadow]\n${b.preview}`);
    }
  } finally { pool.close(); }
}

try { await main(); } catch (e) { log(`digest 오류: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
