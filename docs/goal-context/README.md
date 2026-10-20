# `docs/goal-context/` — **골 저작 시점에 «항상» 들어가는 맥락** (대표 지시 2026-08-08)
<!-- 이 README도 최상위 Markdown이므로 골 저작 시 필수 맥락으로 함께 수집된다. -->

> ⭐ **한 줄**: ***여기 있는 것은 「관련도로 집히길 기대」하지 않는다. 폴더가 계약이다.***

---

## ⛔ 왜 이 폴더가 있나

```
📏 지금까지    저작기는 docs/ 를 «문서 관련도»로 집어 참조 지식·SCOPE BOUNDARY 후보에 실었다
               (goal-author.ts:824 refFacts ⊕ :1069 scopeBoundaryCandidates)
🚨 그런데      그것은 «확률적»이다 — 집히면 들어가고 안 집히면 안 들어간다
📏 실물        2026-08-08 에 관련 문서 13개가 붙어 「내 골이 중복인가」를 «유일하게» 갈랐다.
               ⇒ 안 붙었으면 중복 골이 그대로 발사됐다
⇒ 🩹 ***골을 「어떻게 지어야 하나」는 확률에 맡기면 안 된다.*** 그래서 이 폴더가 있다
```

## 🧩 두 계층 — **여기 들어가는 것과 안 들어가는 것**

```
🅐 여기 «들어간다» — 필수 참조 = 「이 골을 «어떻게 지어야 하나»」   = 규범
   성격   골마다 «같다». 그래서 그 골에 대한 «정보는 없다»
   예     저작 전 검토 여섯 · 하니스가 도는 형태 · 판정 신호를 쓰는 법

🅑 여기 «안 들어간다» — 레퍼런스 = 「이 골이 다루는 «자리»가 지금 어떤가」  = 사실
   성격   골마다 «다르다». 그 골에만 있는 정보다
   예     옛 골(중복 판정) · 그 파일의 기존 계약 · 관련 ISSUES
   ⇒ 그것은 접지가 «관련도»로 집는 몫이다. 여기 넣으면 모든 골이 남의 사실을 진다
```
⛔⭐ ***둘은 「부피」가 아니라 「누가 «언제» 쓰나」로 갈린다*** —
`🅐` 는 **항상 필요한데 매번 복사되면 안 되고**, `🅑` 는 **저작 때 필요한데 실행 때는 안 필요하다**.

## 📌 여기 넣을 때의 규율 넷

```
① 골마다 «같은» 것만 넣는다 — 어느 한 골에만 맞는 문장이면 그건 🅑 다
② «요지»만 넣는다 — 전문은 원본 문서에 두고 여기서는 링크한다
   ⛔ 이유: 여기 있는 것은 «모든 골»에 실린다. 한 줄이 골 수만큼 복제된다
③ ⛔ 「수」를 넣지 않는다 — 실측 수는 늙는다. 「재는 명령」을 넣는다
④ ⛔ 「관문」을 만들지 않는다 — 여기 있는 것은 «관측·안내»다.
   대표 2026-08-08: *하니스의 셀프힐링 «잠재력»을 앞단 판정식으로 없애지 마라*
   ⇒ 답이 비어도 골은 발사된다. 다만 «비었다는 걸 알고» 발사한다
```

## 🔁 갱신 — **상황이 바뀌면 여기가 먼저 바뀐다**

```
언제   ⑴ 파이프라인·판정 규칙이 바뀌었을 때
       ⑵ 같은 형태의 실패가 «두 번» 났을 때 (한 번은 우연, 두 번은 형태다)
       ⑶ 여기 적힌 문장이 실물과 어긋났을 때 — ⛔ 그때는 «문서가 아니라 여기»를 먼저 고친다
어떻게  원본 문서(§ 링크)를 고치고, 여기에는 «요지 한 줄»만 동기화한다
⛔ 하지 마라   여기에 원본을 복사해 두는 것 — 두 벌이 되면 반드시 갈린다
```

## 157차 입구 라이브 확인용 — 실제로 발사하지 않는다

공통 하니스 `--dry-run`은 **미리보기 전용**이다. 입력·입구·시작 예정 계획을 출력하고 전제 검사는 돌리지 않으며, 실제 dispatch 전에 반환한다. 따라서 이 출력은 실제 발사를 수행하지도, 실제 발사가 일어날 것을 보장하지도 않는다.

- 근거 구현: [`src/harness/harness-cli-command.ts`](../../src/harness/harness-cli-command.ts)의 `printHarnessLaunchDryRun`과 `dispatchHarnessAskSay`는 계획을 출력한 뒤 `dispatch()` 전에 반환한다.
- 보존 검증: `bun test -- 'src/harness/harness-cli-command.test.ts' 'src/self-dev/entrance-registry.test.ts'`는 ask·mission dry-run이 주입된 handler를 호출하지 않는 것과, canonical 입구의 `status` 및 수동 `verification` 선언을 함께 검증한다.
- 입구 레지스트리의 `actualMission`·`legacyParity`는 수동 확인 상태의 선언이다. dry-run 관측은 그 상태를 실제 발사로 바꾸거나 보장하는 증거가 아니다.

### 검증 기록

EVIDENCE: [requested] 이 README는 지정 제목과 preview-only 경계를 기록하고, dry-run handler 미호출 및 입구 선언 계약은 focused 테스트가 함께 검증한다. || bun test -- 'src/harness/harness-cli-command.test.ts' 'src/self-dev/entrance-registry.test.ts'
RESULT: 51 pass, 0 fail, 390 expect() calls; Ran 51 tests across 2 files.

EVIDENCE: [preservation] 공통 dry-run의 handler 미호출과 canonical 입구의 status·수동 verification 선언이 함께 유지된다. || bun test -- 'src/harness/harness-cli-command.test.ts' 'src/self-dev/entrance-registry.test.ts'
RESULT: 51 pass, 0 fail, 390 expect() calls; Ran 51 tests across 2 files.

## 📚 지금 있는 것

| 파일 | 무엇 | 원본(전문) |
|---|---|---|
| [`01-goal-authoring-checks.md`](01-goal-authoring-checks.md) | 골을 쓰기 «전»에 답하는 여섯 | [`CONCEPT-self-implement-closed-loop-map`](../CONCEPT-self-implement-closed-loop-map-2026-08-08.md) §8 |
| [`refactoring.md`](../refactoring.md) | 리팩터링·seam·큰 파일 쪼개기 골은 냄새 → seam → 패턴 순서를 따르고, 이론상 깔끔함만으로 패턴을 도입하지 않는다 | [`refactoring.md`](../refactoring.md) |

## Cross-ref
[[CONCEPT-self-implement-closed-loop-map-2026-08-08]](폐루프 전도 · §7a 가 이 두 계층의 근거) ·
[[MANUAL-goal-authoring-method-2026-08-03]](저작 «절차» canonical) · **PR #5730**
