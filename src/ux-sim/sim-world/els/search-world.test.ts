// ELS-SIDECHAT-SEARCH sim — seeded scenarios over the sidechat world (REAL registry + hub + attach apps, fake clock) whose
// scripted model stream is wrapped by the REAL two-round search stream: a scripted chunk «§TOOL <name> <json>» is the
// model's tool call; the next scripted call is the answer round. Fake vault / repo folders and a fake web search (no
// network). Invariants per frame (sidechat-world frameViolations: rows, width in cells, status line) and: the raw secret of
// a repo line never appears in any frame nor in what the model is sent; citations [n] map to the numbered results.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchSidechatStream, type ModelCall } from '../../../els/sidechat-tools.js';
import type { SidechatStream } from '../../../els/sidechat-hub.js';
import { createSidechatWorld, type SidechatViewer, type SidechatWorld } from './sidechat-world.js';

const SEEDS = [1, 2, 3, 4, 5, 6] as const;
const PREFIX = '\u0002';
const SECRET = 'sk-proj-ZyXwVu9876543210ZyXwVu9876543210';
const roots: string[] = [];
const worlds: SidechatWorld[] = [];
afterAll(() => { for (const one of worlds) one.dispose(); for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
const plain = (rows: readonly string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''));
const text = (v: SidechatViewer): string => plain(v.last()).join('\n');

interface SearchWorld { readonly w: SidechatWorld; readonly webQueries: string[] }
function world(seed: number): SearchWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `search-sim-${seed}-`)));
  roots.push(root);
  mkdirSync(join(root, 'vault', 'Projects'), { recursive: true });
  writeFileSync(join(root, 'vault', 'Projects', 'els.md'), '# els\n\nThe z-axis overlay ships Friday.\n');
  mkdirSync(join(root, 'repo', 'src'), { recursive: true });
  mkdirSync(join(root, 'repo', 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(root, 'repo', 'src', 'config.ts'), `export const OPENAI_API_KEY = "${SECRET}";\nexport const PORT = 8080;\n`);
  writeFileSync(join(root, 'repo', 'node_modules', 'x', 'i.js'), 'PORT = 1');
  const webQueries: string[] = [];
  // The scripted world stream → model events: «§TOOL name {json}» is a tool call, anything else text.
  const wrap = (inner: SidechatStream): SidechatStream => {
    const call: ModelCall = async function* (messages, signal) {
      for await (const chunk of inner(messages, signal)) {
        const tool = /^§TOOL (\S+) (.*)$/.exec(chunk);
        if (tool) yield { type: 'tool_call', name: tool[1]!, args: JSON.parse(tool[2]!) as Record<string, unknown> };
        else yield { type: 'text', delta: chunk };
      }
    };
    return searchSidechatStream(call, () => ({ vault: () => join(root, 'vault'), cwd: () => join(root, 'repo'),
      web: async (query) => { webQueries.push(query); return [{ url: 'https://example.com/release', title: 'Release notes', snippet: 'v0.3.40 ships today' }]; } }));
  };
  const w = createSidechatWorld(seed, () => ({}), wrap);
  worlds.push(w);
  return { w, webQueries };
}
const sizes = [{ cols: 120, rows: 30 }, { cols: 80, rows: 24 }, { cols: 200, rows: 50 }, { cols: 64, rows: 18 }] as const;
async function ask(t: SearchWorld, v: SidechatViewer, q: string): Promise<void> {
  for (const ch of Array.from(q)) v.press(ch);
  v.press('\r');
  await t.w.flush();
}
async function sayAll(t: SearchWorld, at: number, answer: string): Promise<void> {
  let i = 0;
  while (i < answer.length) { const n = t.w.rand.int(1, 8); await t.w.calls[at]!.say(answer.slice(i, i + n)); i += n; }
  await t.w.calls[at]!.end();
  await t.w.flush();
}

describe('S1 · the model calls vault_search → round 2 gets «[1] Projects/els.md:3 — …» → the streamed answer cites [1]', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(sizes[t.w.rand.int(0, sizes.length - 1)]!);
    v.press(`${PREFIX}/`); await t.w.flush();
    await ask(t, v, '오버레이 언제 나와?');
    await t.w.calls[0]!.say('§TOOL vault_search {"query":"overlay Friday"}');
    await t.w.calls[0]!.end();
    await t.w.flush();
    expect(t.w.calls).toHaveLength(2);
    expect(t.w.calls[1]!.messages[1]!.content).toContain('[1] Projects/els.md:3 — The z-axis overlay ships Friday.');
    await sayAll(t, 1, 'Friday — the z-axis overlay ships then [1].');
    expect(text(v)).toContain('[1].');
    expect(text(v)).toContain('Friday');
    expect(v.violations).toEqual([]);
  });
});

describe('S2 · repo_grep in the pane folder: node_modules skipped, the secret redacted before the model and never on screen', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(sizes[t.w.rand.int(0, sizes.length - 1)]!);
    v.press(`${PREFIX}/`); await t.w.flush();
    await ask(t, v, 'which port and key does config use?');
    await t.w.calls[0]!.say(t.w.rand.int(0, 1) ? '§TOOL repo_grep {"pattern":"export const"}' : '§TOOL repo_grep {"pattern":"EXPORT CONST"}');
    await t.w.calls[0]!.end(); await t.w.flush();
    const sent = t.w.calls[1]!.messages.map((one) => one.content).join('\n');
    expect(sent).toContain('src/config.ts:2 — export const PORT = 8080;');
    expect(sent).not.toContain('node_modules');
    expect(sent).not.toContain(SECRET);
    await sayAll(t, 1, 'PORT is 8080 [2]; the key is redacted [1].');
    expect(text(v)).toContain('8080');
    expect(text(v)).not.toContain(SECRET);
    expect(v.violations).toEqual([]);
  });
});

describe('S3 · web_search → URL citation; a direct answer makes ONE call (no second round); Esc mid-round-2 stops it', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed);
    const v = await t.w.viewer(sizes[t.w.rand.int(0, sizes.length - 1)]!);
    v.press(`${PREFIX}/`); await t.w.flush();
    await ask(t, v, 'what shipped today?');
    await t.w.calls[0]!.say('§TOOL web_search {"query":"release today"}');
    await t.w.calls[0]!.end(); await t.w.flush();
    expect(t.webQueries).toEqual(['release today']);
    expect(t.w.calls[1]!.messages[1]!.content).toContain('[1] https://example.com/release — Release notes — v0.3.40 ships today');
    await sayAll(t, 1, 'v0.3.40 shipped today [1].');
    expect(text(v)).toContain('v0.3.40 shipped today [1].');
    // A follow-up answered directly: one more call only.
    await ask(t, v, 'thanks — say ok');
    await sayAll(t, 2, 'ok');
    expect(t.w.calls).toHaveLength(3);
    // A third question that searches, closed during the answer round: no orphan text.
    await ask(t, v, 'and the vault?');
    await t.w.calls[3]!.say('§TOOL vault_search {"query":"overlay"}'); await t.w.calls[3]!.end(); await t.w.flush();
    await t.w.calls[4]!.say('partial…');
    v.press('\u001b'); await t.w.flush();
    expect(t.w.layer()).toBeUndefined();
    expect(t.w.calls[4]!.aborted()).toBe(true);
    expect(v.violations).toEqual([]);
  });
});
