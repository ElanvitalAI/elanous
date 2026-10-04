---
name: omni-digest
description: >
  통합 콘텐츠 요약 스킬. 비-YouTube URL의 X(Twitter) 포스트/아티클, 웹페이지,
  GitHub(레포/PR/이슈/커밋), PDF/DOCX/이미지 등 모든 소스를 하나의
  엔트리포인트로 요약. 요약 형식은 essential(간략)/rich-cards(카드형)/rich(심층).
  출력 타겟은 obsidian, markdown, web, pdf (복수 선택 가능).
  X API/OCR/다이어그램 내장. X 포스트는 note_tweet(장문) 전문과 첨부 영상 STT 전사까지
  자동 수집해 요약 근거로 삼는다. YouTube만 youtube-master에 위임.
  "sum" 키워드 시 summarize CLI(steipete/summarize)를 콘텐츠 추출 우선 엔진으로 사용.
  "enrich/풍부하게" 시 omni-crawl로 컨텍스트 보강. 원문 crawl/extract 요청은 omni-crawl 전용.
  Use when the user provides a non-YouTube URL or file and asks for:
  요약, 정리, 저장, 분석, digest, summarize, sum, enrich, 풍부, cc웹, ccv웹, pdf, obsidian.
  A YouTube URL belongs to youtube-master unless the user explicitly requests absorb,
  channel, or subscription work, which belongs to yt-vault.
minTier: T2
composes: [youtube-master, omni-crawl, diagram-master]
category: digest
# 오픈코어 경계(scripts/skill-boundary.ts) — requires = 없으면 이 스킬이 일을 못 하는 catalog/resources.yaml 자원 id
# 요약기 = Grok(XAI_API_KEY 필수 · src/summarize.ts requireEnv). X 수집 BEARER_TOKEN·S3·OCR 은 선택(없으면 그 갈래만 빠진다).
requires: [xai]
boundary: core
boundary_reason: 공식 결정 2026-09-27 «omni-digest 는 배포판 필수» — 요약에 LLM 이 필요한 것은 제품 전제(elanous 는 LLM 자격 없이 일을 못 한다 · xai 행 boundary_note «THE FLOOR»). 후속 = 요약기를 Grok 고정에서 elanous 공급자 체인으로
---

# OmniDigest

**모든 콘텐츠** → 자동 감지 → 요약 → 다중 타겟 출력 + 다이어그램.

## 무료로 쓰는 길 (키 없이)

본문 텍스트를 키 없는 Jina Reader 또는 로컬 파일 텍스트 추출로 확보하고, 로컬 `whisper`(영상 음성)나 로컬 OCR(이미지)이 있다면 이를 이용합니다. 얻은 텍스트를 읽고 에이전트에게 직접 요약을 요청합니다. 이 수동 경로는 API 키 없이 가능하지만, 아래 `scripts/main.ts`의 자동 요약은 현재 `XAI_API_KEY`를 요구하므로 키 없이 자동 실행되는 것으로 안내하지 않습니다.

## 내 키로 쓰는 길

자동 요약을 사용하려면 자신의 `XAI_API_KEY`를 실행 환경변수로 설정합니다. X 포스트 수집에는 추가로 `BEARER_TOKEN`, 이미지 OCR에는 `UPSTAGE_API_KEY` 또는 `OCR_API_KEY`를 사용할 수 있습니다. 키 값이나 자격 파일은 이 스킬 문서·사본에 넣지 않습니다.

## 트리거

URL (X, YouTube, 웹, GitHub) 또는 파일 (PDF, DOCX, 이미지) + 요약/정리/분석 의도.

## 소스 자동 감지

| 소스 | 패턴 | 처리 |
|------|------|------|
| **X 포스트** | `x.com/*/status/*` | X API v2 직접 (내장) + 장문 전문 + 영상 STT |
| **X 아티클** | `x.com/*/article/*` | Jina Reader (내장) |
| **YouTube** | `youtube.com`, `youtu.be` | → youtube-master 위임 |
| **웹페이지** | `https://...` | firecrawl CLI (기본) → summarize CLI 폴백 → Jina Reader 폴백 |
| **웹 (sum 모드)** | `https://...` + "sum" | summarize CLI (우선) → firecrawl 폴백 → Jina Reader 폴백 |
| **GitHub** | `github.com/...` | gh CLI |
| **로컬 파일** | `.pdf`, `.docx`, `.txt`, `.md` | 텍스트 추출 |
| **이미지** | `.png`, `.jpg` 등 | Upstage OCR / OCR.space |

## 요약 형식 (Format)

| 형식 | 트리거 |
|------|--------|
| **essential** | 간단히, 짧게, brief |
| **rich-cards** (기본) | (기본), 카드 |
| **rich** | 상세, 깊게, 분석 |

## 출력 타겟 (복수 선택)

| 타겟 | 트리거 |
|------|--------|
| **obsidian** (기본) | 저장 |
| **markdown** | md로 |
| **web** | cc웹 |
| **web-deploy** | ccv웹 |
| **pdf** | pdf |

### 전달은 호출 서피스가 범용 처리

이 스킬은 요약 결과(마크다운 + Obsidian 저장 경로)만 산출한다. 특정 봇/채널로의 전송은 스킬이 하드코딩하지 않는다 —
**호출한 서피스(elanous 세션 sink·Claude Code 등)가 자기 채널에 맞게 렌더·전달**한다. 별도 전달 스크립트나 특정 봇에 결합하지 않는다(범용화).

## 실행

이 스킬 폴더에서 실행합니다.

```bash
bun scripts/main.ts "<INPUT>" --message "<의도>" --print
```

### 예시

```bash
# X 포스트 카드형 요약
bun scripts/main.ts "https://x.com/user/status/123" --print

# 웹 아티클 상세 + 다이어그램
bun scripts/main.ts "https://example.com" --format rich --diagram --print

# GitHub PR + Obsidian + 웹 동시
bun scripts/main.ts "https://github.com/o/r/pull/42" --target obsidian,web --print

# PDF OCR + 요약
bun scripts/main.ts "/path/to/scan.pdf" --print

# 이미지 OCR + 요약
bun scripts/main.ts "photo.png" --print
```

## 옵션

| 옵션 | 설명 |
|------|------|
| `--message, -m` | 의도 (자동 라우팅) |
| `--format` | essential, rich-cards, rich |
| `--target` | 쉼표 구분: obsidian, markdown, web, web-deploy, pdf |
| `--diagram` | Mermaid 다이어그램 포함 |
| `--content` | 사전 추출 텍스트 (Claude 파이핑) |
| `--print` | stdout 출력 |
| `--dry-run` | 라우팅만 확인 |
| `--no-obsidian` | Obsidian 생략 |
| `--output-dir` | 저장 경로 오버라이드 |
| `--self-test` | 테스트 |

## 환경변수

필요한 환경변수 이름만 아래에 안내합니다. 값과 자격 파일은 이 팩에 포함하지 않습니다.

자동 요약: `XAI_API_KEY`. X 포스트 수집 시: `BEARER_TOKEN`.
선택: `OBSIDIAN_VAULT_ROOT`, `UPSTAGE_API_KEY`, `OCR_API_KEY`, `AWS_S3_BUCKET`(X 첨부 이미지·영상 프레임 «시각 흡수» — 공개 읽기 버킷 ⊕ `aws` CLI 자격 · 없으면 그 갈래만 건너뛴다 · 기본값 없음)

## 흡수한 기능

### X API (x-to-obsidian 흡수)
- X API v2로 트윗 메타/댓글/링크 직접 수집
- **note_tweet 전문 확보**: 280자를 넘는 장문 트윗은 `tweet.text`가 잘려서 온다.
  `tweet.fields=note_tweet`를 함께 요청해 전문을 쓰고, `meta.isLongform`으로 표시한다.
  (이 필드를 안 넣으면 장문 포스트의 절반 이상이 요약에서 통째로 누락된다)
- X 아티클은 Jina Reader로 본문 스크래핑
- X 전용 프롬프트 (포스트/아티클 × essential/rich-cards/rich)

### 첨부 영상 STT (`src/media.ts`)

X 포스트에 영상이 있으면 **자동으로 다운로드 → 오디오 추출 → 전사**해 요약의 1차 자료로 넣는다.
발표·데모·피치 영상은 본문 텍스트보다 정보량이 많은 경우가 많아, 이걸 빼면 요약이 껍데기가 된다.

```
X API media.variants → 최저 비트레이트 MP4 → ffmpeg 오디오 추출 → STT → 프롬프트 주입
                                                                    └→ Obsidian "# 영상 전사" 부록
```

| 항목 | 내용 |
|------|------|
| 다운로드 | `media.variants`의 MP4 직링크 (yt-dlp 불필요, curl로 충분) |
| **화질 선택** | **최저 비트레이트 변형**. 전사는 오디오만 쓰는데 4K를 받으면 66초짜리가 200MB를 넘는다 |
| STT 1순위 | 로컬 `whisper` CLI (무료·오프라인) |
| STT 2순위 | youtube-master `scripts/transcribe-local.ts` (ElevenLabs → OpenAI → Gemini 체인) |
| 실패 시 | 전사 생략하고 **텍스트만으로 요약 계속** (파이프라인 중단 없음) |

**옵션**

| 플래그 | 설명 |
|--------|------|
| `--no-media` | 영상 전사 비활성 (기본은 영상 있으면 자동 전사) |
| `--media-lang <code>` | 전사 언어. 기본 `en`, 한국어 영상은 `ko` |

**환경변수**

| 변수 | 기본값 | 용도 |
|------|--------|------|
| `OMNI_DIGEST_MEDIA_MAX_MS` | `1200000` (20분) | 이보다 긴 영상은 전사 생략 |
| `OMNI_DIGEST_WHISPER_MODEL` | `small` | 로컬 whisper 모델 |
| `OMNI_DIGEST_STT_LANG` | `en` | 기본 전사 언어 |
| `YOUTUBE_MASTER_ROOT` | 설치한 형제 `youtube-master` 스킬 폴더 | 폴백 STT 스킬 경로 |

> **주의**: `--media-lang`을 실제 음성과 다르게 주면 엔진이 번역하거나 오전사한다.
> 한국어 영상에 기본값 `en`이 걸리지 않도록, 한국어 콘텐츠는 `--media-lang ko`를 명시할 것.

### X 첨부 미디어 «시각» 흡수 (`src/visual.ts`)

전사는 소리만 본다 — 말 없는 화면 데모·모션그래픽·벤치 표 이미지는 전사가 비거나 «MUSIC» 한 줄이었다(2026-09-27 저장된 메시지 X 5편 실측). 그래서 화면도 흡수한다.

| 미디어 | 처리 | 노트 |
|---|---|---|
| 사진 | `?name=large` 로 받아 S3(`x/media/<tweetId>/photo_N.jpg`) → Grok 비전 설명(표·그래프 수치, 화면 글자까지) | `# 첨부 미디어 (시각)` 부록에 이미지 ⊕ 설명 |
| 영상·GIF | 장면 전환 프레임(최대 8장 · 모자라면 균등 6장) → S3(`x/media/<tweetId>/vN_fNN.jpg`) → Grok 비전으로 화면 흐름 설명 | 프레임 띠 ⊕ 설명 |

- 설명은 요약 프롬프트에도 들어간다(«첨부 미디어 — 1차 자료»). `--no-media` 면 전사와 함께 끈다.
- 무음 영상은 전사를 건너뛴다(`ffprobe` 로 오디오 스트림 확인) — 화면은 시각 흡수가 본다.
- 의존: `ffmpeg`(`-fps_mode` — 옛 `-vsync` 는 새 ffmpeg 에서 없어졌다) · `aws` CLI · `XAI_API_KEY`. 비전 모델 = `GROK_VISION_MODEL` → `GROK_MODEL` → `grok-4-1-fast-reasoning`. 프레임 상한 영상 길이 = `OMNI_DIGEST_FRAMES_MAX_MS`(기본 10분).
- 실패는 전부 건너뛰고 요약은 계속한다.

### OCR (photo-intake-ocr 흡수)
- Upstage Document OCR (TypeScript 네이티브 포팅)
  - API 키: 실행 환경의 `UPSTAGE_API_KEY` 사용 권장
  - 한국어+영어 혼합 문서 지원
- OCR.space 자동 폴백
- PDF → pdftotext 실패 시 OCR 자동 전환
- 이미지 파일 자동 OCR

### 다이어그램 (내장)
- `--diagram` 또는 "다이어그램/시각화" 키워드로 활성화
- Grok으로 Mermaid 다이어그램 코드 자동 생성
- 요약 마크다운에 다이어그램 섹션 자동 추가
- content-to-web RICH 모드에서 Excalidraw/Mermaid 추가 다이어그램 가능

## 웹 배포 연계 (content-to-web)

타겟에 web/web-deploy 시:
1. 요약 마크다운 + Obsidian 저장
2. `---SIGNAL: webDeploy=...---` 출력
3. Claude가 content-to-web 스킬 호출
   - QUICK: Becoming X 스타일 웹페이지
   - RICH: Excalidraw 다이어그램 + SVG 포함 풍부한 아티클
4. RICH 모드 다이어그램: diagram-master 스킬 (auto-routing) → PNG → Live SVG

## Obsidian 저장 (소스별 자동 분류)

| 소스 | 경로 |
|------|------|
| X | `03. X Summary/` |
| YouTube | `02. Youtube Summary/` |
| 웹 | `04. Web Digest/` |
| GitHub | `06. GitHub Digest/` |
| 문서 | `07. Document Digest/` |

## summarize CLI 연동

`steipete/summarize` CLI를 콘텐츠 추출 엔진으로 통합.

두 가지 모드:

| 모드 | 키워드 | 파이프라인 | LLM |
|------|--------|-----------|-----|
| **sum** | `sum` | summarize `--extract` → Grok 요약 | Grok (기존) |
| **sum full** | `sum full` | summarize CLI end-to-end | summarize의 auto 모델 (OpenAI/Grok/Gemini/로컬) |

- **sum**: summarize CLI가 **1순위 추출기**, Grok이 요약 (기존 품질 유지)
- **sum full**: summarize CLI가 **추출+요약 모두 수행** (Grok API 비용 절감, 더 빠름)
- **기본 모드** (sum 없음): firecrawl → summarize CLI → Jina Reader 순 폴백

```bash
# sum 모드: summarize 추출 → Grok 요약
bun scripts/main.ts "https://example.com" -m "sum 요약" --print

# sum full 모드: summarize CLI가 추출+요약 모두 (Grok 스킵)
bun scripts/main.ts "https://example.com" -m "sum full" --print

# 기본 모드 (summarize는 firecrawl 폴백으로 동작)
bun scripts/main.ts "https://example.com" --print
```

### summarize CLI 설치

```bash
brew install summarize
# 또는
npm i -g @steipete/summarize
```

### summarize CLI 설정 (선택)

```bash
summarize --help
```

## 설치

```bash
cd <installed-skill-folder>
bun scripts/main.ts --self-test
```
