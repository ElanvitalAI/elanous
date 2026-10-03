---
name: youtube-master
description: >
  통합 YouTube 처리 스킬. YouTube URL에서 자막 추출, 요약(brief/cards/detailed),
  학습노트 생성까지 하나의 엔트리포인트로 처리. 출력 타겟은 Obsidian, markdown,
  web, pdf. 전사 품질은 Supadata 우선, 필요 시 Cloud STT 자동 전환.
  Default owner for one youtube.com / youtu.be URL requesting transcript, summary,
  analysis, or a study note: 요약, 정리, 노트, 학습노트, study note, 자막,
  transcript, 상세 분석, 간단 요약, cc웹, ccv웹, pdf, 자막 강화, 전사 강화.
  Explicit YouTube absorb, channel, or subscription work belongs to yt-vault.
minTier: T2
composes: [omni-digest, diagram-master]
category: digest
requires: []
---

# youtube-master

YouTube URL 하나로 **자막 추출**, **요약**, **학습노트**, **웹/PDF 배포**까지 처리하는 통합 스킬.

## 트리거 조건

YouTube URL(`youtube.com`, `youtu.be`, `/shorts/`, `/embed/`)이 포함된 모든 요청에 이 스킬을 사용합니다.

## 3축 자동 라우팅

### 출력 형식 (Format)

| 형식 | 설명 | 트리거 키워드 |
|------|------|-------------|
| **brief** | 서머리 요약 (한 줄 결론 + 불릿 5~8개) | 간단히, 짧게, 요약만, brief |
| **cards** | 상세 카드별 요약 (8~16장 + 타임라인) — **기본값** | (기본), 요약, 카드 |
| **detailed** | 심층 분석 (풀 텍스트 + 데이터 근거 + SCQA) | 상세, 자세히, 깊게, 분석 |
| **study-note** | 학습노트 (챕터별 해설 + 타임스탬프 + 인사이트) | 노트, 학습노트, study note, 정리해줘 |
| **transcript** | 자막 원문만 추출 | 자막, transcript, 자막만 |
| **metadata** | 메타데이터 JSON만 | 메타데이터, metadata |

### 출력 타겟 (Target)

| 타겟 | 설명 | 트리거 키워드 |
|------|------|-------------|
| **obsidian** | Obsidian vault에 .md 저장 — **기본값** | (기본), Obsidian, 저장 |
| **markdown** | stdout 출력 | markdown, md로 |
| **web** | 웹페이지 생성/배포 | cc웹, ccv웹 |
| **pdf** | PDF 파일 생성 | pdf, PDF로 |

> **전달은 호출 서피스가 범용 처리**: 이 스킬은 요약 결과(마크다운 + Obsidian 저장 경로)만 산출한다.
> 특정 봇/채널로의 전송은 스킬이 하드코딩하지 않는다 — **호출한 서피스(monad 세션 sink·Claude Code 등)가
> 자기 채널에 맞게 렌더·전달**한다. 별도 전달 스크립트나 특정 봇에 결합하지 않는다(범용화).

### 전사 전략 (자동 결정)

- Supadata 자막 우선 (빠르고 무료)
- 자막 부족/부재 → 자동 Cloud STT 전환 (ElevenLabs → OpenAI → Gemini)
- 영상 1시간 이상 → 자동 Cloud STT
- 사용자가 "자막 강화" / "전사 강화" → Cloud STT 강제

## 실행

이 스킬 폴더에서 실행합니다.

```bash
npx tsx ./scripts/main.ts "<URL>" --message "<사용자 의도>" --print
```

### 자동 라우팅 예시

```bash
# 기본 카드형 요약 → Obsidian 저장
npx tsx scripts/main.ts "https://youtu.be/VIDEO_ID" --print

# 간단 요약
npx tsx scripts/main.ts "https://youtu.be/VIDEO_ID" --message "짧게 요약" --print

# 학습노트 생성
npx tsx scripts/main.ts "https://youtu.be/VIDEO_ID" --message "학습노트로 정리해줘" --print

# 상세 분석
npx tsx scripts/main.ts "https://youtu.be/VIDEO_ID" --message "상세 분석" --print

# 자막 강화 요약
npx tsx scripts/main.ts "https://youtu.be/VIDEO_ID" --message "자막 강화해서 요약" --print
```

### 부분 스킬 (자막/메타데이터만)

```bash
# 자막만 추출
npx tsx scripts/main.ts "https://youtu.be/VIDEO_ID" --only transcript --print

# 메타데이터만
npx tsx scripts/main.ts "https://youtu.be/VIDEO_ID" --only metadata
```

### 강제 옵션

```bash
# 형식 강제
npx tsx scripts/main.ts "https://youtu.be/VIDEO_ID" --format detailed --print

# 타겟 강제
npx tsx scripts/main.ts "https://youtu.be/VIDEO_ID" --target pdf --print

# Cloud STT 강제
npx tsx scripts/main.ts "https://youtu.be/VIDEO_ID" --cloud-stt --print

# 라우팅 확인만 (실행 없이)
npx tsx scripts/main.ts "https://youtu.be/VIDEO_ID" --message "학습노트" --dry-run
```

## 옵션 정리

| 옵션 | 설명 |
|------|------|
| `--message, -m <text>` | 사용자 의도 (자동 라우팅 힌트) |
| `--only <sub>` | 부분 실행: transcript, metadata |
| `--format <fmt>` | 출력 형식 강제: brief, cards, detailed, study-note |
| `--target <tgt>` | 출력 타겟 강제: obsidian, markdown, web, pdf |
| `--cloud-stt` | Cloud STT 전사 강제 |
| `--transcript-file <path>` | 기존 자막 파일 공급 |
| `--print` | 결과 stdout 출력 |
| `--dry-run` | 라우팅 결정 JSON만 출력 |
| `--no-obsidian` | Obsidian 저장 생략 |
| `--output-dir <path>` | 저장 디렉토리 오버라이드 |
| `--self-test` | 라우팅 smoke test |

## 무료로 쓰는 길 (키 없이)

공개 자막이 있으면 해당 자막을 받아 로컬에서 정리하거나, 오디오를 `yt-dlp`로 받아 로컬 `whisper`로 전사한 뒤 에이전트에게 텍스트 요약을 요청합니다. 이 수동 경로에는 API 키가 필요 없습니다. 아래 `scripts/main.ts` 자동 파이프라인은 YouTube 메타데이터·Supadata 자막·요약 API 키를 요구하므로 키 없는 자동 실행을 보장하지 않습니다.

## 내 키로 쓰는 길

자동 파이프라인을 사용하려면 실행 환경에 `YOUTUBE_API_KEY`(YouTube 메타데이터), `SUPADATA_API_KEY`(자막), `XAI_API_KEY`(요약)를 설정합니다. Cloud STT 및 대체 요약은 `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`를 각각 사용하는 선택 경로입니다. 값이나 자격 파일을 이 스킬 사본에 넣지 않습니다.

## 환경변수

필요한 API 자격은 실행 환경변수로 전달합니다. 저장 위치를 바꾸려면 `OBSIDIAN_VAULT_ROOT`를 설정합니다.

## 웹 배포 (cc웹/ccv웹)

cc웹/ccv웹 요청 시:
1. 이 스킬로 요약 마크다운 생성 + Obsidian 저장
2. stdout에 `---SIGNAL: webDeploy=html-only---` 또는 `---SIGNAL: webDeploy=deploy---` 출력
3. Claude가 `content-to-web` 스킬을 별도 호출하여 웹페이지 생성/배포

## 저장 위치

- 요약: `OBSIDIAN_VAULT_ROOT/YOUTUBE_SAVE_SUBDIR/YYYYMMDD_제목.md`
- 학습노트: `OBSIDIAN_VAULT_ROOT/YOUTUBE_STUDY_NOTE_SUBDIR/YYYYMMDD_제목_study-note.md`
- Cloud STT 아티팩트: `YOUTUBE_SAVE_SUBDIR/_youtube-cloud-stt/<timestamp>_<videoId>_<title>/`

## 설치

```bash
cd .
npm install
npx tsx scripts/main.ts --self-test
```

Cloud STT 경로 사용 시:
```bash
brew install yt-dlp ffmpeg
```
