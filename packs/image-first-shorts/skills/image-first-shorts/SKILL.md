---
name: image-first-shorts
description: >-
  이미지 우선(image-first) 애니/캐릭터 세로 쇼츠 제작 파이프라인. 스토리보드 → codex 이미지(첫 프레임·단색 배경)
  → 영상(기본 Google Flow via Aside · 대체 Higgsfield) → 매팅(색차 키 + isnet-anime) → 소리(곡 BPM/드롭 실측 · TTS 음성인식 선별)
  → 코드 효과 레이어(HyperFrames) → 합성 → 사람 판정. 사람 승인 3곳 ⊕ 대기 4곳을 elanous 그래프가 지킨다.
  트리거: "이미지 우선 쇼츠", "캐릭터 쇼츠 만들어", "애니 쇼츠", "가챠 쇼케이스 영상", "image-first shorts",
  "Flow 로 캐릭터 영상", "밈 쇼츠 파이프라인". NOT for: 단발 이미지/영상 한 개(higgsfield-generate) ·
  실사 광고(ugc-ad-pipeline) · 프롬프트만 쓰기(higgsfield-prompt-engineer).
---

# image-first-shorts

> 출처: 공냥이 AI 실험실 «악역영애 말포이» AI 영상 제작 키트(https://malfoy-meme-making.vercel.app/) · 원작자 허락(2026-10-08) · 출처 명기 조건.
> 단계 구조·템플릿·도구 일부를 키트에서 가져와 우리 환경(mac·elanous 그래프)에 맞게 고쳤다. 원 작품(IP) 소재는 하나도 담지 않는다.

## ⭐ 한 줄

***AI 에게는 «그림»만 맡기고, 박자·글자·효과·합성은 «코드»가 한다.*** 영상은 반드시 우리가 만든 이미지를 첫 프레임으로 시작한다.

## 0. 원칙 일곱 (어기면 조용히 망가진다)

| # | 원칙 | 왜 | 어디서 막나 |
|---|---|---|---|
| P1 | **텍스트 단독 영상 금지** — 모든 컷은 첫 프레임 이미지로 시작 | 글로만 시키면 얼굴·옷을 영상 모델이 정한다 | `storyboard`·`video` 노드 |
| P2 | **합성 컷은 단색 배경(#1E3CFF) ⊕ 고정 카메라** → 나중에 매팅 | 배경이 한 색이어야 사람만 오려 낼 수 있다 | `storyboard` 노드 |
| P3 | 영상 프롬프트 꼬리 **«One continuous shot, no scene cuts. No dialogue, no music.»** | 모델이 컷을 쪼개거나 음악·대사를 넣는다 | 템플릿이 자동으로 붙인다 |
| P4 | **병렬 생성 결과는 파일명이 아니라 «내용»으로 확인·재명명** | 동시에 뽑으면 이름이 뒤바뀐다(키트 실측: 배치마다 3~8건) | `images` 노드(manifest `content_checked`) |
| P5 | **무거운 작업 동시 2개**(렌더·대량 ffmpeg·매팅) | 과부하로 세션이 죽는다(키트 실측: 로드 160 → 재부팅) | `tools/heavy.sh` |
| P6 | **IP 단어 0건** — 작품명·캐릭터명은 생성 프롬프트·가사에 안 쓴다(자막·VO 만) | 정책 거절·권리 문제 | `brief`·`storyboard` 노드(`ip_guard`) |
| P7 | **크레딧 예산** — 생성 직전 화면 단가 재확인, 재생성은 컷당 1회 | 영상 크레딧이 가장 비싸다 | `storyboard`(추정)·`video`(원장) |

## 1. 시작 — 그래프를 먼저 띄운다

```bash
PLUG=<설치 경로>          # elanous plugin list 로 확인
G=$PLUG/graphs/image-first-shorts.yaml
elanous graph run $G --dry-run --input "$(cat $PLUG/examples/input.json)" --json   # 외부 호출 0 · 구조 확인
elanous graph run $G --input '{"title":"…","workspace":"/절대/경로","video_backend":"flow-aside",
  "ip_blocklist":["원작 이름","캐릭터 이름"],"budget":{"video_credits":120,"eleven_chars":25000}}' --json
```

- 원작 캐릭터면 `ip_blocklist` 대신 `"ip_blocklist_none": true` 를 **명시**한다(비워 두면 `brief` 가 거절).
- 그래프가 멈추면 `status=awaiting-approval` ⊕ `pending.nodeId` 를 본다:
  - `wait_*` = «작업을 해 오라»는 대기. 아래 해당 단계를 하고 → `elanous graph approve image-first-shorts <run> --by <이름>` → `elanous graph run $G --resume <run> --json`.
  - `approve_*` = 🙋 **사람 관문**. 에이전트가 대신 승인하지 않는다 — 산출 위치·요약을 보고하고 기다린다. 반려(`--reject`)면 그래프가 해당 단계로 되돌린다.
- 상태: `elanous graph status image-first-shorts` · `elanous graph runs`.

## 2. 단계별 «이렇게 하라»

작업 폴더 구조(`brief` 가 만든다): `jobs/ assets/{images,video,matte} audio/vo fx out ledger`.

### S0 기획·스토리보드 → `storyboard` · 🙋 `approve_storyboard`
1. 레퍼런스 영상이 있으면 프레임 시트·스펙트로그램으로 컷 길이·박자를 잰다(`ffmpeg`).
2. `workspace/storyboard.json` 을 쓴다 — 꼴은 `$PLUG/examples/storyboard.json`.
   - `fixed.image` / `fixed.video` = **고정 블록**(편 전체 동일: STYLE·CHARACTER·OUTFIT·BACKGROUND·TAIL·KEEP).
   - `shots[]` = **가변 블록**(컷마다: POSE · CAMERA · ACTION · seconds 4|6|8 · kind `blue`|`inworld`).
   - 블록 문구 예시 = `templates/image_blocks.json` · `templates/video_blocks.json`. 조립 순서 = `templates/*_template.txt`.
3. `wait_storyboard` 승인 → `storyboard` 노드가 `jobs/images.jsonl` · `jobs/video.jsonl` · `jobs/inworld.txt` 를 조립하고 P1·P2·P3·P6·P7 을 검사한다.
4. 🙋 승인 요청 보고: 컷 수·blue/inworld 비율·크레딧 추정(최악 = 재생성 1회 포함)·박 격자.

### S1 이미지 → `images` · 🙋 `approve_images`
1. 캐릭터 시안(얼굴·머리·의상)을 먼저 3~4종 뽑아 🙋 고르게 한 뒤, 고른 시안을 `refs` 로 모든 컷에 붙인다.
2. 생성: `PROMPTS=$WS/jobs/images.jsonl OUTDIR=$WS PARALLEL=4 python3 $PLUG/skills/image-first-shorts/tools/imagegen_runner.py`
   (codex `$imagegen` · 병렬 4 · 실패 행만 `TIMEOUT=600` 으로 재실행 — 있는 파일은 건너뛴다).
3. **S1-c 내용 대조(P4)**: 이미지를 하나씩 **열어 보고** 프롬프트(포즈·의상·배경색)와 맞는지 확인한다. 이름이 뒤바뀌었으면 «내용 기준»으로 재명명하고, 맞으면 `assets/images/manifest.jsonl` 의 그 행을 `content_checked: true` 로 고친다. 어긋난 컷은 지우고 재생성(컷당 1회).
4. 컨택트 시트(`ffmpeg -pattern_type glob -i '*.png' -filter_complex tile=4x…`)를 만들어 🙋 승인 요청.

### S2 영상 → `video` (백엔드 교체 가능 · `input.video_backend`)
- **flow-aside(기본)**: Google Flow 웹 UI 를 Aside MCP(`aside-browser` 스킬)로 조작한다. 모드 = «첫 프레임 지정»(합성 컷 기본 — 단색 배경을 끝까지 지킨다) · 720p · 9:16 · ×1. 동시 제출 **5 이하**. 제출 직전 화면 단가를 `templates/pricing.json` 과 대조하고 다르면 멈춰 보고. «실패·오류·정책» 표시면 그 컷 중단.
  - 처음 쓰는 계정은 **싼 시험 2건**(최저 해상도)으로 배경 유지·컷 분할·워터마크 위치를 먼저 본다.
  - 한국 계정은 우하단 워터마크가 강제다 — 매팅의 가비지 매트로 대부분 지워지지만 캐릭터와 겹치면 남는다(🙋 최종 판정 항목).
- **higgsfield(대체)**: `higgsfield-generate` 스킬의 image-to-video(첫 프레임 = `first_frame`). 같은 프롬프트·같은 꼬리.
- 결과를 `assets/video/<id>.mp4` 로, 쓴 크레딧을 `ledger/video_credits.jsonl` 에 `{"id","credits"}` 한 줄씩. 원장 합이 예산을 넘으면 `video` 노드가 멈춘다(🙋 확인 없이 추가 생성 금지).

### S3 매팅 → `matte`
- `SKIP_LIST=$WS/jobs/inworld.txt $PLUG/skills/image-first-shorts/tools/matte_queue.sh $WS/assets/video $WS/assets/matte`
  (하이브리드: 색차 키 = 머리카락·가장자리 · isnet-anime = 가비지 매트·몸통 보호 · VP9 알파 webm ⊕ `_qc.jpg`. `heavy.sh` 2슬롯 아래).
- mac 가속: `MATTE_AI_BACKEND=coreml`. 배경이 고르게 깨끗하면 `--fast`(키 단독). 느린 동작은 `-- --ai-every 2`.
- 필요: `pip install rembg opencv-python numpy pillow onnxruntime` · 모델은 첫 실행 때 `~/.u2net` 에 받는다. **속도는 첫 컷에서 `matte_s_per_frame` 로 잰다**(미측정).
- QC 시트를 열어 머리카락 가닥·파란 프린지·워터마크 잔여를 본다.

### S4 소리 → `audio`
1. **곡**: `epidemic-sound` 스킬로 후보를 받거나(라이선스 곡) ElevenLabs Music(`templates/music_plan_template.json` + `tools/fill.py music`)으로 뽑는다. 감으로 고르지 않는다 — `python3 tools/analyze_music.py <목표BPM> 후보*.mp3` 로 BPM·드롭 시각을 재서 고른다.
2. 고른 곡을 박 격자에 맞게 자르고 `audio/beats.json`(`bpm`·`drop_s`·`beats_s`)으로 남긴다 — 이후 컷·효과가 이 시각을 그대로 쓴다.
3. **대사**: ElevenLabs TTS(`templates/tts_request_template.json`) 한 줄에 seed 2개로 테이크 2개 → `python3 tools/asr_pick.py --text "<대본>" --must <핵심단어> take*.mp3` 로 발음 틀린 테이크를 거른다. 비언어음은 `ear_check` → 귀로 듣고 `ear_checked`. 결과를 `audio/vo/picks.json` 에 `[{"line_id","take","verdict"}]`.
4. ElevenLabs 문자 사용량을 `input.budget.eleven_chars` 안에서 관리한다.

### S5 코드 효과 레이어 → `fx`
- `hyperframes` 스킬로 배경 블록·키네틱 타이포·플래시·띠를 **`beats.json` 시각에 맞춰** 렌더 → `fx/*.mp4|mov|webm`. 렌더는 `heavy.sh` 아래, `--workers 2` 이하.
- 알파 webm 을 HyperFrames 안에 넣지 말고(렌더가 멈춘 사례) 배경 패스·전경 패스를 따로 뽑아 ffmpeg 로 얹는다.

### S6 합성 → `compose` · 🙋 `approve_final`
- 순서(아래→위): 코드 배경 패스 → 알파 캐릭터(`assets/matte/*.webm`) → 코드 전경 패스(글자·플래시) → 카메라 펀치·그레인·비네트 → 오디오 mux·loudnorm. 결과 `out/final.mp4`(9:16, 오디오 포함 — 노드가 ffprobe 로 검사).
- 🙋 최종 판정 요청: 파일 경로 ⊕ 25/50/75% 지점 스틸 ⊕ 확인 항목(워터마크 잔여·박자 어긋남·자막 오탈자·레벨). 반려면 그래프가 `compose` 로 되돌린다.

## 3. 사람(🙋) 개입 지점

| 노드 | 무엇을 보나 | 반려하면 |
|---|---|---|
| `approve_storyboard` | 컷·박자·캐릭터 설정·크레딧 추정 | `storyboard` 로 |
| `approve_images` | 이미지 ↔ 프롬프트·설정 대조, 이름=내용 | `images` 로 |
| `approve_final` | 완성본 | `compose` 로 |
| (예산 초과·정책 표시) | 노드가 `fail` 로 멈춤 | 🙋 결정 후 새 런 |

## 4. 비용 감 (키트 실측 · 5편 합계 — 우리 값이 아니다, 첫 편에서 다시 잰다)
- 영상(Google Flow): 386 크레딧(720p 첫 프레임 모드 4초 7 · 6초 10 · 8초 12). 1편 11컷 = 88.
- 음성·음악(ElevenLabs): 약 19,475 문자.
- 이미지(codex): 약 35장, 병렬 4 · 배치당 2~4분.

## 5. 함정
- 병렬 이미지 회수: 러너는 codex `--json` 의 thread_id 로 그 세션 폴더만 집지만, thread_id 를 못 받으면 «가장 새 파일» 폴백(`race_fallback=true`) — **그 행은 반드시 내용 대조**.
- 영상 모델이 작은 장식(배지·문장)을 다른 모양으로 바꾼다 → `KEEP` 블록으로 이름을 대고 고정.
- 승인 노드를 에이전트가 «대신» 승인하지 않는다(`wait_*` 는 작업 완료 신호라 에이전트가 해도 된다).
- `graph run --from` 재개는 쓰지 않는다 — 반려 이력이 있는 런에서 실행기가 거절한다. 항상 `wait_*` 승인 ⊕ `--resume`.
