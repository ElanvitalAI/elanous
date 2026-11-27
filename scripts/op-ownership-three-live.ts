import { tierModel } from '../src/llm/model-defaults.js';
// Explicitly isolated, synthetic evaluation; no production tools are dispatched.
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getProviderForConfigAsync } from '../src/llm.js';
import { getUserConfig } from '../src/user-config.js';
import { LIVE_SCENARIOS, runLiveScenario } from '../src/seat-loop/op-behavior-live.js';
import { runRoster770 } from '../src/seat-loop/op-roster-770.js';

const args = process.argv.slice(2);
const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const promptPath = value('--prompt-file'), output = value('--output'), model = value('--model') ?? tierModel('balanced');
const inTemp = (path: string | undefined) => Boolean(path && isAbsolute(path) && resolve(path).startsWith(`${resolve(tmpdir())}/`));
for (const name of ['ELANOUS_STATE_DIR', 'ELANOUS_CONFIG_DIR']) if (!inTemp(process.env[name])) throw new Error(`${name} must be inside the temporary directory`);
if (!inTemp(promptPath) || !inTemp(output)) throw new Error('prompt and output must be inside the temporary directory');
for (const name of ['ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE']) if (process.env[name]) throw new Error(`refusing ${name}`);
if (process.env.NODE_ENV === 'test') throw new Error('refusing test provider');
const prompt = readFileSync(promptPath!, 'utf8');
if (!prompt.includes('## 조율자 프로필')) throw new Error('assembled OP prompt required');
const cfg = getUserConfig(); cfg.llm.model = model;
const provider = await getProviderForConfigAsync(cfg, model);
if (/fake|mock/i.test(provider.name)) throw new Error('refusing fake provider');
const roster = await runRoster770(prompt, provider, model);
const cases = [];
for (const id of ['cut-blocker', 'review-stall']) {
  const scenario = LIVE_SCENARIOS.find(item => item.id === id);
  if (!scenario) throw new Error(`missing scenario ${id}`);
  cases.push(await runLiveScenario(scenario, prompt, provider, model));
}
const runs = [roster, ...cases];
const evaluatorSha256 = createHash('sha256').update(Buffer.concat([
  readFileSync(import.meta.path), readFileSync(new URL('../src/seat-loop/op-roster-770.ts', import.meta.url)),
  readFileSync(new URL('../src/seat-loop/op-behavior-live.ts', import.meta.url)),
])).digest('hex');
const summary = { completed: runs.filter(run => run.completed).length, total: runs.length,
  errors: runs.filter(run => run.error).length, naturalLanguageUnconfirmed: null, exactHumanHandoffs: null };
writeFileSync(output!, JSON.stringify({ evaluatorSha256, summary, runs }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ summary, output }));
if (summary.errors) process.exitCode = 1;
