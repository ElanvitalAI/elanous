// TUI-NEXT-PROVIDER-FLAG-IGNORED e2e driver — JUD-B #126943 probe (node-b
// /private/tmp/judb-39541-Wsw6Pn/head/src/repl/judb-probe.ts, fetched per OP
// #128708), moved into the PR as a test fixture. Run as a child process with
// PROBE_HOME set and one JSONL turn on stdin; the chat.runTurn spy prints the
// provider/model the model call actually received as a PROBE_CAPTURE line.
import { spyOn } from "bun:test";
import * as os from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
const home = process.env.PROBE_HOME!;
mkdirSync(home, { recursive: true });
spyOn(os, "homedir").mockReturnValue(home);
const { setElanousConfigDir } = await import("../elanous-config-dir.js");
setElanousConfigDir(home);
const { getUserConfig, userConfigPath } = await import("../user-config.js");
// Baseline saved choice (same fixture as the passthrough test): the seat's
// saved config is Codex, so a turn WITHOUT sessionProvider resolves to
// openai-codex/gpt-6-sol instead of the empty-home default `auto`.
writeFileSync(userConfigPath(), JSON.stringify({ llm: { provider: "openai-codex", model: "gpt-6-sol" } }));
const chat = await import("../session/chat.js");
spyOn(chat, "runTurn").mockImplementation(async (turn: any) => {
  console.error("PROBE_CAPTURE " + JSON.stringify({ provider: turn.userConfig.llm.provider, model: turn.userConfig.llm.model }));
  return { text: "mock reply", provider: turn.userConfig.llm.provider, model: turn.userConfig.llm.model, meta: { id: turn.sessionId }, usedTokens: 0, droppedMessages: 0, memoryIds: [] } as any;
});
const { runRepl } = await import("./index.js");
const base = getUserConfig();
const cfg = { ...base, llm: { ...base.llm, provider: "openai-codex", model: "gpt-6-sol" } } as any;
await runRepl({ cfg, initialSessionId: undefined, scenarioPath: undefined, forceNew: true, enableTools: false, scriptedFromStdin: true, jsonOutput: true, exitAfterScenario: true });
