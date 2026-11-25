// TUI-RESTART-NESTED-CHAIN — chain detection, reap plan and a live signal-propagation run (real processes on a real pty).
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyChainPlan, collapseOwnRestartChain, findRestartChains, parsePsTable, parseTuiCommand, planReap, readProcessTable,
  realSignalPort, type ProcRow, type SignalPort,
} from './restart-chain.js';

const BIN = '/Users/u/.bun/bin/bun /Users/u/.local/share/elanous/current/node_modules/elanous/bin/elanous.mjs';
const PS = [
  '  500     1   500 Ss   ??       9000 /usr/bin/holder',
  `  600   500   600 Ss+  ttys015 65000 ${BIN}`,
  `  601   600   600 S+   ttys015 61000 ${BIN} --resume fe6e-1`,
  `  602   601   600 S+   ttys015 62000 ${BIN} --resume fe6e-1`,
  `  603   602   600 S+   ttys015 80000 ${BIN} --resume fe6e-1`,
  '  604   603   600 S+   ttys015 20000 /Users/u/.bun/bin/bun /x/src/tui-client/fast-repl-child.ts fe6e-1',
  `  700   500   700 Ss+  ttys020 70000 ${BIN} --resume solo-2`,
  `  710   500   710 Ss+  ttys021 70000 ${BIN} --resume pair-3`,
  `  711   710   710 S+   ttys021 71000 ${BIN} --resume pair-3`,
  `  800   500   800 Ss+  ttys022 50000 ${BIN} logs --tail`,
].join('\n');

test('ps rows parse with tty, stat and full command', () => {
  const rows = parsePsTable(PS);
  expect(rows.length).toBe(10);
  expect(rows[1]).toEqual({ pid: 600, ppid: 500, pgid: 600, stat: 'Ss+', tty: 'ttys015', rssKb: 65000, command: BIN });
});

test('TUI command lines: root, resume, subcommand, helper', () => {
  expect(parseTuiCommand(BIN)).toEqual({ sessionId: null });
  expect(parseTuiCommand(`${BIN} --provider codex --resume fe6e-1`)).toEqual({ sessionId: 'fe6e-1' });
  expect(parseTuiCommand(`${BIN} --resume=fe6e-9`)).toEqual({ sessionId: 'fe6e-9' });
  expect(parseTuiCommand(`${BIN} logs --tail`)).toBeNull();
  expect(parseTuiCommand('/Users/u/.bun/bin/bun /x/src/tui-client/fast-repl-child.ts fe6e-1')).toBeNull();
});

test('a nested chain is found root → leaf; a single TUI is not a chain', () => {
  const chains = findRestartChains(parsePsTable(PS));
  expect(chains.map((chain) => chain.members.map((row) => row.pid))).toEqual([[600, 601, 602, 603], [710, 711]]);
  expect(chains[0]!.sessionId).toBe('fe6e-1');
  expect(chains[0]!.intermediates.map((row) => row.pid)).toEqual([601, 602]);
});

test('reap plan: freeze the root, kill the wrappers top-down, keep the leaf; root+leaf alone is left as is', () => {
  const plans = planReap(parsePsTable(PS));
  expect(plans[0]!.action).toEqual({ kind: 'collapse', stop: 600, kill: [601, 602], keep: 603, reclaimKb: 123000 });
  expect(plans[1]!.action).toEqual({ kind: 'none', reason: 'root-and-leaf-only' });
  expect(plans.length).toBe(2);
});

test('a frozen root whose leaf exited is thawed; a frozen root with a live leaf in its group is not', () => {
  const frozen = [
    `  900   500   900 Ts+  ttys030 65000 ${BIN}`,
    `  910   500   910 Ts+  ttys031 65000 ${BIN}`,
    `  911     1   910 S+   ttys031 80000 ${BIN} --resume live-4`,
  ].join('\n');
  expect(planReap(parsePsTable(frozen)).map((plan) => plan.action)).toEqual([{ kind: 'thaw', cont: 900 }]);
});

test('apply sends SIGSTOP to the root before any SIGKILL and never signals the leaf', async () => {
  const rows = parsePsTable(PS);
  const sent: string[] = [];
  let table = rows;
  const port: SignalPort = {
    table: () => table,
    kill: (pid, signal) => {
      sent.push(`${signal} ${pid}`);
      if (signal === 'SIGSTOP') table = table.map((row) => row.pid === pid ? { ...row, stat: 'T+' } : row);
      if (signal === 'SIGKILL') table = table.filter((row) => row.pid !== pid);
    },
    sleep: async () => {},
  };
  const result = await applyChainPlan(planReap(rows)[0]!, rows, port);
  expect(sent).toEqual(['SIGSTOP 600', 'SIGKILL 601', 'SIGKILL 602']);
  expect(result).toEqual({ ok: true, detail: 'leaf 603 alive · root 600 frozen', killed: [601, 602] });
});

test('the start guard logs nested-chain with its depth and collapses only its own chain', async () => {
  const rows = parsePsTable(PS);
  const logs: Array<[string, Record<string, unknown>]> = [];
  const sent: string[] = [];
  let table = rows;
  const port: SignalPort = {
    table: () => table,
    kill: (pid, signal) => { sent.push(`${signal} ${pid}`); if (signal === 'SIGSTOP') table = table.map((row) => row.pid === pid ? { ...row, stat: 'T+' } : row); },
    sleep: async () => {},
  };
  await collapseOwnRestartChain({ pid: 711, port, log: (event, data) => logs.push([event, data]) });
  expect(logs).toEqual([['nested-chain', { depth: 1, sessionId: 'pair-3', pids: [710, 711], action: 'none' }]]);
  expect(sent).toEqual([]);
  await collapseOwnRestartChain({ pid: 603, port, log: (event, data) => logs.push([event, data]) });
  expect(logs[1]).toEqual(['nested-chain', { depth: 3, sessionId: 'fe6e-1', pids: [600, 601, 602, 603], action: 'collapse' }]);
  expect(sent).toEqual(['SIGSTOP 600', 'SIGKILL 601', 'SIGKILL 602']);
});

// ── live: an old-style spawn-and-wait chain on a real pty (script(1) = the pane holder) ──────────────────────────
const FIXTURE = `import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const dir = process.env.CHAIN_DIR;
const depth = Number(process.env.CHAIN_DEPTH);
process.on('SIGHUP', () => { appendFileSync(dir + '/hup', process.pid + '\\n'); process.exit(129); });
if (depth > 0) {
  const child = spawn(process.execPath, [process.argv[1], '--resume', 'chain-live-7'], { stdio: 'inherit', env: { ...process.env, CHAIN_DEPTH: String(depth - 1) } });
  child.on('exit', (code) => { appendFileSync(dir + '/wrapper-exit', process.pid + '\\n'); process.exit(code ?? 1); });
  setInterval(() => {}, 200);
} else {
  writeFileSync(dir + '/leaf.pid', String(process.pid));
  setInterval(async () => {
    writeFileSync(dir + '/beat', String(Date.now()));
    if (existsSync(dir + '/stop')) {
      const { thawFrozenRestartRoot } = await import(process.env.CHAIN_MODULE);
      writeFileSync(dir + '/thawed', String(thawFrozenRestartRoot()));
      process.exit(0);
    }
  }, 100);
}
`;

const FIXTURE_ENTRY_NAME = 'elanous.mjs';

const waitFor = async (check: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return true; await Bun.sleep(100); }
  return check();
};

test('live: collapse keeps the leaf on its terminal (no SIGHUP), ends the wrappers, and the leaf exit closes the pane', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-chain-live-'));
  // A fixture that only borrows the entry FILE NAME so the chain matcher sees it — not the elanous CLI (R-LIVE10 n/a).
  const entry = join(dir, 'bin', FIXTURE_ENTRY_NAME);
  mkdirSync(join(dir, 'bin'));
  writeFileSync(entry, FIXTURE);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (typeof value === 'string') env[key] = value;
  const command = process.platform === 'darwin'
    ? ['script', '-q', '/dev/null', process.execPath, entry]
    : ['script', '-qec', `${process.execPath} ${entry}`, '/dev/null'];
  const pane = Bun.spawn(command, {
    env: { ...env, CHAIN_DIR: dir, CHAIN_DEPTH: '4', CHAIN_MODULE: join(import.meta.dir, 'restart-chain.ts') },
    // stdin = /dev/null: Bun's pipe is a socket and BSD script(1) refuses it (tcgetattr on a socket).
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
  });
  const mine = (): ProcRow[] => readProcessTable().filter((row) => row.command.includes(dir));
  try {
    expect(await waitFor(() => existsSync(join(dir, 'leaf.pid')), 20_000)).toBe(true);
    const leaf = Number(readFileSync(join(dir, 'leaf.pid'), 'utf8'));
    const rows = mine();
    const chains = findRestartChains(rows);
    expect(chains.length).toBe(1);
    expect(chains[0]!.members.length).toBe(5);
    expect(chains[0]!.leaf.pid).toBe(leaf);
    const plan = planReap(rows)[0]!;
    expect(plan.action.kind).toBe('collapse');

    const result = await applyChainPlan(plan, rows, realSignalPort);
    expect(result.ok).toBe(true);
    expect(result.killed.length).toBe(3);
    const beat1 = Number(readFileSync(join(dir, 'beat'), 'utf8'));
    await Bun.sleep(600);
    const beat2 = Number(readFileSync(join(dir, 'beat'), 'utf8'));
    expect(beat2).toBeGreaterThan(beat1);
    const after = mine().filter((row) => parseTuiCommand(row.command) !== null);
    expect(after.map((row) => row.pid).sort()).toEqual([chains[0]!.root.pid, leaf].sort());
    expect(after.find((row) => row.pid === chains[0]!.root.pid)!.stat.startsWith('T')).toBe(true);
    expect(existsSync(join(dir, 'hup'))).toBe(false);
    expect(existsSync(join(dir, 'wrapper-exit'))).toBe(false);

    writeFileSync(join(dir, 'stop'), '1');
    expect(await waitFor(() => mine().length === 0, 15_000)).toBe(true);
    expect(readFileSync(join(dir, 'thawed'), 'utf8')).toBe(String(chains[0]!.root.pid));
    expect(await Promise.race([pane.exited.then(() => true), Bun.sleep(10_000).then(() => false)])).toBe(true);
  } finally {
    for (const row of mine()) { try { process.kill(row.pid, 'SIGKILL'); } catch { /* gone */ } }
    try { pane.kill('SIGKILL'); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test('a pty wrapper whose arguments contain the entry is not a TUI', () => {
  expect(parseTuiCommand('script -q /dev/null /usr/bin/bun /tmp/x/bin/elanous.mjs')).toBeNull();
});
