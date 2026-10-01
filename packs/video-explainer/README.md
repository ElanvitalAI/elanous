# video-explainer

Turn a list of facts into a narrated «N things at once» explainer video: a script, a word-timed voice-over, line-art diagrams that move one step per spoken line, and a checked 16:9 render.

## What you need

- `node`, `bun`, `npx` and `ffmpeg` on the PATH. The render uses `npx hyperframes`, which is downloaded on first use.
- Optional: an ElevenLabs API key (`ELEVENLABS_API_KEY`). Without it, a draft voice from the macOS system voice is used — fine for rehearsals, not for public videos.

## How to run

Ask your agent to use the `explainer-video` skill with a topic and a list of facts (one per line, each with its source). The skill writes `script.json`, then runs voice → build → `hyperframes check` → render → QC.

To try it on the bundled example:

```sh
SKILL=<installed plugin>/skills/explainer-video
mkdir demo && cp "$SKILL/examples/elanous-0.2.5/script.json" demo/
bun "$SKILL/engine/vo.ts" demo/script.json
node "$SKILL/engine/build.mjs" demo/script.json
(cd demo/hf && npx hyperframes check && npx hyperframes render --fps 30 --output ../out/explainer-16x9.mp4)
```

Measured on an M-series Mac with the system voice and an empty home folder: the example (about 1 min 36 s of video) took 72 s end to end.

## Nodes

- `explainer` — make an explainer video from a topic and facts.
- `field-reel` — turn a folder of venue photos and clips into a 30–60 s vertical video.

## Not in this version

- Graph execution (`graph run`) comes in 0.2.0. In 0.1.0 the steps run from the skill.

## Before you publish a video

Every claim should trace to a source. Run a 1 fps OCR pass over the render for private names, home paths, accounts and device names, and get consent for any faces. Publishing is a human decision.
