# Plugins

A plugin is a folder of skills — and, for elanous, graphs — that you install from a signed marketplace. The same package works in Codex, so a skill you install once is usable from either tool.

## For everyone — official packs

| Pack | What it adds | Price |
|---|---|---|
| `elanous-basics` | Research and everyday skills: web search and crawling (`omni-crawl`), link digests (`omni-digest`), project onboarding (`project-onboarding`), a grilling interviewer (`grill-me`), photo OCR intake (`photo-intake-ocr`) | Free |
| `elanous-media` | Video skills: building videos (`video-builder`) and word-timed motion B-roll (`motion-broll`) | Free |
| `video-broll` | The first plugin with a graph: cut word-timed motion B-roll into a talking-head video (align words → plan density → author clips with a coding agent → composite → check) | Free |
| `elanous-hwp` | Korean HWP/HWPX documents: read to Markdown (`hwp-read`), write from templates (`hwp-write`), fill existing forms (`hwp-fill`), plus `to-md`/`from-md` step kinds for graphs | Free |
| `job-coach` | Career coaching from an interview: job candidates matched to Korea's NCS competency units, researched courses and a report — a personal mode and an enterprise HRD mode | Free |
| `elanous-markets` | Market research and asset analysis skills | Listed only — not published yet |

Some skills need a key for an outside service (for example `omni-digest` uses xAI, `photo-intake-ocr` uses Upstage, `job-coach` uses a public-data NCS service key). The pack lists these as `secret:<service>` capabilities so you see them before you install, and asks for them as connection settings — see [Connection settings](#connection-settings) below.

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

By name, from the official marketplace:

```bash
elanous plugin add elanous-basics@elanous      # fetches the signed index, checks the signature and the package hash
elanous plugin list
elanous plugin remove <name>
```

`plugin add` shows the capabilities for you to approve (`--yes` approves them), names the connection settings the plugin will ask for (it never prints their values), and registers the plugin's graphs and skills — and any custom node kinds it declares, as `<plugin>:<kind>`. `--json` prints each step as one line of JSON.

Other sources:

```bash
elanous plugin add ./path/to/plugin                     # a folder on this machine
elanous plugin add https://github.com/<owner>/<repo>.git#<commit>:<subfolder>  # a pinned commit of a git repository
elanous plugin market add <name> <https-url>            # another signed marketplace
elanous plugin market update                            # refresh the signed indexes
```

For the git form, the URL must end in `.git` and `<commit>` must be the full 40-character commit hash; a subfolder is only accepted with a pinned commit.

### Install in the web app

Open **마켓** (Market) in the web app, choose **공식 마켓 받기** (get the official marketplace), open a plugin and press **동의하고 설치** (approve and install) after reading its capabilities. The progress shows each step — download, signature check, consent, registration. Installed plugins can be removed from the same page.

### Connection settings

A plugin that talks to an outside service declares the keys it needs. Set them once; elanous passes them to that plugin's graphs and servers as environment variables and never shows the values again:

```bash
elanous plugin credentials job-coach                          # which fields exist, and whether each is set
elanous plugin credentials job-coach --stdin serviceKey       # read one value from standard input
elanous plugin credentials job-coach --unset serviceKey
```

In the web app the same fields appear under the installed plugin as **연결 정보** (connection settings) — a password field per key, marked saved or empty.

### Is it really ours?

Every marketplace ships `index.sig` next to its `marketplace.json`: an Ed25519 signature over the exact bytes of the index. The official marketplace is signed with the published key `4d809b69` (the installer will trust it by default); the signed index is also served at https://elanvitalai.github.io/elanous-plugins/marketplace.json. The elanous installer checks it against the keys it trusts before it uses the list, and refuses an index whose sequence number goes backwards — an attempt to serve an older list.

## For developers

To build and publish your own plugin, see [Build a plugin](build-a-plugin.md).
