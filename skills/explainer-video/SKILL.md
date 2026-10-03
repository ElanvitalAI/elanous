---
name: explainer-video
description: Make a narrated «N things at once» explainer video from a list of facts — a script in a fixed grammar, word-timed Korean or English voice-over (ElevenLabs), line-art diagrams that advance one step per spoken line, and a checked HyperFrames render. Use when someone asks to summarise a release, an event or a list of changes as a short explainer video.
requires: []
---

# Explainer video

You turn a list of facts into one continuous explainer: a header with progress dots, a black card before each chapter, a line-art diagram on the left that moves one step per spoken line, and on the right the chapter number, title, subtitle, a short rule and a one-line caption whose keywords light up **at the moment they are spoken**. A progress bar runs along the bottom.

`$SKILL` is this folder. Work in a project folder of your own (never inside `$SKILL`).

```
<project>/script.json ─▶ bun $SKILL/engine/vo.ts ─▶ node $SKILL/engine/build.mjs ─▶ <project>/hf/ ─▶ hyperframes check · snapshot · render ─▶ QC
```

## 1. Write `script.json`

Copy `examples/elanous-0.2.5/script.json` and replace the content. Shape:

- `title`, `voice` (`id`, `model`), `sources` (where every claim comes from).
- `intro.beats`, `chapters[] { title, sub, diagram, beats[] }`, `outro { beats, cta { line, links } }`.
- A beat is `{ vo, cap, hl? }`:
  - `vo` is what is **spoken**. Write names the voice can't read in the way it should say them (`plugin add` → «플러그인 애드»).
  - `cap` is what is **shown**. Wrap keywords in `**…**`.
  - `hl` maps a shown keyword to the spoken word that lights it: `[["elanous-basics", "베이직스"]]`. When omitted, the keyword's first word is looked up in `vo`.
- `diagram` is one of `mission`, `terminal`, `nodes`, `keys` or `approve`. The intro always uses `agenda` and the outro uses `summary`.

The grammar of a chapter (take it from the reference, don't improvise):

1. **Name it** — «N번째는 X입니다».
2. **Say it plainly** — one line on what it is.
3. **Show one concrete case** — «예를 들어 …», or the real first run.
4. **Contrast** — «(before) … 였다면, (now) …».

The outro gives one line that sums everything up, then the CTA.

⛔ Every claim must trace to a merged change or a measured run, listed in `sources`. Don't write «fully autonomous», dates you can't promise, or comparisons with other products.

## 2. Voice — `bun $SKILL/engine/vo.ts <project>/script.json`

- Makes one `/with-timestamps` call per beat and writes `source/vo/<key>.mp3` and `<key>.json`, where the JSON holds per-character times.
- A beat whose text hash is unchanged is skipped, so you can edit one line and re-run.
- The key comes from `ELEVENLABS_API_KEY`, which the plugin connector sets (`elanous plugin credentials video-explainer`). Never print it.
- **No key** → a draft voice from macOS `say` (a Korean system voice; `EXPLAINER_SAY_VOICE` picks one). Character times are then spread over the measured length — captions still land per line, keyword timing is approximate. Use it for unattended runs and rehearsals; use ElevenLabs for anything public.

## 3. Compose — `node $SKILL/engine/build.mjs <project>/script.json`

- **Timing comes from the voice, not from guesses:**
  - a beat lasts its speech plus 0.45 s;
  - the last beat of a chapter gets another 0.8 s;
  - a chapter card lasts 1.8 s;
  - the CTA lasts 4.5 s.
- **Diagram steps** start at their beat.
- **Keywords** turn red at the spoken character time.
- **Audio**: each beat is its own `<audio>` clip; the renderer mixes them.
- **Assets**: fonts (Pretendard, Geist Mono; OFL) and GSAP are fetched once into `EXPLAINER_CACHE` (default `~/.cache/elanous-explainer`).
- **Output**: `<project>/hf/` (a HyperFrames project) and `<project>/timeline.json`.

## 4. Check, look, render

```bash
cd <project>/hf
npx hyperframes check                       # must pass: 0 errors (layout · contrast · lint)
npx hyperframes snapshot --no-end --at <one time per chapter> -o ../snap   # look at the contact sheet yourself
npx hyperframes render --fps 30 --output ../out/<name>-16x9.mp4
```

If something wraps, overlaps or is off-frame, fix the component in `build.mjs` and rebuild. Don't patch `hf/index.html` by hand — it is regenerated.

## 5. QC before you hand it over

- **Speech equals script**: transcribe the render back (`whisper … --language ko`) and compare with the joined `vo` text. Anything under about 0.97 means a word was misread. Re-write that beat's `vo` and re-run step 2 (only that beat is regenerated).
- **Loudness**: integrated about −14 LUFS, true peak ≤ −1 dBTP (`ffmpeg -af loudnorm=print_format=summary`).
- **Side by side**: if there is a reference video, put matching frames next to each other and check that it reads in the same grammar.
- **Before anything goes public**: run a full 1 fps OCR for private names, home paths, accounts and device names. Publishing is a human decision.

## Look — Elanvital CI only

The reference supplies the **grammar** (components and staging), never its colours or artwork.

- **Ground**: Deepsea Blu `#1D2751`.
- **Accent**: **Icarus Red `#E95047`**, the only accent.
- **Chapter cards and CTA**: Real Black.
- **Text**: `#F2F1EE`.
- **Motif**: the V6 «엘랑 소용돌이» mark (`engine/brand/`), used in three places — a slow, faint rotation behind the scene, the header, and the chapter cards.

The reference is used only for its structure (header, chapter cards, a diagram that moves one step per line, keyword-timed captions). Its colours, artwork and voice are not reproduced.

## Field reel — photos from the venue → a vertical video in about a minute

```bash
zsh $SKILL/engine/reel.sh <folder> --title "마케터의 밤" --sub "2026.10.02 · 서울"
zsh $SKILL/engine/reel.sh --warm-cards --title "마케터의 밤" --sub "2026.10.02 · 서울"  # 행사 전 카드 미리 굽기
zsh $SKILL/engine/reel.sh <folder> --title "마케터의 밤" --sub "2026.10.02 · 서울" --instant  # 사진 구간만 렌더
```

즉석판 카드 캐시: `~/.cache/elanous-explainer/cards/<sha256(JSON 배열 [title, sub, 1080, 1920, 카드판번호]) 앞 16자>/{intro,end}.mp4` (`EXPLAINER_CACHE`로 루트 변경 가능).

- **Input**: a folder of phone photos (jpg · png · heic) and short clips (mp4 · mov). The default upload folder is `~/.elanous/field/<event>/`.
- **Order**: by capture time (`mdls` creation date), then by file name.
- **Captions**: optional `<folder>/captions.txt`, one line per item as `파일명 | 자막`. A photo without a line gets one line from a vision model (`codex exec -i`, all photos in parallel, 30 s cap each); if that fails it shows «현장 N». `FIELD_REEL_VISION=0` turns the vision step off.
- **Title**: `--title`, or `title.txt` through the daemon. A slug-like title (`field-2026-10-01`) is replaced by a vision headline read from the first three photos (event or company names on screen first). The date line defaults to the first photo's capture date (KST).
- **Music**: `FIELD_REEL_BGM=<file>` or `~/.cache/elanous-explainer/bgm/field.wav` — cut to length, faded in and out, leveled to about −16 LUFS. No file means no music. Use only licensed tracks (the default cache holds an Epidemic Sound download); the file is never committed.
- **Output**:
  - `<folder>/reel/reel-9x16.mp4` at 1080×1920, 24–60 s.
  - An intro card (kicker, mark, title word by word, red rule, date), then each item: photos for about 4–6 s. A landscape photo is shown whole over a blurred fill of itself; a portrait photo fills the frame. Each move overlaps the next with a slide and a red wipe on the cut.
  - Per item a counter (`01 / 03`), the caption rising word by word, and a red rule. The V6 header, an Icarus Red progress bar, and an end card with elanous.ai.
  - `--part body` renders the photos only (no cards, no music) — for an instant version that stitches pre-rendered cards around it.
- **Fitting to length**: over 60 s drops items from the middle, keeping the first and last. Under 24 s stretches the photos.
- **Measured**: 3 photos → 24 s video in 28 s end to end, of which vision 8.7 s and render 15.9 s (M-series Mac, 10-01). Earlier: 7 items → 31.2 s video in 56–83 s.
- **Before posting**: people's faces need their consent. Run the same 1 fps OCR check as any public video.

## Graph

`graphs/video/explainer-line.yaml`:

- **Flow**: script → vo → build → render (the existing `hyperframes-render` recipe) → qc.
- **Edges back**:
  - layout fault → build;
  - speech mismatch → vo;
  - bad script → script;
  - public release → needs-human.
- **Recipes**: the `explainer-*` recipes are in the elanous core, but `graph run` does not yet accept this graph's terminal nodes. The video-explainer plugin therefore ships the skill and nodes only; run these steps from this skill. The graph comes with plugin 0.2.0.
