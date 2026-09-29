# `systems/` 디자인 시스템 — 수입 기록 (NOTICE)

> ⭐ 한 줄 — 이 디렉토리의 시스템 폴더는 «우리가 쓴 것이 아니다». OpenDesign 의 디자인 시스템을 바이트 그대로 들여온 것이다. 고치지 말고 원천을 다시 싱크한다.

## 1. 무엇을 · 어디서

| | 값 |
|---|---|
| 출처 | OpenDesign — `https://github.com/nexu-io/open-design` 의 `design-systems/` (로컬 체크아웃 `~/source/ref/open-design`) |
| 라이선스 | Apache License 2.0 — 전문 = 같은 디렉토리의 [`LICENSE`](LICENSE) |
| 원천 커밋 · 날짜 | [`SOURCE.json`](SOURCE.json) 의 `commit` · `syncedAt` (첫 수입 2026-09-27 · `1b47e60bd4`) |
| 수입한 것 | 시스템마다 `DESIGN.md` · `tokens.css` · `manifest.json` 셋 — 목록은 `SOURCE.json` 의 `systems` |
| 고친 것 | 없다 — 바이트 그대로다(`--check` 가 증명한다) |

## 2. 무엇을 «안» 가져왔나 — 브랜드

- 원천 152개 중 **스타일 계열**(`manifest.json` 의 `category` 가 Modern & Minimal · Bold & Expressive · Morphism & Effects · Layout & Structure · Retro & Nostalgic · Creative & Artistic · Professional & Corporate · Starter)만.
- 회사·제품 이름을 단 시스템(AI & LLM · Media & Consumer · Fintech & Crypto · Automotive · E-Commerce & Retail 등 산업 분류 · Themed & Unique)은 **가져오지 않는다** — 고객 프로젝트에 남의 브랜드를 입히지 않는다(RFC `내부 문서 `RFC-design-selection-loop-with-open-design-2026-09-27`` §A1).
- 스타일 분류 안에서도 특정 회사·사람의 디자인 언어에서 온 것은 뺀다: `ant` · `material` · `lingo` · `levels`(`DENIED_IDS`).

## 3. 다시 싱크하기 · 검사

```bash
bun scripts/design/vendor-open-design-systems.ts            # 원천 최신 체크아웃에서 다시 가져온다(선택에서 빠진 것은 지운다)
bun scripts/design/vendor-open-design-systems.ts --check    # 아무것도 안 쓴다 · 원천과 다르면 exit 1
```

- 원천 체크아웃을 먼저 최신으로(`git -C ~/source/ref/open-design fetch && git merge --ff-only origin/main`).
- 선택 규칙을 바꾸면(`STYLE_CATEGORIES` · `DENIED_IDS`) 이 문서 §2 도 같이 고친다.
