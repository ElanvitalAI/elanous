// DR14 · wheel-up over an eln pane in els reaches the chat history — through the REAL els path the CEO uses:
// a real els server (holder-backed panes), the real attach client (attachEls) and the real full-screen els app
// (createAttachApp with its side list), fed the raw SGR wheel bytes a terminal sends. DR02 drove PageUp inside the TUI
// directly, so it stayed green while this path was broken: the holder snapshot carried no wheel route, every
// holder-backed pane read as «els scrollback», and a wheel over eln (alternate screen, its own mouse) spun an empty
// scrollback. All three herdr routes are held here: ① mouse report (eln) ② ↑/↓ alternate scroll (1007) ③ els scrollback, and
// ④ the single-pane view `els side attach <pane>` (the CEO's client) over the eln pane.
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { attachEls, type AttachFrame } from '../../../els/attach-client.js';
import { createAttachApp, type AttachApp } from '../../../els/attach-app.js';
import { requestEls } from '../../../els/client.js';
import { elsSocketPath, startElsServer } from '../../../els/server.js';
import { seatTuiUniverse } from './seat-tui.js';
import { mockSeatPtySequence } from '../../mock-seat-pty-sequence.js';
import type { DailyRegressionContext, DailyRegressionOutcome, DailyRegressionScenario } from './scenarios.js';

const BIN = resolve(import.meta.dir, '..', '..', '..', '..', 'bin', 'elanous.mjs');
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const until = async (check: () => boolean, ms: number, what: string): Promise<void> => {
  const stop = Date.now() + ms;
  while (!check()) { if (Date.now() > stop) throw new Error(`timed out: ${what}`); await sleep(50); }
};
// What a terminal sends for one wheel-up notch at screen column 100, row 12 (SGR 1006) — over the pane, right of the side list.
const WHEEL_UP_AT_100_12 = '\u001b[<64;100;12M';

interface AppRun { readonly app: AttachApp; readonly frames: AttachFrame[]; readonly last: () => AttachFrame | undefined }

/** The full-screen els app (side list open) over one pane, with the real attach client underneath. */
async function openApp(socket: string, pane: string, cwd: string): Promise<AppRun> {
  const frames: AttachFrame[] = [];
  const app = createAttachApp({
    request: (request) => requestEls(socket, request),
    attach: (target, size, handlers) => attachEls(socket, target, size, { ...handlers, onFrame: (frame) => { frames.push(frame); handlers.onFrame(frame); } }),
    write: () => {}, size: () => ({ cols: 140, rows: 44 }), cwd, env: {},
    setInterval: (callback, ms) => setInterval(callback, ms), clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    pollMs: 1_000, chatCommand: ['elanous'], memory: { load: () => ({ sidebar: true }), save: () => {} }, sidebar: true,
  });
  await app.start(pane);
  return { app, frames, last: () => frames.at(-1) };
}

export const dr14: DailyRegressionScenario = {
  id: 'DR14', prs: [],
  title: 'wheel-up over an eln pane in els reaches the chat history (real els server · full-screen app · `els side attach` pane view; mouse / ↑↓ / scrollback routes)',
  async run(ctx: DailyRegressionContext): Promise<DailyRegressionOutcome> {
    const failures: string[] = [];
    const ok = (label: string, condition: boolean, observed?: unknown) => { if (!condition) failures.push(`${label}${observed === undefined ? '' : ` · observed ${JSON.stringify(observed).slice(0, 300)}`}`); };
    const scrubbed: Array<[string, string]> = [];
    for (const name of Object.keys(process.env)) if (name.startsWith('ELANOUS_ELS_')) { scrubbed.push([name, process.env[name]!]); delete process.env[name]; }
    const shellWasMissing = process.env.SHELL === undefined;
    if (shellWasMissing) process.env.SHELL = '/bin/zsh';
    // 0.3.35 칸 DR14-SOCKET-PATH-LEN: 시험 우주 상태 디렉터리가 깊으면 <stateRoot>/els/els.sock 경로가
    // 유닉스 소켓 상한 103바이트를 넘어(node-b 실측 112바이트) listen 이 실패한다. 시나리오의 els 서버 상태
    // 루트를 짧은 tmp 경로로 옮긴다 — 아티팩트·저널도 그 안에 함께 들어가고, 종료 시 지운다.
    const stateRoot = join(tmpdir(), `els-dr14-${process.pid}`);
    const started = await startElsServer({ stateRoot });
    if ('exitCode' in started) return { ok: false, diff: `els server did not start: ${started.message}` };
    const socket = elsSocketPath(stateRoot);
    const apps: AppRun[] = [];
    const panes: string[] = [];
    const open = async (command: string[], cwd: string): Promise<string> => {
      const created = await requestEls(socket, { op: 'new', ws: 'OP', cwd, command });
      if (created.exitCode !== 0) throw new Error(`els new: ${created.message}`);
      const { pane } = JSON.parse(created.message) as { pane: string };
      panes.push(pane);
      return pane;
    };
    try {
      // ① eln next TUI: alternate screen + its own SGR mouse → the wheel is its mouse report and the chat log scrolls.
      const universe = seatTuiUniverse(ctx.universeRoot, 'DRW');
      const reply = Array.from({ length: 300 }, (_, i) => `HIST-LINE-${String(i).padStart(3, '0')}`).join('\n');
      const elnPane = await open(['/usr/bin/env', '-i', `PATH=${process.env.PATH ?? ''}`, 'LANG=en_US.UTF-8', 'TERM=xterm-256color',
        `HOME=${universe.home}`, `ELANOUS_STATE_DIR=${universe.root}`, 'ELANOUS_STATE_DIR_SOURCE=explicit', 'ELANOUS_SKIP_LOGIN_ENV=1',
        `XDG_CONFIG_HOME=${join(universe.root, '.config')}`, `XDG_DATA_HOME=${join(universe.root, '.local', 'share')}`, `XDG_CACHE_HOME=${join(universe.root, '.cache')}`,
        `ELANOUS_SESSION_ROOT=${join(universe.root, 'sessions')}`, 'ELANOUS_TEST_FAKE_LLM=1', 'ELANOUS_TEST_FAKE_LLM_AS_PROVIDER=1', 'ELANOUS_TUI_GOAL_CONTINUE=0',
        `ELANOUS_TEST_FAKE_LLM_RESPONSE=${reply}`,
        process.execPath, BIN, `--test=${universe.root}`, '--config-dir', universe.root, '--test-state-dir', universe.root, '--tui', 'next'], universe.root);
      const eln = await openApp(socket, elnPane, universe.root);
      apps.push(eln);
      await until(() => /Ctrl\+Q|idle/.test(eln.last()?.screen ?? ''), 60_000, 'eln boot');
      eln.app.key('DR14-ASK history probe'); await sleep(300); eln.app.key('\r');
      await until(() => (eln.last()?.screen ?? '').includes('HIST-LINE-299'), 60_000, 'eln reply on screen');
      await sleep(1_500);
      ok('eln: frame route is the pane\'s own SGR mouse report', eln.last()?.wheelRoute === 'mouse-sgr', eln.last()?.wheelRoute ?? 'absent');
      for (let i = 0; i < 10; i += 1) { eln.app.key(WHEEL_UP_AT_100_12); await sleep(80); }
      await until(() => !(eln.last()?.screen ?? '').includes('HIST-LINE-299'), 8_000, 'eln history scrolled').catch(() => {});
      const elnScreen = eln.last()?.screen ?? '';
      const elnShown = elnScreen.match(/HIST-LINE-\d{3}/g) ?? [];
      ctx.note('dr14-eln', { route: eln.last()?.wheelRoute ?? 'host', first: elnShown[0] ?? null, last: elnShown.at(-1) ?? null });
      ok('eln: newest line left the view after wheel-up (HIST-LINE-299 gone)', !elnScreen.includes('HIST-LINE-299'), elnShown.slice(-2));
      ok('eln: older history on screen after wheel-up', elnShown.length > 0, elnScreen.split('\n').slice(-6));
      ok('eln: els scrollback not used (back 0)', (eln.last()?.back ?? 0) === 0, eln.last()?.back);
      eln.app.key('\u0002q');                                      // ctrl+b q: the full-screen app lets go of the pane
      await Promise.race([eln.app.done, sleep(3_000)]);

      // ④ the single-pane view the CEO runs — `els side attach <pane>` (the tree's CLI) in a real terminal, over the same
      // eln pane. The view asks the terminal for SGR mouse reports and routes the wheel like the app; before, it enabled
      // no mouse at all, so the terminal sent no wheel and eln's history never moved (live 11-24 16:0x after #39972).
      let paneViewBottom = '';
      let paneViewScrolled = '';
      let wire = '';
      const view = await mockSeatPtySequence({
        executable: process.execPath,
        args: [BIN, '--test-state-dir', '{root}', 'side', 'attach', elnPane],
        root: stateRoot, rows: 40, cols: 120,
        onOutput: (chunk) => { wire += chunk; },
        ready: { label: 'attached', timeoutMs: 30_000, until: (screen) => screen.includes('ctrl+b q') && screen.includes('HIST-LINE-') },
        steps: [
          { label: 'End (live bottom)', keys: '\u001b[F', timeoutMs: 15_000, until: (screen) => { paneViewBottom = screen; return screen.includes('HIST-LINE-299'); } },
          // The terminal sends a wheel as an SGR report only when the view asked for mouse reports; otherwise (alternate
          // screen, no mouse mode) a terminal turns it into ↑ keys itself — which eln reads as composer keys, not a scroll.
          { label: 'wheel up ×10', enter: false, text: () => (wire.includes('\u001b[?1000h') ? '\u001b[<64;60;12M' : '\u001b[A\u001b[A\u001b[A').repeat(10), timeoutMs: 15_000,
            until: (screen) => { paneViewScrolled = screen; return !screen.includes('HIST-LINE-299') && /HIST-LINE-\d{3}/.test(screen); } },
        ],
        quitKeys: '\u0002q',
      }).catch((error: unknown) => { failures.push(`pane view: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`); return null; });
      const viewShown = paneViewScrolled.match(/HIST-LINE-\d{3}/g) ?? [];
      ctx.note('dr14-pane-view', { exit: view?.exitCode ?? null, first: viewShown[0] ?? null, last: viewShown.at(-1) ?? null });
      ok('pane view: asks the terminal for SGR mouse reports', wire.includes('\u001b[?1000h') && wire.includes('\u001b[?1006h'));
      ok('pane view: live bottom first (HIST-LINE-299 on screen)', paneViewBottom.includes('HIST-LINE-299'), paneViewBottom.split('\n').slice(-4));
      ok('pane view: wheel-up reached eln history (HIST-LINE-299 gone, older lines shown)', !paneViewScrolled.includes('HIST-LINE-299') && viewShown.length > 0, paneViewScrolled.split('\n').slice(-6));
      ok('pane view: no raw mouse bytes typed into eln', !/\[<64;/.test(paneViewScrolled), paneViewScrolled.split('\n').slice(-3));
      ok('pane view: ctrl+b q leaves with exit 0', view?.exitCode === 0, view?.exitCode);

      // ② alternate screen + DECSET 1007, no mouse reporting → the wheel becomes ↑ keys (the tty echoes them as ^[[A).
      const altPane = await open(['/bin/sh', '-c', "printf '\\033[?1049h\\033[?1007hALT-READY\\n'; stty -icanon echo echoctl; sleep 60"], ctx.universeRoot);
      const alt = await openApp(socket, altPane, ctx.universeRoot);
      apps.push(alt);
      await until(() => (alt.last()?.screen ?? '').includes('ALT-READY'), 15_000, 'alt pane ready');
      ok('alt: frame route is ↑/↓ (alternate scroll)', alt.last()?.wheelRoute === 'arrows', alt.last()?.wheelRoute ?? 'absent');
      alt.app.key(WHEEL_UP_AT_100_12);
      await until(() => (alt.last()?.screen ?? '').includes('^[[A^[[A^[[A'), 8_000, 'alt arrows echoed').catch(() => {});
      ok('alt: three ↑ reached the pane', (alt.last()?.screen ?? '').includes('^[[A^[[A^[[A'), (alt.last()?.screen ?? '').split('\n').slice(0, 3));

      // ③ a plain shell on the primary screen → the els scrollback scrolls (the pane gets nothing).
      const shPane = await open(['/bin/sh', '-c', 'i=1; while [ "$i" -le 300 ]; do printf "SH-LINE-%03d\\n" "$i"; i=$((i+1)); done; sleep 60'], ctx.universeRoot);
      const sh = await openApp(socket, shPane, ctx.universeRoot);
      apps.push(sh);
      await until(() => (sh.last()?.screen ?? '').includes('SH-LINE-300'), 15_000, 'shell output');
      ok('shell: frame route is the els scrollback (no route stamped)', sh.last()?.wheelRoute === undefined, sh.last()?.wheelRoute);
      for (let i = 0; i < 5; i += 1) { sh.app.key(WHEEL_UP_AT_100_12); await sleep(80); }
      await until(() => (sh.last()?.back ?? 0) > 0, 8_000, 'shell scrolled').catch(() => {});
      ok('shell: els scrollback moved (back > 0) and SH-LINE-300 left the view', (sh.last()?.back ?? 0) > 0 && !(sh.last()?.screen ?? '').includes('SH-LINE-300'), sh.last()?.back);
    } catch (error) {
      failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      for (const run of apps) { try { run.app.key('\u0002q'); } catch { /* already gone */ } }
      for (const pane of panes) { try { await requestEls(socket, { op: 'close', pane }); } catch { /* already gone */ } }
      await started.close();
      await rm(stateRoot, { recursive: true, force: true }).catch(() => {});
      for (const [name, value] of scrubbed) process.env[name] = value;
      if (shellWasMissing) delete process.env.SHELL;
    }
    return failures.length === 0 ? { ok: true } : { ok: false, diff: failures.join('\n') };
  },
};
