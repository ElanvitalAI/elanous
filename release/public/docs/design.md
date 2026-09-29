# Design systems

When elanous builds a web page for you, it follows the **design system**
chosen for the project. A design system is a set of files: a `DESIGN.md`
that describes the look, and a `tokens.css` holding the actual colours,
fonts and spacing. elanous measures the result against those same files.

You can also start from a site you like: elanous measures it and builds a
new site in a similar concept ([web clone](#rebuild-a-site-you-like--web-clone)).

Everything here works out of the box, except full preview pages. Those need
**OpenDesign**, a separate, free program. See
[OpenDesign (optional)](#opendesign-optional).

## What ships with elanous

| | What it is |
|---|---|
| **52 design systems** | Style-based systems (Modern & Minimal, Bold & Expressive, Retro, Professional, …) imported from OpenDesign's catalogue under Apache-2.0. Systems named after companies or products are left out, so no one else's brand goes into your project. |
| **6 terminal themes** | Colour directions for terminal-style projects. |
| **13 craft rulebooks** | Rules the build agent follows: anti-AI-slop, accessibility, colour, typography, motion, forms, state coverage, laws of UX, right-to-left text. |
| **A measurer and a gate** | They check a page against the chosen system. Neither calls a model. |

These are plain files that travel inside the elanous package. They need no
network, no account and no extra program.

## Choose a system

**In the PWA**, open **Design check** (`/design-check`). Every system is
shown as a card with its colours, fonts, category and a one-line mood. Press
**Select** on a card. You can switch to another system later.

**From the terminal:**

```bash
elanous repo design-direction <project>              # list systems and themes
elanous repo design-direction <project> --set paper  # choose one
```

Choosing a system writes three things into the project:

- `design/system/DESIGN.md` and `design/system/tokens.css`, copied as they are.
- A `## Design direction` section in the project's `DESIGN.md` naming the
  system, the tokens file and its source.

If you edited the copied files by hand, elanous will not overwrite them when
you switch systems. It says which file is in the way instead.

From then on, agents that build pages in this project read `DESIGN.md` and
use the tokens (`var(--fg)`, `var(--font-display)`, …) instead of inventing
colours.

## Check that a page follows it

```bash
elanous repo design-lint <page.html>   # one page: AI-default smells and token use
elanous repo design-gate <project>     # the whole project: pass / fail
```

`design-gate` finds the HTML files in the project and measures each one
against the chosen system. It reports one of three verdicts:

- **pass**
- **fail**, when there is at least one serious finding, such as a serif
  system being given a hard-coded sans-serif heading
- **not applicable**, when no system is chosen or the project has no HTML

Exit codes are `0` for pass or not applicable, `1` for fail and `2` when the
check could not run. The last line of output is JSON, so scripts can read
the verdict.

A rule the gate could not check is listed as **not checked**. It is never
counted as passed.

## Rebuild a site you like — web clone

elanous can study a live site and help you build **a new site in a similar
concept**. It measures what the browser actually drew, turns that into a
`DESIGN.md`, and then builds and checks against it like any other system.

```bash
elanous repo design-extract https://example.com --no-assets --out ./ref   # the look, in seconds
elanous repo design-css ./ref/<site>/DESIGN.md                            # turn it into tokens.css
```

`design-extract` opens the page in Chrome and records:

- the site's CSS custom properties
- the colours really painted, ranked by how much they are used
- font sizes and weights by role, and the type scale
- spacing steps, line length and motion

It writes these into a `DESIGN.md` in the format elanous reads. A value it
could not read is marked as unread, never guessed.

How long it takes, measured on a laptop:

| Run | Time | Output |
|---|---|---|
| `design-extract --no-assets` (the look only) | **5–6 seconds** per site | `DESIGN.md` + `tokens.json` |
| `design-extract --viewports 390,768,1280` (with images and three widths) | about **3 minutes** for a large marketing site | ~300 files, ~90 MB |
| `design-archive` (the whole original, following several pages) | more than 4 minutes on a large site | the original HTML, CSS, JS and assets, indexed |

What you get depends on the site:

| Site | What `design-extract` returns |
|---|---|
| Uses CSS custom properties | Named tokens (hundreds on a large site), plus measured values |
| Plain CSS without custom properties | No named tokens, but measured painted colours, type roles and spacing |

Put the result in your project's `DESIGN.md`. `design-lint` and `design-gate`
then measure against it, the same way they do for a bundled system. Ask the
harness to build the new site from it — for example
`elanous harness say "target paths: index.html · styles.css — a landing page for <your product> following DESIGN.md"`.

`design-archive` keeps the original locally. Uploading it needs a
**private** bucket: elanous checks that the bucket is not public first and
refuses when it cannot tell.

:::warning Reference, not a copy
Use a site to learn its rhythm, palette and proportions. Do not ship another
company's logo, name, images or text as your own.
:::

Needs: Chrome (or Chromium/Edge). See
[Recommended programs](recommended-programs.md).

## OpenDesign (optional)

[OpenDesign](https://github.com/nexu-io/open-design) is a free, open-source
(Apache-2.0) design tool. elanous uses it for one thing: **drawing preview
pages**. You give it one brief, for example "a coffee subscription landing
page", and it draws a full page in each candidate system. You then see real
screens side by side before you choose.

Without OpenDesign, everything above still works; you choose from the cards
instead of from full previews.

### What it needs

| | |
|---|---|
| **Docker** (Compose v2) | The official image `ghcr.io/nexu-io/od`. Its default memory limit is 384 MB. On a Mac, Docker Desktop's VM needs more than that. |
| **An engine to draw with** | This is where cost can come in. OpenDesign itself is free, but each preview is drawn by a model: either a coding-agent CLI you already subscribe to (Codex, Claude Code), or a provider API key such as `OPENAI_API_KEY` (billed per use). The Docker image does not include the agent CLIs. On Linux you can mount the ones installed on the host; otherwise use an API key. |
| **Time** | Around four minutes per preview in our tests. |

Running from source (Node 24 and pnpm) works too. It used about 730 MB in
development mode in our tests.

### Connect elanous to it

1. Start OpenDesign with an API token set (`OD_API_TOKEN` in its `.env`).
2. Save the token in a file readable only by you (`chmod 600`).
3. Tell elanous where to find OpenDesign and the token:

```bash
elanous config set design.openDesign.url http://<host>:7456
elanous config set design.openDesign.tokenFile ~/.config/open-design/api-token
```

Then draw previews:

```bash
elanous repo design-preview <project> --brief "A coffee subscription landing page" \
  --systems minimal,paper --agent codex
```

Previews are saved to `design/previews/<system>.html`. In the PWA's **Design
check**, a card that has a preview shows a **Preview** button. The page opens
in a sandboxed frame, so its scripts do not run, and you can choose the
system from there.

If OpenDesign is not set up, `design-preview` stops and says which two
settings are missing. Nothing else changes.

:::warning Keep the token
OpenDesign does not ask for a token when a request comes from the machine
it runs on. Do not publish it through a proxy on that machine, for example
`tailscale serve`. Bind it to a private network address and keep
`OD_API_TOKEN` set.
:::

## At a glance

| You want to… | Needs |
|---|---|
| Pick one of 52 systems, build with it, check the result | Nothing extra |
| Rebuild a site in a similar concept, or build your own system from it | Chrome |
| See a full preview page per system before choosing | OpenDesign ⊕ an engine (agent CLI or API key) |
