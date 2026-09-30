// ── elanous TUI Simulator (self-dogfood harness · 2026-07-19) ──
//
// drive-tui.ts 는 one-shot(부팅→프롬프트→대기→최종캡처→종료)라 실행 중 PTY 가 죽어
// mid-run 입력이 불가능하다. tui-sim 은 그 한계를 넘는 **상태유지·ID추적·인터랙티브**
// 시뮬레이터다:
//
//   • start  — elanous TUI 를 PTY 로 띄우고 **붙잡은 채** inbox 커맨드를 폴링(백그라운드 데몬).
//              ID 부여 → `.elanous-test/sim/<id>/` 에 meta·스냅샷·로그를 ID 로 추적.
//   • dump   — 실행 중 화면 텍스트+PNG 스냅샷(중간중간 덤프).  text — 보이는 그리드 텍스트만.
//   • transcript — 첫 시작~현재 전체 PTY 트랜스크립트(스크롤아웃 포함·h.snapshot()) → transcript.txt.
//              정지 시에도 자동 저장. renderScreen(보이는 그리드)이 놓치는 전문 회수(drive-tui --transcript 동형).
//   • send   — 질문 응답 등 텍스트 입력(+Enter, 멀티라인은 bracketed paste).  type — Enter 없이.
//   • key    — 특수키(enter/up/down/tab/esc/…) — 옵션 메뉴 네비게이션.
//   • mouse  — SGR 마우스 클릭(옵션 클릭 좌표).
//   • status/list/stop — 관측·정리.
//
// elanous 내부 PTY 시드(startPty/renderScreen/renderScreenPng — pty-shell/registry)를 재사용.
// 화면 녹화(video)는 후속 페이즈(별도).
//
// 클라↔데몬 프로토콜: 클라가 inbox/<seq>.json(atomic rename)을 떨구면 데몬이 폴링·실행 후
// out/<seq>.json + 스냅샷 파일을 쓴다. 파일 기반이라 관측 가능·경쟁 안전(temp+rename).
//
// 라이브 포워딩(기본 ON): start 시 휴먼 리더블 타임라인(goal·tool·reasoning·runaway)을
//   `/tmp/tui-sim-<id>.log` 로 **증분 append** → 다른 터미널에서 `tail -f` 로 실시간 관측.
//   경로는 시작 시 stderr 로 안내. `--forward <path>` 로 경로 override.
//
// 사용:
//   bun run scripts/tui-sim.ts start --id demo --test --worktree [--auto-dump 20]  # 백그라운드로
//   tail -f /tmp/tui-sim-demo.log                      # 라이브 휴먼 리더블 관측(기본 포워딩)
//   bun run scripts/tui-sim.ts dump demo intro        # 화면 텍스트+PNG 스냅샷
//   bun run scripts/tui-sim.ts send demo "추천대로 진행"  # 응답 입력
//   bun run scripts/tui-sim.ts key  demo down          # 옵션 아래로
//   bun run scripts/tui-sim.ts mouse demo 40 22        # 좌표 클릭
//   bun run scripts/tui-sim.ts promote demo --pr       # ⭐worktree diff → 브랜치(+push/PR) 등재(salvage)
//   bun run scripts/tui-sim.ts stop demo               # 종료(dirty worktree 는 보존·salvage 유도)
//   bun run scripts/tui-sim.ts clean demo|--all|--stale # teardown(worktree+세션+포워딩로그 제거)
//
// salvage/teardown(§2.5-4): stop 은 커밋 안 된 worktree 를 삭제하지 않는다(자율빌드 결과 유실 방지).
//   promote 로 브랜치/PR 등재 후 clean 으로 teardown. 코디네이터 폐루프의 deploy 스테이지를 온디맨드로.

import { startPty, ptyAvailable, type PtyHandle } from '../src/pty-shell/registry.js';
import { LogStore, type LogStoreRow } from '../src/mss/logging/log-store.js';
import { collectTimelineRows, renderTimeline, TIMELINE_CATEGORIES } from '../src/cli/logs-timeline.js';
import {
  writeFileSync, appendFileSync, readFileSync, mkdirSync, readdirSync, existsSync, unlinkSync, rmSync, renameSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { getCapturedEnv } from '../src/shell-env-bootstrap.js';
import { identityEnvKeys } from '../src/agent/identity-env.js';
import { resolveKeyBytes, resolveKeyInput, writeKeyInput } from './lib/tui-sim-keys.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[P_^X][^\x1B]*\x1B\\/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B[@-Z\\-_=>]/g, '');
}

// ── git / process helpers (promote · clean · stop-guard) ──
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
/** `git status --porcelain` for a worktree; '' when clean or on error. */
function gitPorcelain(wt: string): string {
  try { return execFileSync('git', ['status', '--porcelain'], { cwd: wt, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const repoRoot = process.cwd();
const simRoot = `${repoRoot}/.elanous-test/sim`;
const dir = (id: string) => `${simRoot}/${id}`;
const inboxDir = (id: string) => `${dir(id)}/inbox`;
const outDir = (id: string) => `${dir(id)}/out`;
const metaPath = (id: string) => `${dir(id)}/meta.json`;
const stopPath = (id: string) => `${dir(id)}/stop`;

interface Meta {
  id: string; pid: number; workdir: string; repoRoot: string;
  cols: number; rows: number; testMode: boolean; worktreeCreated: string | null;
  startedAt: number; ready: boolean; snapSeq: number; forwardPath: string;
}
function readMeta(id: string): Meta | null {
  try { return JSON.parse(readFileSync(metaPath(id), 'utf8')) as Meta; } catch { return null; }
}
function writeMeta(id: string, m: Meta): void {
  const tmp = `${metaPath(id)}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameSync(tmp, metaPath(id));
}

// ── optional child credential isolation ──
const CLEAN_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'COLORTERM', 'TZ', 'TMPDIR',
  'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_COLLATE', 'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY',
  'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
]);

/** Block everything except basic execution/locale variables after PTY env synthesis. */
export function cleanPtyUnsetEnv(captured: Record<string, string>, parent: NodeJS.ProcessEnv): string[] {
  return [...new Set([...Object.keys(captured), ...Object.keys(parent), ...identityEnvKeys()])]
    .filter((key) => !CLEAN_ENV_KEYS.has(key));
}

// ── client: drop a command into inbox, optionally await result ──
function argVal(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

async function sendCommand(
  id: string, verb: string, payload: Record<string, unknown>, wantResult: boolean, timeoutMs = 15000,
): Promise<Record<string, unknown> | null> {
  const meta = readMeta(id);
  if (!meta) { console.error(`[tui-sim] no session '${id}' (start it first)`); process.exit(1); }
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmp = `${inboxDir(id)}/.${name}`;
  writeFileSync(tmp, JSON.stringify({ verb, ...payload }));
  renameSync(tmp, `${inboxDir(id)}/${name}`);
  if (!wantResult) return null;
  const outFile = `${outDir(id)}/${name}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(outFile)) {
      const res = JSON.parse(readFileSync(outFile, 'utf8')) as Record<string, unknown>;
      try { unlinkSync(outFile); } catch { /* */ }
      return res;
    }
    await sleep(100);
  }
  console.error(`[tui-sim] command '${verb}' timed out`);
  return null;
}

// ── daemon (start) ──
async function runDaemon(args: string[]): Promise<void> {
  const id = argVal(args, '--id') ?? `sim-${Date.now()}`;
  const testMode = args.includes('--test');
  const autoWorktree = args.includes('--worktree');
  const explicitWorkdir = argVal(args, '--workdir');
  const home = argVal(args, '--home');
  const cleanEnv = args.includes('--clean-env');
  if (args.includes('--home') && (!home || home.startsWith('--'))) { console.error('[tui-sim] --home requires a directory'); process.exit(1); }
  const childHome = home ? resolve(home) : null;
  const cols = Number(argVal(args, '--cols')) || 220;
  const rows = Number(argVal(args, '--rows')) || 60;
  const bootSec = Number(argVal(args, '--boot')) || 8;
  const autoDumpSec = Number(argVal(args, '--auto-dump')) || 0;
  // 인스턴스별 격리 state-dir(멀티모델 벤치 하네스용) — 기본은 공유 `.elanous-test`.
  // tui-sim-bench 가 모델마다 별도 config+state 를 주려면 각기 다른 --state-dir 로 띄운다.
  const testDir = argVal(args, '--state-dir') ?? `${repoRoot}/.elanous-test`;
  // Live human-readable forward → /tmp (tail -f friendly). Default ON; override
  // path with `--forward <path>`. The drive IS a elanous — its readable story is
  // the logs.db timeline (elanous logs timeline · #4654), not the redraw byte
  // buffer. We append only NEW rows each tick so `tail -f` streams naturally.
  const forwardPath = argVal(args, '--forward') ?? `/tmp/tui-sim-${id}.log`;

  if (!ptyAvailable()) { console.error('[tui-sim] PTY unavailable'); process.exit(1); }

  // fresh session dir
  rmSync(dir(id), { recursive: true, force: true });
  mkdirSync(inboxDir(id), { recursive: true });
  mkdirSync(outDir(id), { recursive: true });

  let workdir = repoRoot;
  let worktreeCreated: string | null = null;
  if (explicitWorkdir) {
    workdir = explicitWorkdir.startsWith('/') ? explicitWorkdir : `${repoRoot}/${explicitWorkdir}`;
  } else if (autoWorktree) {
    workdir = `${testDir}/worktrees/sim-${id}-${Date.now()}`;
    execFileSync('git', ['worktree', 'add', '--detach', workdir, 'HEAD'], { cwd: repoRoot, stdio: 'inherit' });
    worktreeCreated = workdir;
  }
  const worktreeMode = workdir !== repoRoot;
  const binPath = worktreeMode ? `${repoRoot}/bin/elanous.mjs` : 'bin/elanous.mjs';
  const isoArgs = testMode ? ['--config-dir', testDir, '--test-state-dir', testDir] : [];

  // fresh forward file + up-front announce so the operator knows where to tail.
  writeFileSync(forwardPath,
    `# tui-sim live timeline · id=${id} · workdir=${workdir}\n`
    + `# human-readable: goal iterations · tool calls+results · reasoning · runaway signals\n`
    + `# follow live:  tail -f ${forwardPath}\n\n`);
  console.error(`[tui-sim] start id=${id} workdir=${workdir} test=${testMode}`);
  console.error(`[tui-sim] 📡 live timeline → ${forwardPath}   (follow:  tail -f ${forwardPath})`);
  if (childHome) mkdirSync(childHome, { recursive: true });
  const unsetEnv = cleanEnv ? cleanPtyUnsetEnv(getCapturedEnv(), process.env) : undefined;
  const h: PtyHandle = startPty({
    cmd: 'bun', args: [binPath, ...isoArgs], cols, rows, workdir,
    env: { ELANOUS_DRIVE_TUI: '1', ...(testMode ? { ELANOUS_STATE_DIR: testDir } : {}), ...(childHome ? { HOME: childHome } : {}) },
    ...(unsetEnv ? { unsetEnv } : {}),
  });

  const meta: Meta = {
    id, pid: process.pid, workdir, repoRoot, cols, rows, testMode,
    worktreeCreated, startedAt: Date.now(), ready: false, snapSeq: 0, forwardPath,
  };
  writeMeta(id, meta);

  // ── live incremental forward (append-only · tail -f) ──
  // Pull only rows NEW since the last tick (afterId cursor · monotonic row id)
  // and append their rendered timeline. Cross-tick turn headers may land in an
  // earlier batch — acceptable for a live feed; the full structured story stays
  // in timeline.txt (writeTimeline, on transcript/stop). Fail-soft: the forward
  // is a convenience and must never block or crash the drive.
  let forwardAfterId = 0;
  function flushForward(): void {
    try {
      const dbPath = `${testMode ? testDir : (process.env.ELANOUS_STATE_DIR ?? testDir)}/logs/logs.db`;
      if (!existsSync(dbPath)) return;
      const store = LogStore.openReadOnly(dbPath);
      try {
        const fresh: LogStoreRow[] = [];
        for (;;) {
          const page = store.query({
            sinceMs: meta.startedAt, categories: [...TIMELINE_CATEGORIES],
            afterId: forwardAfterId, limit: 1000,
          });
          if (page.length === 0) break;
          fresh.push(...page);
          forwardAfterId = page[page.length - 1]!.id;
          if (page.length < 1000) break;
        }
        const text = renderTimeline(fresh);
        if (text.trim()) appendFileSync(forwardPath, `${text}\n`);
      } finally { store.close(); }
    } catch { /* fail-soft — forward never blocks the drive */ }
  }

  // boot settle + stabilization
  await sleep(bootSec * 1000);
  let prev = '';
  for (let i = 0; i < 8; i++) {
    const cur = await h.renderScreen();
    if (cur === prev && cur.length > 50) break;
    prev = cur; await sleep(1000);
  }
  writeFileSync(`${dir(id)}/boot.txt`, stripAnsi(await h.renderScreen()));
  meta.ready = true; writeMeta(id, meta);
  flushForward();  // capture boot-phase events into the live feed
  console.error(`[tui-sim] id=${id} READY (boot.txt written). artifacts → ${dir(id)}`);
  console.error(`[tui-sim] 📡 follow live:  tail -f ${forwardPath}`);

  // Human-readable transcript — the drive IS a elanous; its story lives in
  // logs.db, not the full-screen PTY byte buffer (h.snapshot() collapses to a
  // few lines when the TUI redraws in place). Render the structured timeline
  // (goal iterations · tool calls+results · reasoning · runaway signals) from
  // the drive's own logs.db since this session's start. Fail-soft.
  function writeTimeline(): void {
    try {
      const dbPath = `${testMode ? testDir : (process.env.ELANOUS_STATE_DIR ?? testDir)}/logs/logs.db`;
      if (!existsSync(dbPath)) return;
      const store = LogStore.openReadOnly(dbPath);
      try {
        const rows = collectTimelineRows(store, { sinceMs: meta.startedAt });
        writeFileSync(`${dir(id)}/timeline.txt`, `${renderTimeline(rows)}\n`);
      } finally { store.close(); }
    } catch { /* fail-soft — timeline is a convenience, never blocks the drive */ }
  }

  async function snapshot(label: string): Promise<{ txt: string; files: string[] }> {
    meta.snapSeq += 1; writeMeta(id, meta);
    const seq = String(meta.snapSeq).padStart(3, '0');
    const base = `${dir(id)}/snap-${seq}${label ? `-${label}` : ''}`;
    const txt = stripAnsi(await h.renderScreen());
    writeFileSync(`${base}.txt`, txt);
    const files = [`${base}.txt`];
    try {
      const png = await h.renderScreenPng();
      if (png) { writeFileSync(`${base}.png`, png); files.push(`${base}.png`); }
    } catch { /* png best-effort */ }
    return { txt, files };
  }

  // bracketed paste for multiline; raw for single-line
  function feed(text: string, enter: boolean): void {
    if (text.includes('\n')) h.write(`\x1b[200~${text}\x1b[201~`);
    else h.write(text);
    if (enter) { h.write('\r'); }
  }

  let lastAuto = Date.now();
  let lastForward = 0;
  // ── inbox poll loop ──
  for (;;) {
    if (existsSync(stopPath(id))) break;
    // live forward — append new timeline rows (throttled ~1s) for tail -f
    if (Date.now() - lastForward >= 1000) { lastForward = Date.now(); flushForward(); }
    // auto text dump
    if (autoDumpSec > 0 && Date.now() - lastAuto >= autoDumpSec * 1000) {
      lastAuto = Date.now();
      try { await snapshot('auto'); } catch { /* */ }
    }
    let names: string[] = [];
    try { names = readdirSync(inboxDir(id)).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort(); }
    catch { names = []; }
    for (const name of names) {
      const p = `${inboxDir(id)}/${name}`;
      let cmd: Record<string, unknown>;
      try { cmd = JSON.parse(readFileSync(p, 'utf8')); } catch { try { unlinkSync(p); } catch { /* */ } continue; }
      let res: Record<string, unknown> = { ok: true };
      try {
        const verb = String(cmd.verb);
        if (verb === 'send' || verb === 'type') {
          const text = cmd.file ? readFileSync(String(cmd.file), 'utf8') : String(cmd.text ?? '');
          feed(text, verb === 'send');
          res = { ok: true, sent: text.length };
        } else if (verb === 'key') {
          const seq = resolveKeyInput(String(cmd.name));
          if (seq === null) { res = { ok: false, error: `unknown key '${cmd.name}'` }; }
          else { const n = Number(cmd.repeat) || 1; for (let i = 0; i < n; i++) writeKeyInput(h, seq); res = { ok: true }; }
        } else if (verb === 'mouse') {
          const x = Number(cmd.x), y = Number(cmd.y);
          const btn = cmd.button === 'right' ? 2 : cmd.button === 'middle' ? 1 : 0;
          if (cmd.button === 'move') { h.write(`\x1b[<${35};${x};${y}M`); }
          else { h.write(`\x1b[<${btn};${x};${y}M`); h.write(`\x1b[<${btn};${x};${y}m`); }
          res = { ok: true };
        } else if (verb === 'dump') {
          const snap = await snapshot(String(cmd.label ?? ''));
          res = { ok: true, text: snap.txt, files: snap.files };
        } else if (verb === 'text') {
          res = { ok: true, text: stripAnsi(await h.renderScreen()) };
        } else if (verb === 'transcript') {
          // 전체 PTY 버퍼(head+tail·스크롤아웃 포함) → ANSI strip 평문. renderScreen(보이는 그리드)이
          // 놓치는 첫 시작~현재 전문 회수(drive-tui --transcript 동형·h.snapshot()).
          const full = stripAnsi(h.snapshot());
          writeFileSync(`${dir(id)}/transcript.txt`, full);
          writeTimeline();  // readable narrative → timeline.txt (from logs.db)
          res = { ok: true, text: full, file: `${dir(id)}/transcript.txt`, timeline: `${dir(id)}/timeline.txt`, bytes: full.length };
        } else if (verb === 'resize') {
          h.resize(Number(cmd.cols) || cols, Number(cmd.rows) || rows); res = { ok: true };
        } else {
          res = { ok: false, error: `unknown verb '${verb}'` };
        }
      } catch (e) { res = { ok: false, error: (e as Error).message }; }
      // write result then remove inbox cmd
      const outTmp = `${outDir(id)}/.${name}`;
      writeFileSync(outTmp, JSON.stringify(res));
      renameSync(outTmp, `${outDir(id)}/${name}`);
      try { unlinkSync(p); } catch { /* */ }
    }
    await sleep(120);
  }

  // ── shutdown ──
  console.error(`[tui-sim] id=${id} stopping…`);
  try { flushForward(); } catch { /* */ }  // final tail of the live feed
  // 정지 시 전체 트랜스크립트(첫 시작~현재) 자동 저장 — 세션 폐기 전 풀로그 보존.
  try { writeFileSync(`${dir(id)}/transcript.txt`, stripAnsi(h.snapshot())); } catch { /* */ }
  try { writeTimeline(); } catch { /* */ }
  try { await snapshot('final'); } catch { /* */ }
  try { h.kill('SIGTERM'); } catch { /* */ }
  if (worktreeCreated) {
    // ⭐ dirty-worktree guard — never force-remove a worktree that still holds
    // uncommitted changes (a completed autonomous build lives here). Losing it
    // was the root cause of drive-result loss (iv7). Only auto-remove when
    // clean; otherwise KEEP + tell the operator to `promote` (→ branch/PR) or
    // `clean` (explicit discard). `git worktree remove` (no --force) also
    // refuses a dirty tree, so this is belt-and-suspenders.
    let dirty = true;
    try { dirty = gitPorcelain(worktreeCreated).length > 0; } catch { /* assume dirty → keep */ }
    if (dirty) {
      console.error(`[tui-sim] id=${id} ⚠️ worktree has uncommitted changes — KEPT (not removed):`);
      console.error(`[tui-sim]   ${worktreeCreated}`);
      console.error(`[tui-sim]   → salvage:  bun run scripts/tui-sim.ts promote ${id} --pr`);
      console.error(`[tui-sim]   → discard:  bun run scripts/tui-sim.ts clean ${id}`);
    } else {
      try { execFileSync('git', ['worktree', 'remove', '--force', worktreeCreated], { cwd: repoRoot, stdio: 'ignore' }); }
      catch { /* */ }
    }
  }
  console.error(`[tui-sim] id=${id} stopped. artifacts kept → ${dir(id)}`);
  process.exit(0);
}

// ── client verbs ──
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const rest = argv.slice(1);

  if (verb === '--help' || verb === 'help') {
    console.log(`usage: tui-sim <verb> [args]
  start [--id id] [--test] [--worktree] [--workdir dir] [--cols n] [--rows n]
  start --home <dir>       Set the child TUI HOME (default: inherited).
  start --clean-env        Allow only basic execution/locale env into the child (default: off).
  send|type <id> <text>    Send text with|without Enter.
  key <id> <name> [--repeat n]  Send a named key; unknown keys exit 1.
  key names: enter/return/tab/shift-tab/esc/escape/space/backspace/delete/up/down/right/left/pageup/pagedown/home/end.
  key ctrl-<a..z>         Send control byte (ctrl-j sends newline).
  key ctrl-\\ | ctrl-]    Send 0x1c | 0x1d.
  key alt-<key>           Send ESC followed by the named key or one character.
  key shift-enter         Send ESC [ 13 ; 2 u.
  key hex:<bytes>         Send raw hex bytes (e.g. hex:1b5b41).
  resize <id> <cols> <rows>  Resize the running PTY.
  mouse|dump|text|transcript|status|list|stop|promote|clean`);
    return;
  }
  if (verb === 'start') { await runDaemon(rest); return; }

  if (verb === 'list') {
    if (!existsSync(simRoot)) { console.log('(no sim sessions)'); return; }
    for (const id of readdirSync(simRoot)) {
      const m = readMeta(id);
      const alive = m ? existsSync(stopPath(id)) === false : false;
      console.log(`${id}\t${m ? (m.ready ? 'ready' : 'booting') : 'unknown'}\t${alive ? 'active' : 'stopped?'}\tsnaps=${m?.snapSeq ?? 0}\t${m?.workdir ?? ''}`);
    }
    return;
  }

  const id = rest[0];
  if (!id) { console.error(`usage: tui-sim ${verb} <id> …`); process.exit(1); }

  switch (verb) {
    case 'send': case 'type': {
      const file = argVal(rest, '--file');
      const text = file ? '' : rest.slice(1).filter((a) => !a.startsWith('--')).join(' ');
      const res = await sendCommand(id, verb, file ? { file } : { text }, true);
      console.log(res?.ok ? `✓ ${verb} (${res.sent ?? 0} chars)` : `✗ ${res?.error ?? 'failed'}`);
      break;
    }
    case 'key': {
      const name = rest[1];
      if (!name || resolveKeyBytes(name) === null) { console.error(`알 수 없는 키 '${name}'`); process.exit(1); }
      const repeat = argVal(rest, '--repeat');
      const res = await sendCommand(id, 'key', { name, ...(repeat ? { repeat: Number(repeat) } : {}) }, true);
      console.log(res?.ok ? `✓ key ${name}` : `✗ ${res?.error}`);
      if (!res?.ok) process.exitCode = 1;
      break;
    }
    case 'resize': {
      const cols = Number(rest[1]), rows = Number(rest[2]);
      if (!Number.isSafeInteger(cols) || cols < 2 || !Number.isSafeInteger(rows) || rows < 2) {
        console.error('usage: tui-sim resize <id> <cols> <rows> (positive integers >= 2)');
        process.exit(1);
      }
      const res = await sendCommand(id, 'resize', { cols, rows }, true);
      console.log(res?.ok ? `✓ resize ${cols}x${rows}` : `✗ ${res?.error ?? 'failed'}`);
      if (!res?.ok) process.exitCode = 1;
      break;
    }
    case 'mouse': {
      const x = rest[1], y = rest[2];
      const button = argVal(rest, '--button') ?? (rest.includes('--move') ? 'move' : 'left');
      const res = await sendCommand(id, 'mouse', { x, y, button }, true);
      console.log(res?.ok ? `✓ mouse ${button} @${x},${y}` : `✗ ${res?.error}`);
      break;
    }
    case 'dump': {
      const label = rest[1] && !rest[1].startsWith('--') ? rest[1] : '';
      const res = await sendCommand(id, 'dump', { label }, true, 20000);
      if (res?.ok) { console.log(res.text); console.error(`[tui-sim] files: ${(res.files as string[]).join(' ')}`); }
      else console.log(`✗ ${res?.error ?? 'failed'}`);
      break;
    }
    case 'text': {
      const res = await sendCommand(id, 'text', {}, true, 20000);
      console.log(res?.ok ? res.text : `✗ ${res?.error}`);
      break;
    }
    case 'transcript': {
      // 첫 시작~현재 전체 PTY 트랜스크립트(스크롤아웃 포함) → stdout + transcript.txt 저장.
      const res = await sendCommand(id, 'transcript', {}, true, 30000);
      if (res?.ok) { console.log(res.text); console.error(`[tui-sim] full transcript → ${res.file} (${res.bytes}B)`); }
      else console.log(`✗ ${res?.error ?? 'failed'}`);
      break;
    }
    case 'status': {
      const m = readMeta(id);
      if (!m) { console.log(`no session '${id}'`); break; }
      console.log(JSON.stringify({ ...m, active: !existsSync(stopPath(id)) }, null, 2));
      break;
    }
    case 'stop': {
      writeFileSync(stopPath(id), String(Date.now()));
      console.log(`✓ stop signal sent to '${id}' (daemon snapshots + keeps a dirty worktree; promote/clean it)`);
      break;
    }
    case 'promote': {
      // ⭐ Salvage a drive's worktree diff → branch (+ optional push / PR). The
      // "register up to PR" stage as an on-demand option — the coordinator
      // closed-loop (planner→builder→verifier→deployer) reuses this as its
      // deploy step. Worktree is left intact (run `clean` to tear down).
      const m = readMeta(id);
      if (!m) { console.log(`✗ no session '${id}'`); break; }
      if (!m.worktreeCreated) { console.log(`✗ '${id}' ran in-place (no worktree) — nothing to promote`); break; }
      const wt = m.workdir;
      const changes = gitPorcelain(wt);
      if (!changes) { console.log(`✗ '${id}' worktree is clean — nothing to promote`); break; }
      const branch = argVal(rest, '--branch') ?? `drive/${id}-${m.startedAt}`;
      const message = argVal(rest, '--message') ?? `feat(drive/${id}): 자율빌드 산출물 salvage`;
      const wantPr = rest.includes('--pr');
      const wantPush = wantPr || rest.includes('--push');
      const rebase = !rest.includes('--no-rebase');
      const nChanges = changes.split('\n').length;
      try {
        const base = git(wt, ['rev-parse', 'HEAD']);  // worktree's (detached) base
        git(wt, ['checkout', '-B', branch]);
        git(wt, ['add', '-A']);
        git(wt, ['commit', '-m', `${message}\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`]);
        console.log(`✓ committed ${nChanges} change(s) → ${branch}`);
        if (rebase) {
          // Replay the drive's delta onto the freshest main so the PR is clean
          // regardless of the worktree's base (drives often branch off a feature
          // branch, not main). Conflict → abort + keep on original base.
          try {
            git(wt, ['fetch', 'origin', 'main']);
            git(wt, ['rebase', '--onto', 'origin/main', base, branch]);
            console.log('✓ rebased onto origin/main (clean PR base)');
          } catch {
            try { git(wt, ['rebase', '--abort']); } catch { /* */ }
            console.log(`⚠ rebase onto main conflicted — kept on original base ${base.slice(0, 9)} (resolve manually or --no-rebase)`);
          }
        }
        if (wantPush) { git(wt, ['push', '-u', 'origin', branch]); console.log(`✓ pushed origin/${branch}`); }
        if (wantPr) {
          const title = argVal(rest, '--title') ?? message.split('\n')[0];
          const body = `자율빌드 산출물 salvage (tui-sim drive \`${id}\`).\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
          const url = execFileSync('gh', ['pr', 'create', '--head', branch, '--base', 'main', '--title', title, '--body', body], { cwd: wt, encoding: 'utf8' }).trim();
          console.log(`✓ PR: ${url.split('\n').pop()}`);
        }
        console.log(`[tui-sim] worktree kept (${wt}). teardown:  bun run scripts/tui-sim.ts clean ${id}`);
      } catch (e) { console.log(`✗ promote failed: ${(e as Error).message}`); }
      break;
    }
    case 'clean': {
      // Teardown infra — stop daemon (graceful), remove worktree + session dir +
      // /tmp forward log. Scopes: <id> · --all · --stale (dead sessions only).
      const all = rest.includes('--all');
      const stale = rest.includes('--stale');
      if (!all && !stale && id.startsWith('--')) { console.error('usage: tui-sim clean <id> | --all | --stale'); process.exit(1); }
      const ids = (all || stale) ? (existsSync(simRoot) ? readdirSync(simRoot) : []) : [id];
      for (const sid of ids) {
        const m = readMeta(sid);
        const alive = m ? (!existsSync(stopPath(sid)) && pidAlive(m.pid)) : false;
        if (stale && alive) continue;
        if (alive) {
          writeFileSync(stopPath(sid), String(Date.now()));
          for (let i = 0; i < 60 && pidAlive(m!.pid); i++) await sleep(200);  // ≤12s graceful
        }
        if (m?.worktreeCreated) {
          try { git(m.repoRoot, ['worktree', 'remove', '--force', m.worktreeCreated]); } catch { /* */ }
        }
        try { rmSync(dir(sid), { recursive: true, force: true }); } catch { /* */ }
        if (m?.forwardPath) { try { unlinkSync(m.forwardPath); } catch { /* */ } }
        console.log(`✓ cleaned '${sid}'${m?.worktreeCreated ? ' (worktree + session + forward log)' : ' (session + forward log)'}`);
      }
      break;
    }
    default:
      console.error(`unknown verb '${verb}'. verbs: start|send|type|key|resize|mouse|dump|text|transcript|status|list|promote|clean|stop`);
      process.exit(1);
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
