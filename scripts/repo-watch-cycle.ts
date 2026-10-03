#!/usr/bin/env bun
// ── Autopilot repo watching 실배선 (P1.3 · 2026-07-08) ────────────────────
//
// 참조 에이전트 repo(hermes/openclaw/codex) 주기 감시 → 새 커밋 → 흡수 제안 리포트.
// triage 라우터(P1.1)의 scheduler 실행모델 첫 실사례. READ-ONLY(gh api 조회만).
// cron 등록: schedule_manage(대표 arming). 로그: ~/.elanous/conatus/repo_watch.log.

import { runRepoWatchCycle } from '../src/autopilot/repo-watch.js';
import { recordAutonomousActionSafe } from '../src/domains/autonomy-log.js';
import { sendOutbound } from '../src/domains/outbound-alert.js';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// 크론 최소 PATH엔 gh(homebrew/PATH) 없을 수 있음 → nvm/homebrew bin 주입.
import { ensureCronNodePath } from '../src/domains/cron-path.js';
ensureCronNodePath();

const LOG = join(homedir(), '.elanous/conatus/repo_watch.log');
function log(s: string): void {
  const stamp = `${new Date().toISOString()} ${s}`;
  console.log(s);
  try { if (!existsSync(dirname(LOG))) mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, `${stamp}\n`); } catch { /* */ }
}

const results = runRepoWatchCycle({
  // 흡수 제안 리포트 발송(report 채널 · 야간무음 게이트 · fail-soft).
  notify: (report) => { try { log(`발송 ${sendOutbound(report, 'ops-report') ? 'OK' : '실패'}`); } catch (e) { log(`발송 오류: ${e instanceof Error ? e.message : String(e)}`); } },
  // 자율행동 회상 기록(loop=autopilot).
  record: (input) => { recordAutonomousActionSafe({ loop: 'autopilot', ...input }); },
});

const total = results.reduce((s, r) => s + r.newCommits, 0);
log(`repo-watch: ${results.map(r => `${r.key}=${r.newCommits}`).join(' ')} · 총 새커밋 ${total}`);
console.log(JSON.stringify(results, null, 2));
