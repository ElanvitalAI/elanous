// `elanous side` = the `els` bin. `serve` runs the one owner (journal + pane PTYs); ls/new/read/send are requests to
// it and never write the journal. Stage 2: `ls` and `read` also reach the remote hosts in els/hosts.json through their
// read window (`serve --http`), read-only. attach·wait·close·send to remote hosts come later.

import { filterPanesBySeatState, parsePaneSeatStatus, parseStateFilter, statusBoardLines, viewerSpaces } from '../els/seat-status.js';
import { seatMarks } from '../els/seat-marks.js';
import { wordOfSeatState } from '../els/status-vocab.js';
import { SEAT_STATES } from '../agent-events/protocol.js';
import { buildCommitTime, cliBuildIdentity, versionLabel } from '../version/build-stamp.js';
import { readWorkspaceFile, type WorkspaceConfig } from '../els/workspace-config.js';
import { workspaceUp } from '../els/workspace-up.js';
import { createHash } from 'node:crypto';
import { elsSkillText, type SkillVerb } from '../els/skill.js';
import { formatPaneStatus, type PaneStatus } from '../els/pane-status.js';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { prodInstanceRoot } from '../instance/resolve.js';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { createAttachApp, type AttachAppDeps } from '../els/attach-app.js';
import { attachEls, isServerAway, noteAfterFrame, RECONNECT_NOTE, type AttachHandlers } from '../els/attach-client.js';
import type { WheelRoute } from '../pty-shell/registry.js';
import { attachElsOverSsh, resolveSshAttach } from '../els/attach-ssh.js';
import { runSshReadBridge } from '../els/attach-ssh-read-bridge.js';
import { parseAddress } from '../els/address.js';
import type { FederatedHost } from '../els/hosts.js';
import { createLineDecoder } from '../els/wire.js';
import { guardLeave, realProcess } from '../els/attach-leave.js';
import { buildBadge, changedRowsPaint, createAppFrameWriter, createPaneViewMouse, createKeyDecoder, createPrefixFilter, drawView, ENTER_PANE_VIEW, ENTER_VIEW, fitCells, LEAVE_PANE_VIEW, LEAVE_VIEW, lastScreenText, statusLine } from '../els/attach-view.js';
import { requestEls } from '../els/client.js';
import { AUTO_ACTING_SEAT } from '../els/baton.js';
import { readPipedStdin } from './piped-stdin.js';
import { grepScreens, type GrepHit, type GrepScreen } from '../els/pane-grep.js';
import type { ElsResult } from '../els/core.js';
import { tabBadge } from '../els/tab-badge.js';
import { updateAllElsTabs, updateResultsTable, updatePreview, updateSummary, updateInstallProgress } from '../els/update-all.js';
import { runRemoteUpdate } from '../els/remote-update.js';
import { runSeatControl } from './seat-control-cli.js';
import { detectSeatTui } from '../seat/seat-boot-preamble.js';
import { resolveSeatStateRoot } from '../loops/msg-wake.js';
import { openSeat } from '../els/seat-open.js';
import { listPtyManifestRowsStrict } from '../pty-shell/pty-manifest.js';
import { requestRemotePtyControl } from '../pty-shell/pty-control-ipc.js';
import { desiredSha } from '../nexus/host-registry/desired-sha.js';
import { readInstalledIdentity } from './self-update.js';
import type { PaneState } from '../els/space.js';
import { askHitlOnTerminal, controlledDo, controlledInput, journalControl } from '../els/control-cli.js';
import { mcpHitlAsk } from '../els/mcp-hitl.js';
import { misplacedOptionHint, withNewDefaults } from '../els/cli-args.js';
import { createFederation } from '../els/federation.js';
import { elsJournalPath, findPane, loadJournal } from '../els/journal.js';
import { emptyJournal } from '../els/space.js';
import { withHerdrHost } from '../els/herdr-host.js';
import { importHerdr } from '../els/herdr-import.js';
import { defaultHerdrCliRunner } from '../pty-shell/herdr-prompt.js';
import { herdrCreated, herdrPanes, herdrTabs, herdrWorkspaces } from '../els/herdr-shape.js';
import { keysToBytes } from '../els/keys.js';
import { elsHostsPath, fetchHostJson, loadHostRegistry, registeredHostAtExecution, type HostRegistry } from '../els/hosts.js';
import { parseHttpBind } from '../els/http.js';
import { humanOwnerToken } from '../els/human-terminal-auth.js';
import { AUTH_OWNER_TOKEN_ENV, AUTH_PANE_TOKEN_ENV } from '../els/server-auth.js';
import { insideElsPane, NESTED_ELS_MESSAGE } from '../els/nesting.js';
import { createControlledBackend, createSocketBackend, serveElsMcpStdio } from '../els/mcp-serve.js';
import { serveElsAcpStdio } from '../acp/els-acp-serve.js';
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

function federation(registry: HostRegistry = loadHostRegistry(elsHostsPath(elanousStateRoot()))) {
  // ELS-ONE-SPACE ④ — the herdr panes of this machine are one more host (`herdr:`) in the same list when herdr is here.
  const hosts = withHerdrHost({
    registry,
    fetchJson: (host, path) => fetchHostJson(host, path, REMOTE_TIMEOUT_MS),
    postJson: (host, path, payload) => fetchHostJson(host, path, DO_TIMEOUT_MS, payload),
  });
  return createFederation({
    localHost: elsHostName(),
    askLocal: (request) => requestEls(elsSocketPath(), request),
    ...hosts,
  });
}

/** ELS-GREP-PANES (칸5): one pattern across the last screen of every pane. The local panes are ONE `grep` request to
 *  the owner (it renders live PTYs plainly and never writes the journal); every remote pane — the registered hosts
 *  and the herdr rows — is one read on its host's read window, the same path `els read` takes (the thin herdr branch:
 *  a read per pane, nothing more). A pane that cannot be read is reported in `errors`, never silently skipped. */
async function grepEverywhere(pattern: string): Promise<ElsResult> {
  if (pattern === '') return { exitCode: 2, message: 'els grep: needs a pattern' };
  const fed = federation();
  const listed = await fed.list();
  if (listed.exitCode !== 0) return listed;
  const rows = (JSON.parse(listed.message) as { readonly panes: { readonly address: string; readonly reach?: string }[] }).panes;
  const hits: GrepHit[] = [];
  const errors: string[] = [];
  const local = await requestEls(elsSocketPath(), { op: 'grep', pattern });
  if (local.exitCode !== 0) errors.push(local.message);
  else {
    const swept = JSON.parse(local.message) as { readonly hits: readonly GrepHit[]; readonly errors: readonly string[] };
    hits.push(...swept.hits);
    errors.push(...swept.errors);
  }
  const screens: GrepScreen[] = [];
  for (const row of rows) {
    if (row.reach === 'local') continue; // already covered by the one local grep request
    const read = await fed.read(row.address);
    if (read.exitCode !== 0) { errors.push(`els grep: cannot read ${row.address}: ${read.message}`); continue; }
    screens.push({ address: row.address, screen: read.message });
  }
  hits.push(...grepScreens(pattern, screens));
  return { exitCode: 0, message: JSON.stringify({ hits, errors }, null, 2) };
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

/** ELS-SKILL: every visible els command as typed (`els pane send-keys <pane> <keys...>`) with its own description —
 *  read from the real command table, so the guide cannot miss a verb. */
export function skillVerbs(side: Command): SkillVerb[] {
  const visible = (command: Command): boolean => !(command as unknown as { _hidden?: boolean })._hidden && !command.name().startsWith('_');
  const usageOf = (command: Command, prefix: string): string => {
    const args = command.registeredArguments.map((arg) => (arg.required ? `<${arg.name()}${arg.variadic ? '...' : ''}>` : `[${arg.name()}${arg.variadic ? '...' : ''}]`)).join(' ');
    return `${prefix} ${command.name()}${args ? ` ${args}` : ''}`;
  };
  const verbs: SkillVerb[] = [];
  for (const command of side.commands.filter(visible)) {
    const children = command.commands.filter(visible);
    if (children.length === 0) { verbs.push({ usage: usageOf(command, 'els'), summary: command.description() }); continue; }
    for (const child of children) verbs.push({ usage: usageOf(child, `els ${command.name()}`), summary: child.description() });
  }
  return verbs;
}

/** `els ls` lines from the federated list JSON — one per pane: address, state, badge, title, build, cwd. The badge is the one the pane's own els server computed
 *  (its clock, so a remote host's stall is judged there); a list without it falls back to the stall rule on `lastEventAtMs` and `nowMs`. */
export function paneListLines(listJson: string, nowMs: number): string[] {
  const listed = JSON.parse(listJson) as { panes: { address: string; title: string; state: string; cwd: string; badgeLabel?: string; lastEventAtMs?: number; build?: { sha?: string | null; age?: string }; git?: GitLabelRow; status?: unknown; unreadMail?: { count?: unknown } | null }[] };
  // SIDETAB-TWO-MARKS: «⚪✋» (activity + attention) leads the title; a seat waiting on a person is listed first.
  const markOf = (row: (typeof listed.panes)[number]): { text: string; person: boolean } => {
    const status = parsePaneSeatStatus(row.status);
    const mail = row.unreadMail?.count;
    const marks = seatMarks({ word: status ? wordOfSeatState(status.state) === 'exited' ? 'idle' : wordOfSeatState(status.state) : row.state,
      ...(status ? { seatState: status.state, ...(status.reason ? { seatReason: status.reason } : {}) } : {}), ...(typeof mail === 'number' ? { unread: mail } : {}) });
    return { text: `${marks.needsPerson ? '⚪' : marks.activity}${marks.attention}`, person: marks.needsPerson };
  };
  const ordered = [...listed.panes].sort((a, b) => Number(markOf(b).person) - Number(markOf(a).person));
  return listed.panes.length === 0
    ? ['els: no panes yet — open one with `els new` (defaults: $SHELL, this folder)']
    : ordered.map((row) => `${row.address}  ${row.state.padEnd(7)} ${row.badgeLabel ?? tabBadge({ state: row.state as PaneState, ...(row.lastEventAtMs === undefined ? {} : { lastEventAtMs: row.lastEventAtMs }) }, nowMs).label} ${gitBadge(row.git) ? `${gitBadge(row.git)} ` : ''}${markOf(row).text} ${row.title} ${buildBadge(row.build, '[자체보고·미인증:unknown unknown]')}  ${row.cwd}`);
}

/** ELS-GIT-AWARENESS-HERDR (OP #139752) — the git label of a pane row as one display token: `[branch]`,
 *  `↑N` ahead, `↓N` behind, `*` dirty; absent when git could not answer (herdr's sidebar label, els' list line). */
export interface GitLabelRow { branch: string; ahead: number; behind: number; dirty: boolean; root?: string | null }

export function gitBadge(git: GitLabelRow | undefined): string {
  if (!git || typeof git.branch !== 'string' || git.branch.length === 0) return '';
  const counts = `${git.ahead > 0 ? `↑${git.ahead}` : ''}${git.behind > 0 ? `↓${git.behind}` : ''}`;
  return `[${git.branch}${counts}${git.dirty ? '*' : ''}]`;
}

/** 판정식 ② — panes grouped by their git worktree root; panes outside any repo keep their order in a trailing group. */
export interface WorktreeGroup { readonly root: string | null; readonly panes: { address: string; title: string; state: string; cwd: string }[] }

export function worktreeGroups(listJson: string): WorktreeGroup[] {
  const listed = JSON.parse(listJson) as { panes: { address: string; title: string; state: string; cwd: string; git?: GitLabelRow }[] };
  const groups = new Map<string | null, WorktreeGroup['panes']>();
  for (const pane of listed.panes) {
    const root = pane.git && typeof pane.git.root === 'string' ? pane.git.root : null;
    const bucket = groups.get(root) ?? [];
    bucket.push({ address: pane.address, title: pane.title, state: pane.state, cwd: pane.cwd });
    groups.set(root, bucket);
  }
  const ordered = [...groups.entries()].sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : a[0].localeCompare(b[0])));
  return ordered.map(([root, panes]) => ({ root, panes }));
}

/** `els worktree list` — one header per worktree, the panes under it; non-repo panes last without a header. */
export function worktreeListLines(listJson: string): string[] {
  const groups = worktreeGroups(listJson);
  const lines: string[] = [];
  for (const group of groups) {
    if (group.root !== null) lines.push(group.root);
    for (const pane of group.panes) lines.push(`${group.root !== null ? '  ' : ''}${pane.address}  ${pane.state.padEnd(7)} ${pane.title}`);
  }
  return lines.length === 0 ? ['els: no panes yet'] : lines;
}

/** 판정식 ③ — `els worktree remove` may not take a worktree that still has a live pane inside (cwd equal or below it). */
export function worktreeRemoveGuard(cwds: readonly string[], worktree: string): { ok: boolean; reason?: string } {
  const target = worktree.replace(/\/+$/, '') || worktree;
  for (const cwd of cwds) {
    if (cwd === target || cwd.startsWith(`${target}/`)) return { ok: false, reason: `pane cwd still inside: ${cwd}` };
  }
  return { ok: true };
}

type CoordinatorRequest = { readonly op: 'coordinator'; readonly ws: string; readonly seat?: string };

/** Register coordinator assignment; the client does not write the journal. */
export function registerCoordinatorCommands(workspace: Command, send: (request: CoordinatorRequest) => Promise<void>): void {
  workspace.command('coordinator <workspace> [seat]')
    .description('Assign the host coordinator workspace, or the coordinator seat in a workspace')
    .allowExcessArguments(false)
    .action((ws: string, seat?: string) => send({ op: 'coordinator', ws, ...(seat === undefined ? {} : { seat }) }));
}

/** OP P0 #133752 ① — the els server must come from the installed build: since 11-21 21:23 the mshq server ran
 *  from the retired worktree `els-api-ceo-channel` (b2d3285f), feeding owner-unreachable / disk I/O error /
 *  database is locked. A serve entry under a git worktree directory is exactly that mistake. */
export function worktreeServeEntry(entry: string | undefined): boolean {
  return typeof entry === 'string' && (entry.includes('/worktrees/') || entry.includes('/repo.git/worktrees/'));
}

export function registerElsCommands(program: Command): void {
  const side = program.command('side').description('Elanous Side (els) — workspaces, tabs and panes in one screen; the command is `els`. In a terminal, bare `els` opens the whole screen.');
  // `els` with no arguments: make sure a server answers (supervisor, installed on first use), then show the spaces.
  // Stage 1 shows the list; the live pane view arrives with the attach stages.
  side.option('--list', 'print the panes as lines instead of opening the screen (also what a pipe gets)');
  side.option('--side', 'open with the side list shown (remembered for next time)');
  side.option('--no-side', 'open with the side list hidden (remembered for next time)');
  side.option('--skill', 'print the usage guide for coding agents (markdown) and exit');
  // ELS-SKILL: the last line of `els --help` points agents at the guide.
  side.addHelpText('after', '\nAgents: run `els --skill` for the usage guide (verbs, rules, what not to do).');
  side.action(async (options: { list?: boolean; side?: boolean; skill?: boolean }) => {
    if (options.skill) { process.stdout.write(elsSkillText(skillVerbs(side))); return; }
    // A second full screen inside an els pane would be a frame in a frame: say so (rc 1) before anything is started.
    if (!options.list && process.stdin.isTTY && process.stdout.isTTY && insideElsPane(process.env, elsSocketPath())) { emit({ exitCode: 1, message: NESTED_ELS_MESSAGE }); return; }
    const ready = await ensureServer(supervisorDeps());
    if (!ready.ok) { emit({ exitCode: 1, message: ready.message }); return; }
    // In a terminal: the whole screen at once, spaces on the left, the live pane on the right (herdr's way in).
    if (!options.list && process.stdin.isTTY && process.stdout.isTTY) { adoptOwnerCredential(); process.exitCode = await runAppView(options.side); return; }
    const answer = await federation().list();
    if (answer.exitCode !== 0) { emit(answer); return; }
    emit({ exitCode: 0, message: paneListLines(answer.message, Date.now()).join('\n') });
  });
  // ELS-GIT-AWARENESS-HERDR (OP #139752): `els worktree …` — list groups panes by their git worktree; open opens a
  // worktree in a pane (cwd set to the worktree, never the repo's own ws — herdr #4293); remove refuses while a live
  // pane still sits inside it.
  const worktreeGroup = side.command('worktree [sub] [path]').description('Git worktrees: list panes per worktree, open one in a pane, or remove an empty one');
  worktreeGroup.allowExcessArguments(false).action(async (sub?: string, path?: string) => {
    if (sub === undefined || sub === 'list') {
      const answer = await federation().list();
      if (answer.exitCode !== 0) { emit(answer); return; }
      emit({ exitCode: 0, message: worktreeListLines(answer.message).join('\n') });
      return;
    }
    if (typeof path !== 'string' || path.length === 0) { emit({ exitCode: 2, message: 'els worktree: open/remove needs a worktree path' }); return; }
    if (sub === 'open') {
      const resolved = spawnSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
      const root = resolved.status === 0 ? resolved.stdout.trim() : '';
      if (root === '') { emit({ exitCode: 2, message: `els worktree open: not a git worktree: ${path}` }); return; }
      adoptOwnerCredential();
      const made = withNewDefaults({ cwd: root, command: [], title: `worktree ${root.split('/').pop() ?? root}` }, process.env, root);
      emit(await requestEls(elsSocketPath(), { op: 'new', ws: made.ws, cwd: made.cwd, command: made.command, ...(made.title ? { title: made.title } : {}) }));
      return;
    }
    if (sub === 'remove') {
      const list = await federation().list();
      if (list.exitCode !== 0) { emit(list); return; }
      const panes = (JSON.parse(list.message) as { panes: { cwd: string }[] }).panes;
      const guard = worktreeRemoveGuard(panes.map((pane) => pane.cwd), path);
      if (!guard.ok) { emit({ exitCode: 2, message: `els worktree remove: ${guard.reason}` }); return; }
      const removed = spawnSync('git', ['worktree', 'remove', path], { encoding: 'utf8' });
      emit(removed.status === 0 ? { exitCode: 0, message: `els worktree remove: removed ${path}` } : { exitCode: 1, message: `els worktree remove: ${removed.stderr.trim() || removed.stdout.trim() || 'git could not remove it'}` });
      return;
    }
    emit({ exitCode: 2, message: 'els worktree: subcommand must be list, open or remove' });
  });
  // `els seat set OP`: a `seat` command with a `set` subcommand (a single `seat set <seat>` string would register `seat`
  // taking the two arguments <set> <seat>, so the documented form failed with "only OP is supported").
  const seatGroup = side.command('seat [seat]').description('Open a seat tab, or register OP with `els seat set OP`');
  seatGroup.allowExcessArguments(false).action(async (seat?: string) => {
    if (!seat) { seatGroup.help(); return; }
    adoptOwnerCredential();
    const answer = await openSeat(seat, resolveSeatStateRoot(), request => requestEls(elsSocketPath(), request));
    if (answer.exitCode !== 0) { process.stderr.write(`${answer.message}\n`); process.exitCode = answer.exitCode; return; }
    const result = JSON.parse(answer.message) as { pane: string; address?: string; existing: boolean };
    if (process.stdin.isTTY && process.stdout.isTTY && !insideElsPane(process.env, elsSocketPath())) {
      process.exitCode = await runAppView(undefined, result.pane);
    } else if (insideElsPane(process.env, elsSocketPath())) {
      const focus = await requestEls(elsSocketPath(), { op: 'seat-focus', pane: result.pane });
      if (focus.exitCode !== 0) process.stderr.write(`${focus.message}\n`);
      process.exitCode = focus.exitCode;
    } else {
      process.stderr.write(`els seat: ${result.existing ? 'already open' : 'opened'} ${seat.toUpperCase()} ${result.address ?? result.pane}; focus requires an ELS terminal\n`);
      process.exitCode = 1;
    }
  });
  const seatCmd = seatGroup.command('set <seat>').description('register the OP seat — the server owner\'s explicit act from the person\'s terminal (JUD #39057 ⓒ1③)');
  seatCmd.action(async (seat: string) => {
    // The owner credential lives next to the socket (written at serve start); this terminal is not a pane.
    const ownerTokenFile = join(dirname(elsSocketPath()), 'owner-token');
    try { process.env.ELANOUS_ELS_OWNER_TOKEN = readFileSync(ownerTokenFile, 'utf-8').trim(); }
    catch { console.error('els seat set: no owner token found — no els server state in this directory'); process.exitCode = 1; return; }
    const reply = await requestEls(elsSocketPath(), { op: 'seat-set', seat });
    if (reply.message) console.log(reply.message);
    process.exitCode = reply.exitCode ?? 1;
  });

  const baton = side.command('baton').description('Delegate or return the OP acting lease');
  baton.command('hand <owner>').requiredOption('--to <seat>').requiredOption('--reason <reason>').requiredOption('--ttl <duration>')
    .description('Issue an OP acting lease (TTL e.g. 30m)')
    .action((owner: string, opts: { to: string; reason: string; ttl: string }) => {
      const match = /^(\d+)(s|m|h)$/.exec(opts.ttl);
      const ttlMs = match ? Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000 } as Record<string, number>)[match[2]!]! : 0;
      return ask({ op: 'baton', action: 'hand', owner, acting: opts.to, reason: opts.reason, ttlMs });
    });
  baton.command('take <owner>').requiredOption('--handoff <text>', 'handled mail and decisions')
    .description('OP takes back the lease with a handoff')
    .action((owner: string, opts: { handoff: string }) => ask({ op: 'baton', action: 'take', owner, handoff: opts.handoff }));
  baton.command('return').requiredOption('--handoff <text>', 'handled mail and decisions')
    .description('Acting TC returns the lease with a handoff')
    .action((opts: { handoff: string }) => ask({ op: 'baton', action: 'return', owner: 'OP', handoff: opts.handoff }));
  baton.command('status').description('Read the server-owned active lease')
    .action(() => ask({ op: 'baton', action: 'status' }));

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
      if (worktreeServeEntry(process.argv[1])) {
        const entry = process.argv[1] ?? '';
        if (elanousStateRoot() === prodInstanceRoot()) {
          emit({ exitCode: 1, message: `els serve: refusing to run the production els server from a worktree build (${entry}) — install first, then serve (출처: #133752 ①)` });
          process.exitCode = 1;
          return;
        }
        process.stderr.write(`els serve: worktree 빌드에서 기동(설치본 아님) — ${entry} (출처: #133752 ①)\n`);
      }
      const started = await startElsServer(http ? { http } : {});
      if ('exitCode' in started) { emit(started); return; }
      process.stdout.write(`els serve: listening on ${elsSocketPath()} (pid ${process.pid})\n`);
      const stop = (): void => { void started.close().then(() => process.exit(0)); };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      // ELS-SERVE-ORPHAN-EXIT (OP 11-22): a serve whose bound socket vanished ends itself — no orphan holders.
      void started.lost.then((reason) => { process.stderr.write(`${reason}\n`); process.exit(1); });
    });
  side.command('mcp').description('els as an MCP server').command('serve')
    .description('Serve els over stdio MCP (line-delimited JSON-RPC): tools els_ls·els_read·els_do·els_new·els_status, resources els://pane/<address>/screen|events')
    // The one control door (§3.1): principal mcp-stdio:<clientInfo.name> · default deny via control-allow.json · -32001.
    // Dangerous shell `do` asks a person out-of-band (confirm channels; stdin is the protocol); nobody answers → deny.
    .action(async () => {
      await serveElsMcpStdio(createControlledBackend({ stateDir: elsControlDir(), lookup: lookupLocalPane, inner: createSocketBackend(elsSocketPath()), hitl: mcpHitlAsk() }));
      process.exit(0);
    });
  side.command('acp').description('els as an ACP agent').command('serve')
    .description('Serve els over stdio ACP (line-delimited JSON-RPC): every prompt is one els do through the control door')
    .requiredOption('--pane <pane>', 'local pane id every prompt is typed into (required)')
    // The same one control door (§3.1): principal acp-session:<sessionId>, minted by the transport at session/new —
    // never taken from the prompt. Default deny via control-allow.json · -32001.
    .action(async (opts: { pane: string }) => {
      await serveElsAcpStdio(createControlledBackend({ stateDir: elsControlDir(), lookup: lookupLocalPane, inner: createSocketBackend(elsSocketPath()) }), opts.pane);
      process.exit(0);
    });
  // Internal SSH bridge: the remote host still resolves its own state root and owns the PTY.
  side.command('_wake-request', { hidden: true }).action(async () => {
    try {
      // Piped-only read: a non-piped (TTY or never-closing) stdin returns immediately with empty input instead of blocking fd0 forever (stdin-timeout ledger in readPipedStdin).
      const raw = await readPipedStdin();
      if (Buffer.byteLength(raw) > 65536) throw new Error('wake request too large');
      const r = JSON.parse(raw) as Record<string, unknown>;
      let request: ElsRequest;
      if (r.op === 'ls') request = { op: 'ls' };
      else if (r.op === 'status' && typeof r.pane === 'string') request = { op: 'status', pane: r.pane };
      else if (r.op === 'send-verified' && typeof r.pane === 'string' && typeof r.text === 'string')
        request = { op: 'send-verified', pane: r.pane, text: r.text, requireEmpty: true };
      else throw new Error('invalid wake request');
      process.stdout.write(JSON.stringify(await requestEls(elsSocketPath(), request)) + '\n');
    } catch (error) { process.stdout.write(JSON.stringify({ exitCode: 1, message: `els wake request: ${error instanceof Error ? error.message : String(error)}` }) + '\n'); }
  });
  side.command('up').description('Review and apply a workspace declaration after terminal confirmation')
    .action(async () => {
      try {
        const declaration = readWorkspaceFile(process.cwd(), homedir());
        for (const warning of declaration.warnings) process.stderr.write(`${warning}\n`);
        if (!declaration.config) { process.stderr.write(`${declaration.errors.join('\n')}\n`); process.exitCode = 2; return; }
        if (!declaration.path) process.stdout.write(`No workspace.yaml — using defaults (one space: ${declaration.defaultSpace}, this folder).\n`);
        else process.stdout.write(`workspace.yaml: ${declaration.path} (sha ${createHash('sha256').update(declaration.text).digest('hex').slice(0, 8)})\n`);
        adoptOwnerCredential();
        const config: WorkspaceConfig = declaration.config;
        const result = await workspaceUp(config, {
          request: request => requestEls(elsSocketPath(), request),
          confirm: askHitlOnTerminal(HITL_TIMEOUT_MS),
          print: text => process.stdout.write(text),
          open: (id, space) => {
            const seat = config.seats[id]!;
            return openSeat(id, resolveSeatStateRoot(), request => requestEls(elsSocketPath(), request), { ws: space, expectedRuntime: seat.runtime, expectedCwd: seat.cwd });
          },
        });
        if (result.exitCode === 0) process.stdout.write(`${result.message}\n`);
        else process.stderr.write(`${result.message}\n`);
        process.exitCode = result.exitCode;
      } catch (error) { process.stderr.write(`els up: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
    });
  side.command('ls')
    .description('List workspaces, tabs and panes as JSON: this host and the hosts in els/hosts.json (a host that does not answer is listed as down)')
    .option('--json', 'JSON (always on for els ls)')
    .option('--older', 'only panes older by self-reported, unauthenticated build and desired SHA')
    .option('--state <states>', `only panes in these seat states, comma separated (${SEAT_STATES.join(', ')})`)
    .option('--ws <workspace>', 'only panes of this workspace')
    .action(async (opts: { older?: boolean; state?: string; ws?: string }) => {
      const states = opts.state === undefined ? undefined : parseStateFilter(opts.state);
      if (states && !states.ok) { process.stderr.write(`${states.message}\n`); process.exitCode = 2; return; }
      const answer = await federation().list();
      if (answer.exitCode !== 0 || (!opts.older && !states && opts.ws === undefined)) { emit(answer); return; }
      const listed = JSON.parse(answer.message) as { panes: { build?: { age?: string }; workspace?: unknown; ws?: unknown; status?: unknown }[]; notice?: string;
        hqCoordinatorSeat?: unknown; workspaces?: { id?: unknown; name?: unknown; coordinatorSeat?: unknown }[] };
      if (opts.older) {
        listed.notice = '자체 보고 · 미인증: 배포 또는 제어의 신뢰 판단에 사용 금지';
        listed.panes = listed.panes.filter((row) => row.build?.age === 'older');
      }
      // SEAT-STATE-ENUM pull: codes only (pane.status.state), across every space unless --ws; a sub-coordinator sees its own spaces.
      if (states || opts.ws !== undefined) {
        const scope = states ? viewerSpaces((() => { try { return detectSeatTui(process.cwd())?.seat ?? null; } catch { return null; } })(), listed) : undefined;
        if (scope && opts.ws !== undefined && !scope.includes(opts.ws)) {
          process.stderr.write(`els ls --ws ${opts.ws}: outside this coordinator's spaces (${scope.join(', ')})\n`); process.exitCode = 1; return;
        }
        listed.panes = filterPanesBySeatState(listed.panes, { ...(states ? { states: states.states } : {}), ...(opts.ws !== undefined ? { ws: opts.ws } : {}), ...(scope ? { scope } : {}) });
      }
      emit({ ...answer, message: JSON.stringify(listed, null, 2) });
    });
  // SEAT-STATE-ENUM pull: one table of seat codes. A sub-coordinator sees its own spaces by default; OP / HQ every space.
  side.command('status-board')
    .description('One table of seats: seat, state, reason, since, model (a space coordinator sees its own spaces; OP every space)')
    .option('--ws <workspace>', 'only this workspace')
    .option('--json', 'the filtered panes as JSON')
    .action(async (opts: { ws?: string; json?: boolean }) => {
      const answer = await federation().list();
      if (answer.exitCode !== 0) { emit(answer); return; }
      const listed = JSON.parse(answer.message) as { panes: { workspace?: unknown; ws?: unknown; status?: unknown }[]; hqCoordinatorSeat?: unknown;
        workspaces?: { id?: unknown; name?: unknown; coordinatorSeat?: unknown }[] };
      const scope = viewerSpaces((() => { try { return detectSeatTui(process.cwd())?.seat ?? null; } catch { return null; } })(), listed);
      if (scope && opts.ws !== undefined && !scope.includes(opts.ws)) {
        process.stderr.write(`els status-board --ws ${opts.ws}: outside this coordinator's spaces (${scope.join(', ')})\n`); process.exitCode = 1; return;
      }
      const panes = filterPanesBySeatState(listed.panes, { ...(opts.ws !== undefined ? { ws: opts.ws } : {}), ...(scope ? { scope } : {}) });
      process.stdout.write(opts.json ? `${JSON.stringify({ panes }, null, 2)}\n` : `${statusBoardLines(panes, Date.now()).join('\n')}\n`);
    });
  side.command('update-all').description('Catch up registered ELS hosts to desiredSha, migrate seat tabs at their turn boundary, and print one result row per tab')
    .option('--local-only', 'SSH child: only this host; do not fan out')
    .option('--json', 'emit a machine-readable result for the pinned SSH parent')
    .option('--expected-desired <sha>', 'require the SSH parent-approved exact desired commit')
    .action(async (opts: { localOnly?: boolean; json?: boolean; expectedDesired?: string }) => {
      const sender = () => detectSeatTui(process.cwd())?.seat ?? null;
      const registryPath = elsHostsPath(elanousStateRoot());
      let listedRegistry: HostRegistry | undefined;
      let processTreeCache: ReadonlyMap<number, number> | undefined | null = null;
      let installStatus: 'already up to date (skipped)' | 'updated' | undefined;
      const approvedTarget = opts.expectedDesired ?? (sender() === 'OP' ? desiredSha() : undefined);
      try {
        const result = await updateAllElsTabs({
          sender,
          progress: message => {
            if (opts.localOnly && opts.json) {
              const match = /^Remaining seats: ([0-9]{1,6}) · ([0-9]{1,6})s remaining$/.exec(message);
              if (match) process.stderr.write(`ELS_UPDATE_PROGRESS remaining=${match[1]} eta=${match[2]}\n`);
            } else process.stderr.write(`els update-all: ${message}\n`);
          },
          expectedDesired: approvedTarget,
          prepare: async () => {
            // Reuse guarded catch-up and keep the OP HITL in this command's install→migrate path.
            // RES-INFRA operates only after an independently verified install.
            if (sender() !== 'OP') return;
            const { runCatchUp } = await import('./self-update-catch-up.js');
            let approved = false;
            const target = approvedTarget;
            if (!target || !/^[a-f0-9]{40}$/i.test(target)) throw new Error('Target build unavailable');
            const confirm = async () => {
              const answer = await federation().list();
              if (answer.exitCode !== 0) throw new Error('Seat list unavailable');
              const listing = JSON.parse(answer.message) as Parameters<typeof updatePreview>[0];
              const identity = readInstalledIdentity();
              approved = (await askHitlOnTerminal(HITL_TIMEOUT_MS)(updatePreview(listing, identity.installedVersion, identity.installedCommit, target))) === 'approve';
              return approved;
            };
            const wasCurrent = readInstalledIdentity().installedCommit.toLowerCase() === target.toLowerCase();
            const installed = await runCatchUp({ seat: 'OP', restart: false, expectedDesired: target }, {
              approveOp: confirm,
              out: { log: () => {}, error: () => {} },
            });
            if (installed.exitCode !== 0) throw new Error('Installation update failed');
            if (!approved && !(await confirm())) throw new Error('Migration cancelled');
            if (desiredSha()?.toLowerCase() !== target.toLowerCase()) throw new Error('Target build changed; no migration requested');
            installStatus = wasCurrent ? 'already up to date (skipped)' : 'updated';
          },
          target: () => ({ desired: desiredSha(), installed: readInstalledIdentity().installedCommit }),
          list: async () => {
            listedRegistry = loadHostRegistry(registryPath);
            const listed = await federation(listedRegistry).list();
            if (listed.exitCode !== 0) throw new Error(listed.message);
            const all = JSON.parse(listed.message) as { panes: { address: string; host: string; reach: string; seat?: string; state: string; cwd: string; pid?: number; kind?: string }[]; hosts: { name: string; reach: string }[]; hostsProblem?: string; rejectedHosts?: string[] };
            return opts.localOnly ? { ...all, panes: all.panes.filter(pane => pane.reach === 'local'), hosts: all.hosts.filter(host => host.reach === 'local') } : all;
          },
          seats: listPtyManifestRowsStrict,
          // OP P1 #134152: one ps snapshot per run feeds the ancestor-chain pane↔TUI matching.
          processTree: () => {
            if (processTreeCache === null) {
              try {
                const table = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
                const tree = new Map<number, number>();
                if (table.status === 0) for (const line of String(table.stdout).split('\n')) {
                  const match = line.trim().match(/^(\d+)\s+(\d+)$/);
                  if (!match) continue;
                  const pid = Number(match[1]), ppid = Number(match[2]);
                  if (Number.isSafeInteger(pid) && Number.isSafeInteger(ppid)) tree.set(pid, ppid);
                }
                processTreeCache = tree;
              } catch { processTreeCache = undefined; }
            }
            return processTreeCache;
          },
          migrate: (seat, expected) => runSeatControl(seat, 'migrate', {
            sender,
            rows: listPtyManifestRowsStrict,
            send: (id, action, payload, options) => requestRemotePtyControl(id, action, payload, options),
          }, expected),
          sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
          now: () => Date.now(),
          localOnly: opts.localOnly,
          // ELS-BATON-AUTO-ON-RESTART: acting seat first, hand OP → TC, then OP; the server returns it when the new OP registers.
          baton: {
            acting: AUTO_ACTING_SEAT,
            hand: async (reason, exclude) => {
              const reply = await requestEls(elsSocketPath(), { op: 'baton', action: 'auto-hand', reason, exclude });
              return reply.exitCode === 0 ? { ok: true } : { ok: false, reason: reply.message };
            },
            giveBack: async (memo) => (await requestEls(elsSocketPath(), { op: 'baton', action: 'auto-return', handoff: memo })).exitCode === 0
              && (await requestEls(elsSocketPath(), { op: 'baton', action: 'status' })).message.trim() === 'null',
            skip: async (reason) => { await requestEls(elsSocketPath(), { op: 'baton', action: 'auto-skip', reason }); },
          },
          remoteUpdate: opts.localOnly ? undefined : async (host, panes, desired) => {
            if (!listedRegistry) throw new Error('els host listing snapshot absent');
            const registered = registeredHostAtExecution(registryPath, listedRegistry, host.name);
            return runRemoteUpdate(registered, panes, desired, message => process.stderr.write(`els update-all: ${message}\n`));
          },
        });
        if (!opts.json && installStatus) process.stderr.write(`${updateInstallProgress(installStatus, result.requested)}\n`);
        if (opts.json) process.stdout.write(`ELS_UPDATE_ALL_RESULT=${JSON.stringify({ ...result, desired: desiredSha(), installed: readInstalledIdentity().installedCommit })}\n`);
        else process.stdout.write(`${result.reason ? `els update-all: ${result.reason}\n` : ''}${updateSummary(result.rows)}\n${updateResultsTable(result.rows)}\n`);
        if (!result.ok) process.exitCode = 1;
      } catch (error) {
        process.exitCode = 1;
        process.stderr.write(`els update-all: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    });
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
  side.command('status <pane>')
    .description('What a pane is doing, from the PTY the server owns: working/idle/exited/unknown (+ why) · input empty · last output ago · running tool')
    .option('--json', 'the PaneStatus object as JSON')
    .action(async (pane: string, opts: { json?: boolean }) => {
      const answer = await requestEls(elsSocketPath(), { op: 'status', pane });
      if (answer.exitCode !== 0 || opts.json) { emit(answer); return; }
      emit({ exitCode: 0, message: formatPaneStatus(JSON.parse(answer.message) as PaneStatus) });
    });
  side.command('grep <pattern>')
    .description('Search the last screen of every pane — this host, the registered hosts and the herdr rows — for a literal pattern (hits as JSON: address · line · text)')
    .action(async (pattern: string) => emit(await grepEverywhere(pattern)));
  side.command('send <pane> <text>')
    .description('Type text into a live pane and press Enter (--no-enter: text only)')
    .option('--no-enter', 'do not press Enter after the text')
    // #38988 (main, newer than #90792 13:54) — the person CLI send presses Enter through the verified paste
    // path (raw text intact as a bracketed paste, turn start observed). The machine paths keep the #38608
    // must ② split: cleaned `send` types text only, raw `input` (attach, `els pane run`/`send-keys`) presses keys.
    .action((pane: string, text: string, opts: { enter: boolean }) => ask(opts.enter ? { op: 'send-verified', pane, text } : { op: 'send', pane, text }));
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

  // Classic PTY capture on the thin els connection: the owner reuses src/capture + src/tool-runtime/pty-recording-runtimes.
  side.command('snapshot <pane>')
    .description('Save a pane\'s screen as an svg artifact (classic capture engine): prints {path}')
    .action((pane: string) => { adoptOwnerCredential(); return ask({ op: 'snapshot', pane }); });
  side.command('record <pane>')
    .description('Record a pane\'s PTY output: first call starts (prints {recordingId}), the next call for the pane (even after it was closed) stops and saves the asciicast: prints {path}')
    .action((pane: string) => { adoptOwnerCredential(); return ask({ op: 'record', pane }); });
  side.command('input <pane> <text>')
    .description('Submit a direct operator line through the owner control door')
    .option('--from <seat>', 'display name only', process.env.ELANOUS_TRACK || process.env.ELANOUS_SEAT || 'unknown')
    .action((pane: string, text: string, opts: { from: string }) => ask({ op: 'input-line', pane, text, from: opts.from }));

  // herdr's words: `els workspace|tab|pane …` (JSON `{result:{…}}` with *_id fields). The commands above stay as aliases.
  const listJson = async (): Promise<{ failed?: ElsResult; listed?: Parameters<typeof herdrPanes>[0] }> => {
    const answer = await federation().list();
    return answer.exitCode === 0 ? { listed: JSON.parse(answer.message) } : { failed: answer };
  };
  const printJson = (value: object): void => emit({ exitCode: 0, message: JSON.stringify(value, null, 2) });
  const workspace = side.command('workspace').alias('ws').description('Workspaces: list · create · rename · close · move · coordinator');
  registerCoordinatorCommands(workspace, async (request) => {
    adoptOwnerCredential();
    await ask(request);
  });
  workspace.command('list').description('Workspaces as JSON').action(async () => {
    const { failed, listed } = await listJson(); if (failed) emit(failed); else printJson(herdrWorkspaces(listed!));
  });
  workspace.command('create')
    .description('Open a workspace with one shell pane (defaults: cwd = here, label = folder name)')
    .option('--cwd <folder>', 'working directory').option('--label <name>', 'workspace name')
    .argument('[command...]', 'command after -- (default: $SHELL)')
    .action((command: string[] = [], opts: { cwd?: string; label?: string }) => createPane({ ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.label ? { ws: opts.label } : {}) }, command, true));
  workspace.command('rename <workspace> <name>').description('Rename a workspace')
    .action((id: string, name: string) => ask({ op: 'rename', kind: 'workspace', id, name }));
  workspace.command('close <workspace>').description('Close a workspace: stop its panes and forget it')
    .action((ws: string) => ask({ op: 'close-workspace', ws }));
  workspace.command('move <workspace>').description('Put a workspace before another one (default: last) — the order every els screen and the eln side tab show')
    .option('--before <workspace>', 'the workspace it goes in front of')
    .action((ws: string, opts: { before?: string }) => ask({ op: 'reorder', kind: 'workspace', id: ws, ...(opts.before ? { before: opts.before } : {}) }));
  side.command('rename <kind> <id> <name>').description('Rename a tab by id or unique name')
    .action((kind: string, id: string, name: string) => ask({ op: 'rename', kind, id, name }));
  const tab = side.command('tab').description('Tabs (herdr words): list · close · move');
  tab.command('list').option('--workspace <id>', 'only this workspace').description('Tabs as JSON').action(async (opts: { workspace?: string }) => {
    const { failed, listed } = await listJson(); if (failed) emit(failed); else printJson(herdrTabs(listed!, opts.workspace));
  });
  tab.command('close <tab>').description('Close a tab and all its panes (a person at a terminal confirms; the OP coordinator closes seat tabs without asking)')
    .action(async (id: string) => {
      // ELS-OP-CLOSE-TAB (대표 11-24): without a terminal (an OP seat's tool, a script) nobody can answer a prompt — send the
      // close unconfirmed and let the server decide: the OP coordinator / same-UID operator may close a seat tab, a
      // hand seat still needs a person, and the OP tab itself is always refused without one.
      // ELS-HERDR-CLI-PARITY ② (tab-close bisect 11-24): the server refuses an unconfirmed close of a
      // tab no seat owns — report it exactly like the interactive path reports a timed-out prompt —
      // exit 2, the same words — while the OP seat-tab close above still lands unconfirmed.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        const result = await requestEls(elsSocketPath(), { op: 'close-tab', tab: id });
        emit(result.exitCode !== 0 && /close-tab denied/.test(result.message)
          ? { exitCode: 2, message: `els tab close: confirmation unavailable (${result.message})` }
          : result);
        return;
      }
      const decision = await askHitlOnTerminal(HITL_TIMEOUT_MS)(`Close tab ${id} and all its panes? [y/N] `);
      if (decision !== 'approve') emit({ exitCode: 2, message: `els tab close: ${decision === 'timeout' ? 'confirmation unavailable' : 'cancelled'}` });
      await ask({ op: 'close-tab', tab: id, confirmed: true });
    });
  tab.command('move <tab>').description('Move a tab to a workspace, or reorder it within its workspace')
    .option('--before <tab>', 'the tab it goes in front of')
    .option('--workspace <workspace>', 'destination workspace (id or name)')
    .action((id: string, opts: { before?: string; workspace?: string }) => {
      if (opts.before && opts.workspace) return emit({ exitCode: 2, message: 'els tab move: --before and --workspace cannot be combined' });
      return opts.workspace ? ask({ op: 'move-tab', tab: id, ws: opts.workspace }) : ask({ op: 'reorder', kind: 'tab', id, ...(opts.before ? { before: opts.before } : {}) });
    });
  side.command('attach <pane>')
    .description('Show a local pane or registered host:ws/tab/pane live (ctrl+b q detaches)')
    .action(async (ref: string) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write('els attach: needs a terminal (use `els pane read` / `els pane send-text` from scripts)\n');
        process.exitCode = 2;
        return;
      }
      let remote: FederatedHost | undefined;
      if (ref.includes(':') && !parseAddress(ref)?.host) {
        process.stderr.write('els attach: invalid remote address\n'); process.exitCode = 2; return;
      }
      if (parseAddress(ref)?.host) {
        try { remote = resolveSshAttach(loadHostRegistry(elsHostsPath(elanousStateRoot())), ref).host; }
        catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; return; }
      } else adoptOwnerCredential();
      const code = await runAttachView(ref, remote);
      process.exitCode = code;
    });
  side.command('attach-stdio <pane> <cols> <rows> [base-url] [ws] [tab]')
    .description('SSH bridge (ELS-SSH-ATTACH-ANYWHERE): carry the attach wire on stdio, so a pane of this host can be attached from anywhere')
    .action(async (ref: string, cols: string, rows: string, baseUrl?: string, ws?: string, tab?: string) => {
      if (baseUrl && ws && tab) {
        clearInheritedElsCredentials();
        process.exitCode = await runSshReadBridge(ref, Number(cols) || 80, Number(rows) || 24, baseUrl, ws, tab);
      }
      else process.exitCode = await runAttachStdioBridge(ref, cols, rows);
    });
  const pane = side.command('pane').description('Panes (herdr words): list · read · send-text · send-keys · run · close');
  pane.command('list').option('--workspace <id>', 'only this workspace').description('Panes (all registered hosts) as JSON')
    .action(async (opts: { workspace?: string }) => {
      const { failed, listed } = await listJson(); if (failed) emit(failed); else printJson(herdrPanes(listed!, opts.workspace));
    });
  pane.command('read <pane>').description('The pane\'s screen as text').action(async (ref: string) => emit(await federation().read(ref)));
  pane.command('send-text <pane> <text>').description('Type text, no Enter').action((ref: string, text: string) => ask({ op: 'send', pane: ref, text }));
  pane.command('run <pane> <text>').description('Type text and press Enter').action((ref: string, text: string) => ask({ op: 'input', pane: ref, bytes: `${text}\r` })); // #38608 must ② — raw path: Enter must reach the pane
  pane.command('send-keys <pane> <keys...>').description('Press keys: enter tab space backspace delete up down left right home end pageup pagedown shift+tab … (esc, ctrl+<key>, alt+<key> are refused)')
    .action((ref: string, keys: string[]) => {
      const bytes = keysToBytes(keys);
      if ('unknown' in bytes) { emit({ exitCode: 2, message: `els pane send-keys: unknown key ${bytes.unknown} (nothing was sent)` }); return; }
      return ask({ op: 'input', pane: ref, bytes: bytes.bytes }); // #38608 must ② — keys are raw control bytes
    });
  pane.command('close <pane>').description('Stop the pane and remove it').action((ref: string) => ask({ op: 'close', pane: ref }));
  // ELS-HERDR-IMPORT: herdr is read once; the plan is shown and a person says yes; els panes come from the owner's `new`.
  side.command('import').description('Bring another layout into els').command('herdr')
    .description('Read this machine\'s herdr workspaces/tabs/panes (cwd), show the plan, ask, then open the missing ones in els (same workspace · tab label · cwd; existing ones skipped; herdr is not changed). Prints a receipt: created · skipped · failed')
    .action(async () => emit(await importHerdr({
      run: defaultHerdrCliRunner(process.env),
      request: (request) => requestEls(elsSocketPath(), request),
      confirm: askHitlOnTerminal(HITL_TIMEOUT_MS),
      shell: process.env.SHELL?.trim() || '/bin/sh',
      lockDir: join(elsControlDir(), 'import-herdr.lock'),
    })));

}

/** The person's terminal types with the server's owner token (read from the 0600 file next to the socket, like `els seat set`); a pane process keeps its pane token. */
function adoptOwnerCredential(): void {
  const token = humanOwnerToken({ env: process.env, socketPath: elsSocketPath(), isTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
  if (token) process.env.ELANOUS_ELS_OWNER_TOKEN = token;
}

function clearInheritedElsCredentials(): void {
  delete process.env[AUTH_OWNER_TOKEN_ENV];
  delete process.env[AUTH_PANE_TOKEN_ENV];
}

/** The remote side of `els side attach-stdio` (ELS-SSH-ATTACH-ANYWHERE): ssh runs this on the
 *  remote host. stdin carries the attach wire (attach/input{bytes}/resize in, frame/end/error back
 *  out on stdout as JSON lines). The socket attach carries its own auth; an `auth` line off the wire is
 *  ignored (no credential is ever taken from the ssh stream). The pane and the size come from the ssh argv. */
function runAttachStdioBridge(pane: string, colsArg: string, rowsArg: string): Promise<number> {
  // A pipe is view-only even if the remote process inherited a real ELS credential from its launcher.
  if (!process.stdin.isTTY || !process.stdout.isTTY) clearInheritedElsCredentials();
  else adoptOwnerCredential(); // only the person's terminal may acquire the remote owner credential
  return new Promise((resolve) => {
    const cols = Number.parseInt(colsArg, 10) || 80;
    const rows = Number.parseInt(rowsArg, 10) || 24;
    const out = (payload: unknown): void => { process.stdout.write(`${JSON.stringify(payload)}\n`); };
    let attached: ReturnType<typeof attachEls> | undefined;
    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      attached?.detach();
      resolve(code);
    };
    const lines = createLineDecoder((line) => {
      if (!line) return;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { return; /* not our wire */ }
      const op = parsed.op;
      if (op === 'auth') return;                                        // never trusts a credential off the wire: the socket attach authenticates itself
      if (op === 'attach') {
        if (attached) return;                                           // one attach per bridge
        attached = attachEls(elsSocketPath(), pane, { cols, rows }, {
          onFrame: (frame) => out({ op: 'frame', ...frame }),
          onEnd: (code, reason) => { out({ op: 'end', code: code ?? 0, reason }); finish(code === 0 ? 0 : 1); },
          onError: (message) => out({ op: 'error', message }),
        });
        return;
      }
      if (op === 'input' && typeof parsed.bytes === 'string') { attached?.input(parsed.bytes); return; }
      if (op === 'resize') { attached?.resize(Number(parsed.cols) || cols, Number(parsed.rows) || rows); return; }
      if (op === 'end') { finish(0); return; }                          // the ssh side hung up
    });
    process.stdin.on('data', (chunk: Buffer) => lines.push(chunk));
    process.stdin.on('end', () => finish(0));
    process.stdin.resume();
  });
}

/** The terminal side of `els attach`: raw keys → `input`, frames → one repaint, window size → `resize`. Returns the exit code. */
function ownBuildLabel(): string {
  const build = cliBuildIdentity();
  return versionLabel(build, buildCommitTime(build)).label;
}

function runAttachView(ref: string, remote?: FederatedHost): Promise<number> {
  const label = ownBuildLabel();
  return new Promise((resolve) => {
    const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
    const prefix = createPrefixFilter();
    const decodeKeys = createKeyDecoder();
    const mouse = createPaneViewMouse();
    let wheelRoute: WheelRoute = 'host';   // ELS-WHEEL-HISTORY: the route the last frame carried (the pane's current modes)
    let last = '';
    let lastBody: string[] | undefined;
    let lastNote = '';
    let note = '';
    const paint = (screen: string): void => {
      last = screen;
      const { cols, rows } = size();
      const body = screen.replace(/^\[screen \d+x\d+ cursor=[^\]]*\]\n/, '').replace(/^\[screen \d+x\d+ scrolled-back=\d+\]\n/, '').replace(/\n+$/, '').split('\n');
      // ELS-ATTACH-FRAME-DIFF (OP #127484 ③): when only some rows changed since the paint before, write those rows
      // cursor-addressed (herdr render_ansi pattern) instead of serialising the whole screen again; anything else —
      // the first paint, a resize, a scroll-back, a note change — is one full repaint as before.
      if (lastBody !== undefined && lastBody.length === body.length && note === lastNote) {
        const step = changedRowsPaint(lastBody, body, cols);
        if (step.changed.length > 0 && step.changed.length < body.length) {
          lastBody = body;
          // Cursor-address each changed row, then put the status line where drawView puts it: the last terminal row,
          // addressed there explicitly — the last changed row may sit anywhere, the status never rides its cursor.
          const last = step.changed[step.changed.length - 1] + 1;
          process.stdout.write(`${step.paint}\u001b[${rows};1H\u001b[7m${fitCells(statusLine(ref, [note, label].filter(Boolean).join(' · ')), cols)}\u001b[0m\u001b[${last};1H`);
          return;
        }
      }
      lastBody = body;
      lastNote = note;
      process.stdout.write(drawView({ screen, cols, rows, status: statusLine(ref, [note, label].filter(Boolean).join(' · ')) }));
    };
    let finished = false;
    // ELS-MOUSE-RELEASE: the leave bytes go out once, also when the process dies under the view (SIGHUP/uncaught exception).
    const leaveGuard = guardLeave({ proc: realProcess, write: (text) => { process.stdout.write(text); }, bytes: LEAVE_PANE_VIEW });
    const finish = (code: number, message: string, keepLastScreen = false): void => {
      if (finished) return;
      finished = true;
      if (retry) clearTimeout(retry);
      process.stdin.off('data', onKey);
      process.stdout.off('resize', onResize);
      try { process.stdin.setRawMode(false); } catch { /* not a TTY any more */ }
      process.stdin.pause();
      leaveGuard.leave();
      // The alternate screen is gone now: when the pane exited, its last screen stays readable in the normal buffer.
      if (keepLastScreen && last) process.stdout.write(`${lastScreenText(last)}\n`);
      if (message) process.stderr.write(`${message}\n`);
      resolve(code);
    };
    // The pane has one row fewer than the terminal: the status line takes the last one.
    const paneSize = () => { const { cols, rows } = size(); return { cols, rows: Math.max(3, rows - 1) }; };
    // D1a(ELS-SERVER-RESTART-SURVIVE): a server that went away after the pane was on screen is waited out — the
    // screen stays, the note says so, and the view re-attaches once a second until the server answers again (every
    // attach starts with the pane's current screen, so the pane comes back as it was).
    let everFramed = false;
    let attached: ReturnType<typeof attachEls> | ReturnType<typeof attachElsOverSsh> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = (): void => {
      const handlers: AttachHandlers = {
        onFrame: (frame) => { everFramed = true; wheelRoute = frame.wheelRoute ?? (frame.wheelPassthrough ? 'mouse-sgr' : 'host'); note = noteAfterFrame(note); paint(frame.screen); },   // the first recovered frame ends the «다시 붙는 중» note
        // A pane that exits under the view is not a detach: say so and exit 1 (detach is the only 0).
        onEnd: (exitCode, reason) => {
          if (finished) return;
          if (!remote && everFramed && isServerAway(reason)) { note = RECONNECT_NOTE; paint(last); retry = setTimeout(open, 1_000); retry.unref?.(); return; }
          finish(1, reason === 'pane exited' ? 'els attach: the pane exited' : (exitCode === 0 ? `els attach: ${reason || 'the stream ended'}` : reason), reason === 'pane exited');
        },
        onError: (problem) => { note = problem; paint(last); },
      };
      if (remote) {
        const address = parseAddress(ref)!;
        // ELS-ATTACH-FRAME-DIFF: `diff:true` rides `attachEls` only — the ssh half (attachElsOverSsh →
        // `side attach-stdio` argv) carries no such flag on its wire, so the remote keeps full frames by contract.
        attached = attachElsOverSsh(remote, address.pane, paneSize(), handlers, undefined, address);
      } else attached = attachEls(elsSocketPath(), ref, paneSize(), handlers, { diff: true });   // ELS-ATTACH-FRAME-DIFF: rows-only frames, assembled in the client
    };
    open();
    const onKey = (chunk: Buffer): void => {
      const routed = mouse.feed(decodeKeys(chunk), wheelRoute, size().rows);
      if (routed.scroll !== 0 && attached && 'scroll' in attached) attached.scroll(routed.scroll);   // an ssh-bridged pane has no els scrollback lane
      const keys = prefix.feed(routed.send);
      if (keys.send) attached?.input(keys.send);
      if (keys.ignored) { note = `ctrl+b ${keys.ignored} 는 아직 없음`; paint(last); }
      if (keys.detach) { attached?.detach(); finish(0, ''); }
    };
    const onResize = (): void => { const next = paneSize(); attached?.resize(next.cols, next.rows); };
    process.stdout.write(ENTER_PANE_VIEW);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onKey);
    process.stdout.on('resize', onResize);
  });
}

/** The terminal side of bare `els`: raw keys → the app, window size → the app, the app's drawing → stdout. */
function runAppView(sidebar: boolean | undefined, initialPane?: string): Promise<number> {
  const decodeKeys = createKeyDecoder();
  const hosts = federation();                                    // the other hosts' panes (registered els hosts + herdr), read-only
  const app = createAttachApp({
    // ELS-VOICE-CONTROL-POPUP: ctrl+b : asks the cheap one-shot model (budget tier; local LM Studio fallback) — null = rules.
    voiceModel: async (prompt) => (await import('../domains/signal-dedup.js')).llmOnce(prompt),
    remote: { list: () => hosts.list(), read: (address) => hosts.read(address) },
    request: (request) => requestEls(elsSocketPath(), request),
    attach: (pane, size, handlers) => attachEls(elsSocketPath(), pane, size, handlers),
    // ELS-FIRST-RUN-FU3 ② · ELS-APP-RENDER-SINGLE-FRAME: an unchanged screen writes nothing; otherwise only the changed
    // rows, as one write inside a DEC 2026 synchronized update.
    write: createAppFrameWriter((text) => { process.stdout.write(text); }),
    size: () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
    cwd: process.cwd(),
    buildLabel: ownBuildLabel(),
    ownBuild: (() => { const build = cliBuildIdentity(); const builtAt = buildCommitTime(build); return { sha: build.sha, ...(builtAt !== undefined ? { builtAt } : {}) }; })(),
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
  // ELS-MOUSE-RELEASE: LEAVE_VIEW goes out once — on the app's end, and also when the process dies under the view (SIGHUP/uncaught exception).
  const leaveGuard = guardLeave({ proc: realProcess, write: (text) => { process.stdout.write(text); }, bytes: LEAVE_VIEW });
  process.stdout.write(ENTER_VIEW);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onKey);
  process.stdout.on('resize', onResize);
  void app.start(initialPane);
  return app.done.then(({ code, message }) => {
    process.stdin.off('data', onKey);
    process.stdout.off('resize', onResize);
    try { process.stdin.setRawMode(false); } catch { /* not a TTY any more */ }
    process.stdin.pause();
    leaveGuard.leave();
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
