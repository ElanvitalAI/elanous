# `craft/` 규칙서 — 수입 기록 (NOTICE)

> ## ⭐ 한 줄
> ### ***이 디렉토리의 `.md` 는 «우리가 쓴 것이 아니다». 바이트 그대로 들여온 남의 저작물이다.***
> ### ⛔ 고치려면 §3 을 먼저 읽어라 — 고치는 순간 라이선스 의무가 «하나 더» 생긴다.

---

## 1. 📦 무엇을 · 어디서

| | 값 |
|---|---|
| **출처** | OpenDesign — `~/source/ref/open-design/craft/` |
| **라이선스** | **Apache License 2.0** (전문 = 같은 디렉토리의 [`LICENSE`](LICENSE)) |
| **수입일** | 1차 2026-08-23 (KST) · **2차 2026-08-23 (KST)** |
| **수입한 것** | 규칙서 **11개 = 원본 전부** (1차 2 ⊕ 2차 9) |
| **고친 것** | ⛔ **없다 — 바이트 그대로다** (§2 가 그것을 «증명»한다) |

```
docs/design/craft/
├── LICENSE                              Apache-2.0 전문            (조건 ⓐ)
├── NOTICE.md                            이 파일                     (조건 ⓑ)
│
│  ── 1차 수입 (2026-08-23) ──
├── anti-ai-slop.md                      게이트 «문법»의 원본
├── accessibility-baseline.md            자동 검증 가능한 축 (WCAG)
│
│  ── 2차 수입 (2026-08-23 · 대표 「ⓐ 소비」 결정) ──
├── animation-discipline.md              움직임의 절제
├── color.md                             색                        ⚠️ MIT 귀속 줄을 «품는다»
├── form-validation.md                   폼 검증
├── laws-of-ux.md                        UX 법칙
├── rtl-and-bidi.md                      RTL · 양방향
├── state-coverage.md                    상태 전수 (빈·로딩·오류·…)
├── typography.md                        타이포그래피              ⚠️ MIT 귀속 줄을 «품는다»
├── typography-hierarchy.md              위계
└── typography-hierarchy-editorial.md    편집형 위계
```

### 📌 1차가 «둘»이었던 이유 ⊕ 2차가 나머지를 마저 들인 이유

1차는 플랜(`PLAN-design-source-acquisition-and-use` §5 3️⃣)의
*"한 번에 11개를 다 들이지 않는다"* 를 따랐다 — 그때는 **읽는 자가 없었다**.
- `anti-ai-slop` = 「자동 강제 ↔ 사람 판단」을 **가르는 문법**의 원본
- `accessibility-baseline` = 그중 **기계가 실제로 잴 수 있는** 축(WCAG)

**2차(대표 결정 「ⓐ 소비 — 규칙서를 elanous 안으로」)의 전제는 달라졌다:**
```
1차 시점   읽는 자 «0»  ⇒ 많이 들이면 «죽은 파일»만 는다
2차 시점   ✅ 파서 `src/design/design-doc.ts` ⊕ CLI `repo design-check` ⊕ 지킴이 셋
           ⇒ 들인 만큼 «선언·검증·렌더»에 곧바로 쓰인다
```
⇒ ⛔ 그리고 **개수가 늘어도 관리 비용이 거의 안 는다** — 체크섬·NOTICE·3자 드리프트를
   **기계가 디렉토리에서 «도출»**하기 때문이다(손으로 세는 목록이 아니다).

---

## 2. 🔒 바이트 동일성 — **주장하지 않고 «증명»한다**

수입 시점 SHA-256:

```
9d95806a26532623360eb84bb17d298f394b55ef73fb4c0796d99b4319b2b0da  LICENSE
d0f57d3064451663f9dca81af170fc754acc4b1e77280fd5cfb3a04afeef9a5c  anti-ai-slop.md
ef6c5f670d114ceb4c347681bcf3be8637e5d1186165a9c79ca265f316c72d11  accessibility-baseline.md
075273e8404f7931adfe196d508461efdd303b54e0d9a9ef3f642a682c12a760  animation-discipline.md
fb45b59fa3055f13d6549f45ae52e88cd09d3facd0e5aaab63600e7fb024db6d  color.md
a31410ce6ba8b7a762c2975386f2e93ae97b59a8bc85169aa58457927b0a88e6  form-validation.md
9a4db0fe294a240920921111d43a6af5ea0c4df1bf979f6e780610a36a9c6d1c  laws-of-ux.md
713abc3707eb056ed1d40ca8f3e91c04afc4003251b9ed266650fd267cbf4391  rtl-and-bidi.md
79bda732b55b0f0e4a366ba934f4a01518d3576091422047690e269222f2b682  state-coverage.md
df5beddb8cd3c2b8f15e74f57ada607f7a89ce9112aaa8f8fad22d89e452bea4  typography-hierarchy-editorial.md
e247ca0358dcbdc3921f2148cc44c6ddcc325429b8082f6ad033792b79e39e06  typography-hierarchy.md
5f8e634b35c6b27a5e86f748825da17efe6a0d2e96f68dc35f57f406420049a6  typography.md
```

✅ **기계가 지킨다** — [`src/design/craft-vendor.test.ts`](../../../src/design/craft-vendor.test.ts) 가
매 테스트마다 이 값을 다시 잰다. ⇒ 누가 이 파일을 조용히 고치면 «시험이 먼저 운다».

📏 직접 재는 법:
```bash
shasum -a 256 내부 문서 `*` docs/design/craft/LICENSE
```

---

## 3. ⛔ **고치려면** — Apache-2.0 조건 셋

```
ⓐ 라이선스 전문을 같이 둔다              ✅ LICENSE
ⓑ 「고쳤다」를 표시한다                   ⚠️ 지금은 «안 고쳤다». 고치는 순간 이 절에 적는다
ⓒ 원저작 귀속을 보존한다                 ✅ anti-ai-slop.md:11 의
                                            `> Adapted from refero_skill` 줄이 살아 있다
```

> ### ⚠️⭐ **ⓒ 는 «Apache-2.0 밖»의 의무다**
> 이 규칙서들 중 일부는 OpenDesign 이 **refero_skill(MIT)** 에서 각색한 것이라, 그 줄은 MIT 귀속이다.
> ⛔ 파일을 편집하다 그 줄을 지우면 **다른 라이선스를 어긴다.**
>
> 📏 **2차 수입 후 실측 — 그 줄을 가진 파일은 «셋»이고 이제 «셋 다 트리 안»에 있다:**
> ```
> anti-ai-slop.md   ✅ 1차 수입    grep -ci refero → 1
> color.md          ✅ 2차 수입    grep -ci refero → 1
> typography.md     ✅ 2차 수입    grep -ci refero → 1
> 나머지 여덟        refero 언급 0
> ```
> ⇒ 🔑 1차 NOTICE 가 *"나중에 앞의 둘을 들일 때도 같다"* 고 예고했고, ***2차에서 그대로 맞았다.***
> 🔧 재는 법: `grep -ci refero 내부 문서 `*``

### 🩹 고칠 때 절차
1. 파일을 고친다
2. **이 절 아래에 「무엇을 왜 고쳤나」를 적는다**
3. `src/design/craft-vendor.test.ts` 의 기대 해시를 새 값으로 갱신한다
4. ⛔ 3을 «먼저» 하지 마라 — 지킴이를 먼저 풀면 1·2 를 잊는다

#### 변경 이력
```
(없음 — 2026-08-23 수입 이후 무변경)
```

---

## 4. 🔌 **이 규칙서를 «어떻게 쓰나»** — ⛔ 두 겹을 섞지 않는다

`anti-ai-slop.md` 자신이 그 문법을 쓴다:

```
자동 강제   기계가 «잡는다»                 ⇒ 실패 = 취향이 아니라 «회귀»
사람 판단   나머지                          ⇒ "(guidance, not auto-checked)"
```

### 📏 지금 이 저장소가 «이미» 자동으로 재는 것
| 규칙서의 축 | 우리 쪽 자 | 상태 |
|---|---|---|
| WCAG 명암비 (normal text) | [`src/theme/contrast.test.ts`](../../../src/theme/contrast.test.ts) | ✅ 테마 레지스트리 전수 감사 |
| 정본↔PWA 거울 일치 | [`apps/pwa/src/lib/theme-mirror.test.ts`](../../../apps/pwa/src/lib/theme-mirror.test.ts) | ✅ 테마당 16 매핑 |

⛔ **그러니 「WCAG 검사기」를 새로 짓지 마라** — 이미 있다. 규칙서는 그 자를 «어디에 더 세울지»를 말해 준다.

### ⚠️ 아직 «안 한» 것
- 이 규칙서를 리뷰어(`elanous self review`)가 인용하게 배선하는 일 — **미착수**
- 나머지 9개 규칙서 수입 — **필요해질 때**

---

## 5. 🧭 관련

- 확보 전략 = `PLAN-design-source-acquisition-and-use`
- 소스 전수 조사 = `RESEARCH-free-design-sources-inventory`
- 로드맵 축 **B1** = `ROADMAP-f-track-acp-conformance-and-design-projects`
