// Isolated child: actual JSONL REPL, real checklist and message stores; only the model is fake.
import { spyOn } from 'bun:test';
import * as os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.PROBE_HOME!;
spyOn(os, 'homedir').mockReturnValue(home);
process.env.COORD_ID = 'TEST-2';
process.env.ELANOUS_STATE_DIR = join(home, 'state');
mkdirSync(join(home, 'elanous-hq', 'seat-state', 'TEST-2'), { recursive: true });
const { setElanousConfigDir } = await import('../elanous-config-dir.js');
setElanousConfigDir(join(home, 'state'));
const { addItem } = await import('../release-loop/checklist.js');
addItem('0.3.33', { id: 'SYNTH-CELL', title: 'synthetic=true', owner: 'TEST-1' });
addItem('0.3.33', { id: 'SYNTH-OWN', title: 'synthetic=true', owner: 'TEST-2' });
const { getUserConfig, userConfigPath } = await import('../user-config.js');
writeFileSync(userConfigPath(), JSON.stringify({ llm: { provider: 'openai-codex', model: 'fake' } }));
const chat = await import('../session/chat.js');
spyOn(chat, 'runTurn').mockImplementation(async (turn: any) => {
  console.error('MODEL ' + turn.userText);
  // Positive control: if this model runs, it invokes an actual safe ledger tool.
  console.error('TOOL ' + turn.userText);
  await turn.dispatchTool('MsgList', { to: 'TEST-1' });
  return { text: 'fake model', provider: 'fake', model: 'fake', meta: { id: turn.sessionId }, usedTokens: 0, droppedMessages: 0, memoryIds: [] } as any;
});
const { initSessionWorkingDir } = await import('../session/working-dir.js');
initSessionWorkingDir(home);
const { runRepl } = await import('./index.js');
await runRepl({ cfg: getUserConfig(), initialSessionId: undefined, scenarioPath: undefined, forceNew: true,
  enableTools: true, scriptedFromStdin: true, jsonOutput: true, exitAfterScenario: true });
