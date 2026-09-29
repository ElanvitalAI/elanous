# Build a plugin

This walks through the plugin format and the publishing tool, using a real package: **`video-broll`**, the first plugin that carries a graph. Its source folder `packs/video-broll` lives in the elanous source tree and is not part of the public repository; what the publisher produces from it is in [`elanous-plugins/video-broll`](https://github.com/ElanvitalAI/elanous-plugins/tree/main/video-broll).

## 1. The folder

```
packs/video-broll/
├── plugin.json               # Agent Plugins manifest + elanous fields
└── .codex-plugin/plugin.json # Codex manifest for the same package
```

That is all the folder holds. The skill and the graph stay where they already live in the source tree; the publisher copies them into the package (see `bundle` below), so there is only ever one copy to maintain.

## 2. `plugin.json`

```json
{
  "$schema": "https://antigravity.google/schemas/v1/plugin.json",
  "name": "video-broll",
  "version": "0.1.0",
  "description": "Cut word-timed motion B-roll into a talking-head video …",
  "extensions": {
    "ai.elanous": {
      "bundle": ["skills/motion-broll", { "from": "graphs/video/broll-line.yaml", "as": "graphs/broll-line.yaml" }],
      "graphs": ["graphs/broll-line.yaml"],
      "capabilities": ["fs:workdir", "proc:ffmpeg", "proc:node", "proc:python3", "agent:codex", "agent:claude"],
      "connectors": [],
      "requires": { "tools": ["ffmpeg", "node", "python3"] },
      "pricing": { "model": "free" },
      "category": "Productivity"
    }
  }
}
```

| Field | Meaning |
|---|---|
| `name` · `version` · `description` | Standard fields. `name` is `[a-z0-9-]{2,40}` and matches the folder name. A `name@version` is published once — it cannot be republished with different contents. |
| `bundle` | What to pack from the repository. A string `"skills/<name>"` packs that skill folder as `skills/<name>/` (a lowercase `skill.md` is packed as `SKILL.md`). An object `{ "from": "<path>", "as": "<path in package>" }` packs any file or folder. Paths resolve against `--bundle-root`; anything outside it — including through a symbolic link — is refused. `.env` files, `.git/` and `node_modules/` are never packed. |
| `graphs` | Graph files inside the package that elanous registers. Only listed graphs are registered — the loader does not scan folders. A listed graph that is not in the package stops the publish for this plugin (`graph-missing`). |
| `nodes` | Custom node kinds the plugin adds (`./nodes/<kind>.yaml`), registered as `<plugin>:<kind>` when elanous finds the installed plugin. Each node declares `kind`, `graph` (`workflow` or `harness`), `inputs` (a JSON Schema — the editor builds its form from it) and `run` — one of `bash`, `http`, `skill` or `mcp`. A node with an unknown `run` is skipped with a warning; the rest of the plugin still loads. |
| `capabilities` | What the plugin may touch, shown to the user before install: `fs:workdir`, `net:<host>`, `proc:<binary>`, `agent:<backend>`, `secret:<service>`. |
| `connectors` | Services the plugin connects to, with the settings it asks the user for; fields marked secret are write-only. |
| `pricing` | `{ "model": "free" }`. Only free plugins are published for now. |

`.codex-plugin/plugin.json` carries the Codex fields (`name`, `version`, `description`, `"skills": "./skills/"`, `interface`) so Codex installs the same package.

## 3. Rules for graphs

Rule 3 is checked by the publisher today. Rules 1 and 2 describe how elanous runs plugin graphs; `elanous plugin add` installs plugins today, but it does not yet enforce rules 1 and 2 at install time — follow them anyway, so your plugin keeps working when it does.

1. elanous registers only the graphs listed in `graphs`.
2. When a graph runs, each step's `recipe` is looked up in the plugin's own `recipes.yaml` (next to the graph) first, then in elanous's built-in recipes. An unknown recipe is a validation error before anything runs.
3. Third-party plugins should use their own `recipes.yaml` or custom nodes. If a graph uses a recipe the plugin does not ship, the publisher still publishes it but reports a warning (`third-party-core-recipe`). Official packs may use built-in recipes — `video-broll` uses the built-in `broll-*` steps.

## 4. Publish

```bash
elanous market keygen --out ./keys            # a local test key: index-key.pem (0600) and index-key.pub.json
elanous market publish --dir packs --out ./market \
  --key ./keys/index-key.pem --key-id <keyId from index-key.pub.json> \
  --bundle-root .                             # the repository root that bundle paths resolve against
```

The output folder:

| Path | What |
|---|---|
| `marketplace.json` | The list of plugins, written once and signed as bytes |
| `index.sig` | `{"keyId","alg":"ed25519","sig"}` over those exact bytes |
| `.agents/plugins/marketplace.json` | The same bytes where Codex looks for a marketplace |
| `plugins/<name>/` | The unpacked package, so `codex plugin marketplace add ./market` can install it |
| `<name>/<version>/<sha256>.tgz` | The package archive; the same contents always produce the same bytes |

Each publish increases `sequence` by one. Skipped plugins are listed with a reason (`paid-not-allowed-in-M0`, `bundle-missing`, `bundle-path-outside-root`, `graph-missing`, …); warnings are listed separately. Add `--json` for a machine-readable result. The private key is never printed.

Try the result in Codex:

```bash
codex plugin marketplace add ./market
codex plugin add video-broll@elanous
```

## 5. Before you open a pull request

- `bun test src/market/` passes — it publishes the repository's own packs, so a new pack is checked there too.
- Your pack publishes with no unexpected skips or warnings.
- Capabilities list everything the skills and graphs touch.
