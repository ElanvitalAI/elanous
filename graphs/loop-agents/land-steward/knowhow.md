# 착지 집사 노하우 팩 — 기차 매니저 몫 (merge-train 시대에서 다시 붙임)

> 원본 원장: `seat-state/OP/LANDING-KNOWHOW.md`(L1~L45 · 11-18~11-22). 여기에는 지금 몸이 쓰는 규칙만 남긴다. 로직이 된 규칙에는 코드 위치를 적는다.

| # | 규칙 | 근거(원장) | 지금 로직 |
|---|---|---|---|
| T1 | 같은 핫파일을 고치는 PR 은 직렬로 착지한다. 한 틱에 파일당 하나만, 다음 것은 새 main 위에서 다시 preflight 한다 | L41 · 11-26 #40285 하루 저녁 5회 거절 | `tickLand` 같은 파일 겹침 = `main-moved-overlap` · `train.ts` lanes |
| T2 | pregate 전에 main 을 병합한다. 착지 명령은 병합 결과에서 ratchet·tsc·isolation 을 돈다 | L41 ② · 11-20 #38817 main 빨강 | pregate merge-main 단계 · op-direct-land-v2 tsc-preflight |
| T3 | churn 으로 거절된 뒤 main 을 병합해 새 head 가 된 PR 이 자기 차선에서 먼저 착지한다 | 11-26 THROUGHPUT-CONTROLLER | `landOrder` → `trainOrder` 첫 기준 |
| T4 | 깨끗한 충돌(merge-tree 충돌 0)은 손을 기다리지 않고 main 을 병합해 다시 pregate 한다. 진짜 충돌만 작성자 몫이다 | L41 ② | 마무리꾼 `refresh` |
| T5 | main 병합만 다른 head 는 영수를 승계한다(patch-id 같음) | L32 drift-accept | #40358 PATCHID |
| T6 | 슬롯 = 게이트 완료율이다. 슬롯 수를 늘린다고 빨라지지 않는다(호스트 슬롯 ≤ ncpu ÷ 게이트당 샤드) | 11-20 18:2x | `slotAdvice` — 착지/h 가 준비 수보다 낮을 때만 +1 권고 |
| T7 | 부하로 인한 시간 초과(exit 124)는 결함이 아니다. 다른 호스트에서 한 번 다시 돈다 | L7 · 11-21 NUMGUARD | 마무리꾼 `pregate-retry` · land 시점 LAND_TSC_HOSTS 회전 |
| T8 | 큐 head ≠ 실제 PR head 이면 그 행은 버린다(옛 head 로 같은 일을 되풀이하지 않는다) | 11-20 16:28 hotloop | 몸은 늘 `gh pr list` 의 지금 head 로 판단한다 |
| T9 | 순서: churn 피해 → 대표/P0 → 오래된 것 → 번호 | 11-19 PRIORITY-ORDER | `trainOrder` |
