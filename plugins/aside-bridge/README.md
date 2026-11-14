# Aside bridge

`aside.exec@1` lets an Elanous graph request one bounded Aside task. Its node input is `{ "task": "...", "timeoutMs": 30000 }`; output is `{ "sessionId": "...", "outcome": "success", "answer": "...", "links": [] }`. The graph receipt retains the session ID. The provider requires a locally available, already connected `aside` CLI. It does not log in or manage credentials.

The included `graphs/aside-bridge.yaml` takes the graph run input as the capability request. Other graphs can register `createAsideCapabilityRegistry()` and use `requires: aside.exec@1`.

Windows is disabled for this bridge in 0.3.17. The provider returns `Windows 미지원 · 0.3.18` before launching `aside`. Windows process containment and lifetime-bound identity belong to the separate `ASIDE-BRIDGE-WINDOWS-JOB-OBJECT` 0.3.18 follow-up.

## Aside calls Elanous (demo profile only)

For the reverse path, an approved demo Aside profile can gather public items and write one JSON object per line to a JSONL file:

```json
{"url":"https://example.org/public-notice","title":"Public notice","text":"Public summary","kind":"web","signals":{"source":"aside","round":1}}
```

The allowed commands for this demo profile are:

| Command | Purpose |
| --- | --- |
| `eln intake ingest --file <JSONL path>` | Ingest gathered items; current source CLI help and installed `eln 0.3.9-dev.0` help both confirm `--file`. Recheck the 0.3.17 installed build before a real rehearsal. |
| `eln intake items` | Read ingested items. |
| `eln graph run graphs/demo/coevolution-loop.yaml` | Run one loop round after that graph lands. |
| `eln research <query>` | Optional public-web research. |

Do not use `eln secret`, `setup`, `config set`, `git`, or deployment commands from this profile. Keep account data, keys, cookies, and private memory out of JSONL and command arguments. A real Aside profile and intake rehearsal require their own isolated state/config directories and separate live approval; this package has only synthetic test evidence.
