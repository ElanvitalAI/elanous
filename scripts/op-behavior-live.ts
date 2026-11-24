// Run explicitly on a disposable machine/state root. No production tools are dispatched.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getProviderForConfigAsync } from '../src/llm.js';
import { LIVE_SCENARIOS, runLiveScenario } from '../src/seat-loop/op-behavior-live.js';
import { runCheckpointed } from '../src/seat-loop/op-behavior-checkpoint.js';
import { buildReplSystemPrompt } from '../src/repl/index.js';
import { getUserConfig } from '../src/user-config.js';
import { setGlobalAnchorPathForTest } from '../src/prompt-library/universal-preamble.js';

const args = process.argv.slice(2);
const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const output = value('--output');
const promptPath = value('--prompt-file');
const emitPrompt = value('--emit-prompt');
const model = value('--model') ?? 'gpt-6.1-terra';
if (args.includes('--resume') && !promptPath) throw new Error('--resume requires the original --prompt-file');
for (const name of ['ELANOUS_STATE_DIR', 'ELANOUS_CONFIG_DIR']) {
  const path = process.env[name];
  if (!path || !isAbsolute(path) || !resolve(path).startsWith(`${resolve(tmpdir())}/`)) throw new Error(`${name} must point inside the OS temporary directory`);
}
if ((!output && !emitPrompt) || (output && (!isAbsolute(output) || !resolve(output).startsWith(`${resolve(tmpdir())}/`)))) {
  throw new Error('provide --output inside the OS temporary directory, or --emit-prompt');
}
for (const name of ['ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE']) {
  if (process.env[name]) throw new Error(`refusing fake/simulation provider switch ${name}`);
}
if (process.env.NODE_ENV === 'test') throw new Error('refusing NODE_ENV=test: the model may be fake');
const root = mkdtempSync(join(tmpdir(), 'op-live-eval-'));
const home = join(root, 'home');
const cwd = join(home, 'elanous-hq', 'seats', 'OP');
mkdirSync(cwd, { recursive: true });
mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
writeFileSync(join(cwd, 'AGENTS.local.md'), '역할 = OP 자리\n');
const cfg = getUserConfig();
cfg.llm.model = model;
setGlobalAnchorPathForTest(null);
const prompt = promptPath ? readFileSync(promptPath, 'utf8') : buildReplSystemPrompt({ cfg, cwd,
  enabledToolNames: ['Read', 'MsgPost', 'MsgAck', 'RunShell'], sessionId: 'op-live-eval',
  seatBootDeps: { home, msgPath: join(root, 'msg', 'messages.db'), env: { NODE_ENV: 'production' } }, skillCatalog: [],
}) ?? '';
if (!prompt.trim() || !prompt.includes('## 조율자 프로필')) throw new Error('OP assembled coordinator prompt missing');
if (emitPrompt) {
  if (!isAbsolute(emitPrompt) || !resolve(emitPrompt).startsWith(`${resolve(tmpdir())}/`)) throw new Error('prompt output must be in temporary directory');
  writeFileSync(emitPrompt, prompt, { flag: 'wx' });
} else {
  const provider = await getProviderForConfigAsync(cfg, model);
  if (/fake|mock/i.test(provider.name)) throw new Error('refusing fake or mock provider');
  const sha = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');
  const evaluatorSha256 = sha(Buffer.concat([
    readFileSync(import.meta.path), readFileSync(new URL('../src/seat-loop/op-behavior-live.ts', import.meta.url)),
    readFileSync(new URL('../src/seat-loop/op-behavior-checkpoint.ts', import.meta.url)),
  ]));
  const result = await runCheckpointed({ path: output!, resume: args.includes('--resume'), scenarios: LIVE_SCENARIOS,
    binding: { model, provider: provider.name, promptSha256: sha(prompt), evaluatorSha256, scenarioSha256: sha(JSON.stringify(LIVE_SCENARIOS)) },
    run: scenario => runLiveScenario(scenario, prompt, provider, model),
  });
  console.log(JSON.stringify({ model, complete: result.complete, summary: result.summary, output }));
  if (!result.complete) process.exitCode = 1;
}
