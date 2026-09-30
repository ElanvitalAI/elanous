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

⛔ Every claim must trace to a merged change or a measured run, listed in `sources`. Don't write «fully autonomous», dates you can't promise, or comparisons (`docs/marketing/GUIDE-launch-tone-and-banned-claims-*`).

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

Why these choices, what the reference does, and what we can and cannot reproduce: `내부 문서 `RESEARCH-explainer-video-reference-decomposition-2026-09-30``.

## Field reel — photos from the venue → a vertical video in about a minute

```bash
zsh $SKILL/engine/reel.sh <folder> --title "마케터의 밤" --sub "2026.10.02 · 서울"
```

- **Input**: a folder of phone photos (jpg · png · heic) and short clips (mp4 · mov). The default upload folder is `~/.elanous/field/<event>/`.
- **Order**: by capture time (`mdls` creation date), then by file name.
- **Captions**: optional `<folder>/captions.txt`, one line per item as `파일명 | 자막`. Items without a line get no caption.
- **Output**:
  - `<folder>/reel/reel-9x16.mp4` at 1080×1920, 30–60 s.
  - A black title card, then each item: photos for 3.5 s with a slow zoom, clips for their first 5 s.
  - One caption line per item, the V6 header, an Icarus Red progress bar, and an end card with elanous.ai.
- **Fitting to length**: over 60 s drops items from the middle, keeping the first and last. Under 30 s stretches the photos.
- **Measured**: 7 items → 31.2 s video in 56–83 s end to end (M-series Mac, `hyperframes render`).
- **Before posting**: people's faces need their consent. Run the same 1 fps OCR check as any public video.

## Graph

`graphs/video/explainer-line.yaml`:

- **Flow**: script → vo → build → render (the existing `hyperframes-render` recipe) → qc.
- **Edges back**:
  - layout fault → build;
  - speech mismatch → vo;
  - bad script → script;
  - public release → needs-human.
- **Not coded yet**: the `explainer-*` recipes. Until they are, you run these steps from this skill.
