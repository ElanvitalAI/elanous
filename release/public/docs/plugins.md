# Plugins

A plugin is a folder of skills — and, for elanous, graphs — that you install from a signed marketplace. The same package works in Codex, so a skill you install once is usable from either tool.

## For everyone — official packs

| Pack | What it adds | Price |
|---|---|---|
| `elanous-basics` | Research and everyday skills: web search and crawling (`omni-crawl`), link digests (`omni-digest`), project onboarding (`project-onboarding`), a grilling interviewer (`grill-me`), photo OCR intake (`photo-intake-ocr`) | Free |
| `elanous-media` | Video skills: building videos (`video-builder`) and word-timed motion B-roll (`motion-broll`) | Free |
| `video-broll` | The first plugin with a graph: cut word-timed motion B-roll into a talking-head video (align words → plan density → author clips with a coding agent → composite → check) | Free |
| `elanous-markets` | Market research and asset analysis skills | Listed only — not published yet |

Some skills need a key for an outside service (for example `omni-digest` uses xAI, `photo-intake-ocr` uses Upstage). The pack lists these as `secret:<service>` capabilities so you see them before you install.

### Install in Codex

Codex reads the same marketplace. The official one lives at [ElanvitalAI/elanous-plugins](https://github.com/ElanvitalAI/elanous-plugins):

```bash
codex plugin marketplace add ElanvitalAI/elanous-plugins
codex plugin add elanous-basics@elanous
codex plugin list        # shows the plugin as installed
```

elanous can also do this for you inside the agent's own screen while it runs a mission:

```bash
elanous agent-mission mission --backend codex --plugin elanous-basics@elanous "make this PDF folder searchable"
```

The skills appear in Codex as `<plugin>:<skill>`, for example `elanous-basics:omni-crawl`.

### Install in elanous

```bash
elanous plugin add ./path/to/plugin                     # a folder on this machine
elanous plugin add https://github.com/<owner>/<repo>.git#<commit>:<subfolder>  # a pinned commit of a git repository
elanous plugin list
elanous plugin remove <name>
```

For the git form, the URL must end in `.git` and `<commit>` must be the full 40-character commit hash; a subfolder is only accepted with a pinned commit.

`plugin add` shows the capabilities for you to approve (`--yes` approves them), names the connector settings the plugin will ask for (it never prints their values), and registers the plugin's graphs and skills — and any custom node kinds it declares, as `<plugin>:<kind>`. `--json` prints each step as one line of JSON.

Installing **by name from a marketplace** (`elanous plugin add <plugin>@<market>`, which fetches and verifies the signed index first) is **coming**. Until then, install the official plugins in Codex as above, or from the repository with a pinned commit.

### Is it really ours?

Every marketplace ships `index.sig` next to its `marketplace.json`: an Ed25519 signature over the exact bytes of the index. The official marketplace is signed with the published key `4d809b69` (the installer will trust it by default); the signed index is also served at https://elanvitalai.github.io/elanous-plugins/marketplace.json. The elanous installer (coming, above) checks it against the keys it trusts before it uses the list, and refuses an index whose sequence number goes backwards — an attempt to serve an older list.

## For developers

To build and publish your own plugin, see [Build a plugin](build-a-plugin.md).
