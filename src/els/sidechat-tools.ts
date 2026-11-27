// ELS-SIDECHAT-SEARCH (대표 11-26 A6) — read-only search tools for the sidechat model: the Obsidian vault (config
// obsidian.vault), a grep of the current pane's folder (the journal's lastFocus pane cwd), and the product's web search
// (src/web-search searchWeb — the same cascade the WebSearch tool uses). Every tool is bounded (files walked, bytes read,
// hits returned, time) and read-only; repo/vault lines go through the shared redactSecretText before the model sees them.
//
// Why tool-call DECISION + a second answer round (not a full provider tool loop): the sidechat streams through
// provider.streamChat, and LLMMessage has no portable «tool result» role across providers. So round 1 offers the three
// tools; if the model calls any, the server runs them and round 2 asks the same question again with the numbered results
// in a system message and no tools — the answer streams and cites [n]. If the model answers directly in round 1, that text
// IS the answer (no second call). The model decides when to search (a structured tool call), never a keyword rule.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { redactSecretText } from '../debug/secret-redaction.js';
import type { SidechatMessage, SidechatStream } from './sidechat-hub.js';

export type SidechatToolName = 'vault_search' | 'repo_grep' | 'web_search';
export interface SidechatHit { readonly source: 'vault' | 'repo' | 'web'; readonly where: string; readonly text: string }
export interface WebHit { readonly url: string; readonly title: string; readonly snippet: string }

export interface SidechatToolDeps {
  readonly vault?: () => string | undefined;
  /** The current pane's working folder (repo grep scope); undefined = no pane in view. */
  readonly cwd?: () => string | undefined;
  readonly web?: (query: string, signal: AbortSignal) => Promise<readonly WebHit[]>;
}

// 출처: ELS-SIDECHAT-SEARCH — a popup answer, not a research run: 8 hits per tool, 3000 files walked, 512 KiB per file,
// 200 chars per hit line, 2 rounds of tools at most per question.
export const TOOL_MAX_HITS = 8;
export const TOOL_MAX_FILES = 3_000;
export const TOOL_MAX_FILE_BYTES = 524_288;
export const TOOL_HIT_CHARS = 200;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo', '.cache', '.obsidian', '.trash']);

export const SIDECHAT_TOOL_SPECS = [
  { name: 'vault_search', description: 'Search the user\'s Obsidian vault notes (read-only). Use for questions about the user\'s own notes.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'words to find in the notes' } }, required: ['query'] } },
  { name: 'repo_grep', description: 'Search the files of the current pane\'s folder (read-only; node_modules and .git skipped). Use for questions about the code or files the user is working on.',
    parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'literal text to find (case-insensitive)' } }, required: ['pattern'] } },
  { name: 'web_search', description: 'Search the public web. Use for current facts or anything outside the user\'s files.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
] as const;

export const SIDECHAT_TOOLS_SYSTEM = 'Tools (read-only): vault_search (the user\'s Obsidian notes), repo_grep (the current pane\'s folder), web_search (the public web). Call one only when the answer needs it; otherwise answer directly.';
export const SIDECHAT_CITE_SYSTEM = 'Answer the question using these search results. Cite every fact you take from them as [n] (the result number). If the results do not answer it, say so briefly.';

const clip = (line: string): string => { const one = line.replace(/\s+/g, ' ').trim(); return one.length > TOOL_HIT_CHARS ? `${one.slice(0, TOOL_HIT_CHARS - 1)}…` : one; };

/** Walk text files under `root` (bounded, symlinks not followed, skipped dirs), calling `visit(rel, text)`. */
function walk(root: string, accept: (name: string) => boolean, visit: (rel: string, text: string) => boolean): void {
  let files = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(path); continue; }
      if (!entry.isFile() || !accept(entry.name)) continue;
      if (++files > TOOL_MAX_FILES) return;
      let text: string;
      try { if (statSync(path).size > TOOL_MAX_FILE_BYTES) continue; const buf = readFileSync(path); if (buf.includes(0)) continue; text = buf.toString('utf8'); } catch { continue; }
      if (visit(relative(root, path), text)) return;
    }
  }
}

/** Lines matching the words (case-insensitive; a line scores by how many of the words it has), best first, bounded. */
function grepText(root: string, terms: readonly string[], accept: (name: string) => boolean, source: 'vault' | 'repo'): SidechatHit[] {
  const words = terms.map((one) => one.toLowerCase()).filter((one) => one.length >= 2);
  if (!words.length) return [];
  const found: Array<SidechatHit & { score: number }> = [];
  walk(root, accept, (rel, text) => {
    const lines = text.split('\n');
    for (let at = 0; at < lines.length; at++) {
      const low = lines[at]!.toLowerCase();
      const score = words.filter((word) => low.includes(word)).length;
      if (score) found.push({ source, where: `${rel}:${at + 1}`, text: clip(redactSecretText(lines[at]!)), score });
    }
    return found.length >= TOOL_MAX_HITS * 20;
  });
  return found.sort((a, b) => b.score - a.score).slice(0, TOOL_MAX_HITS).map(({ score: _s, ...hit }) => hit);
}

const realDir = (path: string | undefined): string | undefined => {
  if (!path?.trim()) return undefined;
  try { const real = realpathSync(path.trim()); return statSync(real).isDirectory() ? real : undefined; } catch { return undefined; }
};

/** Run one tool call → hits, or a one-line reason it could not run. Never throws. */
export async function runSidechatTool(deps: SidechatToolDeps, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ hits: SidechatHit[] } | { error: string }> {
  try {
    if (name === 'vault_search') {
      const root = realDir(deps.vault?.());
      if (!root) return { error: 'Obsidian vault not set or not found' };
      const query = typeof args.query === 'string' ? args.query.slice(0, 200) : '';
      return { hits: grepText(root, query.split(/\s+/), (file) => file.toLowerCase().endsWith('.md'), 'vault') };
    }
    if (name === 'repo_grep') {
      const root = realDir(deps.cwd?.());
      if (!root) return { error: 'no pane folder in view' };
      const pattern = typeof args.pattern === 'string' ? args.pattern.slice(0, 200) : '';
      return { hits: grepText(root, [pattern], () => true, 'repo') };
    }
    if (name === 'web_search') {
      if (!deps.web) return { error: 'web search is not available here' };
      const query = typeof args.query === 'string' ? args.query.slice(0, 300) : '';
      if (!query.trim()) return { hits: [] };
      const hits = await deps.web(query, signal);
      return { hits: hits.slice(0, TOOL_MAX_HITS).map((hit) => ({ source: 'web' as const, where: hit.url, text: clip(`${hit.title} — ${hit.snippet}`) })) };
    }
    return { error: `unknown tool ${name}` };
  } catch (error) { return { error: `search failed: ${error instanceof Error ? error.message.replace(/[\u0000-\u001f]/g, ' ').slice(0, 100) : 'error'}` }; }
}

/** The numbered results block the answer round cites: «[1] path:line — text» / «[2] URL — title — snippet». */
export function citationBlock(hits: readonly SidechatHit[], notes: readonly string[] = []): string {
  const lines = hits.map((hit, at) => `[${at + 1}] ${hit.where} — ${hit.text}`);
  return [...lines, ...notes.map((note) => `(${note})`)].join('\n') || '(no results)';
}

/** One model call event (the subset of the product stream events the sidechat uses). */
export type ModelEvent = { readonly type: 'text'; readonly delta: string } | { readonly type: 'tool_call'; readonly name: string; readonly args: Record<string, unknown> } | { readonly type: string };
export type ModelCall = (messages: readonly SidechatMessage[], signal: AbortSignal, withTools: boolean) => AsyncIterable<ModelEvent>;

// 출처: ELS-SIDECHAT-SEARCH — at most this many tool calls are run for one question (the rest are dropped).
export const MAX_TOOL_CALLS = 4;

/** The sidechat stream with search tools: round 1 offers the tools (direct text = the answer); tool calls → run them →
 *  round 2 streams the cited answer without tools. */
export function searchSidechatStream(call: ModelCall, deps: () => SidechatToolDeps): SidechatStream {
  return async function* (messages, signal) {
    const withTools: SidechatMessage[] = [...messages.slice(0, 1), { role: 'system', content: SIDECHAT_TOOLS_SYSTEM }, ...messages.slice(1)];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let said = false;
    for await (const event of call(withTools, signal, true)) {
      if (signal.aborted) return;
      if (event.type === 'text' && 'delta' in event && event.delta) { if (!calls.length) { said = true; yield event.delta; } }
      else if (event.type === 'tool_call' && 'name' in event && calls.length < MAX_TOOL_CALLS) calls.push({ name: event.name, args: event.args ?? {} });
    }
    if (!calls.length || signal.aborted) return;
    const hits: SidechatHit[] = [];
    const notes: string[] = [];
    const toolDeps = deps();
    for (const one of calls) {
      const done = await runSidechatTool(toolDeps, one.name, one.args, signal);
      if ('error' in done) notes.push(`${one.name}: ${done.error}`); else hits.push(...done.hits);
    }
    const answer: SidechatMessage[] = [...messages.slice(0, 1), { role: 'system', content: `${SIDECHAT_CITE_SYSTEM}\n\n${citationBlock(hits.slice(0, TOOL_MAX_HITS * 2), notes)}` }, ...messages.slice(1)];
    if (said) yield '\n\n';                                         // a preamble before the tool call stays; the answer starts below it
    for await (const event of call(answer, signal, false)) {
      if (signal.aborted) return;
      if (event.type === 'text' && 'delta' in event && event.delta) yield event.delta;
    }
  };
}

/** Production model call: the product LLM client on the budget tier (same as productSidechatStream), tools offered on
 *  round 1. Loaded lazily so the els server starts light. */
export const productModelCall: ModelCall = async function* (messages, signal, withTools) {
  const [{ getProviderForConfig }, { getUserConfig }, { streamChatLedgered }, { tierModel }] = await Promise.all([
    import('../llm.js'), import('../user-config.js'), import('../llm/ledgered-call.js'), import('../llm/model-defaults.js'),
  ]);
  const provider = getProviderForConfig(getUserConfig());
  if (!provider.streamChat) throw new Error('the configured provider cannot stream');
  let model: string | undefined;
  try { model = tierModel('budget', provider.name as Parameters<typeof tierModel>[1]); } catch { model = undefined; }
  const opts = { temperature: 0.3, maxTokens: 1200, signal, ...(model ? { model } : {}), ...(withTools ? { tools: SIDECHAT_TOOL_SPECS.map((one) => ({ ...one, parameters: one.parameters as Record<string, unknown> })) } : {}) };
  yield* streamChatLedgered(provider, messages.map((one) => ({ role: one.role, content: one.content })) as never, opts, { site: 'els-sidechat', jobKind: 'els-sidechat' }) as AsyncIterable<ModelEvent>;
};

/** Production web search: the product cascade (src/web-search), top hits. */
export async function productWebSearch(query: string, signal: AbortSignal): Promise<readonly WebHit[]> {
  const { searchWeb } = await import('../web-search/index.js');
  const result = await searchWeb({ query, limit: TOOL_MAX_HITS }, { signal });
  return result.hits.map((hit) => ({ url: hit.url, title: hit.title, snippet: hit.snippet }));
}
