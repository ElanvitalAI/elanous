---
name: omni-crawl
description: >
  통합 «문서» 검색/크롤링 스킬 (2026-09-02 재편 — 여론 축은 social-pulse 로 분리).
  일반 웹/뉴스 검색은 계약 선택으로 DuckDuckGo 무료를 먼저 시도하고 빈 결과면 Tavily/Firecrawl BYOK로 진행한다.
  URL 스크랩은 Jina/로컬 readability 무료 후 Firecrawl REST v2로 진행한다. 개발 아티팩트(README·문서·이슈·PR)는
  Firecrawl Developer Index(`--engine fc-dev` — 매칭 패시지를 직접 반환해 스크랩 콜 절감).
  --mode deep 딥리서치 (다각도 검색 + 풀스크랩 + 커뮤니티 합성 · 기술 주제면 fc-dev 자동 가세 —
  검증·인용 보고서가 필요하면 이게 아니라 deep-research 하니스).
  Firecrawl Monitors 관리(scripts/monitor.ts — 뉴스룸/IR 변경감지). --health 전 엔진 라이브 진단.
  --json 파이프라인용 구조화 출력.
  Dedicated owner for raw source crawl, scrape, extract, and collection: 검색, 크롤링, 추출,
  원문 추출, 스크랩, 리서치, 딥리서치(수집형), 뉴스 검색, 기업/종목 웹 정보 수집, 트렌드 파악,
  사이트 변경감지, 뉴스룸 모니터링, search, crawl, scrape, extract, research, monitor,
  "~에 대해 찾아줘", "웹에서 검색", "뉴스 모아줘", "이 사이트 감시해줘", "문서 찾아줘".
  경계 — X/레딧/커뮤니티 «여론»=social-pulse · 코딩 중 라이브러리/에러/이슈 1차 출처=
  firecrawl-developer-index · 비-YouTube URL 요약=omni-digest · 단일 YouTube=youtube-master ·
  명시적 YouTube absorb·채널=yt-vault · 매력도 점수화=asset-attractiveness ·
  인용 검증 보고서=deep-research. 여기는 키워드→«문서» 원문 수집이 본분.
minTier: T2
composes: [omni-digest, stochastic-multi-agent-consensus, asset-attractiveness]
category: search
# 오픈코어 경계(scripts/skill-boundary.ts) — requires = 없으면 이 스킬이 일을 못 하는 catalog/resources.yaml 자원 id
requires: []
---

# OmniCrawl

**키워드 하나** → 역할기반 멀티 엔진 라우팅 → 통합 마크다운/JSON → (선택) omni-digest 요약.

## 계약 선택 (2026-11-09)

자동 라우팅은 공급자 이름 대신 `search.web@1`, `search.news@1`, `scrape.url@1`, `crawl.site@1`, `social.posts@1` 등의 요구 계약을 만든다. `src/registry.ts` 공급자 선언의 `provides`·`tier`·`latency`·`keyEnv`·`conditions`로 후보를 고른다. 무료 공급자 성공 시 BYOK는 호출하지 않는다. 무료 결과가 비거나 실패하면 적격 BYOK를 순서대로 한 번씩 시도한다. `keyEnv` 목록은 OR이며 값은 출력하지 않는다.

| 요구 능력 | 무료 첫 경로 | 후속 BYOK |
|---|---|---|
| 웹·뉴스 검색 | DuckDuckGo | Tavily, Firecrawl, Grok 웹(해당 계약) |
| URL 본문 스크랩 | Jina Reader, 로컬 readability | Firecrawl 스크랩 |
| 소셜 게시물 | DDG의 X/Reddit 공개 검색 | Grok, Apify(조건 일치 시) |
| 사이트 크롤·맵·에이전트 추출·개발 인덱스 | 해당 무료 공급자가 없으면 명시적 소진 | 기존 Firecrawl 어댑터 |
| 스크린샷 | 로컬 capture | — |

`--engine <id>`는 기존 엔진 ID를 직접 호출하는 호환 경로다. `--free`는 요구 능력에서 무료 공급자만 허용한다. `--json`과 `--print`의 출력 마커는 유지된다. `OMNI_CRAWL_TAVILY`는 자동 순위를 제어하지 않으며 명시 `--engine tavily`도 그대로 동작한다.
기간을 지정한 뉴스는 DDG를 제외하고 기간 필터를 지원하는 공급자만 선택한다. `research.deep@1`과 `extract.structured@1`의 상위 계약은 capability 레지스트리가 맡고, 이 스킬의 deep 합성은 단계별 검색·스크랩 계약을 소비한다.

## 무료로 쓰는 길 (키 없이)

`bun scripts/main.ts "<검색어>" --print`는 무료 검색부터 시작한다. `--free`는 BYOK 폴백도 금지한다. URL 본문은 Jina Reader와 로컬 readability를 순서대로 시도한다.

## 내 키로 쓰는 길

`TAVILY_KEY`/`TAVILY_API_KEY`, `FIRECRAWL_API_KEY`, `XAI_API_KEY`, `APIFY_TOKEN` 중 해당 키가 있으면 무료 경로 공백 뒤 적격 공급자로 호출된다. 값이나 자격 파일은 스킬 문서에 넣지 않는다.

## 엔진

| 엔진 | 소스 | 내용 |
|------|------|------|
| **firecrawl** | 웹 | Firecrawl REST 검색+풀스크랩 |
| **fc-news** | 뉴스 | Firecrawl sources:news + tbs 기간필터 |
| **fc-crawl** | 사이트 | 사이트 전체 크롤 (비동기 잡·limit 10) |
| **fc-map** | 사이트 | URL 구조 탐색 |
| **fc-dev** | 개발 아티팩트 | Developer Index — README·문서·이슈·PR 7천만+. «매칭 패시지(마크다운)» 직접 반환 = 스크랩 콜 불필요. 실측 2cr(k=10·passages=2) |
| **fc-agent** | 웹 | FIRE-1 에이전트 (⚠ CLI 전용·대화형) |
| **grok-x / grok-reddit / grok-community / grok-web** | X/레딧/웹 | Grok 검색 (grok-4-1-fast-reasoning) |
| **apify** | X | 트윗 벌크 수집 |
| **ddg** 🆓 | 웹 | DuckDuckGo HTML 검색 (키 불필요) — 무료 자동 첫 경로. `--health` 에서 실패해도 ⚠️ 경고일 뿐 전체 판정을 깨지 않는다 |
| **jina-reader / local-readability** 🆓 | URL | Jina Reader·로컬 HTML 본문 추출 계약 어댑터 |
| **capture** 🆓 | 페이지 | 스크린샷 아티팩트 (로컬 headless Chrome → Dia CDP 폴백) |

## 딥리서치 (`--mode deep`)

기존 합성 파이프라인을 유지하되 세 각도 검색은 `search.web@1`, 상위 URL 본문은 `scrape.url@1`, 커뮤니티 각도는 `social.posts@1`, 기술 주제의 개발 아티팩트는 `search.developer@1`로 선택한다. 공급자는 각 계약의 무료→BYOK 순서가 정한다. 결과를 합쳐 URL을 중복 제거하고 Sources 섹션을 출력한다.

## 실행

이 스킬 폴더에서 실행합니다.

```bash
bun scripts/main.ts "<검색어>" [OPTIONS]
```

### 예시

```bash
# 기본 (search.web@1 · 무료 우선)
bun scripts/main.ts "Samsung HBM4 경쟁력" --print

# 뉴스 (오늘자)
bun scripts/main.ts "삼성전자 뉴스" --time-range day --print

# 딥리서치
bun scripts/main.ts "SK하이닉스 전망" --mode deep --print

# Conatus 파이프라인 (구조화 JSON)
bun scripts/main.ts "NVDA earnings" --json

# 전 엔진 라이브 진단 (+크레딧 잔량)
bun scripts/main.ts --health

# 개발 아티팩트 (라이브러리 동작·에러·버그 수정 여부)
bun scripts/main.ts "pydantic model_validator wrap mode" --engine fc-dev --print

# X 트윗 벌크 / 커뮤니티 / 사이트 크롤
bun scripts/main.ts "bitcoin outlook" --engine apify --min-favs 50 --print
bun scripts/main.ts "Claude Code 반응" --engine grok-community --print
bun scripts/main.ts "https://news.samsung.com" --engine fc-crawl --print
```

## 옵션

| 옵션 | 설명 |
|------|------|
| `--message, -m` | 의도 힌트 (역할 자동 라우팅 + digest 연계) |
| `--engine` | 엔진 강제 (쉼표 구분) — `fc-dev`(개발 아티팩트)·`ddg`(무료 검색)·`capture`(스크린샷) 포함 |
| `--free` | 무료 티어 강제 (ddg 검색 / jina 스크랩 / capture) |
| `--allow-private` | SSRF 가드 opt-out (내부/사설 IP 타깃 허용 — 주의) |
| `--mode auto\|deep` | deep = 딥리서치 합성 파이프라인 (+Sources 인용 강제) |
| `--depth basic\|advanced` | tavily 깊이 (advanced=2cr·chunks_per_source 3) |
| `--limit <n>` | 검색 결과 수 (기본 5) |
| `--time-range day\|week\|month\|year` | 최신성 필터 (tavily+firecrawl tbs 매핑) |
| `--json` | 파이프라인용 구조화 JSON (`---BEGIN_OMNI_CRAWL_JSON---` 마커) |
| `--health` | 전 엔진 1콜 라이브 진단 + 크레딧 잔량 (exit 0/1) |
| `--min-favs` / `--max-items` / `--lang` | Apify 옵션 |
| `--save` / `--no-save` | Obsidian 저장 |
| `--print` | 마크다운 stdout (`---BEGIN_OMNI_CRAWL_MARKDOWN---` 마커) |
| `--dry-run` / `--self-test` | 라우팅 확인 / 회귀 테스트 |

## 아키텍처 노트

- **프로바이더 레지스트리** (`src/registry.ts`, 2026-07-10): 엔진 디스패치를 switch 하드코딩에서
  디스크립터 등록으로 전환 (deer-flow `use: module:function` 플러그인 패턴 이식). 신규 프로바이더
  추가 = `registerEngine({ id, capability, provides, tier, keyEnv, conditions, available, run })` 등록.
  계약별 무료→BYOK 선택과 빈 결과 폴백은 레지스트리 공용 함수가 맡는다.
- **SSRF 가드** (`src/url-safety.ts`, 2026-07-10): 무료 로컬 페치/스크린샷 전 URL 검증 —
  localhost·RFC1918·클라우드 메타데이터(169.254.169.254)·난독화 IP(10진/16진/8진) 차단
  (deer-flow `url_safety.py` 포팅). fc-crawl/fc-map/capture/scrapeFree 에 적용. `--allow-private` opt-out.
- **무료 티어** (`src/free.ts`, 2026-07-10): DDG HTML 검색 + Jina Reader(keyless) 마크다운 +
  로컬 readability 폴백 (dep-free = 순수 fetch+regex). 자동 계약 선택의 첫 경로다.
- **web_capture** (`src/capture.ts`, 2026-07-10): headless Chrome `--screenshot` 셸아웃 →
  Dia CDP(9222) 폴백. PNG 아티팩트는 로컬 캡처 디렉토리에 저장.
- **REST 직결** (2026-07-06): firecrawl CLI shell-out 제거 — 크론/데몬 최소 PATH 즉사,
  launchctl 키 증발, 콜당 146ms 스폰, execSync 이벤트루프 블로킹(병렬성 파괴)이
  간헐 고장의 근본원인이었음(실측). 키는 실행 환경에서 전달. fc-agent만 CLI 잔존(대화형 전용).
- **Developer Index** (`fc-dev`, 2026-09-02 배선): `POST /v2/search/developer`. 다른 v2
  엔드포인트와 **봉투가 다르다** — 파라미터는 `limit` 이 아니라 **`k`**(`limit` 보내면 400),
  응답은 `data` 가 아니라 **`results`** (실측 2026-08-31). `id` 접두사가 곧 종류
  (`readme:` `doc:` `issue:` `pull_request:` `web:`) 라 렌더 헤딩에 `id` 를 그대로 쓴다.
  ⚠️ `min_stars`/`language`/`topic`/`license` 는 «저장소» 사실이라 `sources` 스코프 없이 보내면
  doc 결과가 통째로 빠진다(문서 대부분은 뒤에 저장소가 없다) — 사양이지 결함이 아니다.
  대화형 코딩 질문은 별도 `firecrawl-developer-index` 스킬(공식·업스트림 유지보수)이 맡고,
  여기 `fc-dev` 는 **파이프라인·deep 모드용** 프로그래매틱 경로다.
- **표면 분리** (2026-09-02): 여론 축을 `social-pulse` 스킬로 분리 — 단, **설명만** 갈랐고
  코드·엔진·폴백·dedup 은 이 한 벌을 공유한다. grok 은 100줄, apify 는 66줄로 전체의 7%라
  떼어낼 덩어리가 아니었고, `--mode deep` 이 ddg+firecrawl+grok 을 한 파이프라인에서 합성하므로
  프로세스 경계를 넣으면 위 «REST 직결» 항목이 기록한 고장을 재현한다. `--engine grok-*` 호출 계약은 불변.
- **폴백 체인**: 계약 적격 공급자를 무료→BYOK→paid, 선언 latency, ID 순으로 정렬하고 빈 결과·실패 때 다음 공급자를 한 번씩 호출한다.
- **URL dedup**: 엔진 간 중복 제거. deep 모드는 풀본문 우선 생존.
- **비용 가시성**: 결과에 `비용: firecrawl ~5cr` 표시. `--health`가 잔량 보고.
- **API 스펙 보관**: `specs/` — Firecrawl v2·Tavily 전 엔드포인트 (2026-07-06 다운로드).
  배선된 함수: search/scrape/map/crawl/batchScrape/creditUsage (firecrawl.ts) ·
  search/extract/usage (tavily.ts). 미배선 잔여 능력(필요 시 확장): Firecrawl
  Monitors(변경감지 웹훅 — Conatus 뉴스 모니터링 후보)·Parse(문서 업로드)·
  Research(논문/GitHub)·Interact 세션 REST · Tavily crawl/map·Research 엔드포인트(크레딧 大).

## 모니터링 (Firecrawl Monitors — 뉴스룸/IR 변경감지)

페이지 변경감지 모니터를 만들면 Firecrawl이 스케줄대로 체크하고,
**elanous 크론 폴러**(`monad-agent/scripts/firecrawl-monitor-alert.ts` · */30분)가
changed/new 페이지를 텔레그램(/v1/outbound)으로 알림. 첫 체크는 baseline(무발송).

```bash
# 생성 (자연어 스케줄 · goal=judge 판정으로 노이즈 억제·변경페이지당 1cr)
bun scripts/monitor.ts create --name "삼성전자 뉴스룸" \
  --urls "https://news.samsung.com/kr/latest" --schedule "every 1 hours" \
  --goal "새 기사 등장 시 알림. 날짜/배너 등 사소한 변경 무시."
bun scripts/monitor.ts list                 # 목록+예상 크레딧/월
bun scripts/monitor.ts checks <monitorId>   # 체크 이력 (same/changed/new)
bun scripts/monitor.ts run <monitorId>      # 즉시 1회 체크
bun scripts/monitor.ts delete <monitorId>
```

운영 중(2026-07-06~): 삼성전자 뉴스룸·SK하이닉스 뉴스룸 (각 1h·~1,440cr/월).

## 스크랩 우선순위 (계약 선택)

```
🆓 Jina Reader → 🆓 직접 HTML+로컬 readability → Firecrawl scrape(REST·캐시, BYOK)
```

웹 검색 축: `🆓 ddg → Tavily → Firecrawl → Grok 웹`(각 키가 있고 앞 공급자가 비었을 때만 진행).
SSRF 가드는 무료 로컬 페치·capture 에 항상 적용(`--allow-private` 로만 해제).

## omni-digest 연계

의도에 "요약/정리/분석" 키워드 포함 시:

1. omni-crawl이 검색 결과 마크다운 생성
2. `---SIGNAL: digestRequested=true format=rich-cards---` 출력
3. Claude가 크롤 결과 마크다운을 omni-digest `--content`로 전달

```
omni-crawl "AI agent" --message "요약" --print
    ↓ 크롤 결과 마크다운
omni-digest --content "<크롤결과>" --format rich-cards --print
```

## 환경변수

실행 환경의 변수 이름을 아래 표에서 확인합니다. 자격 파일은 이 팩에 포함하지 않습니다.

| 변수 | 용도 | 필수 |
|------|------|------|
| `TAVILY_KEY` | Tavily 검색/추출 | tavily 사용 시 |
| `OMNI_CRAWL_TAVILY` | 옛 자동 순위 스위치; 계약 선택에는 영향 없음 | 선택 |
| `FIRECRAWL_API_KEY` | Firecrawl REST | firecrawl 사용 시 |
| `XAI_API_KEY` | Grok 검색 | Grok 사용 시 |
| `APIFY_TOKEN` | Apify tweet-scraper | Apify 사용 시 |
| `JINA_API_KEY` | Jina Reader rate-limit 상향 (무료 티어는 키 없이도 동작) | 선택 |
| `OMNI_CRAWL_CHROME` | headless Chrome 바이너리 경로 (기본 자동 탐지) | 선택 |
| `OMNI_CRAWL_CAPTURE_DIR` | 스크린샷 저장 디렉토리 (기본 자동 선택) | 선택 |
| `OMNI_CRAWL_CDP_PORT` | Dia/Chrome CDP 폴백 포트 (기본 9222) | 선택 |
| `OBSIDIAN_VAULT_ROOT` | Obsidian 볼트 경로 (자동 저장 대상) | 저장 시 |
| `OMNI_CRAWL_SAVE_SUBDIR` | 볼트 내 저장 서브디렉토리 (기본: `00. Inbox/05. Crawl`) | 선택 |

## CLI 계약 (파이프라인 호환 — 절대 유지)

`asset-attractiveness`(Conatus 매력도)·elanous `research-bridge`가 다음 계약으로 호출:
positional query + `--engine <e>` + `--print` → exit 0 + `---BEGIN_OMNI_CRAWL_MARKDOWN---` 마커.
신규 플래그(--mode/--json/--health 등)는 전부 추가형 — 기존 호출 무변경 동작.
