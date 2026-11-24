import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as llm from '../llm.js';
import * as seatBoot from '../seat/seat-boot-preamble.js';
import { runCoreTurn } from './run-core-turn.js';

const originalCwd = process.cwd();
const savedCoord = process.env.COORD_ID;
let root = '';
afterEach(() => {
  process.chdir(originalCwd);
  if (savedCoord === undefined) delete process.env.COORD_ID; else process.env.COORD_ID = savedCoord;
  if (root) rmSync(root, { recursive: true, force: true });
});

test('real seat detection admits mail, while missing or throwing detection stays closed', async () => {
  root = mkdtempSync(join(tmpdir(), 'research-seat-detect-'));
  const seat = join(root, 'seats', 'SIMSEAT'), plain = join(root, 'plain');
  mkdirSync(seat, { recursive: true }); mkdirSync(plain, { recursive: true });
  delete process.env.COORD_ID;
  let offered: string[] = [];
  const stream = spyOn(llm, 'streamLLMWithTools').mockImplementation(async (_messages, _handlers, options) => {
    offered = options?.tools?.map(tool => tool.name) ?? []; return 'done';
  });
  const spec = (name: string) => ({ name, description: name, parameters: { type: 'object' } });
  const run = async () => {
    offered = [];
    await runCoreTurn({ sessionId: 'seat-detection-test', messages: [{ role: 'user', content: 'Research recent battery policy updates using current sources.' }],
      userText: 'Research recent battery policy updates using current sources.', tools: [spec('WebSearch'), spec('MsgPost'), spec('MsgAck')],
      dispatchTool: async () => 'ok', signal: new AbortController().signal },
    { runResearch: async () => ({ ok: true, output: 'evidence' }), stallMailer: async () => {} });
    return offered;
  };
  let detection: ReturnType<typeof spyOn> | undefined;
  try {
    process.chdir(seat); expect(await run()).toContain('MsgPost');
    process.chdir(plain); expect(await run()).not.toContain('MsgPost');
    detection = spyOn(seatBoot, 'detectSeat').mockImplementation(() => { throw new Error('unavailable'); });
    process.chdir(seat); expect(await run()).not.toContain('MsgPost');
  } finally { detection?.mockRestore(); stream.mockRestore(); }
});
