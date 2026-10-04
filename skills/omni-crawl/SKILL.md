---
name: omni-crawl
description: >
  통합 «문서» 검색/크롤링 스킬 (2026-09-02 재편 — 여론 축은 social-pulse 로 분리).
  일반 웹/뉴스 검색은 Tavily 1순위(공식 결정 2026-09-10 기본 ON · DuckDuckGo 는 **폴백 전용**으로 강등),
  크롤/스크랩/추출은 Firecrawl REST v2(풀본문·maxAge 캐시), 개발 아티팩트(README·문서·이슈·PR)는
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

## 역할 분담 (2026-07-06 재편 — 구독 최적화)

| 역할 | 1순위 (유료·기본) | 폴백 | 근거 (실측) |
|------|-------|------|-------------|
| **일반 웹 검색** | **tavily** | firecrawl → 🆓 ddg | 공식 결정 2026-09-10 기본 ON. ⚙️ `OMNI_CRAWL_TAVILY=0` 이면 ddg 1순위로 역전 |
| **뉴스** | tavily-news + fc-news(qdr 필터) | 🆓 ddg | ⚙️ 스위치 OFF 면 fc-news 단독 |
| **크롤/스크랩/PDF/추출** | firecrawl REST v2 | **jina 무료** | 풀본문·maxAge 캐시(기본 2일·500% 가속) |
| **개발 아티팩트(문서·이슈·PR)** | **fc-dev** (Developer Index) | ddg | 패시지 직반환 — 블로그보다 «정의한» 원문이 강한 답 |
| **X/레딧/커뮤니티 여론** | grok (유일 커버) | apify | $0.03/콜 — 엔진은 여기 있고 **표면은 `social-pulse`** |
| **X 트윗 벌크(정량)** | apify | — | 좋아요/날짜 필터 |
| **스크린샷(시각 소스)** | **capture (로컬 Chrome·무료)** | Dia CDP 9222 | JS 렌더 페이지 아티팩트 |
| **딥 리서치** | `--mode deep` 합성 파이프라인 | — | 기본 **tavily ~6cr + firecrawl ~5cr + grok $0.05** · 스위치 OFF 면 tavily 대신 무료 ddg ·**Sources 인용 강제** |

### 💸 비용 원칙 (2026-07-10 무료 티어 추가)

> **품질 동일 시 무료, 아니면 유료 우선.** 유료(firecrawl/grok/apify)가 **1순위·기본**.
> ⚙️ **tavily 가 1순위** — 공식 결정 2026-09-10: 2026-08-06 엔 고정비 때문에 ddg 를 1순위로 뒀는데,
> **DDG HTML 이 차단되면 웹 검색 축이 통째로 0건**이 되고 폴백조차 안 걸리는 구멍이 있었다(실측).
> 무료는 «돈 떨어졌을 때의 안전망»이지 1순위가 아니다 — 기본 ON, `OMNI_CRAWL_TAVILY=0` 으로 역전 가능.
> ⛔ ***「콜당 싸다」와 「늘 켜 둔다」는 다른 축이다.*** `--engine tavily` 명시 호출은 스위치와 무관하게 돈다.
> 무료(ddg 검색·jina 스크랩·capture)는 **① 유료 키 없음 ② 유료 0건 공백 ③ `--free` 명시
> ④ deep 스크랩 실패분 보충** 일 때만 자동 강등. "돈 떨어지면 죽는" 구조를 메우는 안전망.
> deer-flow(무료 DDG+Jina 기본, 유료 선택) 아키텍처에서 이식 — omni-crawl은 유료 우선으로 반전.

## 무료로 쓰는 길 (키 없이)

이 스킬 폴더에서 `bun scripts/main.ts "<검색어>" --free --print`로 DDG 검색을 사용합니다. URL 본문은 키 없는 Jina Reader 또는 로컬 HTML 추출을 사용할 수 있습니다. `--free`는 유료 엔진을 피하려는 명시적 선택이며, 검색 서비스 접속이 막히면 결과가 없을 수 있습니다.

## 내 키로 쓰는 길

유료 검색·스크랩은 자신의 `TAVILY_KEY`(Tavily)와 `FIRECRAWL_API_KEY`(Firecrawl)를 실행 환경에 설정합니다. 선택 엔진은 `XAI_API_KEY`(Grok), `APIFY_TOKEN`(Apify)를 사용합니다. 설정할 때 값이나 자격 파일은 이 스킬 문서·사본에 넣지 않습니다.

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
| **ddg** 🆓 | 웹 | DuckDuckGo HTML 검색 (키 불필요) — **폴백 전용**. `--health` 에서 실패해도 ⚠️ 경고일 뿐 전체 판정을 깨지 않는다 |
| **jina** 🆓 | URL | Jina Reader 마크다운 스크랩 (키리스·scrapeFree 내부) |
| **capture** 🆓 | 페이지 | 스크린샷 아티팩트 (로컬 headless Chrome → Dia CDP 폴백) |

## 딥리서치 (`--mode deep` 또는 "딥리서치/심층 분석" 인텐트)

자체 합성 파이프라인 (Tavily Research 엔드포인트 미사용 — 콜당 15~250cr 폭탄 회피):

```
1) 다각도 tavily advanced ×3 (core/outlook/risk) 병렬   ~6cr  ⚙️ OMNI_CRAWL_TAVILY=0 이면 ddg 무료 ×3 (0cr)
2) URL dedup → 상위 5개 firecrawl 풀스크랩 (캐시 2h)     ~5cr
3) grok-community 1콜 (X+레딧 여론 각도)                 ~$0.05
4) 기술 주제면 fc-dev 1콜 자동 가세 (looksTechnical 게이트)  ~2cr
→ 통합 마크다운 (풀본문이 스니펫보다 dedup 우선 생존)
```

## 실행

이 스킬 폴더에서 실행합니다.

```bash
bun scripts/main.ts "<검색어>" [OPTIONS]
```

### 예시

```bash
# 기본 (tavily · OMNI_CRAWL_TAVILY=0 이면 ddg 무료)
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
  추가 = `registerEngine({ id, capability, tier, available, run })` 1개 등록 (main.ts 수정 불필요).
  각 디스크립터의 `tier: paid|free` 가 자동 폴백 근거.
- **SSRF 가드** (`src/url-safety.ts`, 2026-07-10): 무료 로컬 페치/스크린샷 전 URL 검증 —
  localhost·RFC1918·클라우드 메타데이터(169.254.169.254)·난독화 IP(10진/16진/8진) 차단
  (deer-flow `url_safety.py` 포팅). fc-crawl/fc-map/capture/scrapeFree 에 적용. `--allow-private` opt-out.
- **무료 티어** (`src/free.ts`, 2026-07-10): DDG HTML 검색 + Jina Reader(keyless) 마크다운 +
  로컬 readability 폴백 (dep-free = 순수 fetch+regex). 유료 공백/키없음/`--free`/deep 실패분에만 발동.
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
- **폴백 체인**: tavily ↔ firecrawl → (최후) 🆓 ddg · scrape 실패 → waitFor 재시도 → 🆓 jina.
  공식 결정 2026-09-10: `wantedWeb` 에 ddg 를 포함시켜 **ddg 1순위였을 때 0건이면 유료로 «승격» 보충**되게 했다
  (종전엔 ddg 가 축 계산에서 빠져 보충이 아예 안 걸렸다).
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

## 스크랩 우선순위 (fallback 체인)

```
firecrawl scrape(REST·캐시) → waitFor 재시도(SPA)
  → 🆓 jina Reader(keyless) → 🆓 직접 HTML+로컬 readability → Dia CDP (로그인 필요 시)
```

웹 검색 축: `🆓 ddg → firecrawl` (⚙️ 스위치 ON 이면 `tavily → firecrawl → 🆓 ddg` 로 복귀).
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
| `OMNI_CRAWL_TAVILY` | ⚙️ tavily 상시사용 스위치 (기본 ON · `0` 이면 OFF, ddg 우선) | 선택 |
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
