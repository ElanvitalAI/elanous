// ELS-SIDECHAT-SEARCH — the read-only search tools and the two-round stream, fakes only (temp folders, a fake model, a fake
// web search — no network). Literal expectations.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { citationBlock, runSidechatTool, searchSidechatStream, SIDECHAT_CITE_SYSTEM, SIDECHAT_TOOLS_SYSTEM, type ModelCall, type ModelEvent } from './sidechat-tools.js';

const dirs: string[] = [];
const temp = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sc-tools-'))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const never = new AbortController().signal;

function vault(): string {
  const v = temp();
  mkdirSync(join(v, 'Projects'));
  mkdirSync(join(v, '.obsidian'));
  writeFileSync(join(v, 'Projects', 'els.md'), '# els\n\nThe z-axis overlay ships Friday.\nunrelated line\n');
  writeFileSync(join(v, 'Welcome.md'), 'Welcome to the vault. overlay basics.\n');
  writeFileSync(join(v, '.obsidian', 'workspace.md'), 'overlay hidden\n');
  writeFileSync(join(v, 'image.png'), 'overlay');
  return v;
}

describe('tools', () => {
  test('vault_search: .md only, hidden folders skipped, best match first, path:line', async () => {
    const v = vault();
    const done = await runSidechatTool({ vault: () => v }, 'vault_search', { query: 'overlay Friday' }, never);
    expect(done).toEqual({ hits: [
      { source: 'vault', where: 'Projects/els.md:3', text: 'The z-axis overlay ships Friday.' },
      { source: 'vault', where: 'Welcome.md:1', text: 'Welcome to the vault. overlay basics.' },
    ] });
    expect(await runSidechatTool({}, 'vault_search', { query: 'x' }, never)).toEqual({ error: 'Obsidian vault not set or not found' });
  });
  test('repo_grep: the pane folder only, node_modules/.git skipped, secrets redacted, binaries and symlinks skipped', async () => {
    const repo = temp();
    const outside = temp();
    mkdirSync(join(repo, 'src')); mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true }); mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'const token = "x";\nexport const OPENAI_API_KEY = "sk-proj-AbCdEf0123456789AbCdEf0123456789";\n');
    writeFileSync(join(repo, 'node_modules', 'x', 'i.js'), 'OPENAI_API_KEY');
    writeFileSync(join(repo, '.git', 'config'), 'OPENAI_API_KEY');
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x4f, 0x50, 0, 0x41]));
    writeFileSync(join(outside, 'leak.ts'), 'OPENAI_API_KEY outside');
    symlinkSync(outside, join(repo, 'linked'));
    const done = await runSidechatTool({ cwd: () => repo }, 'repo_grep', { pattern: 'openai_api_key' }, never) as { hits: Array<{ where: string; text: string }> };
    expect(done.hits.map((hit) => hit.where)).toEqual(['src/a.ts:2']);
    expect(done.hits[0]!.text.includes('sk-proj-AbCdEf0123456789')).toBe(false);
    expect(await runSidechatTool({}, 'repo_grep', { pattern: 'x' }, never)).toEqual({ error: 'no pane folder in view' });
  });
  test('web_search: the injected search, bounded; failures are one line', async () => {
    const web = async (query: string) => [{ url: 'https://example.com/a', title: `About ${query}`, snippet: 'snippet one' }];
    expect(await runSidechatTool({ web }, 'web_search', { query: 'els' }, never)).toEqual({ hits: [{ source: 'web', where: 'https://example.com/a', text: 'About els — snippet one' }] });
    expect(await runSidechatTool({ web: async () => { throw new Error('quota\nexceeded'); } }, 'web_search', { query: 'q' }, never)).toEqual({ error: 'search failed: quota exceeded' });
    expect(await runSidechatTool({}, 'web_search', { query: 'q' }, never)).toEqual({ error: 'web search is not available here' });
    expect(await runSidechatTool({}, 'rm_rf', {}, never)).toEqual({ error: 'unknown tool rm_rf' });
  });
  test('citation block', () => {
    expect(citationBlock([{ source: 'vault', where: 'a.md:1', text: 'x' }, { source: 'web', where: 'https://e.com', text: 'T — s' }], ['repo_grep: no pane folder in view']))
      .toBe('[1] a.md:1 — x\n[2] https://e.com — T — s\n(repo_grep: no pane folder in view)');
    expect(citationBlock([])).toBe('(no results)');
  });
});

describe('two-round stream', () => {
  const collect = async (stream: AsyncIterable<string>): Promise<string> => { let out = ''; for await (const one of stream) out += one; return out; };
  const scripted = (rounds: ModelEvent[][]) => {
    const seen: Array<{ messages: readonly { role: string; content: string }[]; withTools: boolean }> = [];
    const call: ModelCall = async function* (messages, _signal, withTools) { seen.push({ messages, withTools }); for (const event of rounds[seen.length - 1] ?? []) yield event; };
    return { call, seen };
  };
  const question = [{ role: 'system' as const, content: 'SYS' }, { role: 'user' as const, content: 'when does the overlay ship?' }];
  test('a direct answer: one call, tools offered, text streamed as is', async () => {
    const s = scripted([[{ type: 'text', delta: 'Hello ' }, { type: 'text', delta: 'there' }]]);
    expect(await collect(searchSidechatStream(s.call, () => ({}))(question, never))).toBe('Hello there');
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]!.withTools).toBe(true);
    expect(s.seen[0]!.messages.map((one) => one.content)).toEqual(['SYS', SIDECHAT_TOOLS_SYSTEM, 'when does the overlay ship?']);
  });
  test('a tool call: the tool runs, round 2 gets numbered results (no tools) and streams the cited answer', async () => {
    const v = vault();
    const s = scripted([[{ type: 'tool_call', name: 'vault_search', args: { query: 'Friday' } }], [{ type: 'text', delta: 'Friday [1].' }]]);
    expect(await collect(searchSidechatStream(s.call, () => ({ vault: () => v }))(question, never))).toBe('Friday [1].');
    expect(s.seen).toHaveLength(2);
    expect(s.seen[1]!.withTools).toBe(false);
    expect(s.seen[1]!.messages[1]!.content).toBe(`${SIDECHAT_CITE_SYSTEM}\n\n[1] Projects/els.md:3 — The z-axis overlay ships Friday.`);
  });
  test('a preamble before the tool call stays, separated; at most 4 tool calls run; a failing tool is a note', async () => {
    const s = scripted([[{ type: 'text', delta: 'Let me look.' }, ...Array.from({ length: 6 }, () => ({ type: 'tool_call', name: 'repo_grep', args: { pattern: 'x' } }))], [{ type: 'text', delta: 'Not found.' }]]);
    expect(await collect(searchSidechatStream(s.call, () => ({}))(question, never))).toBe('Let me look.\n\nNot found.');
    expect(s.seen[1]!.messages[1]!.content).toBe(`${SIDECHAT_CITE_SYSTEM}\n\n(repo_grep: no pane folder in view)\n(repo_grep: no pane folder in view)\n(repo_grep: no pane folder in view)\n(repo_grep: no pane folder in view)`);
  });
  test('an aborted question stops before the second round', async () => {
    const abort = new AbortController();
    const s = scripted([[{ type: 'tool_call', name: 'web_search', args: { query: 'q' } }], [{ type: 'text', delta: 'late' }]]);
    abort.abort();
    expect(await collect(searchSidechatStream(s.call, () => ({ web: async () => [] }))(question, abort.signal))).toBe('');
    expect(s.seen).toHaveLength(1);
  });
});
