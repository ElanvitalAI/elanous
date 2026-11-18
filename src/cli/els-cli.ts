// `elanous side` = the `els` bin. `serve` runs the one owner (journal + pane PTYs); ls/new/read/send are requests to
// it and never write the journal. Stage 2: `ls` and `read` also reach the remote hosts in els/hosts.json through their
// read window (`serve --http`), read-only. attach·wait·close·send to remote hosts come later.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { prodInstanceRoot } from '../instance/resolve.js';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { createAttachApp, type AttachAppDeps } from '../els/attach-app.js';
import { attachEls } from '../els/attach-client.js';
import { createKeyDecoder, createPrefixFilter, drawView, ENTER_VIEW, LEAVE_VIEW, lastScreenText, statusLine } from '../els/attach-view.js';
import { requestEls } from '../els/client.js';
import type { ElsResult } from '../els/core.js';
import { askHitlOnTerminal, controlledDo, journalControl } from '../els/control-cli.js';
import { misplacedOptionHint, withNewDefaults } from '../els/cli-args.js';
import { createFederation } from '../els/federation.js';
import { elsJournalPath, findPane, loadJournal } from '../els/journal.js';
import { emptyJournal } from '../els/space.js';
import { withHerdrHost } from '../els/herdr-host.js';
import { herdrCreated, herdrPanes, herdrTabs, herdrWorkspaces } from '../els/herdr-shape.js';
import { keysToBytes } from '../els/keys.js';
import { elsHostsPath, fetchHostJson, loadHostRegistry } from '../els/hosts.js';
import { parseHttpBind } from '../els/http.js';
import { insideElsPane, NESTED_ELS_MESSAGE } from '../els/nesting.js';
import { createControlledBackend, createSocketBackend, serveElsMcpStdio } from '../els/mcp-serve.js';
import { elsHostName, elsSocketPath, elsSocketTaken, startElsServer, type ElsRequest } from '../els/server.js';
import { ensureServer, elanousCommandFor, serveCommandFor, supervisorOff, supervisorOn, supervisorPaths, supervisorStatus, type SupervisorDeps } from '../els/supervisor.js';

function emit(result: ElsResult): void {
  (result.exitCode === 0 ? process.stdout : process.stderr).write(`${result.message}\n`);
  process.exit(result.exitCode);
}

const ask = async (request: ElsRequest): Promise<void> => emit(await requestEls(elsSocketPath(), request));

// 출처: a host on the tailnet answers a GET in well under a second; one that does not answer in this time is shown
// as down rather than holding up the whole list.
const REMOTE_TIMEOUT_MS = 2_000;

// 출처: the receiving owner renders the pane's screen to check it is not busy before it answers (≤ the 10 s local request).
const DO_TIMEOUT_MS = 8_000;

// 출처: ELS-EXTERNAL-SURFACES §3.1 — a person at the terminal has this long to approve a dangerous shell line.
const HITL_TIMEOUT_MS = 60_000;

/** `<state>/els` — the allow list and the audit log live next to the journal. */
function elsControlDir(): string {
  return dirname(elsJournalPath());
}

/** The journal says which workspace a pane belongs to, and whether it is a shell (pty). A missing journal is an unknown pane. */
async function lookupLocalPane(ref: string): Promise<{ readonly workspace: string; readonly pane: string; readonly shell: boolean } | undefined> {
  let journal;
  try { journal = loadJournal(elsJournalPath()); }
  catch { return undefined; }
  const pane = findPane(journal, ref);
  const tab = pane ? journal.tabs.find((row) => row.id === pane.tabId) : undefined;
  const ws = tab ? journal.workspaces.find((row) => row.id === tab.workspaceId) : undefined;
  if (!pane || !ws) return undefined;
  return { workspace: ws.name || ws.id, pane: pane.id, shell: pane.kind === 'pty' };
}

/** The journal gives pane lookup and allow-list name → id resolution. An unreadable journal resolves nothing. */
function localControl(): ReturnType<typeof journalControl> {
  try { return journalControl(loadJournal(elsJournalPath())); }
  catch { return journalControl(emptyJournal()); }
}

function federation() {
  // ELS-ONE-SPACE ④ — the herdr panes of this machine are one more host (`herdr:`) in the same list when herdr is here.
  const hosts = withHerdrHost({
    registry: loadHostRegistry(elsHostsPath(elanousStateRoot())),
    fetchJson: (host, path) => fetchHostJson(host, path, REMOTE_TIMEOUT_MS),
    postJson: (host, path, payload) => fetchHostJson(host, path, DO_TIMEOUT_MS, payload),
  });
  return createFederation({
    localHost: elsHostName(),
    askLocal: (request) => requestEls(elsSocketPath(), request),
    ...hosts,
  });
}

/** The real supervisor environment: launchctl, a detached `side serve`, the real clock. */
function supervisorDeps(): SupervisorDeps {
  const stateRoot = elanousStateRoot();
  return {
    stateRoot,
    isDefaultState: stateRoot === prodInstanceRoot(),
    platform: process.platform,
    paths: supervisorPaths(stateRoot),
    serveCommand: serveCommandFor({ prefixEnv: process.env.ELANOUS_INSTALL_PREFIX, home: homedir(), exists: existsSync, execPath: process.execPath, entry: process.argv[1] }),
    pathEnv: process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin',
    uid: process.getuid?.() ?? 501,
    launchctl: async (args) => {
      const run = spawnSync('launchctl', [...args], { encoding: 'utf8' });
      return { code: run.status ?? 127, output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? String(run.error) : ''}` };
    },
    spawnDetached: (command, logPath) => {
      mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
      const log = openSync(logPath, 'a', 0o600);
      spawn(command[0]!, command.slice(1), { detached: true, stdio: ['ignore', log, log] }).unref();
    },
    serverState: () => elsSocketTaken(elsSocketPath(stateRoot)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    notify: (line) => { process.stderr.write(`${line}\n`); },
  };
}

export function registerElsCommands(program: Command): void {
  const side = program.command('side').description('Elanous Side (els) — workspaces, tabs and panes in one screen; the command is `els`. In a terminal, bare `els` opens the whole screen.');
  // `els` with no arguments: make sure a server answers (supervisor, installed on first use), then show the spaces.
  // Stage 1 shows the list; the live pane view arrives with the attach stages.
  side.option('--list', 'print the panes as lines instead of opening the screen (also what a pipe gets)');
  side.option('--side', 'open with the side list shown (remembered for next time)');
  side.option('--no-side', 'open with the side list hidden (remembered for next time)');
  side.action(async (options: { list?: boolean; side?: boolean }) => {
    // A second full screen inside an els pane would be a frame in a frame: say so (rc 1) before anything is started.
    if (!options.list && process.stdin.isTTY && process.stdout.isTTY && insideElsPane(process.env, elsSocketPath())) { emit({ exitCode: 1, message: NESTED_ELS_MESSAGE }); return; }
    const ready = await ensureServer(supervisorDeps());
    if (!ready.ok) { emit({ exitCode: 1, message: ready.message }); return; }
    // In a terminal: the whole screen at once, spaces on the left, the live pane on the right (herdr's way in).
    if (!options.list && process.stdin.isTTY && process.stdout.isTTY) { process.exitCode = await runAppView(options.side); return; }
    const answer = await federation().list();
    if (answer.exitCode !== 0) { emit(answer); return; }
    const listed = JSON.parse(answer.message) as { panes: { address: string; title: string; state: string; cwd: string }[] };
    const lines = listed.panes.length === 0
      ? ['els: no panes yet — open one with `els new` (defaults: $SHELL, this folder)']
      : listed.panes.map((row) => `${row.address}  ${row.state.padEnd(7)} ${row.title}  ${row.cwd}`);
    emit({ exitCode: 0, message: lines.join('\n') });
  });
  const supervisor = side.command('supervisor').description('The launchd user agent that keeps the els server running: on · off · status');
  supervisor.command('on').description('Install/start the supervisor (and clear "off")')
    .action(async () => emit({ exitCode: 0, message: await supervisorOn(supervisorDeps()) }));
  supervisor.command('off').description('Stop the supervisor and do not start it automatically again')
    .action(async () => emit({ exitCode: 0, message: await supervisorOff(supervisorDeps()) }));
  supervisor.command('status').description('Is the agent installed, is the server answering')
    .action(async () => { const deps = supervisorDeps(); emit({ exitCode: 0, message: supervisorStatus(deps, await deps.serverState()) }); });
  side.command('serve')
    .description('Run the els server: the one owner of the journal and the pane PTYs (run once, by a supervisor)')
    .option('--http <address:port>', 'also open the read-only window for federated els (loopback or tailnet address only)')
    .action(async (opts: { http?: string }) => {
      const http = opts.http === undefined ? undefined : parseHttpBind(opts.http);
      if (typeof http === 'string') { emit({ exitCode: 2, message: http }); return; }
      const started = await startElsServer(http ? { http } : {});
      if ('exitCode' in started) { emit(started); return; }
      process.stdout.write(`els serve: listening on ${elsSocketPath()} (pid ${process.pid})\n`);
      const stop = (): void => { void started.close().then(() => process.exit(0)); };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
    });
  side.command('mcp').description('els as an MCP server').command('serve')
    .description('Serve els over stdio MCP (line-delimited JSON-RPC): tools els_ls·els_read·els_do·els_new·els_status, resources els://pane/<address>/screen|events')
    // The one control door (§3.1): principal mcp-stdio:<clientInfo.name> · default deny via control-allow.json · -32001.
    // No HITL over stdio (stdin is the protocol), so a dangerous shell `do` is held, never sent.
    .action(async () => {
      await serveElsMcpStdio(createControlledBackend({ stateDir: elsControlDir(), lookup: lookupLocalPane, inner: createSocketBackend(elsSocketPath()) }));
      process.exit(0);
    });
  side.command('ls')
    .description('List workspaces, tabs and panes as JSON: this host and the hosts in els/hosts.json (a host that does not answer is listed as down)')
    .option('--json', 'JSON (always on for els ls)')
    .action(async () => emit(await federation().list()));
  const createPane = async (opts: { ws?: string; cwd?: string; title?: string; raw?: boolean }, command: string[], herdrShape: boolean): Promise<void> => {
    const hint = misplacedOptionHint({ ...opts, command });
    if (hint) { emit({ exitCode: 2, message: hint }); return; }
    const args = withNewDefaults({ ...opts, command }, process.env, process.cwd());
    const answer = await requestEls(elsSocketPath(), { op: 'new', ws: args.ws, cwd: args.cwd, command: args.command, ...(args.title ? { title: args.title } : {}) });
    if (answer.exitCode === 0 && herdrShape) { emit({ exitCode: 0, message: JSON.stringify(herdrCreated(JSON.parse(answer.message)), null, 2) }); return; }
    emit(answer);
  };
  side.command('new')
    .description('Open a pane: the server spawns a PTY and records ws/tab/pane + cwd in the journal. No command → $SHELL, no --cwd → this folder, no --ws → the folder name. Options go BEFORE --')
    .option('--ws <name>', 'workspace name (created if missing; default: the folder name)')
    .option('--cwd <folder>', 'pane working directory (restored after restart; default: the current folder)')
    .option('--title <title>', 'tab/pane title')
    .option('--raw', 'run the words after -- exactly as given (skip the «options go before --» check)')
    .argument('[command...]', 'command after -- (default: $SHELL)')
    .action((command: string[] = [], opts: { ws?: string; cwd?: string; title?: string; raw?: boolean }) => createPane(opts, command, false));
  side.command('read <pane>')
    .description('Read a pane: a local pane id, ws/tab/pane, or host:ws/tab/pane on a registered host')
    .action(async (pane: string) => emit(await federation().read(pane)));
  side.command('send <pane> <text>')
    .description('Type text into a live pane and press Enter (--no-enter: text only)')
    .option('--no-enter', 'do not press Enter after the text')
    .action((pane: string, text: string, opts: { enter: boolean }) => ask({ op: 'send', pane, text: opts.enter ? `${text}\r` : text }));
  side.command('do <pane> <text>')
    .description('Type a line into a pane (local, ws/tab/pane or host:ws/tab/pane): marked «⇢ from · text», queued while the pane\'s turn is running. A local pane walks the control door first (default deny).')
    .option('--from <seat>', 'who is sending (shown to the receiver)', process.env.ELANOUS_TRACK || process.env.ELANOUS_SEAT || 'unknown')
    .action(async (pane: string, text: string, opts: { from: string }) => emit(await controlledDo({
      stateDir: elsControlDir(),
      from: opts.from,
      uid: process.getuid?.() ?? -1,
      ...localControl(),
      send: (target, line, from) => federation().do(target, line, from),
      ask: askHitlOnTerminal(HITL_TIMEOUT_MS),
    }, pane, text)));

  // herdr's words: `els workspace|tab|pane …` (JSON `{result:{…}}` with *_id fields). The commands above stay as aliases.
  const listJson = async (): Promise<{ failed?: ElsResult; listed?: Parameters<typeof herdrPanes>[0] }> => {
    const answer = await federation().list();
    return answer.exitCode === 0 ? { listed: JSON.parse(answer.message) } : { failed: answer };
  };
  const printJson = (value: object): void => emit({ exitCode: 0, message: JSON.stringify(value, null, 2) });
  const workspace = side.command('workspace').description('Workspaces (herdr words): list · create · close · move');
  workspace.command('list').description('Workspaces as JSON').action(async () => {
    const { failed, listed } = await listJson(); if (failed) emit(failed); else printJson(herdrWorkspaces(listed!));
  });
  workspace.command('create')
    .description('Open a workspace with one shell pane (defaults: cwd = here, label = folder name)')
    .option('--cwd <folder>', 'working directory').option('--label <name>', 'workspace name')
    .argument('[command...]', 'command after -- (default: $SHELL)')
    .action((command: string[] = [], opts: { cwd?: string; label?: string }) => createPane({ ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.label ? { ws: opts.label } : {}) }, command, true));
  workspace.command('close <workspace>').description('Close a workspace: stop its panes and forget it')
    .action((ws: string) => ask({ op: 'close-workspace', ws }));
  workspace.command('move <workspace>').description('Put a workspace before another one (default: last) — the order every els screen and the eln side tab show')
    .option('--before <workspace>', 'the workspace it goes in front of')
    .action((ws: string, opts: { before?: string }) => ask({ op: 'reorder', kind: 'workspace', id: ws, ...(opts.before ? { before: opts.before } : {}) }));
  const tab = side.command('tab').description('Tabs (herdr words): list · move');
  tab.command('list').option('--workspace <id>', 'only this workspace').description('Tabs as JSON').action(async (opts: { workspace?: string }) => {
    const { failed, listed } = await listJson(); if (failed) emit(failed); else printJson(herdrTabs(listed!, opts.workspace));
  });
  tab.command('move <tab>').description('Put a tab before another tab of the same workspace (default: last in its workspace)')
    .option('--before <tab>', 'the tab it goes in front of')
    .action((id: string, opts: { before?: string }) => ask({ op: 'reorder', kind: 'tab', id, ...(opts.before ? { before: opts.before } : {}) }));
  side.command('attach <pane>')
    .description('Show one pane live in this terminal and type into it (ctrl+b q detaches; the pane keeps running)')
    .action(async (ref: string) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write('els attach: needs a terminal (use `els pane read` / `els pane send-text` from scripts)\n');
        process.exitCode = 2;
        return;
      }
      const code = await runAttachView(ref);
      process.exitCode = code;
    });
  const pane = side.command('pane').description('Panes (herdr words): list · read · send-text · send-keys · run · close');
  pane.command('list').option('--workspace <id>', 'only this workspace').description('Panes (all registered hosts) as JSON')
    .action(async (opts: { workspace?: string }) => {
      const { failed, listed } = await listJson(); if (failed) emit(failed); else printJson(herdrPanes(listed!, opts.workspace));
    });
  pane.command('read <pane>').description('The pane\'s screen as text').action(async (ref: string) => emit(await federation().read(ref)));
  pane.command('send-text <pane> <text>').description('Type text, no Enter').action((ref: string, text: string) => ask({ op: 'send', pane: ref, text }));
  pane.command('run <pane> <text>').description('Type text and press Enter').action((ref: string, text: string) => ask({ op: 'send', pane: ref, text: `${text}\r` }));
  pane.command('send-keys <pane> <keys...>').description('Press keys: enter esc tab space backspace up down left right ctrl+c alt+x …')
    .action((ref: string, keys: string[]) => {
      const bytes = keysToBytes(keys);
      if ('unknown' in bytes) { emit({ exitCode: 2, message: `els pane send-keys: unknown key ${bytes.unknown} (nothing was sent)` }); return; }
      return ask({ op: 'send', pane: ref, text: bytes.bytes });
    });
  pane.command('close <pane>').description('Stop the pane and remove it').action((ref: string) => ask({ op: 'close', pane: ref }));
}

/** The terminal side of `els attach`: raw keys → `input`, frames → one repaint, window size → `resize`. Returns the exit code. */
function runAttachView(ref: string): Promise<number> {
  return new Promise((resolve) => {
    const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
    const prefix = createPrefixFilter();
    const decodeKeys = createKeyDecoder();
    let last = '';
    let note = '';
    const paint = (screen: string): void => {
      last = screen;
      const { cols, rows } = size();
      process.stdout.write(drawView({ screen, cols, rows, status: statusLine(ref, note || undefined) }));
    };
    let finished = false;
    const finish = (code: number, message: string, keepLastScreen = false): void => {
      if (finished) return;
      finished = true;
      process.stdin.off('data', onKey);
      process.stdout.off('resize', onResize);
      try { process.stdin.setRawMode(false); } catch { /* not a TTY any more */ }
      process.stdin.pause();
      process.stdout.write(LEAVE_VIEW);
      // The alternate screen is gone now: when the pane exited, its last screen stays readable in the normal buffer.
      if (keepLastScreen && last) process.stdout.write(`${lastScreenText(last)}\n`);
      if (message) process.stderr.write(`${message}\n`);
      resolve(code);
    };
    // The pane has one row fewer than the terminal: the status line takes the last one.
    const paneSize = () => { const { cols, rows } = size(); return { cols, rows: Math.max(3, rows - 1) }; };
    const attached = attachEls(elsSocketPath(), ref, paneSize(), {
      onFrame: (frame) => paint(frame.screen),
      // A pane that exits under the view is not a detach: say so and exit 1 (detach is the only 0).
      onEnd: (exitCode, reason) => finish(1, reason === 'pane exited' ? 'els attach: the pane exited' : (exitCode === 0 ? `els attach: ${reason || 'the stream ended'}` : reason), reason === 'pane exited'),
      onError: (problem) => { note = problem; paint(last); },
    });
    const onKey = (chunk: Buffer): void => {
      const keys = prefix.feed(decodeKeys(chunk));
      if (keys.send) attached.input(keys.send);
      if (keys.ignored) { note = `ctrl+b ${keys.ignored} 는 아직 없음`; paint(last); }
      if (keys.detach) { attached.detach(); finish(0, ''); }
    };
    const onResize = (): void => { const next = paneSize(); attached.resize(next.cols, next.rows); };
    process.stdout.write(ENTER_VIEW);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
    process.stdout.on('resize', onResize);
  });
}

/** The terminal side of bare `els`: raw keys → the app, window size → the app, the app's drawing → stdout. */
function runAppView(sidebar: boolean | undefined): Promise<number> {
  const decodeKeys = createKeyDecoder();
  const hosts = federation();                                    // the other hosts' panes (registered els hosts + herdr), read-only
  const app = createAttachApp({
    remote: { list: () => hosts.list(), read: (address) => hosts.read(address) },
    request: (request) => requestEls(elsSocketPath(), request),
    attach: (pane, size, handlers) => attachEls(elsSocketPath(), pane, size, handlers),
    write: (text) => { process.stdout.write(text); },
    size: () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
    cwd: process.cwd(),
    env: process.env,
    setInterval: (callback, ms) => { const handle = setInterval(callback, ms); handle.unref?.(); return handle; },
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    // 출처: 내부 문서 `ELS-SIDETAB-SERVER` «맨 els 전체 화면» — the left list follows the server once a second, like the TUI sidetab.
    pollMs: 1_000,
    chatCommand: elanousCommandFor({ prefixEnv: process.env.ELANOUS_INSTALL_PREFIX, home: homedir(), exists: existsSync, execPath: process.execPath, entry: process.argv[1] }),
    memory: viewMemory(),
    ...(sidebar === undefined ? {} : { sidebar }),
  });
  const onKey = (chunk: Buffer): void => app.key(decodeKeys(chunk));
  const onResize = (): void => app.resized();
  process.stdout.write(ENTER_VIEW);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  process.stdout.on('resize', onResize);
  void app.start();
  return app.done.then(({ code, message }) => {
    process.stdin.off('data', onKey);
    process.stdout.off('resize', onResize);
    try { process.stdin.setRawMode(false); } catch { /* not a TTY any more */ }
    process.stdin.pause();
    process.stdout.write(LEAVE_VIEW);
    if (message) process.stderr.write(`${message}\n`);
    return code;
  });
}

/** The view's own memory: <state>/els/ui.json = { sidebar, lastPane }. A missing or unreadable file is «nothing remembered». */
function viewMemory(): AttachAppDeps['memory'] {
  const file = join(elanousStateRoot(), 'els', 'ui.json');
  return {
    load: () => {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { sidebar?: unknown; lastPane?: unknown };
        return { ...(typeof parsed.sidebar === 'boolean' ? { sidebar: parsed.sidebar } : {}), ...(typeof parsed.lastPane === 'string' ? { lastPane: parsed.lastPane } : {}) };
      } catch { return {}; }
    },
    save: (state) => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      renameSync(temp, file);
    },
  };
}
