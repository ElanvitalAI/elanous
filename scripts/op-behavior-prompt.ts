// Copy this script into each pinned checkout to capture that revision's actual
// assembled OP REPL prompt. It does not call a model or a production tool.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { buildReplSystemPrompt } from '../src/repl/index.js';
import { getUserConfig } from '../src/user-config.js';
import { setGlobalAnchorPathForTest } from '../src/prompt-library/universal-preamble.js';

const output = process.argv[2];
if (!output || !isAbsolute(output) || !resolve(output).startsWith(`${resolve(tmpdir())}/`)) throw new Error('absolute temporary output path required');
// Reuse the exact same isolated fixture across checkouts when comparing
// prompts. Otherwise random paths, file mtimes and boot timestamps vary.
const fixture = process.argv[4];
const root = fixture ? resolve(fixture) : mkdtempSync(join(tmpdir(), 'op-prompt-snapshot-'));
const tempRoot = realpathSync(tmpdir());
if (fixture) {
  if (!isAbsolute(fixture) || !existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()
    || !realpathSync(root).startsWith(`${tempRoot}/`)) throw new Error('fixture must be an existing, non-symlink temporary directory');
  const state = process.env.ELANOUS_STATE_DIR;
  if (!state || !isAbsolute(state) || !resolve(state).startsWith(`${resolve(tmpdir())}/`)) throw new Error('ELANOUS_STATE_DIR must be isolated in the temporary directory');
}
const home = join(root, 'home'), cwd = join(home, 'elanous-hq', 'seats', 'OP');
mkdirSync(cwd, { recursive: true });
mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
const agents = join(cwd, 'AGENTS.local.md');
if (existsSync(agents)) {
  if (lstatSync(agents).isSymbolicLink() || readFileSync(agents, 'utf8') !== '역할 = OP 자리\n') throw new Error('fixture AGENTS.local.md differs');
} else {
  writeFileSync(agents, '역할 = OP 자리\n', { flag: 'wx' });
  if (fixture) { const stamp = new Date('2026-11-23T18:00:00.000Z'); utimesSync(agents, stamp, stamp); }
}
const cfg = getUserConfig();
cfg.llm.model = process.argv[3] ?? 'gpt-6.1-terra';
setGlobalAnchorPathForTest(null);
const prompt = buildReplSystemPrompt({ cfg, cwd, enabledToolNames: ['Read', 'MsgPost', 'MsgAck', 'RunShell'],
  sessionId: 'op-live-eval', seatBootDeps: { home, msgPath: join(root, 'msg', 'messages.db'), env: { NODE_ENV: 'production' },
    ...(fixture ? { now: () => new Date('2026-11-23T18:00:00.000Z') } : {}) }, skillCatalog: [] }) ?? '';
if (!prompt.includes('## 조율자 프로필')) throw new Error('OP coordinator prompt missing');
writeFileSync(output, prompt, { flag: 'wx' });
