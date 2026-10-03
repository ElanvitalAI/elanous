#!/usr/bin/env bun
/**
 * tree-sync 가 연속으로 «판정 불가»일 때 사람에게 한 번 알린다 — `scripts/tree-sync-apply.sh` 가 부른다.
 *   bun scripts/tree-sync-alert.ts <트리> <연속 횟수> <판정기 출력>
 * 🩸 계기(2026-09-24): pilot 이 지워진 기능 브랜치에 남아 sync 가 멈췄고, 그 트리에서 도는 크론이 21커밋 낡은 코드로 돌았다 — 아무도 몰랐다.
 * 발송은 기존 `sendOutbound`(야간 무음 규칙 포함) — 새 발송 경로를 만들지 않는다.
 */
import { sendOutbound } from '../src/domains/outbound-alert.js';

export function renderTreeSyncAlert(tree: string, streak: number, decision: string): string {
  return [
    `⚠️ **pilot 트리 동기화가 ${streak}회 연속 멈췄습니다** — 이 트리에서 도는 크론이 낡은 코드로 돌고 있을 수 있습니다.`,
    '',
    `트리: \`${tree}\``,
    `판정: \`${decision.slice(0, 300)}\``,
    '',
    `확인: \`git -C ${tree} branch --show-current\` (main 이어야 한다) · \`tail /tmp/tree-sync-apply.log\``,
  ].join('\n');
}

if (import.meta.main) {
  const [tree = '', streak = '0', decision = ''] = process.argv.slice(2);
  const ok = sendOutbound(renderTreeSyncAlert(tree, Number(streak) || 0, decision), 'ops-alert');
  process.exit(ok ? 0 : 1);
}
