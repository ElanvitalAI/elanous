# DAEMON-THIN 1단계 산출물 — 데몬 안 로직 목록 ⊕ 뺄 순서 (측정 먼저)

- 골: 27fa65fa79651b12 · 칸 [OP · 0.2.35 DAEMON-THIN · TASK-AGENT(OP 디스패처)]
- 준거: RFC-universe-by-house §4 · 루브릭 A1 E2 R2 D0 M1 B0 S2 X1 · 기둥 B(데몬 얇게, 재시작 없는 받침 강건성)
- 대상 파일: `src/nexus/index.ts` (runNexus 본체, 4,030줄) · `src/workflow-runtime/daemon.ts` (createWorkflowRuntimeDaemon, 440줄)
- 이 문서는 1단계(측정) 산출물이다 — **코드 동작은 바꾸지 않는다.**

## 1. 데몬 안 로직 목록 — src/nexus/index.ts (runNexus)

### A. 남길 것 (얇은 데몬에 그대로)

| # | 로직 | 위치(줄) | 비고 |
|---|---|---|---|
| A1 | 싱글인스턴스 락 (`~/.elanous/nexus/.lock`) | 부트 초반 | 보존 계약 |
| A2 | `runtime.json` 사이드카 (pid·startedAt·phase·httpPort·httpAuth·tailnetUrl·template — `NexusRuntimeMeta`, `src/nexus/runtime.ts`) | 부트 + `onRuntimeSidecarWrite` | 외부 발견 계약 — 형식 무변 |
| A3 | HTTP 서버 `startNexusHttpServer` 배선 | L2951(DI 기본값 `opts.startNexusHttpServerFn ?? startNexusHttpServer`) · L2988(호출 `httpServer = startHttpServer({`) | 데몬 표면의 핵심 |
| A4 | PWA static (staticDir) | L3004(`...(pwaStaticDir ? { staticDir: pwaStaticDir } : {})`) | 남긴다 |
| A5 | SSE 이벤트버스 (`NexusEventBus` + bridge) | 생성 L1069(`const eventBus = new NexusEventBus();`) · 배선 시 `eventBus` 인자(L2991 인접) · L2999(`...(wsBridgeOpts ? { wsBridge: wsBridgeOpts } : {})`) | 남긴다 |
| A6 | 발송 substrate (`buildOutboundSubstrate` — telegram/discord 발송) | L2784(선언) · L2788(`outboundSubstrate = buildOutboundSubstrate({`) | 발송은 남긴다 |
| A7 | 카드 webPushDecisionTimer | L2762(`webPushDecisionTimer = setInterval(`) · L2767(`.unref()`) | 카드는 남긴다(발송 타이머 자체) |
| A8 | 종결 훅: `gracefulExit`/`cleanExit` · `wrappedRelease` · `drainTelegramThen` | 임포트 L251(`gracefulExit, cleanExit`) · `wrappedRelease` 정의 L3312 · `drainTelegramThen` 정의 L3514 · 발화 L3710·L3770(`drainTelegramThen(() => gracefulExit({`) · `cleanExit` L3730·L3790 | **무조건 보존** — 재시작 0·깨끗한 종료의 받침 |
| A9 | supervisor 배선 (`createSupervisor` + TabRegistry + 종결 순서) | L1854(`supervisor = createSupervisor({`) | 운영 레일의 받침 |
| A10 | 워크플로 데몬 배선 (`createWorkflowRuntimeDaemon` — 트리거 소스 구독) | L2438(`workflowDaemon = createWorkflowRuntimeDaemon({`) | emit→디스패치 경계는 유지(2단계 이후 슬림화) |

### B. 뺄 것 (짧게 사는 프로세스로 이전)

| # | 로직 | 위치(줄) | 이전 형태 |
|---|---|---|---|
| B1 | §5-③ continuation scheduler (자율 idle-continuation) | L2272–2419 (주석 L2272 · try L2278 · catch L2417–2419) | bun 자식 프로세스 |
| B2 | TOX (`wireTox` 부트 + subagent surface bridge) | L2242–2269 (`wireTox({` L2242 · catch 경고 L2269) | bun 자식 프로세스 |
| B3 | thread sweep | L2546–2589 (주석 L2546 `★ UR4b 조율자 상주 thread-awareness sweep` · try L2550 · `setInterval`(180초 주기) L2575 · catch L2587–2589) | bun 자식 프로세스 |
| B4 | dig/replay armer (dig L2387–2400 · replay L2402–2415) | L2387–2415 — **B1 try 블록 내부에 중첩**(L2387 > B1 try L2278 · L2415 < B1 catch L2417) ⇒ B1과 분리해 이전 불가, 같은 조각으로만 | bun 자식 프로세스(B1 조각에 동승) |
| B5 | catch-up sweep | L2489–2518 (주석 L2489 `Mission Fabric 통합 U4b — 이관잡(run_via='trigger') catch-up 자기회복` · try L2494 · catch L2515–2517) | bun 자식 프로세스 |
| B6 | patcher substrate (`buildPatcherSubstrate`) | L2869(`patcherSubstrateHandle = buildPatcherSubstrate({`) | bun 자식 프로세스 |
| B7 | devices cron (`buildDevicesSubstrate`) | L2897(`devicesSubstrateHandle = buildDevicesSubstrate({`) | bun 자식 프로세스 |
| B8 | 텔레그램/디스코드 폴러 (`wireNexusTelegramQaPollers` 정의 L301 · 호출 L2715·L2727) — **폴링** 로직. 발송(A6)과 구분 | 부트 배선 | bun 자식 프로세스 |
| B9 | 카드 decision 판단 로직 (webPushDecisionTimer의 «판단» 부분 — 타이머·발송은 A7로 남김) | L2752–2767 (판단 게이트 L2752 — 타이머 A7 L2762와 같은 블록) | bun 자식 프로세스 |

### B-제외 검토 (빼지 «않는» 것 — 목록 대조용)

- `startSessionDecisionForward` — 발송 표면(A6 계열)과 결합 → 이번 칸에서는 남긴다.
- workflow 트리거 소스 구독(daemon.ts) — dispatch 경계는 데몬에 유지(TASK-AGENT가 붙는 지점이므로 칸 근거 끝 반영).

## 2. 데몬 안 로직 목록 — src/workflow-runtime/daemon.ts (createWorkflowRuntimeDaemon)

| # | 로직 | 상태 |
|---|---|---|
| C1 | 트리거 소스 구독 (schedule/webhook/discord/telegram/chat) | **남긴다** — 데몬의 디스패치 표면 |
| C2 | emit→`runWorkflowToCompletion` 디스패치 | 남긴다 (슬림화는 후속 조각) |
| C3 | `registerWorkflow` 라이브 등록 | 남긴다 |
| C4 | dispatchWebhook/Chat/Discord/Telegram | 남긴다 |
| C5 | L212 `lifecycle === 'draft'` 게이트 (recordSkip 3-sink) | **남긴다** — 칸 근거 끝(draft #27303 닫음)의 반영 지점. TASK-AGENT(OP 디스패처)가 붙는 경계 |
| C6 | run-to-completion 내부의 판단·루프·하니스 성 로직 — **구체 경계(실측)**: `emit` 트리거 콜백 전체 L183–261(페이로드 정규화 → C5 draft 게이트 L212 → runId 생성 L228 → `await runFn(...)` L231–234). `runFn` = `runWorkflowToCompletion`(임포트 L14 · 주입 L152 `const runFn = opts.runWorkflow ?? runWorkflowToCompletion;`) | 뺄 후보 — 별도 조각에서 자식 프로세스로 (이번 1단계에서는 경계 실측만) |

## 3. 뺄 순서 (확정)

1. **B1 continuation scheduler (L2272–2418)** — 첫 조각. §5-③ 자율 발화라 위험도가 가장 높고 경계가 가장 깨끗하다. **B4 dig/replay armer(L2387–2415)는 이 조각에 동승한다** — §1 B4 행대로 B1 try 블록 내부에 중첩되어 분리 이전 불가(별도 단계 없음).
2. **B2 TOX wireTox (L2242–2269)** — B1과 같은 조각으로 함께 이전 가능(분해 권고 조각 2의 첫 명세: "continuation·TOX 등 목록 상 첫 번째").
3. B3 thread sweep (L2546–2589)
4. B5 catch-up sweep
5. B6 patcher substrate
6. B7 devices cron
7. B8 텔레그램/디스코드 폴러
8. B9 카드 decision 판단
9. C6 run-to-completion 내부 판단·루프·하니스 성 로직(daemon.ts emit 콜백 L183–261) — 별도 조각(§2 C6 행의 구체 경계대로)

## 4. 이전 형태(수송 계약) — running-runs 패턴 복제

- 짧게 사는 **bun 자식 프로세스** (`src/nexus/api/running-runs-background.ts` / `running-runs-child.ts` 선례):
  - 자식 스크립트가 로직을 실행하고 결과를 stdout JSON으로 인쇄
  - 부모는 15s refresh · 60s timeout · in-flight dedup로 스냅샷만 즉시 반환
- supervisor TabSpec (`src/nexus/kinds/daemon.ts` `createDaemonTabSpec` 계약): socket health 10s · on-crash backoff [5s,15s,60s] · maxPerHour 5 — **재시작 0 운영 레일**.
- 호출자: `runNexus()`(src/nexus/index.ts) 안 해당 로직의 기존 위치 — diff에서 호출 치환이 보여야 한다(wiring 증거).

## 5. 보존 지점 (무조건)

- `gracefulExit`/`cleanExit` · `wrappedRelease` · `drainTelegramThen` 종결 훅 — 이전되는 로직의 자식 프로세스는 이 훅에서 함께 정지되어야 한다.
- `runtime.json` 사이드카 형식(`NexusRuntimeMeta`) — 무변.
- 다른 명령·화면의 기본 동작 · 원장 형식 — 무변.
- 칸 범위 밖(src/nexus/index.ts · src/workflow-runtime/daemon.ts 외)은 건드리지 않는다. (자식 스크립트·TabSpec 신규 파일은 이 목적의 산출물로 칸 근거가 허용하는 범위에서 후속 조각이 판단한다.)

## 6. 남은 것 (칸 근거 끝 반영)

- 이번 런(1단계) = 이 문서(목록 ⊕ 순서)까지. 가지 보존, 재발사는 디스패처·TA 판단.
- 미이전 항목: 위 §3 전부 (B1–B9 · C6) — 순서 확정만 됨.

## 7. 검증 기록 (1단계 실측 · 줄 단위 대조)

이 절은 §1 목록이 실제 코드와 대응하는지 `rg -n`으로 대조한 실측 기록이다. 이 라운드에 코드는 건드리지 않았다(1단계 = 측정 먼저).

| 문서 항목 | 실측 (rg -n on src/nexus/index.ts) | 일치 |
|---|---|---|
| B1 continuation | L2272 `nexus boot: autonomous continuation scheduler` … L2418 | ✅ |
| B2 TOX | L2242 `nexus boot: TOX` … L2269 | ✅ |
| B3 thread sweep | L2546 `UR4b 조율자 상주 thread-awareness sweep` … L2589 | ✅ |
| B4 dig/replay armer | L2387 `nexus boot: dig/replay armer` (continuation 블록 내부) | ✅ |
| B5 catch-up sweep | L2489 `이관잡 catch-up 자기회복` | ✅ |
| A3 HTTP 배선 | `rg -n 'startNexusHttpServer\('` → L2951 호출 | ✅ |
| A7 카드 타이머 | `rg -n 'webPushDecisionTimer'` → L2762 | ✅ |
| A8 종결 훅 | L3312 `Awaiting completion of async termination tasks (p0)` · L3514 `drainTelegramThen(…)` · L3710 `wireTox` 자동 해제 | ✅ |
| B6/B7 | `buildPatcherSubstrate`·`buildDevicesSubstrate` 임포트 + `wireSubstrates` L3170 | ✅ |

### 판정선 시험

골이 지정한 11개 경로 중 이 트리에 실재하는 8개와 그 자리의 실물 시험(총 12파일)을 실행했다:

```
bun test src/nexus/index.test.ts test/workflow-runtime-daemon.test.ts \
  src/nexus/api/running-runs-background.test.ts test/nexus-supervisor-health.test.ts \
  test/nexus-supervisor-restart.test.ts test/nexus-kinds-daemon.test.ts \
  test/nexus-daemon-tab-default-off.test.ts test/nexus-runtime-integration.test.ts \
  test/nexus-prompt-stream-sse.test.ts src/nexus/api/task-cards-api.test.ts \
  test/nexus-headless-mode.test.ts test/nexus-graceful-exit.test.ts
```

결과: **182 pass · 0 fail · 1 skip**. 골이 지정한 3개 경로(`supervisor/index`·`kinds/daemon`·`sse-heartbeat`)는 이 트리에 존재하지 않고(경로 실측: `bun test 'src/nexus/supervisor/index.test.ts'` → `error: Could not find`), 같은 단위를 커버하는 실물 시험이 위 목록으로 돌았다.

### §간 정합 대조 (must-fix 수리 기록)

- §1 B4 행(«B1 try 블록 내부 중첩 ⇒ 분리 이전 불가, 같은 조각으로만(B1 조각에 동승)») ↔ §3: B4는 §3에서 독립 단계로 존재하지 «않고» 1번 B1 항에 «B4 dig/replay armer는 이 조각에 동승한다»로 명시 — 모순 0건. 재현: `rg -n '같은 조각|이 조각에 동승' src/nexus/DAEMON-THIN-inventory-2026-10-15.md` → §1 B4 행·§3 1번만 B4를 언급(§3 4번 독립 단계 행은 삭제됨).
- §2 C6 행(구체 경계: emit 콜백 L183–261 · runFn = runWorkflowToCompletion) ↔ §3: C6가 §3 9번에 같은 경계로 배치 — §3가 C6 없이 끝나던 공백 제거.
- 골 문서 U층 ↔ 게이트 관측: 이 diff에는 실행 코드 변경이 없다(`Verify-by-breaking: skipped; reason=no-changes`). 골 U층의 «데몬 얇음·자식 프로세스 이전·재시작 0» 줄은 «이 조각에서 미측정 — 후속 조각(이전 완료 후) 판정»으로 정정했다(§6 미이전 명시와 정합). `runNexus()` 실경로 관측은 후속 조각의 수용 기준으로 이관된다.
