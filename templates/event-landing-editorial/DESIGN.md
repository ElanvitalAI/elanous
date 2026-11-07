# Design — Editorial Event Landing

> 한 장짜리 행사 랜딩의 **디자인 씨앗**. 이 문서가 정본이고 `styles.css` 의 `:root` 는 여기서 «파생»된다.
> ⛔ 색·폰트·모션 값을 CSS 에서 먼저 고치지 마라 — 여기서 고치고 `:root` 에 옮긴다.
>
> 📏 출처: `https://ku-architecture-golf-2026.kkh2114.chatgpt.site/` 를 2026-09-08 에 분해해 얻은 패턴.
> 그 사이트의 «내용»이 아니라 «구조»를 담는다(내용은 `content.json`).

## Craft rulebooks

- anti-ai-slop
- accessibility-baseline
- animation-discipline
- color
- laws-of-ux
- state-coverage
- typography
- typography-hierarchy-editorial

## Design direction

- elanous-pastel-default

> ⚠️ 위 `## Design direction` 은 elanous `design-check` 가 읽는 칸이고, 고를 수 있는 여섯은 **전부 터미널 색 구성표**다
> (`catppuccin-*` · `rose-pine-dawn` · `nord-light` · `elanous-pastel-default`). ⛔ **이 문서의 웹 팔레트는 거기서 안 나온다** —
> 아래 §Palette 가 정본이고, 위 선언은 「어느 방향을 표방하나」의 «기록»일 뿐이다. 그 간극이 매뉴얼 §5 의 보강 항목 ①이다.

---

## Palette

> ⭐ **이 절은 «기계가 읽는다»** — `readTokenSection(doc, '## Palette')` 이 `- --name: value` 를 뽑고,
> `measureDeclaredContrasts` 가 그 값들로 WCAG 대비를 «직접» 잰다.
> ⛔ 그래서 아래 목록과 §Palette 표를 «둘 다» 두지 않는다 — 이 목록이 정본이고 표는 설명이다.

- --ground: #ffffff
- --ink: #172d24
- --ink-muted: #606f66
- --brand: #07513b
- --brand-deep: #103e2e
- --brand-panel: #0d4c39
- --hero-ground: #173f31
- --surface: #f4f6f2
- --surface-cool: #eef3ed
- --line: #dbe4de
- --line-soft: #edf0ec
- --accent: #9d783f
- --danger: #a63823
- --on-brand: #ffffff

## Typography

- --font-display: Pretendard, "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif
- --font-body: Pretendard, "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif
- --font-eyebrow: Arial, "Helvetica Neue", sans-serif

## Contrast pairs

> ⭐ **이 절이 「무엇이 실제로 겹치나」를 말한다.** ⛔ 없으면 도구가 «전 조합»을 재고,
> 그 대부분이 안 쓰는 조합이라 경고가 소음이 된다(실측: 16쌍 중 12개가 그랬다).
> 🔑 그리고 선언이 없으면 그것은 「통과」가 아니라 ***「안 쟀다」***다.

- --ink on --ground
- --ink on --surface
- --ink-muted on --ground
- --ink-muted on --surface
- --on-brand on --brand
- --on-brand on --brand-panel
- --on-brand on --brand-deep

⛔ `--accent` 는 **본문 쌍에 «없다»** — 실측 `4.04:1` 로 본문 문턱(4.5)을 못 넘어
큰 글자·비텍스트 전용으로만 쓰기로 한 «결정»이기 때문이다. 그 결정이 여기 빠짐으로 «표시»된다.

## Motion

- --dur-instant: 120ms
- --dur-base: 150ms
- --dur-enter: 420ms
- --ease-out: cubic-bezier(0.2, 0, 0, 1)
- --ease-inout: cubic-bezier(0.4, 0, 0.2, 1)

---

## Palette — 설명

명도 대비를 만드는 축은 **딥 포레스트 그린**이고, 강조는 **브라스(황동)** 하나다. ⛔ 두 번째 강조색을 만들지 마라.

| 토큰 | 값 | 쓰임 |
|---|---|---|
| `--ground` | `#ffffff` | 본문 바탕 |
| `--ink` | `#172d24` | 본문 글자 |
| `--ink-muted` | `#606f66` | 보조 글자 · 캡션 |
| `--brand` | `#07513b` | 1차 브랜드 · 버튼 바탕 |
| `--brand-deep` | `#103e2e` | 마감 섹션 · 어두운 판 |
| `--brand-panel` | `#0d4c39` | 강조 패널(요금표 등) |
| `--hero-ground` | `#173f31` | 히어로 이미지 «뒤» 바탕(이미지 로드 전 색) |
| `--surface` | `#f4f6f2` | 옅은 면(퀵팩트 띠) |
| `--surface-cool` | `#eef3ed` | 옅은 면 2(장소 섹션) |
| `--line` | `#dbe4de` | 경계선 |
| `--line-soft` | `#edf0ec` | 헤더 하단선 |
| `--accent` | `#9d783f` | 포커스 링 · 강조 밑줄 · 마감일 |
| `--danger` | `#a63823` | 마감 임박 · 오류 |
| `--on-brand` | `#ffffff` | 브랜드 바탕 위 글자 |

⛔ `anti-ai-slop` §1 — 기본 Tailwind 인디고(`#6366f1` 계열)를 강조로 쓰지 않는다. 이 팔레트엔 없다.
⛔ 같은 규칙 §2 — 히어로에 2-스톱 「신뢰 그라디언트」를 깔지 않는다. 여기서는 **사진 + 단색 셰이드**다.

### 대비 근거 (WCAG 2.x · 본문 문턱 4.5:1)

📏 **실측 2026-09-08** — elanous `measureContrast`(`src/theme/contrast.ts`)로 잰 값이다. 추정이 아니다.

| 쌍 | 비율 | 판정 |
|---|---|---|
| `--ink` on `--ground` | **14.61**:1 | ✅ AAA |
| `--ink` on `--surface` | **13.44**:1 | ✅ AAA |
| `--on-brand` on `--brand-deep` | **12.00**:1 | ✅ AAA |
| `--on-brand` on `--brand-panel` | **9.95**:1 | ✅ AAA |
| `--on-brand` on `--brand` | **9.34**:1 | ✅ AAA |
| `--danger` on `--ground` | **6.54**:1 | ✅ AA |
| `--ink-muted` on `--ground` | **5.30**:1 | ✅ AA |
| `--ink-muted` on `--surface` | **4.87**:1 | ✅ AA (여유 0.37 — ⚠️ 면 색을 더 어둡게 바꾸면 깨진다) |
| `--accent` on `--ground` | **4.04**:1 | ⚠️ **큰 글자·비텍스트 전용** · ⛔ 본문 금지 |

⛔ **이 수를 손으로 고치지 마라.** 색을 하나라도 바꿨으면 아래를 «쳐서» 다시 넣는다:

```bash
bun -e 'import {measureContrast as m} from "./src/theme/contrast.ts";
  console.log(m("#172d24","#ffffff"))'
```

🩸 **이 표는 한 번 틀렸다** — 처음 쓸 때 재지 않고 어림으로 적어 셋이 어긋났다
(`12.6→14.61` · `9.8→9.95` · `3.9→4.04`). ⇒ ***색 표를 쓰는 순간 재라.***

---

## Typography

| 토큰 | 값 |
|---|---|
| `--font-display` | `Pretendard, "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif` |
| `--font-body` | 같은 스택 |
| `--font-eyebrow` | `Arial, "Helvetica Neue", sans-serif` (라틴 전용 — 한글이 안 들어가는 칸) |

⭐ **한글 랜딩의 핵심 결정**: 디스플레이와 본문이 «같은 서체»다. 한글에는 신뢰할 만한 무료 세리프 디스플레이가 드물어,
위계를 **서체 대비가 아니라 「크기 · 자간 · 굵기」로** 만든다. 그래서 `--font-display` 는 세리프가 아니고,
`anti-ai-slop` §4(*"씨앗이 세리프를 묶으면 디스플레이에 산세리프를 쓰지 마라"*)는 **이 씨앗이 세리프를 안 묶으므로 위반이 아니다**.

| 역할 | 크기 | 자간 | 굵기 | 행간 |
|---|---|---|---|---|
| `h1` (히어로) | `clamp(42px, 4.5vw, 72px)` | `-0.055em` | 650 | 1.22 |
| `h2` (섹션) | `clamp(30px, 3vw, 44px)` | `-0.04em` | 640 | 1.28 |
| `h3` | `clamp(20px, 1.6vw, 26px)` | `-0.02em` | 620 | 1.35 |
| 본문 | `clamp(15px, 1.05vw, 17px)` | `0` | 400 | 1.75 |
| **eyebrow** | `12px` | **`0.18em`** | 600 | 1.5 |
| 캡션 | `13px` | `0.02em` | 400 | 1.6 |

⭐ **eyebrow 가 이 디자인의 «편집형» 신호다** — `01 — INVITATION` 처럼 «번호 + 대시 + 라틴 대문자».
`typography-hierarchy-editorial` 이 말하는 그 층이고, ⛔ 이것을 빼면 평범한 SaaS 랜딩이 된다.

---

## Space & rhythm

| 토큰 | 값 | 쓰임 |
|---|---|---|
| `--gutter` | `6.5%` | 섹션 좌우 여백(뷰포트 비례) |
| `--gutter-header` | `4.5%` | 헤더만 더 좁게 |
| `--measure` | `1320px` | 본문 최대 폭 |
| `--section-y` | `100px` | 섹션 상하 여백 |
| `--section-y-lg` | `120px` | 서사 섹션(초대문) |
| `--header-h` | `94px` | 고정 헤더 높이 |
| `--radius` | `0.5rem` | 라운드(버튼·카드) |

⛔ `anti-ai-slop` §5 — 「라운드 카드 + 색깔 좌측 보더」 조합을 만들지 마라. 이 템플릿의 카드는 **보더 없는 면 전환**으로 구분한다.

---

## Motion

`animation-discipline` 이 정한 문턱을 그대로 쓴다. ⛔ 값을 늘리지 마라.

| 토큰 | 값 | 쓰임 |
|---|---|---|
| `--dur-instant` | `120ms` | 호버 · 버튼 눌림 |
| `--dur-base` | `150ms` | 상태 확정 피드백 (교차 설계 시스템 수렴값) |
| `--dur-enter` | `420ms` | 섹션 진입 페이드 |
| `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | 들어오는 것 |
| `--ease-inout` | `cubic-bezier(0.4, 0, 0.2, 1)` | 자리 이동 |

**움직여도 되는 것**(사용자가 공간·시간·상태를 지날 때):
- 섹션 진입 페이드업 (스크롤 = 공간 이동)
- 계좌 복사 확인 (상태 확정)
- 낙엽 · 공 (⚠️ **장식이다** — 아래 조항을 지키는 조건에서만)

⛔ **움직이면 안 되는 것**: 가르치려고 · 「고급스러워 보이려고」 · 침묵을 메우려고.

### ⛔ 장식 모션의 세 조항 (이 템플릿의 자체 규율)

1. **`prefers-reduced-motion: reduce` 에서 «전부» 멈춘다** — 페이드조차 즉시 표시로 떨어진다.
2. **본문 위에 겹치지 않는다** — 낙엽은 히어로 안, `pointer-events: none`, `aria-hidden="true"`.
3. **사람이 끌 수 있다** — 소리와 움직임에 «하나의» 토글을 준다(`data-motion-paused`).

⛔ **소리는 자동 재생하지 않는다.** 브라우저가 막고, 막히면 그 사실을 화면에 말한다(`state-coverage`).

---

## Layout skeleton

```
header            고정 아님 · 높이 94px · 흰 바탕 · 하단 1px 선
hero              height: calc(100svh - var(--header-h)) · min 730 / max 1050px
                  ├ 배경 사진(object-fit: cover) + 단색 셰이드
                  ├ 좌측: eyebrow · 초대문 한 줄 · h1(3줄) · 설명 · CTA + 마감 고지
                  └ 우측: 날짜 블록(월 / 일 / 요일 / 장소)   ← 데스크톱 전용
quick-facts       4열 그리드 · 옅은 면 · 아이콘 + 라벨 + 값 + 보조
01 invitation     2열(제목 / 본문) · 서사 · 서명으로 닫는다
02 venue          2열(사진 / 정보) · 지도 링크
03 details        2열(정의 목록 / 요금 패널) · 요금 패널만 어두운 판
04 sponsor        3열 카드 · 번호(01·02·03) 부여
closing           어두운 판 · 가운데 정렬 · 최종 CTA
footer            3줄 · 조직명 · 회차 · 슬로건
mobile-apply      ≤900px 에서만 · 하단 고정 바 · 날짜 + CTA
```

**브레이크포인트**: `1100px`(3→2열) · `900px`(2→1열 · 모바일 바 등장) · `560px`(퀵팩트 4→2열)

---

## Content model

내용은 **이 문서가 아니라 `content.json`** 에 있다. ⛔ 둘을 섞지 마라 —
섞는 순간 「다른 행사」로 재사용할 때 디자인까지 갈아엎게 된다.

---

## Accessibility floor

`accessibility-baseline` 을 이 템플릿에 대면 다음이 **필수**다.

- `<a class="skip-link" href="#main">` 이 첫 포커스 대상
- 모든 대화형 요소에 보이는 포커스 링 — `outline: 2px solid var(--accent); outline-offset: 2px`
- 장식 요소 전부 `aria-hidden="true"` ⊕ `pointer-events: none`
- 상태 변화(계좌 복사 · 소리 차단)는 `role="status"` 로 «말한다»
- 히어로 사진에 내용 있는 `alt` (⛔ 빈 `alt` 금지 — 이 사진은 장소 정보를 담는다)
- 전화 링크는 `tel:` ⊕ 화면에는 사람이 읽을 수 있는 번호
- 색만으로 정보를 전하지 않는다 — 마감일은 색 ⊕ **「마감」 낱말**을 같이 쓴다

---

## 📏 레퍼런스 대비 충실성 (실측 · 2026-09-08)

```
RMSE (1280×813 · 잰 뷰포트로 자른 값)   18.87% → 17.70% → ***16.64%***
다른 픽셀 (fuzz 5%)                     51.47% → 43.45% → ***42.73%***
본문 글자수 비                           ***98.5%*** (유지)
anti-ai-slop                            P0 ***0*** · advisory ***0***
```
⛔ **이 수를 인용하지 마라** — 색·간격을 하나라도 바꾸면 달라진다. 그때 다시 재라:
```bash
bun scripts/webclone/measure-fidelity.ts <원본 URL>
bun scripts/webclone/lint-design.ts templates/event-landing-editorial/index.html
```

### 🩸 수리에서 배운 것 — ⛔ 「같아 보이게」와 「같은 방식으로」는 다르다
로고를 `object-fit: cover` 로 맞췄더니 포스터 «가운데»가 보였다.
원본의 실제 기전은 ***확대(487.619%) + 오프셋***이었고, 그것을 쓰고서야 로고가 나왔다.
⇒ 기전을 모르고 결과만 맞추면 다음 판(다른 이미지·다른 크기)에서 다시 어긋난다.

## 🖼️ 에셋 — ⛔ `assets/` 의 셋은 «플레이스홀더»다

```
assets/hero.svg   assets/venue.svg   assets/logo.svg
```

⭐ **이 팔레트로 우리가 그린 것**이지 원본 사진·로고가 «아니다».
🩸 이 자리가 왜 있나(2026-09-08 실측): 원본 저작물은 **재배포할 수 없어** 안 담았는데,
그 결과가 ***처음 열면 이미지 3/3 이 깨진 페이지***였다(`brokenImgs:3`).
⛔ 해법은 「담기」도 「빼기」도 아니라 **자작 플레이스홀더**다 — 경계를 지키면서 템플릿이 «혼자 선다».
✅ 실측: **3/3 깨짐 → 0/3** · 전체 높이 4429px.

### 교체하는 법
`content.json` 의 `brand.logo.src` · `hero.image.src` · `sections.venue.image.src` 를 자기 파일로 바꾼다.
플레이스홀더는 화면에서 **스스로 「자기 사진으로 교체」라고 말한다** — 지우는 것을 잊어도 배포본에서 보인다.

## Template reuse — voice notes

`next-app-voice-note` uses this design seed for its editorial typography, spacing, palette, and
reduced-motion behavior. Its recording, saving, and processing controls must keep the seed's
contrast and visible focus treatment so each state remains clear and operable.

## Template reuse — translator

`next-app-translator` uses this design seed for its editorial typography, spacing, palette, and
reduced-motion behavior. Recording, language selection, translation progress, and playback controls
must keep the seed's contrast and visible focus treatment so each state remains clear and operable.
