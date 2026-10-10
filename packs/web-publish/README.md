# web-publish

Build a business website that starts from the business, not from a template: graded claims, a page map,
a design direction made for this project, a working hero slice, media with a stated role, a media audit,
mobile QA with honest evidence grades, and a publish step that defaults to a local folder.

> **Source:** includes the agent skill **business-motion-websites** by **passeth** (MIT) —
> <https://github.com/passeth/business-motion-websites> at commit `fe5e8b0ae3a2`. Used with the author's permission (2026-10-09).
> See [`SOURCE.md`](SOURCE.md).

## How it works

The graph `web-publish` runs these stages:

`brief → absorb_ref → strategy → 🙋 approve_plan → hero_slice → media → audit_media → motion → qa → 🙋 approve_release → publish → verify_public → done`

- Two human approvals (🙋). Seven «wait» nodes also pause the run while you or your agent produce a stage's output — they are human/agent signals too, not automatic: approve the wait node and `--resume` to re-check that stage.
- The graph's own steps (`graphs/run-step.ts`) never generate media and never call the network. They check the brief,
  the claim table and page map, that `site/tokens.css` names `DESIGN.md` as its source (a header comment — the step does not compare the two files), the media list (role and rights for
  every asset, and every media file under `site/` must be listed) against your `budget`, the media metadata (`audit-media.mjs`, local `ffprobe`, workspace paths only),
  the motion plan (`motion/motion-plan.json`: each motion's kind — ambient loop, frame scrub, section entrance, explanatory connector, UI feedback — with what happens under reduced motion and on a phone), and the QA table. The QA step checks the table's contract; it does not re-measure the site itself.
- The QA step records a fingerprint of `site/`; publishing refuses if `site/` changed after QA (for example a media file added after the release approval).
- `mode: "plan-only"` stops after the plan approval — no build, no paid generation, no publishing.
- Rejecting `approve_plan` goes back to `strategy`; rejecting `approve_release` goes back to `hero_slice`.
  A media audit problem goes back to `wait_media`; a failing QA row goes back to `wait_build`.
- `verify_public` ends in `unobserved` when a site was published to a URL but nobody re-checked that URL after this publish
  (`release/verify-public.json` with the same `url`, `status: 200`, `qa_rerun: true` and a `checked_at` later than the publish record).
  That run is not reported as verified. A `folder` publish ends as `published-local` (no public URL to re-check).

## Two entry points

- **The graph** `graphs/web-publish.yaml` — stage by stage, with the approvals, the budget ledger, the media audit, the QA contract and the publish adapters. Use this when the site will be published.
- **The workflow node** `web-publish` (`nodes/web-publish.yaml`) — one workflow step that asks the `business-motion-websites` skill for a **plan only** (claim table, page map, `DESIGN.md`, production plan). It does not build, generate paid media or publish; that is the graph's job.

## How to run

```sh
G=<installed plugin>/graphs/web-publish.yaml
elanous graph run "$G" --dry-run --input "$(cat <installed plugin>/examples/input.json)" --json   # no external calls
elanous graph run "$G" --input '{"business":"…","goal":"…","workspace":"/absolute/path","publish_target":"folder","budget":{"image_generations":12}}' --json
elanous graph approve web-publish <run_id> [--reject] --by <name>
elanous graph run "$G" --resume <run_id> --json
```

### Inputs

| Field | Meaning |
|---|---|
| `business`, `goal` | What the business does and what the site should achieve (required) |
| `mode` | `build` (default) or `plan-only` |
| `workspace` | Absolute path of the working folder |
| `publish_target` | `folder` (default, copies `site/` to `out/site/`), `pub`, or `vercel` (both print a command for you to run, then accept only a `release/publish-record.json` written after this run's release approval; `vercel` also needs `release/vercel-approval.json`) |
| `reference_urls` | Optional `https` sites to learn from — values only (colour, type, spacing, layout, motion numbers) into `ref/seed.json`; never their text, photos, logos or font files. The automatic check on `ref/seed.json` only refuses file references and `data:` URIs; copied wording or inline assets are for the person approving `wait_absorb` to catch. Files kept under `ref/assets/` while measuring are hashed, and publishing fails if one of them shows up in `site/` (a file moved elsewhere and renamed is still caught by content; one edited is not) |
| `budget` | `image_generations`, `video_credits`, `voice_chars` — the media step fails when `ledger/media_spend.jsonl` goes over |
| `webclone_root` | Optional path to a checkout that has `scripts/webclone/`; without it the QA step waits for a hand-written `qa/qa-report.json`. The table must say what measured it (`ruler`: `webclone` or `manual`) |

The workspace fence (manifest paths inside the workspace, no `--ffprobe`, report inside the workspace) is applied by the
graph's `audit_media` step. Before calling it, the step passes only image/video files with known extensions (`png jpg webp avif gif mp4 webm mov m4v`) whose first 64 KB show no playlist markers (HLS, DASH, concat), which keeps the obvious URL-referencing inputs away from `ffprobe` (a content check, not a network sandbox — process-level blocking is a separate security task); SVG files are listed and rights-checked but not probed.
The vendored `scripts/audit-media.mjs` itself is unchanged: run directly, it accepts
`--ffprobe` and any `--out` path, as in the original.

## What you need

| Item | Used for |
|---|---|
| `bun`, `node` | Graph steps, the media audit script |
| `ffprobe` (needed once the site has media) | Media metadata audit |
| Image / video / voice tools of your choice (optional) | Media your agent makes by following the skill — they run under your agent's own setup and keys, not under this plugin's permissions |

Paid generation happens only in your agent's steps, under the budget you pass.

The plugin asks only for what its own steps use: the workspace, `bun`, `node` and `ffprobe`. It declares no network access and no API keys.

## License

[MIT](LICENSE). Keep `SOURCE.md`, the `Required Notice:` lines and the MIT notice in `LICENSE`, and the source line
at the top of each file under `skills/business-motion-websites/` when you share this plugin.
