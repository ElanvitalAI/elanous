# 침묵 감시 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: seat-state/OPS/OPS-RULES.md «메시지 교환» · «우편 케이던스 ⊕ 자치» · seat-state/OP/design-archive-1126/SUPERVISORS-AND-MESSAGING-1127.md §2d·§3·§3a · src/msg/msg-store.ts listUnseenRequests(SEAT-MAIL-ACK-SLA).

## K-SILENCE-WATCH-001 미결 = 수락·거절·완료·만료가 없는 요청 (2026-11-27)
- 상황: 어떤 우편을 «답 없음» 으로 셀지 정할 때.
- 처방(힐링): intent=request ⊕ needsAck 인 우편 중 accepted·rejected·done·expired 영수도 done ack 도 없고 받는 이의 reply_to 회신도 없는 것. 본 것(seen)·손 ack 만으로는 결정이 아니다. 24시간 넘은 것은 은퇴·오타 자리 몫이라 세지 않는다.
- 재는 명령: eln msg overdue --stage ack --after 30
- 종류: fact
- 검증: 2026-11-27 참 (src/msg/msg-store.ts listUnseenRequests stage ack)
- 출처: SEAT-MAIL-ACK-SLA · src/cli/msg-receipts-cli.ts · 상태: active

## K-SILENCE-WATCH-002 실제로 깨우는 줄기는 초인종이다 (2026-11-27)
- 상황: 묵힌 우편의 받는 자리를 다시 깨우려 할 때.
- 처방(힐링): seat-inbox 폴링·tf-hq-wake 는 죽었다. 원장 옆 inbox/<SEAT>.bell 을 울리면 postoffice SSE 와 탭 감시가 원장을 다시 읽는다(p50 0.29s). 우편마다 한 번만.
- 재는 명령: eln msg list --to <자리>
- 종류: fact
- 검증: 2026-11-27 참 (SUPERVISORS-AND-MESSAGING-1127 §2d postoffice · §3 bell-wake 실측)
- 출처: SUPERVISORS-AND-MESSAGING-1127 §2d · src/msg/seat-bell.ts · 상태: active

## K-SILENCE-WATCH-003 읽는 몸이 없는 주소는 깨워도 소용없다 — 보낸 이에게 알린다 (2026-11-27)
- 상황: RES·REL·JUD-2·REVIEW-2·ORCHESTRATOR 처럼 탭이 없는 주소로 간 요청이 쌓일 때(RES 회신 0/12 · ORCHESTRATOR 미확인 ≥100).
- 처방(힐링): 24시간 동안 그 주소가 보낸 우편이 하나도 없고 루프 에이전트 카드도 없으면 읽는 몸 없음. 초인종 대신 보낸 이에게 «읽는 몸 없음 · 다른 주소로» 한 줄(멱등 키).
- 재는 명령: eln msg list --to RES
- 종류: playbook
- 검증: 2026-11-27 참 (SUPERVISORS-AND-MESSAGING-1127 §3a «깨움 경로 없음»)
- 출처: SUPERVISORS-AND-MESSAGING-1127 §3·§3a · 상태: active

## K-SILENCE-WATCH-004 재촉은 한 번 — 우편 폭주를 만들지 않는다 (2026-11-24)
- 상황: 같은 우편을 여러 번 다시 깨우고 싶을 때.
- 처방(힐링): «접수·확인 중» 우편과 우편마다 깨우개는 폭주의 증폭기다. 한 번 재배달 뒤에도 묵히면 더 두드리지 말고 KPI 위반으로 OP 에 한 장 올린다.
- 재는 명령: eln loop agent silence-watch status
- 종류: heuristic
- 검증: 2026-11-24 참 (OPS-RULES «우편 케이던스 ⊕ 자치»)
- 출처: OPS-RULES «우편 케이던스 ⊕ 자치» (대표 11-24 23:5x) · 상태: active

## K-SILENCE-WATCH-005 사람 탭에는 주입하지 않는다 (2026-11-05)
- 상황: 사람이 앉은 탭(MK 등)으로 간 요청이 묵힐 때.
- 처방(힐링): 사람 탭은 깨움·초인종·재Enter 주입 0. 원장 초인종만 울리고(탭 입력 아님), 그 뒤는 OP 판단.
- 재는 명령: (없음)
- 종류: warning
- 검증: 2026-11-05 참 (OPS-RULES «메시지 교환»)
- 출처: OPS-RULES «메시지 교환» (대표 11-05 06:2x) · 상태: active
