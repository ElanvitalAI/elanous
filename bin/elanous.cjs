#!/usr/bin/env node
'use strict';
// npm 설치 입구(R6) — `npm i -g elanous` 는 이 파일을 `elanous`·`eln` 으로 건다. Node 로 뜬다.
// Bun 을 찾으면 `bin/elanous.mjs`(실제 배포 엔트리)로 그대로 넘기고, 없으면 설치를 안내한다.
// ⛔ 한 줄 설치기(install.sh · install.ps1)는 이 파일을 거치지 않는다 — Bun 절대 경로로 `.mjs` 를 직접 부른다.

const { spawn, spawnSync } = require('node:child_process');
const { existsSync, readFileSync, readSync } = require('node:fs');
const { delimiter, join } = require('node:path');
const os = require('node:os');

const ROOT = join(__dirname, '..');
const ENTRY = join(__dirname, 'elanous.mjs');
const IS_WIN = process.platform === 'win32';
const BUN_EXE = IS_WIN ? 'bun.exe' : 'bun';
const INSTALL_UNIX = 'curl -fsSL https://bun.sh/install | bash';
const INSTALL_WIN = 'powershell -c "irm bun.sh/install.ps1 | iex"';

/** Bun 후보 — ELANOUS_BUN → PATH → BUN_INSTALL/~/.bun/bin → npm `bun` 패키지(있을 때만). 처음 실재하는 것. */
function findBun(env) {
  const candidates = [];
  if (env.ELANOUS_BUN) candidates.push(env.ELANOUS_BUN);
  for (const dir of String(env.PATH || env.Path || '').split(delimiter)) if (dir) candidates.push(join(dir, BUN_EXE));
  const home = env.HOME || env.USERPROFILE || os.homedir();
  candidates.push(join(env.BUN_INSTALL || join(home, '.bun'), 'bin', BUN_EXE));
  try { candidates.push(require.resolve('bun/bin/bun.exe')); } catch { /* npm `bun` 패키지는 의존에 넣지 않는다 — 있으면 쓸 뿐 */ }
  return candidates.find((p) => { try { return existsSync(p); } catch { return false; } }) || null;
}

/** Bun 없이도 `--version` 은 답한다 — 판은 package.json, 커밋은 팩에 구운 packed-revision.json(없으면 unknown). */
function packedVersion() {
  let version = 'unknown';
  let commit = 'unknown';
  try { version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || 'unknown'; } catch { /* 지어내지 않는다 */ }
  try { commit = JSON.parse(readFileSync(join(ROOT, 'src', 'version', 'packed-revision.json'), 'utf8')).commit || 'unknown'; } catch { /* 체크아웃이면 없다 */ }
  return `${version} ${commit}`;
}

function run(bun, args) {
  const child = spawn(bun, [ENTRY, ...args], { stdio: 'inherit' });
  // SIGINT 는 터미널이 프로세스 그룹 전체(자식 포함)에 보낸다 → 부모는 무시하고 자식(TUI)이 처리한다.
  // SIGTERM·SIGHUP·SIGQUIT 는 부모 «하나»에만 올 수 있다(kill <pid> · launchd · 크론) → 자식에게 넘긴다(TC 리뷰 #22241).
  try { process.on('SIGINT', () => {}); } catch { /* Windows */ }
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    try { process.on(sig, () => { try { child.kill(sig); } catch { /* 이미 끝났다 */ } }); } catch { /* Windows 일부 신호 */ }
  }
  child.on('error', (err) => {
    process.stderr.write(`elanous: Bun 을 실행하지 못했습니다 (${bun}): ${err.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) process.removeAllListeners(sig);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code == null ? 1 : code);
  });
}

function askYes(question) {
  process.stderr.write(question);
  const buf = Buffer.alloc(16);
  try {
    const n = readSync(0, buf, 0, buf.length, null);
    return /^\s*y/i.test(buf.toString('utf8', 0, n));
  } catch {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  let bun = findBun(process.env);
  if (bun) return run(bun, args);

  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
    process.stdout.write(`${packedVersion()}\n`);
    return process.exit(0);
  }

  const install = IS_WIN ? INSTALL_WIN : INSTALL_UNIX;
  process.stderr.write([
    'elanous needs Bun (>= 1.3.5), and Bun was not found. / elanous 는 Bun 위에서 돕니다 — Bun 을 찾지 못했습니다.',
    `  Install Bun: ${install}`,
    '  Then open a new shell and run elanous again. (Or set ELANOUS_BUN=<path to bun>.)',
    '',
  ].join('\n'));

  const interactive = process.stdin.isTTY && process.stderr.isTTY && !process.env.CI && !IS_WIN;
  if (!interactive) return process.exit(1);
  if (!askYes('Run the official Bun installer now? / 지금 공식 설치기를 실행할까요? [y/N] ')) return process.exit(1);

  const r = spawnSync('bash', ['-c', INSTALL_UNIX], { stdio: 'inherit' });
  if (r.status !== 0) {
    process.stderr.write('elanous: Bun 설치가 끝나지 않았습니다 — 위 안내대로 직접 설치해 주세요.\n');
    return process.exit(1);
  }
  bun = findBun(process.env);
  if (!bun) {
    process.stderr.write('elanous: Bun 을 설치했지만 찾지 못했습니다 — 새 셸에서 다시 실행해 주세요.\n');
    return process.exit(1);
  }
  return run(bun, args);
}

main();
