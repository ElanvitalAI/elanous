import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setDefaultTimeout, describe, expect, test } from 'bun:test';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repositoryRoot = process.cwd();
const entrypoint = [join(repositoryRoot, 'bin/elanous.mjs')];

function inIsolatedGitWorktree<T>(run: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), 'elanous-git-cli-cwd-'));
  const initialized = spawnSync('git', ['init', '-q'], { cwd });
  if (initialized.status !== 0) throw new Error(`test git init failed: ${initialized.stderr.toString()}`);
  try {
    return run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function isolatedCliEnvironment(home: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    ELANOUS_SUPPRESS_XDG_WARNING: '1',
    // Keep child stderr byte-exact for the git status-line contract.
    MSS_LOG_STORE_DIAGNOSTICS: '0',
  };
}

function invokeGit(args: string[], env?: NodeJS.ProcessEnv) {
  return inIsolatedGitWorktree((cwd) => {
    const home = mkdtempSync(join(tmpdir(), 'elanous-git-cli-home-'));
    try {
      return spawnSync('bun', [...entrypoint, '--test', 'git', ...args], {
        cwd,
        encoding: 'utf8',
        env: isolatedCliEnvironment(home, env),
        timeout: 60_000,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

function invokeFakeGit(stdout: string, stderr: string, status: number) {
  const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-cli-'));
  const gitPath = join(binDir, 'git');
  writeFileSync(gitPath, `#!/bin/sh\nprintf %s '${stdout}'\nprintf %s '${stderr}' >&2\nexit ${status}\n`);
  chmodSync(gitPath, 0o755);
  try {
    return invokeGit(['fixture'], { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` });
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

/** Spawn `elanous git fixture` against a fake git whose stdout/stderr are written
 *  from raw byte files, so the test can emit large payloads and invalid UTF-8
 *  bytes without any shell-quoting or encoding round-trip. */
function invokeFakeGitBytes(stdout: Buffer, stderr: Buffer, status: number) {
  const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-cli-bytes-'));
  const gitPath = join(binDir, 'git');
  const outPath = join(binDir, 'out.bin');
  const errPath = join(binDir, 'err.bin');
  writeFileSync(outPath, stdout);
  writeFileSync(errPath, stderr);
  writeFileSync(gitPath, `#!/bin/sh\ncat '${outPath}'\ncat '${errPath}' >&2\nexit ${status}\n`);
  chmodSync(gitPath, 0o755);
  try {
    return inIsolatedGitWorktree((cwd) => {
      const home = mkdtempSync(join(tmpdir(), 'elanous-git-cli-home-'));
      try {
        return spawnSync('bun', [...entrypoint, '--test', 'git', 'fixture'], {
          cwd,
          env: isolatedCliEnvironment(home, { PATH: `${binDir}:${process.env.PATH ?? ''}` }),
          timeout: 60_000,
          maxBuffer: Infinity,
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  } finally {
    rmSync(binDir, { recursive: true, force: true });
  }
}

describe('elanous git', () => {
  test('forwards successful git output and appends its success status', () => {
    const result = invokeGit(['status', '--porcelain']);
    expect(result.status).toBe(0);
    // ⛔⭐ 2026-08-09 계약 정정 — 상태 줄은 «stderr» 다. stdout 은 «원 바이트 그대로»여야 한다.
    //   초판은 stdout 에 붙였고 그래서 `$(elanous git rev-parse HEAD)` 가 «두 줄»을 돌려줬다(실측).
    expect(result.stderr.trimEnd().split(/\r?\n/).at(-1)).toBe('[git] status ok rc=0');
    expect(result.stdout).not.toContain('[git]');
  }, 90_000);

  test('prefixes top-level help with guidance while preserving git help and its status line', () => {
    const baseline = spawnSync('git', ['--help'], { encoding: 'utf8', timeout: 60_000 });
    const result = invokeGit(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(baseline.stdout);
    expect(result.stdout).toStartWith('usage: git');
    expect(result.stderr).toContain('Wraps git and automatically retries transient lock failures.');
    expect(result.stderr).toContain("Git's own help follows.");
    expect(result.stderr.trimEnd().split(/\r?\n/).at(-1)).toBe('[git] (none) ok rc=0');
  }, 90_000);

  test('does not show help guidance when help spellings are subcommand values or options', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-cli-help-arguments-'));
    const gitPath = join(binDir, 'git');
    writeFileSync(gitPath, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n');
    chmodSync(gitPath, 0o755);
    try {
      const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
      const invocations = [
        ['commit', '-m', '--help'],
        ['grep', '-h', 'needle'],
        ['clone', '--origin', '--help', 'repository'],
      ];
      for (const args of invocations) {
        const result = invokeGit(args, env);
        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('[elanous git]');
        expect(result.stdout).toBe(args.map((arg) => `<${arg}>\n`).join(''));
      }
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('passes option operands and following arguments to git in their original order', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-cli-argv-'));
    const gitPath = join(binDir, 'git');
    writeFileSync(gitPath, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n');
    chmodSync(gitPath, 0o755);
    try {
      const repository = join(binDir, 'repository operand');
      const result = invokeGit(['-C', repository, 'status'], {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('[git] status ok rc=0\n');
      // ⭐ stdout 은 «원 바이트 그대로» — argv 전달 확인이 상태 줄에 오염되지 않는다
      expect(result.stdout).toBe(`<-C>\n<${repository}>\n<status>\n`);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 90_000);

  test('forwards git failure and exits with git actual exit code', () => {
    const result = invokeGit(['no-such-subcommand']);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain(`[git] no-such-subcommand FAILED rc=${result.status}`);
  }, 90_000);

  test('keeps failure visible after stderr and stdout are piped to tail', () => {
    const result = inIsolatedGitWorktree((cwd) => spawnSync('bash', ['-lc', `bun ${entrypoint[0]} --test git no-such-subcommand 2>&1 | tail -1`], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
    }));
    expect(result.status).toBe(0);
    // ⭐⭐ 이 테스트가 이 명령의 «존재 이유»다 — `2>&1` 로 합쳐 파이프에 넣어도 실패가 «마지막 줄»에 남는다.
    //   ⛔ 2026-08-09 계약 정정 뒤에도 이 계약은 «그대로»다: 상태 줄이 stderr 로 갔지만
    //     `2>&1` 이 그것을 stdout 으로 합치므로 `tail -1` 이 여전히 그 줄을 준다.
    expect(result.stdout.trimEnd().split(/\r?\n/).at(-1)).toMatch(/^\[git\] no-such-subcommand FAILED rc=[1-9]\d*$/);
  }, 90_000);

  // ⭐⭐ 2026-08-19 — 「실패했다」와 「아무것도 안 바뀌었다」는 다른 값이다.
  //   실측: `elanous git merge origin/main` 이 충돌로 rc=1 을 냈는데 작업 트리엔 머지가 절반 들어가 있었다.
  //   상태 줄이 `FAILED rc=1` 뿐이면 읽는 사람이 「아무 일도 없었다」로 읽고 되돌려서 작업을 잃는다.
  //
  // ⛔⭐ 리뷰 must-fix: 판정은 «문면»이 아니라 «파일시스템 상태»(git 이 남기는 MERGE_HEAD 등)로 한다.
  //   그래서 이 테스트들은 가짜 git 이 아니라 ***진짜 충돌 저장소***를 만든다 —
  //   가짜 git 으로 문구만 흉내내면 초판의 «오탐»을 오히려 정당화하는 테스트가 된다.
  function inRealConflictRepo<T>(run: (cwd: string) => T): T {
    const cwd = mkdtempSync(join(tmpdir(), 'elanous-git-cli-conflict-'));
    // ⛔ 리뷰 should-fix: 준비 명령의 종료 코드를 «본다». 안 보면 git 환경 차이가
    //   「원인 불명 실패」로 나타나고, 그때 사람은 테스트가 아니라 «구현»을 의심한다.
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
      if (r.status !== 0) throw new Error(`test fixture git ${args.join(' ')} failed rc=${r.status}: ${r.stderr}`);
      return r;
    };
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'test');
      writeFileSync(join(cwd, 'a.txt'), 'base\n');
      git('add', 'a.txt'); git('commit', '-qm', 'base');
      git('checkout', '-qb', 'other');
      writeFileSync(join(cwd, 'a.txt'), 'other\n');
      git('commit', '-qam', 'other');
      git('checkout', '-q', 'main');
      writeFileSync(join(cwd, 'a.txt'), 'mine\n');
      git('commit', '-qam', 'mine');
      return run(cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  function runInRepo(cwd: string, args: string[]) {
    const home = mkdtempSync(join(tmpdir(), 'elanous-git-cli-home-'));
    try {
      return spawnSync('bun', [...entrypoint, '--test', 'git', ...args], {
        cwd, encoding: 'utf8', env: isolatedCliEnvironment(home), timeout: 60_000,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test('진짜 머지 충돌 — 트리에 상태가 «남았다»는 사실을 상태 줄이 말한다', () => {
    inRealConflictRepo((cwd) => {
      const result = runInRepo(cwd, ['merge', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] merge FAILED rc=${result.status} worktree-changed=yes reason=merge-conflict`);
      // ⛔ 「성공했다」고 쓰지 않는다 — 쓰는 것은 「트리가 바뀌었다」는 사실뿐이다.
      expect(result.stderr).not.toContain('merge ok rc=');
      // 📏 그리고 그 말이 «참»인지 확인한다 — git 이 실제로 MERGE_HEAD 를 남겼다.
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(true);
    });
  }, 120_000);

  test('⛔ 오탐 방지 — 출력에 그 «문구»가 있어도 상태가 안 남았으면 표지가 없다', () => {
    inRealConflictRepo((cwd) => {
      // 초판은 출력을 정규식으로 훑어서 이런 diff 를 충돌로 «오인»했다.
      writeFileSync(join(cwd, 'a.txt'), 'Automatic merge failed; fix conflicts and then commit the result.\n');
      const result = runInRepo(cwd, ['diff', '--exit-code']);
      expect(result.status).not.toBe(0); // diff 가 있으므로 실패로 나간다
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1)).toBe(`[git] diff FAILED rc=${result.status}`);
      expect(result.stderr).not.toContain('worktree-changed');
    });
  }, 120_000);

  test('⛔ 충돌 없이 실패한 merge 에는 표지가 안 붙는다', () => {
    inRealConflictRepo((cwd) => {
      const result = runInRepo(cwd, ['merge', 'no-such-branch']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain('worktree-changed');
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false);
    });
  }, 120_000);

  test('⛔ 이미 «중단된 머지»가 있는 상태에서 실패하면 표지를 안 붙인다 (stale marker 오탐)', () => {
    // ⭐ 리뷰 must-fix 2라운드: 「지금 마커가 있다」로는 부족하다.
    //   이미 MERGE_HEAD 가 있는 상태에서 새 merge 를 치면 git 은 「머지를 안 끝냈다」로 실패하는데,
    //   그 마커는 «원래» 있던 것이다 — 이번 명령은 아무것도 안 했다.
    inRealConflictRepo((cwd) => {
      const first = runInRepo(cwd, ['merge', 'other']);
      expect(first.stderr).toContain('worktree-changed=yes'); // 첫 번째는 «이번에» 남겼다
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(true);

      // 같은 상태에서 다시 친다 — git 은 실패하고, 마커는 «전에도» 있었다.
      const second = runInRepo(cwd, ['merge', 'other']);
      expect(second.status).not.toBe(0);
      expect(second.stderr).not.toContain('worktree-changed');
      expect(second.stderr.trimEnd().split(/\r?\n/).at(-1)).toBe(`[git] merge FAILED rc=${second.status}`);
    });
  }, 120_000);

  test('rebase 충돌도 «진짜»로 표지가 붙는다', () => {
    inRealConflictRepo((cwd) => {
      const result = runInRepo(cwd, ['rebase', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] rebase FAILED rc=${result.status} worktree-changed=yes reason=rebase-conflict`);
      // 📏 말이 «참»인지 확인 — git 이 실제로 rebase 상태를 남겼다.
      expect(existsSync(join(cwd, '.git', 'rebase-merge')) || existsSync(join(cwd, '.git', 'rebase-apply'))).toBe(true);
    });
  }, 120_000);

  test('cherry-pick 충돌도 «진짜»로 표지가 붙는다', () => {
    inRealConflictRepo((cwd) => {
      const result = runInRepo(cwd, ['cherry-pick', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] cherry-pick FAILED rc=${result.status} worktree-changed=yes reason=cherry-pick-conflict`);
      expect(existsSync(join(cwd, '.git', 'CHERRY_PICK_HEAD'))).toBe(true);
    });
  }, 120_000);

  test('⛔ "would be overwritten" 류 — git 이 «아무것도 안 하고» 멈춘 실패엔 표지가 없다', () => {
    inRealConflictRepo((cwd) => {
      // 커밋 안 한 로컬 변경을 두고 merge 하면 git 은 손대지 않고 거부한다.
      writeFileSync(join(cwd, 'a.txt'), 'uncommitted local edit\n');
      const result = runInRepo(cwd, ['merge', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain('worktree-changed');
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false);
    });
  }, 120_000);

  test('pull 충돌도 «진짜»로 표지가 붙는다 (내부적으로 merge 를 돌린다)', () => {
    inRealConflictRepo((cwd) => {
      // 자기 자신을 remote 로 삼아 other 를 당긴다 — pull 은 fetch ⊕ merge 이고 MERGE_HEAD 를 남긴다.
      const result = runInRepo(cwd, ['pull', '--no-rebase', '.', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] pull FAILED rc=${result.status} worktree-changed=yes reason=merge-conflict`);
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(true);
    });
  }, 120_000);

  test('⭐ `-C <dir>` 등 전역 옵션이 앞에 붙어도 하위 명령과 git-dir 을 옳게 찾는다', () => {
    // ⛔ 리뷰 4라운드가 「gitSubcommand 가 <dir> 을 subcommand 로 오인한다」고 지적했으나
    //   실측하면 옳게 동작한다(GLOBAL_OPTIONS_WITH_OPERANDS 가 피연산자를 건너뛴다).
    //   ⇒ 반론만 하지 않고 «회귀로 못 박는다» — 이 경로가 깨지면 표지가 조용히 사라진다.
    // ⚠️ 저장소 «밖»에서 돌리면 elanous 의 격리 관문이 먼저 막는다(별개 축) — 그래서 저장소 «안»에서
    //   전역 옵션만 앞에 붙여 «파서»를 잰다. 피연산자를 건너뛰는지가 이 테스트의 대상이다.
    inRealConflictRepo((cwd) => {
      const result = runInRepo(cwd, ['-c', 'user.name=probe', '-C', cwd, 'merge', 'other']);
      expect(result.status).not.toBe(0);
      // 하위 명령이 `merge` 로 잡혔다 — `-c` 의 값도 `-C` 의 디렉토리도 «아니다».
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] merge FAILED rc=${result.status} worktree-changed=yes reason=merge-conflict`);
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(true);
    });
  }, 120_000);

  test('⛔ 마커가 생겨도 «충돌이 아니면» conflict 라 쓰지 않는다 (rebase --exec false)', () => {
    // ⭐ 리뷰 must-fix 5라운드: 마커 생성 ≠ 충돌.
    //   `--exec false` 는 충돌 없이도 rebase 를 중단시켜 상태를 남긴다.
    //   그때 「conflict」라 쓰면 ***안 일어난 일을 적는 것***이다.
    inRealConflictRepo((cwd) => {
      const result = runInRepo(cwd, ['rebase', '--exec', 'false', 'HEAD~1']);
      expect(result.status).not.toBe(0);
      const last = result.stderr.trimEnd().split(/\r?\n/).at(-1);
      expect(last).toContain('worktree-changed=yes');
      // 상태는 남았지만 «충돌»은 아니다 — 그래서 in-progress 다.
      expect(last).toContain('reason=rebase-in-progress');
      expect(last).not.toContain('conflict');
    });
  }, 120_000);

  test('pull --rebase 충돌은 «rebase» 상태로 잡힌다 (MERGE_HEAD 만 보면 놓친다)', () => {
    // ⭐ 리뷰 must-fix 5라운드: pull.rebase 면 rebase 마커를 남긴다.
    inRealConflictRepo((cwd) => {
      const result = runInRepo(cwd, ['pull', '--rebase', '.', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] pull FAILED rc=${result.status} worktree-changed=yes reason=rebase-conflict`);
      expect(existsSync(join(cwd, '.git', 'MERGE_HEAD'))).toBe(false); // merge 가 아니다
    });
  }, 120_000);

  test('충돌 «경로가 많아도» conflict 로 잡힌다 (산출 길이에 안 기댄다)', () => {
    // ⭐ 경로 «목록»으로 물으면 대량 충돌에서 maxBuffer 를 넘겨 진짜 충돌이 in-progress 로
    //   거짓 표기된다. `--quiet` 은 산출을 아예 안 내므로 그 부류가 구조적으로 사라진다.
    // ⚠️ 정직하게: ***이 테스트는 1MiB 조건을 «재현하지 않는다».*** 60개로는 그만큼이 안 나온다.
    //   이 테스트가 고정하는 것은 「경로가 여럿일 때도 판정이 유지된다」뿐이고,
    //   버퍼 부류의 제거는 «구조»(산출 0바이트)가 보장한다.
    const cwd = mkdtempSync(join(tmpdir(), 'elanous-git-cli-many-'));
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
      if (r.status !== 0) throw new Error(`fixture git ${args.join(' ')} rc=${r.status}: ${r.stderr}`);
      return r;
    };
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'test');
      const names = Array.from({ length: 60 }, (_, i) => `f${i}.txt`);
      for (const n of names) writeFileSync(join(cwd, n), 'base\n');
      git('add', '.'); git('commit', '-qm', 'base');
      git('checkout', '-qb', 'other');
      for (const n of names) writeFileSync(join(cwd, n), 'other\n');
      git('commit', '-qam', 'other');
      git('checkout', '-q', 'main');
      for (const n of names) writeFileSync(join(cwd, n), 'mine\n');
      git('commit', '-qam', 'mine');

      const home = mkdtempSync(join(tmpdir(), 'elanous-git-cli-home-'));
      try {
        const result = spawnSync('bun', [...entrypoint, '--test', 'git', 'merge', 'other'], {
          cwd, encoding: 'utf8', env: isolatedCliEnvironment(home), timeout: 60_000,
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
          .toBe(`[git] merge FAILED rc=${result.status} worktree-changed=yes reason=merge-conflict`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);

  test('pull.rebase=true 설정 경로도 rebase 상태로 잡힌다', () => {
    // ⭐ 리뷰 should-fix: --rebase 플래그만이 아니라 «설정»으로도 같은 상태가 된다.
    inRealConflictRepo((cwd) => {
      const configured = spawnSync('git', ['config', 'pull.rebase', 'true'], { cwd, encoding: 'utf8', timeout: 60_000 });
      expect(configured.status).toBe(0); // fixture 준비 실패를 즉시 드러낸다
      const result = runInRepo(cwd, ['pull', '.', 'other']);
      expect(result.status).not.toBe(0);
      expect(result.stderr.trimEnd().split(/\r?\n/).at(-1))
        .toBe(`[git] pull FAILED rc=${result.status} worktree-changed=yes reason=rebase-conflict`);
    });
  }, 120_000);

  test('성공한 명령에는 어떤 경우에도 그 표지가 안 붙는다', () => {
    const result = invokeFakeGit('Automatic merge failed; fix conflicts and then commit the result.\n', '', 0);
    expect(result.status).toBe(0);
    expect(result.stderr.trimEnd().split(/\r?\n/).at(-1)).toBe('[git] fixture ok rc=0');
  }, 90_000);

  test('separates its status line after newline-free stdout and preserves the git exit code', () => {
    const result = invokeFakeGit('raw-stdout', '', 7);
    expect(result.status).toBe(7);
    // ⭐ 핵심 회귀: stdout 은 «원 바이트 그대로**(separator 도 안 붙는다)
    expect(result.stdout).toBe('raw-stdout');
    expect(result.stderr).toBe('[git] fixture FAILED rc=7\n');
  }, 90_000);

  test('separates its status line after newline-free stderr without rewriting that stream', () => {
    const result = invokeFakeGit('', 'raw-stderr', 9);
    expect(result.status).toBe(9);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('raw-stderr\n[git] fixture FAILED rc=9\n');
    expect(result.stderr.trimEnd().split(/\r?\n/).at(-1)).toBe('[git] fixture FAILED rc=9');
  }, 90_000);

  // ⛔⭐⭐⭐ 리뷰 must-fix(2026-08-03) — **이 조합이 없어서 결함이 가려져 있었다.**
  //    stdout 이 개행 없이 끝나고 stderr 가 개행으로 끝나면, 초판 로직(stderr 우선)은 separator 를
  //    건너뛰어 stdout 이 `raw-stdout[git] …` 로 붙었다. **stdout 만 파이프로 받는 소비자**에게는
  //    상태 줄이 독립된 마지막 줄이 아니게 된다 — 이 명령이 존재하는 계약 그 자체다.
  test('separates its status line when stdout lacks a newline but stderr ends with one', () => {
    const result = invokeFakeGit('raw-stdout', 'raw-stderr\n', 5);
    expect(result.status).toBe(5);
    expect(result.stderr).toBe('raw-stderr\n[git] fixture FAILED rc=5\n');
    // ⭐ stdout 만 파이프로 받는 소비자에게는 «순수 산출»만 간다 — 이것이 새 계약이다.
    expect(result.stdout).toBe('raw-stdout');
  }, 90_000);

  test('separates its status line after stdout ending in a lone CR', () => {
    const result = invokeFakeGit('raw-stdout\r', '', 7);
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('raw-stdout\r');
    expect(result.stderr).toBe('[git] fixture FAILED rc=7\n');
  }, 90_000);

  test('separates its status line after stderr ending in a lone CR', () => {
    const result = invokeFakeGit('', 'raw-stderr\r', 9);
    expect(result.status).toBe(9);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('raw-stderr\r\n[git] fixture FAILED rc=9\n');
  }, 90_000);

  test('does not add an extra separator after CRLF stdout', () => {
    const result = invokeFakeGit('raw-stdout\r\n', '', 7);
    expect(result.status).toBe(7);
    expect(result.stdout).toBe('raw-stdout\r\n');
    expect(result.stderr).toBe('[git] fixture FAILED rc=7\n');
  }, 90_000);

  test('does not add an extra separator after CRLF stderr', () => {
    const result = invokeFakeGit('', 'raw-stderr\r\n', 9);
    expect(result.status).toBe(9);
    expect(result.stderr).toBe('raw-stderr\r\n[git] fixture FAILED rc=9\n');
    expect(result.stdout).toBe('');
  }, 90_000);

  test('forwards stdout larger than the default 1MB spawn buffer without truncation', () => {
    // 3MB exceeds the historical default maxBuffer (1MB) that would ENOBUFS-truncate the output.
    const payload = Buffer.alloc(3 * 1024 * 1024, 0x61); // 'a'
    const result = invokeFakeGitBytes(payload, Buffer.alloc(0), 0);
    expect(result.status).toBe(0);
    const out = result.stdout as unknown as Buffer;
    // ⭐ stdout 은 «원 바이트 그대로» — 접미 한 글자도 안 붙는다(새 계약)
    expect(out.length).toBe(payload.length);
    expect(out.equals(payload)).toBe(true);
    expect(String(result.stderr)).toBe('[git] fixture ok rc=0\n');
  }, 90_000);

  test('passes invalid UTF-8 bytes through stdout and stderr unchanged', () => {
    // 0xff 0xfe 0x80 are not valid UTF-8; utf8 decoding would replace them with U+FFFD (ef bf bd).
    const rawOut = Buffer.from([0xff, 0xfe, 0x80, 0x72, 0x61, 0x77]);
    const rawErr = Buffer.from([0x80, 0xc0, 0xaf, 0x65, 0x72, 0x72]);
    const result = invokeFakeGitBytes(rawOut, rawErr, 3);
    expect(result.status).toBe(3);
    const out = result.stdout as unknown as Buffer;
    const err = result.stderr as unknown as Buffer;
    // stdout: ⭐ raw bytes «만» — 상태 줄도 separator 도 안 붙는다(새 계약).
    expect(out.equals(rawOut)).toBe(true);
    // stderr: raw bytes 를 그대로 보존한 «뒤» separator ⊕ 상태 줄이 붙는다.
    const errSuffix = Buffer.from('\n[git] fixture FAILED rc=3\n');
    expect(err.subarray(0, rawErr.length).equals(rawErr)).toBe(true);
    expect(err.subarray(rawErr.length).equals(errSuffix)).toBe(true);
    // Guard against the U+FFFD replacement byte sequence leaking into either stream.
    expect(out.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    expect(err.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  }, 90_000);

  test('records the wrapper numerator, exit code, duration, and lock retries without touching streams', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'elanous-git-cli-observation-'));
    const gitPath = join(binDir, 'git');
    const countPath = join(binDir, 'count');
    writeFileSync(gitPath, `#!/bin/sh\ncount=0; [ -f '${countPath}' ] && count=$(cat '${countPath}'); count=$((count + 1)); printf %s "$count" > '${countPath}'; if [ "$count" -eq 1 ]; then printf 'index.lock' >&2; exit 1; fi; printf raw-output; exit 0\n`);
    chmodSync(gitPath, 0o755);
    const script = `const root = process.env.REPOSITORY_ROOT; const { debug } = await import(root + '/src/debug/log.js'); const { runGitCli } = await import(root + '/src/git-fs/git-cli.js'); debug.setFileEnabled(false); debug.setVerboseEnabled(true); const records = []; const off = debug.registerSink({ name: 'git-cli-observation-capture', emit: (record) => records.push({ category: record.category, event: record.event, data: record.data }) }); runGitCli(['status', '--short']); off(); debug.setVerboseEnabled(false); process.stderr.write(JSON.stringify(records));`;
    try {
      const result = inIsolatedGitWorktree((cwd) => spawnSync('bun', ['-e', script], {
        cwd,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}`, REPOSITORY_ROOT: repositoryRoot },
        encoding: 'utf8',
        timeout: 60_000,
      }));
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('raw-output');
      const [status, recordsJson] = result.stderr.trimEnd().split('\n');
      expect(status).toBe('[git] status ok rc=0');
      const records = JSON.parse(recordsJson!) as Array<{ category: string; event: string; data?: Record<string, unknown> }>;
      const record = records.find(({ category, event }) => category === 'git.cli' && event === 'completed');
      expect(record?.data).toMatchObject({ subcommand: 'status', exitCode: 0, ok: true, lockRetryCount: 1, measurementScope: 'wrapper-numerator-only; raw shell git and PATH/hook denominator are out of scope' });
      expect(record?.data?.durationMs).toBeNumber();
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 90_000);
});
