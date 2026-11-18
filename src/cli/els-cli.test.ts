// els end to end: `side serve` is the one owner process; `side ls/new/read/send` are separate client processes.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestEls } from '../els/client.js';
import { simCli } from '../ux-sim/in-process-cli.js';

// 출처: a fresh `elanous` process boots, loads the journal and binds the socket in a few seconds on the gate hosts.
const SERVE_READY_MS = 20_000;
// 출처: the whole one-owner scenario (three serves, a dozen client calls) finishes well inside this on the gate hosts.
const SERVE_LIFETIME_MS = 120_000;

const dirs: string[] = [];
const stops: AbortController[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop.abort();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

/** Start `side serve` for `state` (through simCli) and wait until it listens or exits with its refusal.
 *  `kill()` SIGKILLs its process group: the server dies without removing its socket. */
async function serve(state: string, extra: string[] = [], env: Record<string, string> = {}): Promise<{ kill: () => void; exited: Promise<number>; output: () => string }> {
  const stop = new AbortController();
  stops.push(stop);
  let text = '';
  const run = simCli(['side', 'serve', ...extra], {
    mode: 'spawn', allowPaths: [['side']], stateRoot: state, cwd: state, env: { NODE_ENV: 'development', HERDR_ENV: '', ...env },
    signal: stop.signal, killSignal: 'SIGKILL', timeoutMs: SERVE_LIFETIME_MS, onStdout: (chunk) => { text += chunk; },
  });
  let exitCode: number | undefined;
  const exited = run.then((result) => { text += result.stderr; exitCode = result.exitCode; return result.exitCode; });
  const deadline = Date.now() + SERVE_READY_MS;
  while (Date.now() < deadline && !text.includes('listening on') && exitCode === undefined) await Bun.sleep(50);
  return { kill: () => stop.abort(), exited, output: () => text };
}

const side = (state: string, cwd: string, args: string[], env: Record<string, string> = {}) => simCli(['side', ...args], {
  mode: 'spawn', allowPaths: [['side']], stateRoot: state, cwd, env: { NODE_ENV: 'development', HERDR_ENV: '', ...env },
});

test('no server: the CLI says so and writes nothing', async () => {
  const state = tempDir('els-none-');
  const listed = await side(state, state, ['ls']);
  expect(listed.exitCode).toBe(1);
  expect(listed.stderr).toContain('els serve');
  expect(existsSync(join(state, 'els', 'journal.json'))).toBe(false);
});

test('one owner: new/send/read go through the server, a second serve is refused, a dead server is replaced and the pane keeps its cwd', async () => {
  const state = tempDir('els-owner-');
  const cwd = tempDir('els-cwd-');
  const first = await serve(state);
  expect(first.output()).toContain('listening on');

  // Concurrent serve while one answers: refused, the first keeps serving.
  const second = await serve(state);
  expect(await second.exited).toBe(1);
  expect(second.output()).toContain('already answers');

  const created = await side(state, cwd, ['new', '--ws', 'HQ', '--cwd', cwd, '--', 'sh']);
  expect(created.exitCode, created.stderr).toBe(0);
  const pane = (JSON.parse(created.stdout) as { pane: string }).pane;
  expect((await side(state, cwd, ['send', pane, 'echo els-hi\n'])).exitCode).toBe(0);
  let screen = '';
  for (let attempt = 0; attempt < 40 && !screen.includes('els-hi'); attempt += 1) {
    screen = (await side(state, cwd, ['read', pane])).stdout;
    if (!screen.includes('els-hi')) await Bun.sleep(100);
  }
  expect(screen).toContain('els-hi');

  // The owner dies without cleaning up: its socket file stays; nobody answers on it.
  first.kill();
  await first.exited;
  expect(existsSync(join(state, 'els', 'els.sock'))).toBe(true);
  expect((await side(state, cwd, ['ls'])).stderr).toContain('els serve');

  // Restart: a new serve clears the dead socket; the pane is back with its cwd and last screen, without a pty.
  const third = await serve(state);
  expect(third.output()).toContain('listening on');
  const listed = JSON.parse((await side(state, cwd, ['ls'])).stdout) as { panes: { pane: string; cwd: string; ptyId: string; state: string }[] };
  expect(listed.panes.map((row) => [row.pane, row.cwd, row.ptyId, row.state])).toEqual([[pane, cwd, '', 'idle']]);
  expect((await side(state, cwd, ['read', pane])).stdout).toContain('els-hi');
  const refused = await side(state, cwd, ['send', pane, 'x']);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain('no live pty');
}, 120_000);

test('a state dir too deep for a Unix socket is reported by serve and by the CLI', async () => {
  const state = join(tempDir('els-deep-'), 'd'.repeat(120));
  mkdirSync(state, { recursive: true });
  const listed = await side(state, state, ['ls']);
  expect(listed.exitCode).toBe(1);
  expect(listed.stderr).toContain('too deep for a Unix socket');
  const server = await serve(state);
  expect(await server.exited).toBe(1);
  expect(server.output()).toContain('too deep for a Unix socket');
});

/** A free loopback port (bound and released; the serve under test binds it right after). */
const freePort = () => new Promise<number>((resolve) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

test('stage 2: ls and read reach a registered host through its read window; a host that stops answering stays listed as down', async () => {
  const hostA = tempDir('els-a-');
  const hostB = tempDir('els-b-');
  const port = await freePort();
  const b = await serve(hostB, ['--http', `127.0.0.1:${port}`], { ELANOUS_ELS_HOST: 'hostb' });
  expect(b.output()).toContain('listening on');
  const a = await serve(hostA, [], { ELANOUS_ELS_HOST: 'hosta' });
  expect(a.output()).toContain('listening on');
  const sideAt = (state: string, args: string[], host: string) => simCli(['side', ...args], {
    mode: 'spawn', allowPaths: [['side']], stateRoot: state, cwd: state, env: { NODE_ENV: 'development', HERDR_ENV: '', ELANOUS_ELS_HOST: host },
  });
  // A pane on host B, with something on its screen.
  const created = await sideAt(hostB, ['new', '--ws', 'GATE', '--cwd', hostB, '--', 'sh'], 'hostb');
  expect(created.exitCode, created.stderr).toBe(0);
  const bPane = JSON.parse(created.stdout) as { address: string; pane: string };
  await sideAt(hostB, ['send', bPane.pane, 'echo from-host-b\n'], 'hostb');
  // Host A registers B (and a public URL, which is rejected).
  mkdirSync(join(hostA, 'els'), { recursive: true });
  writeFileSync(join(hostA, 'els', 'hosts.json'), JSON.stringify({ hosts: [
    { name: 'hostb', baseUrl: `http://127.0.0.1:${port}` }, { name: 'pub', baseUrl: 'https://example.com' }] }));
  const listed = JSON.parse((await sideAt(hostA, ['ls'], 'hosta')).stdout) as {
    hosts: { name: string; reach: string }[]; rejectedHosts: string[]; panes: { address: string; reach: string }[] };
  expect(listed.hosts.map((host) => [host.name, host.reach])).toEqual([['hosta', 'local'], ['hostb', 'up']]);
  expect(listed.rejectedHosts).toEqual(['pub: baseUrl is not a tailnet or loopback http(s) URL']);
  expect(listed.panes.map((pane) => [pane.address, pane.reach])).toEqual([[`hostb:${bPane.address}`, 'up']]);
  let screen = '';
  for (let attempt = 0; attempt < 40 && !screen.includes('from-host-b'); attempt += 1) {
    screen = (await sideAt(hostA, ['read', `hostb:${bPane.address}`], 'hosta')).stdout;
    if (!screen.includes('from-host-b')) await Bun.sleep(100);
  }
  expect(screen).toContain('from-host-b');
  // Host B dies: A still lists it, as down; reading it says ? with the reason.
  b.kill();
  await b.exited;
  const after = JSON.parse((await sideAt(hostA, ['ls'], 'hosta')).stdout) as { hosts: { name: string; reach: string }[]; panes: unknown[] };
  expect(after.hosts.map((host) => [host.name, host.reach])).toEqual([['hosta', 'local'], ['hostb', 'down']]);
  expect(after.panes).toEqual([]);
  const failed = await sideAt(hostA, ['read', `hostb:${bPane.address}`], 'hosta');
  expect(failed.exitCode).toBe(1);
  expect(failed.stderr).toContain('hostb ?');
  // Host B restarts on the same window: A sees it up again, with B's pane (its pty gone after the restart).
  const bAgain = await serve(hostB, ['--http', `127.0.0.1:${port}`], { ELANOUS_ELS_HOST: 'hostb' });
  expect(bAgain.output()).toContain('listening on');
  const back = JSON.parse((await sideAt(hostA, ['ls'], 'hosta')).stdout) as { hosts: { name: string; reach: string }[]; panes: { address: string; state: string }[] };
  expect(back.hosts.map((host) => [host.name, host.reach])).toEqual([['hosta', 'local'], ['hostb', 'up']]);
  expect(back.panes.map((pane) => [pane.address, pane.state])).toEqual([[`hostb:${bPane.address}`, 'idle']]);
  expect((await sideAt(hostA, ['read', `hostb:${bPane.address}`], 'hosta')).stdout).toContain('from-host-b');
}, 120_000);

test('serve --http refuses a public bind address', async () => {
  const state = tempDir('els-pub-');
  const refused = await serve(state, ['--http', '0.0.0.0:8790']);
  expect(await refused.exited).toBe(2);
  expect(refused.output()).toContain('not a loopback or tailnet');
});

test('herdr words and defaults: workspace create with no options, pane run/send-keys/list/close, send presses Enter, options after -- are explained', async () => {
  const state = tempDir('els-parity-');
  const folder = join(realpathSync(tempDir('els-proj-')), 'myproj');   // the process cwd is the real path (/private/var on macOS)
  mkdirSync(folder);
  const server = await serve(state);
  expect(server.output()).toContain('listening on');
  const shell = { SHELL: '/bin/sh' };

  const created = await side(state, folder, ['workspace', 'create'], shell);
  expect(created.exitCode, created.stderr).toBe(0);
  const pane = (JSON.parse(created.stdout) as { result: { pane: { pane_id: string }; root_pane: { cwd: string } } }).result;
  expect(pane.root_pane.cwd).toBe(folder);
  const paneId = pane.pane.pane_id;
  const workspaces = JSON.parse((await side(state, folder, ['workspace', 'list'])).stdout) as { result: { workspaces: { name: string }[] } };
  expect(workspaces.result.workspaces.map((row) => row.name)).toEqual(['myproj']);

  const readUntil = async (needle: RegExp): Promise<string> => {
    let screen = '';
    for (let attempt = 0; attempt < 50 && !needle.test(screen); attempt += 1) {
      screen = (await side(state, folder, ['pane', 'read', paneId])).stdout;
      if (!needle.test(screen)) await Bun.sleep(100);
    }
    return screen;
  };
  expect((await side(state, folder, ['pane', 'run', paneId, 'echo run-ok'])).exitCode).toBe(0);
  expect(await readUntil(/^run-ok$/m)).toMatch(/^run-ok$/m);
  expect((await side(state, folder, ['send', paneId, 'echo enter-ok'])).exitCode).toBe(0);   // Enter by default
  expect(await readUntil(/^enter-ok$/m)).toMatch(/^enter-ok$/m);
  expect((await side(state, folder, ['pane', 'send-text', paneId, 'echo held'])).exitCode).toBe(0);   // no Enter
  await Bun.sleep(300);
  expect((await side(state, folder, ['pane', 'read', paneId])).stdout).not.toMatch(/^held$/m);
  expect((await side(state, folder, ['pane', 'send-keys', paneId, 'enter'])).exitCode).toBe(0);
  expect(await readUntil(/^held$/m)).toMatch(/^held$/m);
  const badKey = await side(state, folder, ['pane', 'send-keys', paneId, 'ctrl+c', 'bogus']);
  expect(badKey.exitCode).toBe(2);
  expect(badKey.stderr).toContain('nothing was sent');

  const misplaced = await side(state, folder, ['new', '--', 'sh', '--cwd', folder]);
  expect(misplaced.exitCode).toBe(2);
  expect(misplaced.stderr).toContain('must come before --');
  const raw = await side(state, folder, ['new', '--ws', 'R', '--cwd', folder, '--raw', '--', 'sh', '--cwd', folder]);   // a command that really takes --cwd runs
  expect(raw.exitCode, raw.stderr).toBe(0);
  expect((await side(state, folder, ['pane', 'close', (JSON.parse(raw.stdout) as { pane: string }).pane])).exitCode).toBe(0);

  const listed = JSON.parse((await side(state, folder, ['pane', 'list'])).stdout) as { result: { panes: { pane_id: string; cwd: string }[] } };
  expect(listed.result.panes.map((row) => [row.pane_id, row.cwd])).toEqual([[paneId, folder]]);
  expect((await side(state, folder, ['pane', 'close', paneId])).exitCode).toBe(0);
  expect((JSON.parse((await side(state, folder, ['pane', 'list'])).stdout) as { result: { panes: unknown[] } }).result.panes).toEqual([]);
}, 120_000);

test('bare `els` on an empty isolated state dir starts the server by itself (no launchd), shows the spaces, and a second run reuses it', async () => {
  const state = tempDir('els-bare-');
  const folder = tempDir('els-bare-cwd-');
  let pid = 0;
  try {
    const first = await side(state, folder, [], { SHELL: '/bin/sh' });
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout).toContain('no panes yet');
    expect(existsSync(join(state, 'els', 'els.sock'))).toBe(true);
    expect(existsSync(join(state, 'els', 'events.jsonl'))).toBe(true);             // «serve-direct» recorded
    const ping = await requestEls(join(state, 'els', 'els.sock'), { op: 'ping' });
    pid = Number(/pid (\d+)/.exec(ping.message)?.[1]);
    expect(Number.isNaN(pid)).toBe(false);   // the ping answered with a pid
    expect(pid).not.toBe(0);
    expect((await side(state, folder, ['new', '--ws', 'W', '--cwd', folder, '--', 'sh'])).exitCode).toBe(0);
    const second = await side(state, folder, []);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/working|idle/);
    expect(second.stderr).not.toContain('감독자');
    const status = await side(state, folder, ['supervisor', 'status']);
    expect(status.stdout).toContain('isolated state (never uses launchd)');
    expect(status.stdout).toContain('server answering');
  } finally {
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  }
}, 120_000);

test('`els workspace move` / `els tab move` change the order every list shows, and a restarted server keeps it', async () => {
  const state = tempDir('els-order-');
  const cwd = tempDir('els-order-cwd-');
  const first = await serve(state);
  expect(first.output()).toContain('listening on');
  for (const ws of ['alpha', 'beta', 'gamma']) expect((await side(state, cwd, ['new', '--ws', ws, '--cwd', cwd, '--', 'sh'])).exitCode).toBe(0);
  const names = async () => (JSON.parse((await side(state, cwd, ['workspace', 'list'])).stdout) as { result: { workspaces: { name: string }[] } }).result.workspaces.map((ws) => ws.name);
  expect(await names()).toEqual(['alpha', 'beta', 'gamma']);
  expect((await side(state, cwd, ['workspace', 'move', 'gamma', '--before', 'alpha'])).exitCode).toBe(0);
  expect((await side(state, cwd, ['workspace', 'move', 'beta'])).exitCode).toBe(0);
  expect(await names()).toEqual(['gamma', 'alpha', 'beta']);
  const bad = await side(state, cwd, ['workspace', 'move', 'nope']);
  expect([bad.exitCode, bad.stderr]).toEqual([1, expect.stringContaining('unknown workspace')]);
  const tabs = (JSON.parse((await side(state, cwd, ['tab', 'list'])).stdout) as { result: { tabs: { tab_id: string }[] } }).result.tabs;
  const crossed = await side(state, cwd, ['tab', 'move', tabs[0]!.tab_id, '--before', tabs[1]!.tab_id]);
  expect([crossed.exitCode, crossed.stderr]).toEqual([2, expect.stringContaining('its own workspace')]);
  first.kill();
  await first.exited;
  const second = await serve(state);
  expect(second.output()).toContain('listening on');
  expect(await names()).toEqual(['gamma', 'alpha', 'beta']);
}, 120_000);

test('both help screens — `els --help` and `elanous side --help` — show the whole confirmed description, word for word, and no old tail', async () => {
  const state = tempDir('els-help-');
  const confirmed = 'Elanous Side (els) — workspaces, tabs and panes in one screen; the command is `els`. In a terminal, bare `els` opens the whole screen.';
  // commander wraps long descriptions at the terminal width: compare the words, not the line breaks.
  const words = (text: string): string => text.replace(/\s+/g, ' ');
  // The `els` shim is exactly `exec elanous side "$@"` (scripts/install.sh), so its `--help` IS `elanous side --help`; the
  // second form asks the root command for the same screen through its own help, which lists `side` with the same text.
  // terra must-fix (PR self-review): compare BOTH whole screens against independent
  // literals — a containment check on the description (side) or the 'Elanous Side (els)'
  // prefix (root) proves only a fragment, not the screen. The literals below are the real
  // output, captured by running the dev bin exactly the way the helpers run it (spawn,
  // --test state, NODE_ENV=development, COLUMNS) and pasted verbatim — they are not
  // assembled from implementation constants. The old negative check ('Alias of the els
  // bin' absent) is subsumed by the whole-screen equality below.
  const sideHelpScreen = `Usage: elanous side [options] [command]

Elanous Side (els) — workspaces, tabs and panes in one screen; the command is
\`els\`. In a terminal, bare \`els\` opens the whole screen.

Options:
  --list                        print the panes as lines instead of opening the
                                screen (also what a pipe gets)
  --side                        open with the side list shown (remembered for
                                next time)
  --no-side                     open with the side list hidden (remembered for
                                next time)
  -h, --help                    display help for command

Commands:
  supervisor                    The launchd user agent that keeps the els server
                                running: on · off · status
  serve [options]               Run the els server: the one owner of the journal
                                and the pane PTYs (run once, by a supervisor)
  ls [options]                  List workspaces, tabs and panes as JSON: this
                                host and the hosts in els/hosts.json (a host
                                that does not answer is listed as down)
  new [options] [command...]    Open a pane: the server spawns a PTY and records
                                ws/tab/pane + cwd in the journal. No command →
                                $SHELL, no --cwd → this folder, no --ws → the
                                folder name. Options go BEFORE --
  read <pane>                   Read a pane: a local pane id, ws/tab/pane, or
                                host:ws/tab/pane on a registered host
  send [options] <pane> <text>  Type text into a live pane and press Enter
                                (--no-enter: text only)
  do [options] <pane> <text>    Type a line into a pane (local, ws/tab/pane or
                                host:ws/tab/pane): marked «⇢ from · text»,
                                queued while the pane's turn is running. A
                                local pane walks the control door first
                                (default deny).
  workspace                     Workspaces (herdr words): list · create · close
                                · move
  tab                           Tabs (herdr words): list · move
  attach <pane>                 Show one pane live in this terminal and type
                                into it (ctrl+b q detaches; the pane keeps
                                running)
  pane                          Panes (herdr words): list · read · send-text ·
                                send-keys · run · close
`;
  const rootHelpScreen = `Usage: elanous [options] [command]

말 한 줄로 시작: elanous harness say "…" — 끝까지 간다 · 다 보인다 · 스스로를 만들었다

Options:
  -V, --version                                output the version number
  --config-dir <dir>                           Override the elanous config / daemon root directory (default ~/.elanous). Pass at any position — works at the global or subcommand level. Replaces the legacy ELANOUS_DAEMON_DIR env var.
  -r, --remote [name]                          원격 북마크로 붙는다. \`-r\` 만 쓰면 default 북마크(값을 받지 않는다), 이름을 대려면 \`--remote <name>\`. 처음 1회 \`elanous nexus connect <host> --default\`.
  --test                                       격리 테스트 인스턴스로 실행 — cwd 의 git 트리(worktree 포함)에서 \`<트리>/.elanous-test\` 를 루트로 잡고 state·config 두 축을 함께 격리한다. config 사본이 없으면 자동 물질화. \`--test=<dir>\` 로 루트 직접 지정 가능(값 문법은 \`=\` 형태 하나 — 모호함 없음). ELANOUS_STATE_DIR/--config-dir 을 손으로 줄 필요가 없다.
  --name <name>                                대시보드 TUI 의 PTY 행(tui:<pid>)에 별명을 달고 뜬다 — \`elanous pty list\` 에 보이고 \`pty snapshot <name>\` 으로 부른다. 뜬 뒤 바꾸려면 \`elanous pty rename <ref> <name>\`.
  --legacy                                     기존 대시보드 TUI로 시작한다(--tui classic 의 짧은 표기). 기본 진입은 classic 이다.
  --tui <mode>                                 루트 TUI를 명시한다(classic|next). 로컬·원격 기본은 classic 이고 next 는 --tui next 로 연다. --legacy는 classic의 짧은 표기다.
  --provider <name>                            Next TUI 세션 한정 provider 선택(전역 config 불변)
  --model <id>                                 --provider와 함께 Next TUI 세션 모델 선택
  --help-all                                   시스템 명령을 제외한 모든 최상위 명령 표시
  -h, --help                                   display help for command

Commands:
  preview [options] <target>                   Isolated PR/branch-head TUI + PWA preview; publish the TUI-COMFORT friction table to a PR
  pty                                          PTY control — <ref> is an id, nickname, or unique prefix (see 'pty list')
  pane                                         Pane compatibility entry via els
  side [options]                               Elanous Side (els) — workspaces, tabs and panes in one screen; the command is \`els\`. In a terminal, bare \`els\` opens the whole screen.
  pr                                           PR landing commands
  repo                                         명시적 로컬 저장소 GitHub 비공개 발행
  role                                         관제부 Primary 임대 조회 및 수동 넘김
  machine                                      기계 식별자 · 맡은 일 · 자리 후보 순위
  image                                        하니스 이미지 원장 — 신분 표지(역할·보존·출신) · 원장 없는 레지스트리 태그 = transient
  agent-env                                    에이전트 CLI 환경의 비밀 없는 프로필
  where [options]                              지금 이 프로세스가 어느 인스턴스(prod/test)에 속하는지와 그 이유를 보여준다 (READ-ONLY)
  bench                                        벤치 팔(같은 골 · 모델만 다른 발사) 원장 — harness ask/say --bench 가 쓴다
  shadow                                       git 아닌 폴더의 이력을 인스턴스 밖 그림자 저장소에 남긴다
  llm [options] [text...]                      Ask a model without Elanous context, tools, or a session; use \`detect\` to inspect providers
  storage                                      저장소 공급자
  leader                                       은퇴한 리더 트리 명령
  pod                                          Pod 명령 Job — 하니스 없이 명령 하나를 돌리고 산출을 돌려받는다
  runs                                         실행 지문 조회
  browser                                      🎨 봇이 모는 브라우저 페이지 «안»에 그린다 — 도형 · 캔들 차트 · 지우기
  questions                                    AskUserQuestion 대기를 조회하고 파일 답을 기록한다
  usage [options]                              계정마다 행으로 「지금 쓸 수 있는 것이 얼마나 남았나」를 본다 (크레딧 축 ≠ 구독 축)
  live                                         Live 상세 관측 스위치
  research [options] <query...>                여러 웹 검색 엔진으로 조사 (사용 가능한 provider 를 병렬 검색)
  rfc                                          RFC registry (list/show initialize the database when absent)
  release                                      공개 배포 한 판 — prepare(로컬) → publish(--yes) → verify (docs/manual/MANUAL-versioning-and-release-2026-09-25.md)
  know [options] <words...>                    대표 지시 · 결정 · 판 칸 · 교훈을 한 질문으로 검색
  life                                         생애 종류 · 종류별 끝의 증거 · 반복 실행 시리즈
  notify [options] [text...]                   대표에게 운영 보고를 발송한다 (기본 kind: op-report)
  away                                         외출 모드 — 켜면 발행 현황을 텔레그램으로 따라간다(노드 전이 · 막힘 즉시 · 60분 생존 줄)
  freeze                                       착지 동결 상태 on/off/status
  herdr                                        herdr 연동 — herdr pane 의 elanous TUI 를 밖에서 다룬다
  flow                                         Wish 카드 → 칸 → 릴리스 판
  hq                                           본부 임대 — 하트비트·중재·단일 작성자 래퍼
  seat                                         분배된 자리의 하루 루프와 보고
  model-watch [options]                        제공자 문서에서 카탈로그 변경 제안을 만든다; 자동 적용하지 않는다
  bootstrap                                    Install safe first-run tools and add elanous to PATH
  doctor [options]                             Reports whether credentials resolve and where each resolution comes from
  control                                      독립 관제부
  resources                                    관제부 자원 조회
  train                                        열차 관측
  hooks                                        외부 웹훅 수신·재전송
  setup [options]                              Check OpenAI Codex setup and guide each missing credential step
  member                                       Manage member credentials and approved app-session handoffs.
  start [options]                              Discover LLM, ensure Nexus is healthy, and open the GUI or TUI
  grounding                                    그라운딩 출처 레지스트리
  graph                                        Run a declared command graph or inspect its latest run
  loop                                         Inspect and control graph-backed loop agents
  resource                                     자리별 루프 자원 관측 (읽기 전용)
  card                                         Inspect task cards
  launch-head                                  발사 앞 머리 — 골이 Pod 로 가도 되는지 판정
  a2a                                          A2A 에이전트 서버와 공개 카드
  plugin                                       Install and manage Elanous plugins
  make [options] <request>                     Classify a one-line request and make a plugin or build a workflow
  skills                                       Check, install and repair skills
  connect [options] <agent>                    Use the skills you already have in another agent (claude | codex) or a Claude Code plugin folder — registers in place, never copies; plugin MCP servers are added switched off
  import [options]                             Show what elanous can bring over from Claude Code, Codex, ~/.agents, OpenClaw and Hermes — a plan first; \`--apply\` registers skills in place and adds MCP switched off, \`--undo\` puts everything back
  team                                         Validate a YAML team definition
  team-set                                     Install, remove and list persona team sets
  persona                                      Persona presets — AI coworkers you pick and customise (list · add · edit · show)
  market                                       Signed plugin marketplace
  steward                                      Steward loop controls
  directive                                    Turn instructions into Linear issues
  connector                                    External task connectors
  storyboard                                   스토리보드 정본 검사 · MD 생성
  python                                       elanous 가 쓰는 파이썬(해석 · 점검 · elanous venv 셋업) — RFC-doctor-fix-build-toolchain-and-python-by-distro
  self-update|update [options]                 설치본은 릴리스로, 체크아웃은 깨끗한 체크아웃으로 갱신 · --auto 는 캐너리 자동 판단, --auto on|off|status 는 기존 자동 갱신 서비스 관리
  measure-fabric-arc-ab                        Fabric 분해 아크의 축소/전체 그라운딩 A/B를 관측하고 표와 JSON 결과를 낸다
  mcp                                          MCP (Model Context Protocol) server / client integration
  relay                                        Encrypted WebSocket relay
  telegram-test [options]                      Standalone TEST telegram bot (separate token) — full Q&A/HITL/delegate path with ISOLATED state, WITHOUT touching the production daemon. Restart THIS process to test code changes; the live daemon stays up.
  telegram                                     텔레그램 봇 — 넥서스 밖에서 도는 정식 Q&A 폴러
  discord-test [options]                       Standalone TEST discord session (SAME app/token, scoped to discord.testChannel.channelId) with ISOLATED state, WITHOUT touching the production daemon. Restart THIS process to test code changes; the live daemon stays up.
  sync [options]                               Sync skills to local or remote machines
  status                                       Show current sync status and detect changes since last sync
  git <args...>                                Run git through the git-fs gateway and append a pipe-visible exit status
  gh <args...>                                 Run gh with retry-safe reads and append a pipe-visible outcome
  theme                                        Inspect and configure dashboard themes
  history [options]                            Show sync history
  inspect [options]                            Inspect remote targets without syncing
  retro                                        Read-only retrospective facts from existing logs
  memory                                       Persistent memories injected into every chat turn (user / feedback / project / reference)
  decide [options] <question>                  Jev(System One)에게 «확률이 붙은» 판정 하나를 묻는다 — 기본 예/아니오. 📚 docs/manual/MANUAL-typesafe-jev-system-one-2026-09-20.md
  ax-screen [options] <tasks.json>             업무 목록을 Jev 로 스크리닝해 자동화 후보 순위를 낸다. 📚 docs/manual/MANUAL-ax-task-screening-2026-09-20.md
  decide-recipe [options] <name> <state.json>  이름 붙은 레시피로 판정한다. 질문은 recipes/<name>.json 에 «고정»되어 있다 — 매번 짓지 않는다.
  signals [options]                            신호 파이프라인 퍼널(READ-ONLY) — 유입→분류→critical→2차→확정→집행 각 단계 수·통과율·갭. 게이트 튜닝 판단 근거.
  loops [options]                              루프 에이전트 자산 원장(READ-ONLY) — 목표까지 반복하는 실행 주체(계약/자율/코디네이터)를 미션연관·독립·라이프사이클별로. 좀비(TTL 초과) 감지.
  buzz [options]                               커뮤니티 버즈 온디맨드 브리핑 — 수집분 조회 + stale(밤/주말)이면 실시간 그랩 폴백. 매매 아님(정성 신호).
  harness                                      dev-harness worktree 수명 — 워크트리 생성(worktree add)·조회(worktrees)·정리(clean)·프로세스 관찰(processes)
  context                                      외부 에이전트 맥락 이벤트
  coord                                        조율 채널 맥락 원장
  self                                         Self-awareness memory — 외부 도구(Claude Code/Codex)가 구현/변경 이력을 elanous 기억에 주입·회상
  factcheck [options] <query...>               팩트체크 — 내부(발송 리포트/대화) 먼저 검색 → 없으면 외부(X/레딧/웹) 에스컬레이션
  provider|providers                           Show the currently active LLM provider + model + auth status
  provider:set [options] <name>                Swap active LLM provider in config.json (auto-backs-up the previous config to its \`.bak\` sibling — ⛔ the path is the ACTIVE config, not a fixed one: run \`elanous where\` to see it). Useful for A/B testing model behaviour — e.g. \`elanous provider:set anthropic\` to force-switch to Claude, then \`elanous provider:set restore\` (or \`elanous provider:restore\`) to roll back.
  provider:restore                             Restore config.json from the automatic backup written by \`elanous provider:set\`.
  provider:rotate [options] [sub] [target]     Cycle through the rotation list. With no argument: advance one step. Sub-commands: \`list\` (print list), \`reset\` (jump to first entry), \`add <provider> [-m model] [-l label]\` (append), \`remove <label>\`, \`clear\` (wipe rotation).
  provider:use <needle>                        Jump to a specific rotation entry by label / provider name / model substring. Auto-backs-up config.json before the switch (restore with \`elanous provider:restore\`). Example: \`elanous provider:use opus\`, \`elanous provider:use grok\`, \`elanous provider:use gpt-5\`.
  status-bar [options]                         Print the status pills (working dir + git + model) — pipe into shell prompt or preview
  schedule                                     스케줄/크론 CRUD (registry·crontab·기억 정합). --json 으로 프로그래매틱 소비.
  guardian                                     크론 수호자 그림자 관측(기존 크론·알림 무변경)
  intake                                       바깥 사실·문서를 elanous 현재와 대조하거나 태스크로 받는다
  logs [options]                               전 서피스 로그 조회/실시간 tail (adb logcat 동형) — level/surface/category/grep 필터
  credentials                                  Encrypted host credential backup and restore preflight.
  cred                                         Inventory credential metadata without displaying credential values.
  secret                                       Store and manage API keys without displaying their values.
  sim                                          격리 시나리오를 실행하고 화면·로그 기대값을 대조한다
  ad [options] [input...]                      판매 URL, 텍스트 브리프 또는 실사 이미지로 광고 제작 파이프라인을 시작
  docs                                         문서 지식 검색/관리 — knowledge.db 벡터+BM25 하이브리드 (DocOps)
  decisions                                    대표 결정 로컬 원장
  claims                                       소구점 실측 근거 로컬 원장
  lesson                                       교훈 · 재발 로컬 원장
  directives                                   대표 지시 로컬 색인·검색
  fleet                                        멀티 elanous 인스턴스 통합 뷰(READ-ONLY 연합) — 등록 인스턴스·보유 스토어 매트릭스. \`logs instances\` 일반화(kubectl get nodes 등가). 연합 조회는 \`session list --all-instances\` 등.
  ops                                          운영 관측(READ-ONLY) — 미션·태스크·계약 루프·오케스트레이터 현재 상태·이상·전이. --json 프로그래매틱.
  catalog                                      서명된 LLM 모델 카탈로그 관리
  app                                          Validate and build local app sources
  outputs                                      산출물 원장 조회 (읽기 전용)
  publish                                      external-markdown 게시 라이프사이클 — 만료 게시물 GC(S3 콜드 백업·삭제 아님)
  env                                          환경 감지
  agent-mission|codex                          Agent-mission CLI — 외부 에이전트 backend(codex[디폴트]·claude·gemini·grok·aside·openclaw·hermes) 미션·리뷰 워치·셋업. \`codex\` 는 deprecated alias(하위호환).
  dev|drive [options] [text...]                ⛔ \`drive\` 별칭으로 부르면 옵션은 아홉뿐 (--goal · --attach · --max-steps · --poll-ms · --model · --cwd · --worktree · --json · --jail-home) — \`--attach <ref>\` 는 이미 있는 PTY 를 몬다(생략하면 셸 명령을 새로 띄운다). 나머지는 전부 \`dev\` 전용이고 \`drive\` 에서는 거부된다. dev 와 drive 는 한 명령이라 이 도움말을 공유하므로, 아래 목록은 \`dev\` 기준이다. ⚠️ 실험 — 통합 self-dev 파이프라인 runDevPipeline. --backend self(디폴트·elanous-chat 자체구현)|codex/claude/gemini/grok(외부). --transport pty(디폴트·worktree·--branch 필수)|acp(cwd 세션·U6·capability 미검증). 미배선 조합은 NotYetUnified 명시 거부. ★self 는 무인 완결이 기본(PR 개설→auto-review 라벨→리뷰 clean 시 병합) — 끄려면 --no-open-pr/--no-auto-review/--no-auto-merge. 관측=elanous logs --category dev-pipeline · 상세=docs/manual/MANUAL-frontdoor-selfdev-dogfood-mechanism-2026-07-25.md
  keys [options] [context]                     Print all keybindings + slash commands. Optional context filter.
  finance                                      Native finance/investment logic (SSOT) — skill thin-client 진입점
  config                                       Inspect and edit ~/.config/elanous/config.json
  mission [options]                            Run a stateless Codex/Claude mission and exchange replies by missionId
  tasks|task                                   TOX 태스크 조회 및 승인 · TASK-AGENT 과제 넘기기(hand)
  brief                                        대표 브리핑 항목 원장과 슬롯 발송
  labels                                       PR 라벨 등록표 조회·GitHub 동기화
  msg                                          Durable seat-addressed messages
  statusline                                   Check and preview your status-line definition (statusline.yaml)
  shell-init <shell>                           Print optional shell integration for command-line suggestions
  q [options] <request...>                     Print one shell command for a natural-language request; never runs it
  ask [options] <text...>                      Ask one question with Elanous context, then print the reply
  do [options] <text...>                       Investigate a task and execute it in this terminal (the execution mode); destructive commands require y/N.
  onboarding [options] [step]                  Run the first-run wizard. Pass a step name (llm|skills|obsidian|telegram|discord|voice-ai) to run only that step.
  login                                        Authenticate to an LLM provider via OAuth
  session                                      Manage conversation sessions
  chat [options] [text...]                     Send one message in a new session (or a continued one with --continue/--resume/--session) and print the reply
  repl [options]                               Sticky multi-turn REPL — same session across turns, no per-turn process boot. Drives chat / agent / scenario from one shell. Boots a new session by default; --continue/--resume continue the active one, --session <id> resumes an explicit one, --scenario <yaml> for a scripted run, JSONL on stdin for piped automation.
  agent [options] [text...]                    Single-turn agent — same as \`chat\` but with the tool loop on by default (Read/Grep/Glob/ListDir/Edit/Write + Bash). Use this when the LLM needs to inspect files / run commands / debug itself.
  registry                                     모델 카탈로그(catalog/=SSoT) 관측 — 라우팅 맵 drift 감사
  tier                                         LLM tier→모델 SSOT 조회 — provider별 budget/balanced/better/best/loaded 사다리(llm-tier-map). "grok low" 같은 별칭 흡수.
  local                                        Local OpenAI-compatible LLM — ping, list, test, setup
  scheduler|sched [args...]                    Retired — scheduling is now a workflow-runtime Schedule Trigger node (\`elanous wf\`)
  attach [options]                             ACP client for the running elanous daemon. Three modes: handshake-only (default), one-shot (--message), interactive REPL (--interactive). Local (unix socket) or remote (--host / --url) over Tailscale.
  wf|workflows                                 Run YAML DAG workflows (workflow-runtime · prompt|bash|skill|cft|approval|if|switch|iteration|classify|extract|set|filter|template|http|showroom|task|scheduleTrigger|webhookTrigger|discordTrigger|telegramTrigger|manualTrigger|chatTrigger|subworkflow|knowledge nodes). Aliases: \`workflows\` (plural) · \`workflow\` (singular).
  nexus                                        NEXUS — unified TUI shell + supervisor + meta-api (Phase N-1, opt-in)
  phone                                        Connect the phone app to this Mac
  token                                        Manage the ACP admin token
  acp                                          Agent Client Protocol — spawn ACP agents (claude-code, codex, gemini)
  voice                                        Voice tier + identity helpers (STT slider · TTS voice id · cost preview)
  help [command]                               display help for command

ACP server (Agent Client Protocol)
  Usage: elanous --acp-server [--transport=stdio|unix-socket|websocket] [options]
  Example: elanous --acp-server --transport=websocket

  --transport=stdio|unix-socket|websocket  Connection transport (default: stdio)
  --socket-path=<path>                    Unix socket path (unix-socket only)
  --port=<number>                         Listening port (websocket only)
  --host=<host>                           Bind host (websocket only)
  --tool-cwd=<path>                       Default working directory for tools
  --no-auth                               Disable websocket token authentication

  Zed setup and connection check: docs/manual/MANUAL-zed-acp.md

`;
  expect(words(sideHelpScreen)).toContain(confirmed);
  expect(words(rootHelpScreen)).toContain(confirmed);
  const viaSide = await side(state, state, ['--help'], { COLUMNS: '300' });
  expect(viaSide.exitCode).toBe(0);
  expect(words(viaSide.stdout)).toBe(words(sideHelpScreen));
  const viaRoot = await simCli(['--help'], { mode: 'spawn', allowPaths: [[]], stateRoot: state, cwd: state, env: { NODE_ENV: 'development', COLUMNS: '300' } });
  expect(viaRoot.exitCode).toBe(0);
  expect(words(viaRoot.stdout)).toBe(words(rootHelpScreen));
});
