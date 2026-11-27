# 대식세포 — 노하우 팩 (씨앗 · seat KNOWHOW 항목 형식)

> 씨앗 출처: seat-state/OPS/OPS-RULES.md §17 자원 위생 · «가지·작업 트리 14일 정리» · «/tmp 정규 청소» · seat-state/OP/design-archive-1126/SUPERVISORS-AND-MESSAGING-1127.md §2c·§2d · PR #40352 guardian reaper.

## K-MACROPHAGE-001 고아는 정확한 PID 로만 — 패턴 kill 금지 (2026-11-27)
- 상황: 오래된 bun test·codex exec·pregate 자식이 launchd(ppid 1)로 입양돼 부하를 먹을 때.
- 처방(힐링): ps 한 번으로 후보를 고르고, 죽이기 직전 그 PID 를 다시 읽어 같은 명령 앞 60자 · ppid 1 · 나이가 줄지 않았음을 확인한 뒤 SIGTERM. pkill·killall 은 macOS 에서 패턴 뒤 인자를 패턴으로 읽어 엉뚱한 것을 죽인다.
- 재는 명령: ps -x -U $USER -o pid=,ppid=,etime=,command=
- 종류: playbook
- 검증: 2026-11-27 참 (PR #40352 reaper.ts · node-b load 135 수동 정리)
- 출처: guardian reaper(PR #40352) · OP 메모리 no-pkill-macos-pattern-trap · 상태: active

## K-MACROPHAGE-002 launchd 서비스 PID 는 고아가 아니다 (2026-11-27)
- 상황: ppid 1 인 프로세스를 고아로 세려 할 때.
- 처방(힐링): macOS 에서는 상주 서비스(postoffice · nexus · els)도 ppid 1 이다. launchctl list 의 PID 는 늘 빼고, launchctl 을 못 읽으면 고아 판정을 하지 않는다(KPI 모름).
- 재는 명령: launchctl list
- 종류: warning
- 검증: 2026-11-27 참 (SUPERVISORS-AND-MESSAGING-1127 §2d postoffice 상주)
- 출처: SUPERVISORS-AND-MESSAGING-1127 §2d · 상태: active

## K-MACROPHAGE-003 일회성 launchd 잔재는 plist 를 격리하고 내린다 (2026-11-27)
- 상황: resinfra.pinch*·cx*lease*·postpub* 처럼 Month·Day 하나만 가진 일회성 job 이 날짜가 지나도 남아 있을 때(≈40개).
- 처방(힐링): plist 를 격리 폴더로 복사 → launchctl bootout gui/<uid>/<label> → plist 를 LaunchAgents 밖으로 옮긴다. 되돌림 = 제자리로 옮기고 launchctl bootstrap. KeepAlive·RunAtLoad·주기 job 은 손대지 않는다.
- 재는 명령: ls ~/Library/LaunchAgents | grep elanous
- 종류: playbook
- 검증: 2026-11-27 참 (SUPERVISORS-AND-MESSAGING-1127 §2d «일회성 잔재»)
- 출처: SUPERVISORS-AND-MESSAGING-1127 §2c 대식세포 · §2d · 상태: active

## K-MACROPHAGE-004 worktree 는 14일·깨끗·가지 있음일 때만, 가지는 남긴다 (2026-11-05)
- 상황: 마지막 커밋이 14일 넘은 worktree 가 쌓일 때.
- 처방(힐링): 열린 PR head·착지 줄·도는 런·더티 트리는 제외. git worktree remove(--force 없음)로 지우고 가지·끝 sha 를 기록해 되살릴 수 있게 한다. 50개 묶음 · 부하 30 넘으면 쉰다.
- 재는 명령: git -C ~/elanous-hq/repo.git worktree list --porcelain
- 종류: playbook
- 검증: 2026-11-05 참 (OPS-RULES «가지·작업 트리 14일 정리»)
- 출처: OPS-RULES «가지·작업 트리 14일 정리» (대표 11-05 14:3x) · 상태: active

## K-MACROPHAGE-005 자원 위생은 시키기 전에 — 보고만 하고 끝내지 않는다 (2026-11-18)
- 상황: 디스크·워크트리·임시 파일이 쌓이는 것을 보고만 할 때.
- 처방(힐링): 위생은 RES 상시 몫이고 대식세포는 그 손이다. 찾으면 권한 안에서 바로 치우고, 권한 밖(crontab · 원격 · 디스크 큰 정리)은 RES 에 한 장으로 올린다. «SCOPE STOP» 으로 보고만 하지 않는다.
- 재는 명령: eln loop agent macrophage status
- 종류: heuristic
- 검증: 2026-11-18 참 (OPS-RULES §17)
- 출처: OPS-RULES §17 (11-18 node-c 디스크 1G 사고) · 상태: active
