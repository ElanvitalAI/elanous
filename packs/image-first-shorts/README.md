# image-first-shorts

Make an image-first vertical (9:16) anime/character short. You design the frames; video models only animate them. Beats, text, effects and compositing are done in code.

> **Source:** adapted with permission from **공냥이 AI 실험실** («악역영애 말포이» AI 영상 제작 키트) — original page <https://malfoy-meme-making.vercel.app/> · pipeline wiring <https://malfoy-meme-making.vercel.app/wiring/index.html> · harness download <https://malfoy-meme-making.vercel.app/index.html#download>. Permission 2026-10-08, attribution required. See [`SOURCE.md`](SOURCE.md).

## How it works

The graph `image-first-shorts` runs these stages:

`brief → storyboard → 🙋 approve_storyboard → images → 🙋 approve_images → video → matte → audio → fx → compose → 🙋 approve_final → done`

- 15 working nodes and 2 terminal nodes (`done`, `failed`). Three are human approvals (🙋); four are «wait» nodes that pause the run while you or your agent produce the stage's output.
- The graph's own steps (`graphs/run-step.ts`) never call a paid service. They check inputs, assemble prompts from templates, enforce a blocked-words list, estimate and enforce the video credit budget, and verify that each stage's outputs exist.
- Generation is done by your agent following `skills/image-first-shorts/SKILL.md`.
- Rejecting an approval sends the run back one stage. Breaking a contract (over budget, a blocked word in a prompt, a shot without a first-frame image) ends in `failed`.

## How to run

```sh
G=<installed plugin>/graphs/image-first-shorts.yaml
elanous graph run "$G" --dry-run --input "$(cat <installed plugin>/examples/input.json)" --json   # no external calls
elanous graph run "$G" --input '{"title":"…","workspace":"/absolute/path","video_backend":"higgsfield","ip_blocklist_none":true,"budget":{"video_credits":120,"eleven_chars":25000}}' --json
elanous graph approve image-first-shorts <run_id> [--reject] --by <name>
elanous graph run "$G" --resume <run_id> --json
```

`ip_blocklist` lists words that must never appear in image/video prompts or lyrics (titles, character names). For an original character, set `"ip_blocklist_none": true` explicitly — an empty list is refused.

## What you need

| Item | Used for |
|---|---|
| `bun`, `python3`, `ffmpeg`/`ffprobe` | Graph steps, tools, matting, compositing |
| `codex` CLI (signed in) | First-frame images (`tools/imagegen_runner.py`) |
| Video backend: Google Flow in a browser (`flow-aside`, default) or the `higgsfield` CLI (`higgsfield`) | Image-to-video |
| ElevenLabs API key (`ELEVENLABS_API_KEY`) | Music and voice lines |
| Python packages: `numpy opencv-python pillow rembg onnxruntime librosa faster-whisper` | Matting, music analysis, take selection. The matting and speech models download on first use. |
| HyperFrames (optional) | Code-rendered backgrounds, type and flashes |

Paid generation (video credits, ElevenLabs characters) happens only in the agent's steps, under the budget you pass in `budget`.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for noncommercial use. Keep the attribution in `SOURCE.md` and the `Required Notice:` lines in `LICENSE` when you share it. You are responsible for the rights to any characters, music or voices you use.
