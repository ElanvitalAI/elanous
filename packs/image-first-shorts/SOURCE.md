# Source and attribution

**Required attribution.** This plugin is adapted, with the author's permission, from
**공냥이 AI 실험실** — work: «악역영애 말포이» AI 영상 제작 키트.

- Original page: <https://malfoy-meme-making.vercel.app/>
- Pipeline wiring (structure): <https://malfoy-meme-making.vercel.app/wiring/index.html>
- Harness download: <https://malfoy-meme-making.vercel.app/index.html#download>

Permission was granted on 2026-10-08 on the condition that the source is credited.
Our side was written new, using the kit's stage structure, principles and template patterns as reference
(a few kit tools are carried over with changes — see the table below).
Anyone who redistributes this plugin, in whole or in part, must keep this file and the
`Required Notice:` lines at the top of `LICENSE`. Removing the credit breaks the terms of the permission.

## What came from the kit

The kit's stage structure (storyboard → images → video → matte → sound → effects → composite),
its «a rejection goes back a stage» rule, the concurrency and budget ideas, and the prompt-block
assembly were carried over and adapted for macOS and the elanous graph runner. Every file that
came from or follows the kit carries its own source line.

| File | Relation to the kit |
|---|---|
| `graphs/image-first-shorts.yaml` · `graphs/recipes.yaml` | Kit pipeline stages rewritten as an elanous graph |
| `graphs/run-step.ts` | New code; stage structure and checks follow the kit |
| `skills/image-first-shorts/templates/*` | Block structure and fixed phrases from the kit; character examples written new |
| `tools/fill.py` | Kit file, unchanged |
| `tools/imagegen_runner.py` | Kit file; configurable paths, session-scoped image pickup |
| `tools/keyer.py` · `tools/matte.sh` · `tools/matte_queue.sh` · `tools/heavy.sh` | Kit files ported to macOS (CPU/Core ML backends, portable locks) |
| `tools/analyze_music.py` | Kit analysis script; JSON output and drop detection added |
| `tools/asr_pick.py` · `tools/ip_guard.py` | New code following kit practices |

## What is not included

No material from the work the kit was made for: no characters, names, likenesses, images,
video, lyrics or dialogue. The bundled examples use an original character. Franchise words appear only in the
kit's title in the credit lines.

## License

This plugin is distributed under the PolyForm Noncommercial License 1.0.0 (`LICENSE`).
Rights to the characters, music and voices you put into your own videos are your responsibility.
