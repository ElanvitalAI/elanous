import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { splitDeferredToolSpecs } from '../session-runtime/tier-flip.js';
import { getUserConfig } from '../user-config.js';
import { buildReplSystemPrompt, buildReplTools, coordinatorElsReadResult } from './index.js';

const roots: string[] = [];
const oldState = process.env.ELANOUS_STATE_DIR;
afterEach(() => {
  if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() { const root = mkdtempSync(join(tmpdir(), 'coord-trim-')); roots.push(root); return root; }

test('coordinator prompt omits installed catalog, while hand and non-seat keep it', () => {
  const home = fixture();
  for (const seat of ['OP', 'TC']) mkdirSync(join(home, 'elanous-hq', 'seat-state', seat), { recursive: true });
  const build = (seat?: string) => buildReplSystemPrompt({ cfg: getUserConfig(), cwd: home,
    enabledToolNames: ['skill_exec', 'elanous_skills_list'], skillCatalog: [{ name: 'demo-skill', description: 'Demo.' }],
    seatBootDeps: { home, env: seat ? { COORD_ID: seat } : {} } }) ?? '';
  expect(build('OP')).not.toContain('[Installed skills]');
  expect(build('TC')).toContain('demo-skill');
  expect(build()).toContain('demo-skill');
});

test('coordinator defers coding schemas but ToolSearch can hydrate them; hand retains them', async () => {
  const coord = buildReplTools({ nextTui: true, seatRole: 'coordinator' });
  const hand = buildReplTools({ nextTui: true, seatRole: 'hand' });
  const cs = splitDeferredToolSpecs(coord.specs), hs = splitDeferredToolSpecs(hand.specs);
  for (const name of ['Edit', 'Write', 'Grep', 'Glob', 'ListDir']) {
    expect(cs.deferred.map(s => s.name)).toContain(name);
    expect(cs.active.map(s => s.name)).not.toContain(name);
    expect(hs.active.map(s => s.name)).toContain(name);
  }
  expect(cs.active.map(s => s.name)).toContain('ToolSearch');
  expect(JSON.stringify(await coord.dispatch('ToolSearch', { query: 'select:Edit' }))).toContain('Edit');
});

test('coordinator mailbox pages at 10 and hand keeps the ordinary limit', async () => {
  const root = fixture(); process.env.ELANOUS_STATE_DIR = root;
  const store = new MsgStore(join(root, 'msg', 'messages.db'));
  try { for (let i = 0; i < 15; i++) store.post({ from: 'TC', to: 'OP', body: `msg ${i}` }); }
  finally { store.close(); }
  const coord = buildReplTools({ nextTui: true, seatRole: 'coordinator' });
  const hand = buildReplTools({ nextTui: true, seatRole: 'hand' });
  const first = await coord.dispatch('MsgList', { to: 'OP', limit: 100 }) as { messages: { id: number }[] };
  expect(first.messages).toHaveLength(10);
  const second = await coord.dispatch('MsgList', { to: 'OP', after: first.messages.at(-1)!.id }) as { messages: unknown[] };
  expect(second.messages).toHaveLength(5);
  expect((await hand.dispatch('MsgList', { to: 'OP' }) as { messages: unknown[] }).messages).toHaveLength(15);
});

test('pane read keeps last 20 lines, while other actions and failures remain unchanged', () => {
  const message = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const input = JSON.stringify({ action: 'read', ok: true, message });
  const result = JSON.parse(coordinatorElsReadResult({ action: 'read' }, input));
  expect(result.message).toContain('line 6\n'); expect(result.message).toContain('line 25');
  expect(result.message).not.toContain('line 5\n');
  expect(coordinatorElsReadResult({ action: 'status' }, input)).toBe(input);
  const failed = JSON.stringify({ ok: false, message });
  expect(coordinatorElsReadResult({ action: 'read' }, failed)).toBe(failed);
});
