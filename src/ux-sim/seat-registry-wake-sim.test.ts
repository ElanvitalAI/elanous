import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { spyOn } from 'bun:test';
import { debug } from '../debug/log.js';
import { MsgStore } from '../msg/msg-store.js';
import { registerMsgCommands, type MsgCliDeps } from '../cli/msg-cli.js';
import { quoteRemoteHerdrCommand } from '../loops/msg-wake.js';
import type { HerdrCliRunner } from '../pty-shell/herdr-prompt.js';

const dirs: string[] = [];
const originalAgentRuntime = process.env.ELANOUS_AGENT_RUNTIME;
function restoreAgentRuntime() {
  if (originalAgentRuntime === undefined) delete process.env.ELANOUS_AGENT_RUNTIME;
  else process.env.ELANOUS_AGENT_RUNTIME = originalAgentRuntime;
}
afterEach(() => {
  restoreAgentRuntime();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function simulatedRemoteHerdr(agent: () => string, status: () => string, observeRun: (runtime: string, receiver: string) => void) {
  const calls: string[][] = [];
  const runner: HerdrCliRunner = async argv => {
    calls.push([...argv]);
    if (argv[0] === 'pane' && argv[1] === 'list') return { code: 0, stderr: '', stdout: JSON.stringify({
      id: 'cli:pane:list', result: { panes: [{ pane_id: 'wJ:p2K', agent: agent(), agent_status: status() }] },
    }) };
    if (argv[0] === 'pane' && argv[1] === 'run' && argv[2] === 'wJ:p2K') {
      observeRun(process.env.ELANOUS_AGENT_RUNTIME || 'unknown', agent());
      return { code: 0, stderr: '', stdout: JSON.stringify({ id: 'cli:pane:run', result: { accepted: true } }) };
    }
    return { code: 1, stdout: '', stderr: `unexpected fake herdr command: ${argv.join(' ')}` };
  };
  return { calls, runner };
}

test('fake remote world: grok, codex, claude, and eln all wake the seat registry target; sender and receiver runtimes vary independently; busy and unknown seats stay durable', async () => {
  expect(quoteRemoteHerdrCommand(['pane', 'run', "text 'x"])).toContain(String.fromCharCode(39, 92, 39, 39));
  const root = mkdtempSync(join(tmpdir(), 'seat-registry-world-'));
  dirs.push(root);
  const registryPath = join(root, 'seat-registry.json');
  const calls: string[][] = [];
  let receiverAgent = 'codex';
  let receiverStatus = 'idle';
  const postLog = spyOn(debug, 'log');
  const observedPairs: string[] = [];
  const remoteHosts: string[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  let now = 1_800_000_000_000;
  const program = new Command();
  const deps: MsgCliDeps = {
    openStore: () => new MsgStore(join(root, 'messages.db')),
    out: { log: line => output.push(line), error: line => errors.push(line) },
    setExitCode: code => exits.push(code),
    registerLogSink: async () => {},
    postOfficeStateRoot: root,
    postOfficeAlive: () => false,
    postOfficeProbe: async () => false,
    postOfficeLaunch: () => {},
    wakeDeps: {
      seatStateRoot: root,
      stateRoot: root,
      live: true,
      now: () => now,
      hasOptIn: () => false,
      listPtys: () => [],
      readPane: () => null,
      herdrRunForHost: host => {
        remoteHosts.push(host);
        const fake = simulatedRemoteHerdr(() => receiverAgent, () => receiverStatus, (sender, receiver) => { observedPairs.push(sender + '/' + receiver); });
        return async (argv, timeoutMs) => {
          const result = await fake.runner(argv, timeoutMs);
          calls.push([...argv]);
          return result;
        };
      },
    },
  };
  registerMsgCommands(program, deps);

  await program.parseAsync(['msg', 'address', 'register', 'MVP-B', '--herdr-pane', 'wJ:p2K', '--host', 'mshq', '--wake', '--json'], { from: 'user' });
  const senderRuntimes = ['grok', 'codex', 'claude', 'eln'];
  const receiverRuntimes = ['grok', 'codex', 'claude', 'elanous'];
  // The caller runtime is injected through the same environment the production CLI observes.
  for (const senderRuntime of senderRuntimes) {
    for (const receiver of receiverRuntimes) {
      receiverAgent = receiver;
      process.env.ELANOUS_AGENT_RUNTIME = senderRuntime;
      await program.parseAsync(['msg', 'post', 'cross-runtime wake', '--from', 'OP', '--to', 'MVP-B', '--json'], { from: 'user' });
      now += 5 * 60_000 + 1;
    }
  }
  process.env.ELANOUS_AGENT_RUNTIME = 'codex';
  receiverStatus = 'working';
  await program.parseAsync(['msg', 'post', 'busy recipient remains durable', '--from', 'grok', '--to', 'MVP-B', '--json'], { from: 'user' });
  process.env.ELANOUS_AGENT_RUNTIME = 'claude';
  await program.parseAsync(['msg', 'post', 'unknown remains durable', '--from', 'grok', '--to', 'UNDECLARED', '--json'], { from: 'user' });

  const saved = new MsgStore(join(root, 'messages.db'));
  try {
    expect(saved.list('MVP-B', 0, 30)).toHaveLength(17);
    expect(new Set(observedPairs).size).toBe(16);
    const callerRuntimeEvents = postLog.mock.calls.filter(call => call[0] === 'msg.post' && call[1] === 'caller-runtime');
    expect(new Set(callerRuntimeEvents.map(call => (call[2] as { runtime: string }).runtime))).toEqual(new Set(senderRuntimes));
    expect(saved.list('UNDECLARED', 0, 10)).toHaveLength(1);
  } finally { saved.close(); }
  expect(remoteHosts).toEqual(Array(17).fill('mshq'));
  expect(calls.filter(argv => argv[0] === 'pane' && argv[1] === 'run')).toHaveLength(16);
  expect(calls.filter(argv => argv[0] === 'pane' && argv[1] === 'run').map(argv => argv[2])).toEqual(Array(16).fill('wJ:p2K'));
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('undeclared-address');
  expect(exits).toEqual([]);
  expect(output.map(line => JSON.parse(line)).filter(row => typeof row.id === 'number').map(row => row.id)).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
  postLog.mockRestore();
  expect(JSON.parse(readFileSync(registryPath, 'utf8')).seats.find((row: { address: string }) => row.address === 'MVP-B')).toEqual({
    address: 'MVP-B', host: 'mshq', target: 'wJ:p2K', wake: 'herdr', replyBody: 'agent', optIn: true,
  });
});
