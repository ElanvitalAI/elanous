// SEARCH-BENCH agent arm — score real agents with the same scorer.
//   replay  : a recorded transcript's tool calls are re-executed through the kit (cost = what those calls return on
//             this corpus) and its final answer is scored. No LLM call; CI-safe. Live A/B runs (terra vs Opus …)
//             export to this format and are scored later.
//   LLM arm : OFF by default (CLI `--llm-arm`). OpenRouter, small budget: the same gold queries with different tool
//             EXPOSURES (order / tier) and tool DESCRIPTIONS; records the first tool the model reaches for.
import { readFileSync } from 'node:fs';
import { buildGlobTool } from '../../skills/tools/glob.js';
import { buildGrepTool } from '../../skills/tools/grep.js';
import { buildReadTool } from '../../skills/tools/read.js';
import type { SearchKit } from './kit.js';
import { pathsFromLines } from './plan.js';
import type { SearchStrategy } from './types.js';

export interface TranscriptCall { readonly tool: string; readonly args: Readonly<Record<string, unknown>> }
export interface Transcript {
  readonly schema: 'search-bench.transcript/1';
  readonly agent: string;
  readonly queries: ReadonlyArray<{ readonly query: string; readonly calls: readonly TranscriptCall[]; readonly answer: readonly string[] }>;
}

/** Execute one tool call (canonical names) through the kit; returns the model-visible text. */
export async function execToolCall(kit: SearchKit, call: TranscriptCall): Promise<string> {
  const a = call.args;
  switch (call.tool) {
    case 'Grep': return (await kit.grep(String(a.pattern ?? ''), { ...(a['-i'] === true ? { i: true } : {}), ...(typeof a.glob === 'string' ? { glob: a.glob } : {}) })).join('\n');
    case 'Glob': return (await kit.glob(String(a.pattern ?? ''))).join('\n');
    case 'Read': return kit.read(kit.rel(String(a.file_path ?? a.path ?? '')));
    case 'DocsSearch': return (await kit.docs(1, String(a.query ?? ''), 8)).map((h) => h.path).join('\n');
    case 'RunShell': {
      const argv = Array.isArray(a.command) ? a.command.map(String) : [];
      if (argv.length === 0) return 'error: command required';
      return kit.exec('RunShell', argv, { kind: 'runshell' }).visible;
    }
    default: kit.note(`unknown:${call.tool}`, JSON.stringify(a)); return `unknown tool ${call.tool}`;
  }
}

export function replayStrategy(path: string): SearchStrategy {
  const t = JSON.parse(readFileSync(path, 'utf8')) as Transcript;
  if (t.schema !== 'search-bench.transcript/1') throw new Error('transcript schema must be search-bench.transcript/1');
  return {
    id: `A-replay-${t.agent}`, version: 1, track: 'A', label: `replay ${t.agent}`, source: path,
    async run(q, kit) {
      const row = t.queries.find((r) => r.query === q);
      if (!row) return [];
      for (const c of row.calls) await execToolCall(kit, c);
      return row.answer.map((p) => kit.rel(p));
    },
  };
}

// ── LLM arm ───────────────────────────────────────────────────────────────────────────────────────────────────
export type Exposure = 'A-native-first' | 'B-docs-first' | 'C-runshell-only' | 'D-ops-ui-deferred';
export type DescriptionSet = 'D1-current' | 'D2-short' | 'D3-examples' | 'D4-korean';
interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }

const PARAMS: Record<string, Record<string, unknown>> = {
  Grep: { type: 'object', properties: { pattern: { type: 'string' }, '-i': { type: 'boolean' }, glob: { type: 'string' } }, required: ['pattern'] },
  Glob: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  Read: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  DocsSearch: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  RunShell: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } }, required: ['command'] },
  LoadTools: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] },
};

export function toolDescriptions(set: DescriptionSet): Record<string, string> {
  if (set === 'D1-current') {
    return { Grep: buildGrepTool().description, Glob: buildGlobTool().description, Read: buildReadTool().description,
      DocsSearch: 'Search the repository docs knowledge index (vector + BM25 hybrid).', RunShell: 'Execute an argv-style command (no shell interpretation). Returns exit code, stdout, stderr.' };
  }
  if (set === 'D2-short') {
    return { Glob: 'Use for FILENAMES: **/*name*.', Grep: 'Use for CONTENT: regex over files; returns matching paths.', Read: 'Read one file.',
      DocsSearch: 'Use for design docs by topic.', RunShell: 'Run rg/git/ast-grep argv when the other tools cannot.' };
  }
  if (set === 'D3-examples') {
    return { Glob: 'Find files by name. Examples: **/*JUDGE-LOAD*.md, **/*graph-approval*.ts.', Grep: 'Search file contents. Examples: pattern "function dispatchGlob", "docsRoots", -i for case-insensitive.',
      Read: 'Read a file to confirm a candidate.', DocsSearch: 'Ranked docs for a topic. Example: "judge load reduction".', RunShell: 'argv command, e.g. ["rg","-l","pattern"] or ["ast-grep","run","-p","foo($$$)"].' };
  }
  return { Glob: '파일 이름으로 찾기. 예: **/*JUDGE-LOAD*.md · **/*승인*', Grep: '파일 내용 검색(정규식). 예: "판정국|judge", "function dispatchGlob", -i 대소문자 무시',
    Read: '후보 파일을 읽어 확인', DocsSearch: '주제로 설계 문서 찾기. 예: "판정국 부하 줄이기"', RunShell: 'argv 명령. 예: ["rg","-l","판정국"]' };
}

export function exposureTools(exposure: Exposure, set: DescriptionSet): { immediate: ToolDef[]; deferred: ToolDef[] } {
  const d = toolDescriptions(set);
  const def = (name: string): ToolDef => ({ name, description: d[name] ?? name, parameters: PARAMS[name]! });
  if (exposure === 'A-native-first') return { immediate: ['Grep', 'Glob', 'Read', 'DocsSearch', 'RunShell'].map(def), deferred: [] };
  if (exposure === 'B-docs-first') return { immediate: ['DocsSearch', 'Grep', 'Glob', 'Read', 'RunShell'].map(def), deferred: [] };
  if (exposure === 'C-runshell-only') return { immediate: [def('RunShell'), def('Read')], deferred: [] };
  return { immediate: [def('RunShell'), { name: 'LoadTools', description: 'Load deferred tools by name: Grep, Glob, Read, DocsSearch.', parameters: PARAMS.LoadTools! }],
    deferred: ['Grep', 'Glob', 'Read', 'DocsSearch'].map(def) };
}

export interface LlmArmOptions { readonly model: string; readonly exposure: Exposure; readonly descriptions: DescriptionSet; readonly maxTurns?: number; readonly apiKey: string; readonly fetchImpl?: typeof fetch }

const SYSTEM = 'You find files in a code repository (cwd = repo root). Use the tools. When done, answer ONLY with a JSON array of up to 5 repo-relative paths, best first.';

export function llmStrategy(o: LlmArmOptions): SearchStrategy {
  const fetcher = o.fetchImpl ?? fetch;
  return {
    id: `A-llm-${o.exposure.split('-')[0]}-${o.descriptions.split('-')[0]}`, version: 1, track: 'A', label: `LLM ${o.model} · ${o.exposure} · ${o.descriptions}`,
    params: { model: o.model, exposure: o.exposure, descriptions: o.descriptions },
    async run(q, kit) {
      const { immediate, deferred } = exposureTools(o.exposure, o.descriptions);
      let tools = [...immediate];
      const messages: Array<Record<string, unknown>> = [{ role: 'system', content: SYSTEM }, { role: 'user', content: q }];
      for (let turn = 0; turn < (o.maxTurns ?? 6); turn += 1) {
        const res = await fetcher('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: o.model, temperature: 0, messages, tools: tools.map((t) => ({ type: 'function', function: t })), max_tokens: 800 }),
        });
        if (!res.ok) throw new Error(`openrouter ${res.status}`);
        const body = await res.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
        const msg = body.choices?.[0]?.message;
        if (!msg) throw new Error('openrouter: empty choice');
        messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
        if (!msg.tool_calls?.length) {
          const m = /\[[\s\S]*\]/.exec(msg.content ?? '');
          try { return (JSON.parse(m?.[0] ?? '[]') as unknown[]).map((p) => kit.rel(String(p))); } catch { return pathsFromLines(kit, msg.content ?? ''); }
        }
        for (const call of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>; } catch { /* empty */ }
          let out: string;
          if (call.function.name === 'LoadTools') {
            const names = Array.isArray(args.names) ? args.names.map(String) : [];
            tools = [...tools, ...deferred.filter((t) => names.includes(t.name) && !tools.some((x) => x.name === t.name))];
            kit.note('LoadTools', names.join(','));
            out = `loaded: ${names.join(', ')}`;
          } else out = await execToolCall(kit, { tool: call.function.name, args });
          messages.push({ role: 'tool', tool_call_id: call.id, content: out.slice(0, 20_000) });
        }
      }
      return [];
    },
  };
}
