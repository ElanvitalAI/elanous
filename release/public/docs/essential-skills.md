The pack is listed but not published to the marketplace yet — the install lines work once it is published.

# Five essential skills

The `elanous-essentials` pack brings together five skills for research, reading, diagrams and study notes. **It is not available from the official marketplace yet.** The commands below are for use *after* publication, not a way to install it today.

## What can I give each skill?

| Skill | What it does | Input | Output |
|---|---|---|---|
| `youtube-master` | Turns a YouTube video into a transcript, summary or study note. | YouTube URL and desired depth or format | Transcript, brief/cards/detailed summary or study note in Markdown; optional web page or PDF |
| `omni-crawl` | Searches and collects source documents across web and news engines. | Keyword, question or site URL | Deduplicated Markdown research results with source links; optional deep report |
| `omni-digest` | Extracts and summarizes a non-YouTube link or file. | Web or X link, GitHub item, PDF, document or image | Markdown digest in essential, cards or in-depth form; optional diagram or PDF |
| `diagram-master` | Chooses a suitable diagram engine and checks the result. | Description, data or document | Mermaid, Matplotlib, Excalidraw or SVG diagram; optional AI illustration |
| `lecture-note-digitizer` | Combines handwritten notes and slides into a readable lecture note. | Notes, slide PDFs or images, and optional summary/transcript | Structured Markdown with diagrams, HTML and PDF |

## Can I use them without API keys?

Yes, but **key-free does not mean every automated script runs without a key**. Use a local agent and its available tools for the manual paths below; your agent's own model access may still have a cost. For current free allowances, consult each provider's pricing page rather than relying on a fixed limit.

| Skill | No API key: available path | Bring your own key: additional path |
|---|---|---|
| `youtube-master` | Use public captions, or download audio with `yt-dlp` and transcribe with local `whisper`; ask the agent to summarize the text. The automatic script does **not** promise key-free summaries. | `YOUTUBE_API_KEY` for metadata, `SUPADATA_API_KEY` for captions and `XAI_API_KEY` for automated summaries. Optional `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` or `GEMINI_API_KEY` for cloud transcription. |
| `omni-crawl` | Search DuckDuckGo with `--free`; use keyless Jina Reader or local text extraction for pages. Search may fail when the service blocks access. | `TAVILY_KEY` and `FIRECRAWL_API_KEY` for search and full-page extraction; optional `XAI_API_KEY` or `APIFY_TOKEN` for other engines and `JINA_API_KEY` for Jina access. |
| `omni-digest` | Extract text via keyless Jina Reader or local files, optionally transcribe with local `whisper` or run local OCR, then ask the agent to summarize it. The automatic summary script currently needs a key. | `XAI_API_KEY` for automated summaries; optional `BEARER_TOKEN` for X posts, `UPSTAGE_API_KEY` or `OCR_API_KEY` for OCR. |
| `diagram-master` | Render Mermaid, Matplotlib, Excalidraw or SVG locally; extract an existing diagram from a PDF with local tools. | `GEMINI_API_KEY` (or `GOOGLE_API_KEY` where supported) for AI-generated illustrations only. |
| `lecture-note-digitizer` | Read local notes and slides, draft Markdown and diagrams with `diagram-master`, and render HTML/PDF locally. | `GEMINI_API_KEY` or `GOOGLE_API_KEY` only if you choose AI illustrations through `diagram-master`; ordinary note/PDF creation needs no skill API key. |

Keys are **optional connectors for the pack**, not bundled credentials. Configure only the services you choose, in your own environment or the installed plugin's [connection settings](plugins.md#connection-settings); never paste key values into a skill or a shared document. For a manually obtained skill folder that expects a local `.env`, copy its `.env.example` and supply only the keys that path uses; keep that file private and out of shared packages. You can reuse a private set of keys across your local skill folders without distributing it.

## Which tools do I need on my machine?

Install only the tools for the path you intend to use. These are local tools; uploading a skill to a hosted app does not install them there.

| Skill | Tool | Why | Where to install / command |
|---|---|---|---|
| `youtube-master` | Node.js (`npx tsx`) | Run its scripts | [Node.js LTS](https://nodejs.org/) |
| `youtube-master` | `yt-dlp`, `ffmpeg` | Captionless audio download and processing | `brew install yt-dlp ffmpeg`; alternatively `pipx install yt-dlp` and [ffmpeg.org](https://ffmpeg.org/) |
| `youtube-master` | Optional local `whisper` | Transcribe downloaded audio without a cloud key | `pipx install openai-whisper` |
| `omni-crawl` | Node.js (`npx tsx`); optional Chrome | Run scripts; local page screenshots | [Node.js LTS](https://nodejs.org/); [Chrome](https://www.google.com/chrome/) |
| `omni-digest` | Node.js (`npx tsx`); `ffmpeg` for video | Run scripts; extract video audio | [Node.js LTS](https://nodejs.org/); `brew install ffmpeg` or [ffmpeg.org](https://ffmpeg.org/) |
| `omni-digest` | Optional `pdftotext`, `whisper` | Text PDFs; offline video transcription | `brew install poppler`; `pipx install openai-whisper` |
| `diagram-master` | `uv` and Python | Local rendering | [uv installer](https://docs.astral.sh/uv/); from the installed skill's `references` folder run `uv sync` |
| `lecture-note-digitizer` | `uv`, Python, Playwright Chromium and `diagram-master` | Diagram rendering and HTML-to-PDF conversion | [uv installer](https://docs.astral.sh/uv/); `uv run playwright install chromium`; `diagram-master` is in this pack |

## How do I get the pack?

**Not yet:** the official marketplace has not published `elanous-essentials`. Once it is published, use the same marketplace syntax as [Plugins](plugins.md):

```bash
elanous plugin add elanous-essentials@elanous
```

For Codex, register the official marketplace first and then install:

```bash
codex plugin marketplace add ElanvitalAI/elanous-plugins
codex plugin add elanous-essentials@elanous
```

Do not interpret these future install lines as a currently working download. The installed skill folders contain `SKILL.md` and any scripts the skill needs.

## How do I use them in my agent?

- **Claude Code:** After the pack is available, put a skill folder in `.claude/skills/<skill>/` for one project or `~/.claude/skills/<skill>/` for all projects, then ask in plain English, for example, “Summarize this YouTube link as a study note.” Claude Code reads the matching skill. Install the local tools for that skill and provide your own keys only for the keyed paths.
- **Codex CLI:** After publication, install with the Codex commands above. The plugin's skills appear as `elanous-essentials:<skill>`; ask in plain English or name the skill. For a manually obtained skill folder, Codex also reads `~/.agents/skills/<skill>/`. The ChatGPT browser does not load local skill folders; use the Codex CLI instead.
- **Claude desktop or web app:** You may upload a custom skill as a `.zip`, but it runs in Claude's sandbox, not on your computer. A skill that needs local tools such as `ffmpeg`, `uv` or Chrome, access to your files, or your own API keys belongs in **Claude Code** instead. An uploaded skill is not the same as installing this unpublished marketplace pack.

To use the same manually obtained skill across local agents, place copies in each agent's skill directory and restart the agent. This describes folder usage, **not** an alternative claim that the unpublished marketplace pack is already downloadable.
