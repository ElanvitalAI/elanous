#!/usr/bin/env bash
# ── Codex CLI notify hook — 손(hand) progress 전달 (HAND-HOOKS-NEXUS-STATUS · 2026-10-30) ──
#
# OP #54582 승인 · TC #54571 계약 기반. Codex notify 실행 시 알림 JSON 을 기존 계약
# `POST /v1/missions/{missionId}/line`(src/agent-mission/mission-line.ts · postMissionLineEvent)로
# **type:progress** 한 건만 보낸다. final 은 명시적 `mission reply --done` 전용,
# ask/answer/correct 는 예약 — 이 훅은 progress 만 보낸다.
#
# 인증: missionId+attemptId+손별 Bearer. token 은 child env 에만 둔다:
#   ELANOUS_HAND_TOKEN  — 손별 Bearer token(인자·파일 저장 금지)
#   ELANOUS_MISSION_ID · ELANOUS_ATTEMPT_ID — 현재 미션/시도
#   ELANOUS_NEXUS_URL — (선택) 계약 endpoint base
# 자격이 없으면 조용히 exit 0(fail-soft — 훅이 Codex 를 막지 않는다).
# PWA 손 카드 제외(TC graphEvents node-added kind=hand · DEMO1104-ARG-ADAPTIVE-VIEW가 렌더).
# OSC 는 폴백이며 화면 scraping 은 하지 않는다. 병렬 송신 없음(Pod concurrency=1).
#
# 인자/stdin: Codex 가 주는 notify JSON {tool_name, cwd, ...} — Codex 는 notify JSON 을
# 인자 하나(argv[1])로 넘기고, stdin 은 폴백이다.

set -uo pipefail
# Codex notify 프로그램 규약: JSON 을 argv[1] 로 받는다 — 인자가 없으면 stdin 을 읽는다.
if [ "$#" -gt 0 ]; then INPUT="$1"; else INPUT="$(cat)"; fi

HAND_CLI="$(cd "$(dirname "$0")/../.." && pwd)/src/agent-mission/hand-hooks.ts"

if [ -n "${ELANOUS_HAND_TOKEN:-}" ] && [ -n "${ELANOUS_MISSION_ID:-}" ] && [ -n "${ELANOUS_ATTEMPT_ID:-}" ] \
  && command -v bun >/dev/null 2>&1 && [ -f "$HAND_CLI" ]; then
  # 논블로킹(백그라운드 &)·출력 버림 — notify 경로를 지연시키지 않는다.
  printf '%s' "$INPUT" | bun "$HAND_CLI" codex-notify >/dev/null 2>&1 &
fi

exit 0