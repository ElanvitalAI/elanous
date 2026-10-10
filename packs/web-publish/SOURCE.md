# Source and attribution

**Required attribution.** This plugin includes the agent skill **business-motion-websites** by **passeth**,
used with the author's permission (2026-10-09) under the MIT License.

- Original repository: <https://github.com/passeth/business-motion-websites>
- Pinned commit: `fe5e8b0ae3a208efba751d3dd13aa168afd4fa74` (2026-10-09T01:44:35Z)
- Original license: MIT, `Copyright (c) 2026 passeth` — kept in full in `LICENSE`.

The files were read from that commit as data and copied. Nothing from the original repository was executed while
building this plugin. There is no automatic update path: a newer upstream version needs a new review and a new pinned commit.
Anyone who redistributes this plugin, in whole or in part, must keep this file, the `Required Notice:` lines
and the MIT notice in `LICENSE`, and the source line at the top of each vendored file.

## What came from the original

Every vendored file is unchanged except for one added source line at the top (after the YAML front matter in
`SKILL.md`, after the `#!` line in `audit-media.mjs`).
With that line removed, each file's git blob sha equals the blob sha in the original repository's tree at the pinned commit
(`gh api repos/passeth/business-motion-websites/git/trees/<sha>?recursive=1` lists them).

| File in this plugin | Original path | Upstream blob sha | Change |
|---|---|---|---|
| `skills/business-motion-websites/SKILL.md` | `SKILL.md` | `11c1ff6f1d562f959c3f2364757033148f6dd34d` | source line only |
| `skills/business-motion-websites/references/business-content.md` | `references/business-content.md` | `c5f2236137c2478bd5361a4ee006c2c04e91643b` | source line only |
| `skills/business-motion-websites/references/art-direction.md` | `references/art-direction.md` | `d8abe6904acc8cbb28a4528d2bd129eb6acdbaa5` | source line only |
| `skills/business-motion-websites/references/media-production.md` | `references/media-production.md` | `1224fa3c0485ea279ac337d002cb8bc82b8348d2` | source line only |
| `skills/business-motion-websites/references/scroll-and-mobile.md` | `references/scroll-and-mobile.md` | `38187aced8313069e19bf6c21c97afb1ca384a81` | source line only |
| `skills/business-motion-websites/references/verification-and-release.md` | `references/verification-and-release.md` | `05ab7683a12602dcef0a41c0b297d788716bc959` | source line only |
| `skills/business-motion-websites/assets/project-brief.md` | `assets/project-brief.md` | `38f4d5638f31577622ea9d8843b8c0c15980411e` | source line only |
| `skills/business-motion-websites/scripts/audit-media.mjs` | `scripts/audit-media.mjs` | `748c7ffb0e2e0259363389738d7a77a3fde3c40a` | source line only |
| `skills/business-motion-websites/agents/openai.yaml` | `agents/openai.yaml` | `5de68ee779b8270528cc5dc32e985808cb64f824` | source line only |
| `skills/business-motion-websites/examples/evas.md` | `examples/evas.md` | `586378985d77f5927a0d519418e7fef80f4e25d2` | source line only (kept so the link in `SKILL.md` resolves; it is a link and a note, not site material) |

## What is new in this plugin

Written for elanous; the stage structure follows the skill's seven-step flow.

| File | What it is |
|---|---|
| `graphs/web-publish.yaml` · `graphs/recipes.yaml` | The skill's flow as an elanous graph: two human approvals, `wait_*` pauses, rejections go back a stage |
| `graphs/run-step.ts` | Deterministic checks for each stage. No generation, no network calls |
| `nodes/web-publish.yaml` | A workflow node that hands a brief to the skill |
| `examples/input.json` | A fictional business |
| `plugin.json` · `.codex-plugin/plugin.json` · `README.md` · this file | Packaging |

How the graph differs from the original guidance:

- **Publishing defaults to a local folder.** The original guide describes Git, hosting and domain work (including Vercel).
  Here the publish step copies `site/` to `out/site/` by default. `pub` and `vercel` targets only print the command
  for a person to run and then check the record they leave; `vercel` also needs a written approval record.
- **The media audit is fenced to the workspace.** The graph calls `audit-media.mjs` only with a manifest inside the
  workspace, refuses manifests whose files point outside it, never passes `--ffprobe`, and writes the report inside the workspace.
- **Mobile QA is a contract, not a claim.** The graph asks for a QA table with widths 390/768/1280, reduced-motion
  visibility, and evidence grades (emulator / WebKit / real device). An unmeasured grade must be written as `unverified`.
  If no measuring tool is available, the step waits (`pending`) instead of passing.
- **Unverified claims stay off the page.** A claim graded `미확인` (unverified) that is marked public fails the strategy step.

## What is not included

No material from the showcase site named in the original repository: no source code, logos, copy, photos, video or
data from it. `examples/evas.md` is the original author's link and note only, and its own text says the site's content
belongs to its rights holders. The example input in this plugin is a fictional business. The original repository's
`README.md` and `.gitignore` were not copied.

## License

MIT (`LICENSE`). The vendored skill is `Copyright (c) 2026 passeth`. The new files listed above are
`Copyright 2026 ElanvitalAI` and are offered under the same MIT terms.
Rights to the copy, images, video, voices and fonts you put into your own site are your responsibility.
