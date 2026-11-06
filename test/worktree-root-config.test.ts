import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildUserConfig, configuredWorktreeRoot, setUserConfigOverlay } from '../src/user-config.js';
import { createWorktree, worktreeDirName, worktreeParentDir } from '../src/git-fs/worktree.js';

function configWith(worktreeRoot: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'elanous-worktree-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ tools: { selfImplement: { worktreeRoot } } }));
  try {
    return buildUserConfig(path).tools.selfImplement.worktreeRoot;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

describe('configured child worktree root', () => {
  test('defaults, rejects blank and non-string values, expands tilde, and preserves absolute roots', () => {
    const defaultRoot = join(homedir(), '.elanous', 'worktrees');
    expect(configWith(undefined)).toBe(defaultRoot);
    expect(configWith('')).toBe(defaultRoot);
    expect(configWith('  ')).toBe(defaultRoot);
    expect(configWith(42)).toBe(defaultRoot);
    expect(configWith('~/custom-worktrees')).toBe(join(homedir(), 'custom-worktrees'));
    expect(configWith('/absolute/worktrees')).toBe('/absolute/worktrees');
    expect(configWith('relative/worktrees')).toBe(defaultRoot);
  });

  test('parent derivation is pure and a created child lives below configured root/repository.worktrees/branch', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'elanous-worktree-root-'));
    const repo = join(tmp, 'repo');
    const root = join(tmp, 'configured-root');
    try {
      git(tmp, 'init', '-q', 'repo');
      git(repo, 'config', 'user.email', 'test@example.com');
      git(repo, 'config', 'user.name', 'test');
      writeFileSync(join(repo, 'file.txt'), 'base\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'base');

      // ⭐ 계약: `<뿌리>/<중간 폴더>/<저장소>.worktrees` — 중간 폴더가 «동명 저장소»를 가른다(5R ①).
      //    ⛔ `worktreeParentDir` 로 기대값을 만들면 자기참조라 아무것도 증명 못 하므로 «모양»을 직접 쓴다.
      const parent = worktreeParentDir(repo, root);
      expect(parent.startsWith(`${root}/`)).toBe(true);
      expect(basename(parent)).toBe(`${basename(repo)}.worktrees`);
      expect(parent.slice(root.length + 1).split('/').length).toBe(2);   // 중간 폴더 «한 겹»
      expect(existsSync(root)).toBe(false);
      expect(existsSync(parent)).toBe(false);

      const child = createWorktree({ repoRoot: repo, branch: 'child/root', worktreeRoot: root, base: 'HEAD' });
      expect(child.path).toBe(join(parent, worktreeDirName('child/root')));
      expect(existsSync(child.path)).toBe(true);
      expect(readdirSync(parent)).toContain(worktreeDirName('child/root'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ── 뿌리를 «내는 자리»가 하나임을 못박는다 (리뷰 2R must-fix ①②) ──────────────
//
// ⛔⭐⭐⭐ 2R 리뷰가 1R 의 소스 스캔을 이렇게 물었다:
//    ① `worktreeRoot: undefined` 나 잘못된 값도 통과하므로 Goodhart 테스트다
//    ② 별칭·래퍼·복합 인자 형태의 호출을 놓쳐 「누락 0」을 신뢰성 있게 보장 못 한다
//    ⇒ ***둘 다 맞다.*** 「인자를 «썼는가»」를 세는 검사는 「그 값이 «맞는가»」를 원리상 못 답한다.
//
// 🩹 그래서 검사를 고치는 대신 «구조»를 고쳤다 — `configuredWorktreeRoot()` 하나가 값을 낸다.
//    ⇒ 소비처는 넘길 «잘못된 값»을 만들 수 없고(표현식이 없다), 별칭·래퍼로 불러도 같은 값이다.
//    ⇒ 그리고 그 함수 «하나»를 런타임으로 검증하면 모든 소비처의 전달값이 같이 검증된다(아래 describe).
//
// ⛔⭐⭐⭐ 3R 리뷰가 그 소스 스캔을 «다시» Goodhart 로 판정했고 그것도 옳았다:
//    *"createWorktree/worktreeParentDir 가 «선택 인자»로 기존 sibling 배치를 허용하는 구조라
//      단일 producer 만 검증해도 소비처 누락이 «구조적으로» 방지되지 않는다"*
// 🩹 ⇒ 그래서 `worktreeRoot` 를 **필수 인자**로 바꿨다(worktree.ts). 누락은 이제 «컴파일 에러»다.
//    ⭐ 그리고 그 변경이 «즉시» 값을 냈다 — 내 정규식이 못 찾은 프로덕션 소비처
//    `agent-mission/driver.ts` 의 «별칭 호출»(createMissionWorktree)을 타입 검사가 찾아냈다.
//    ***리뷰가 경고한 「별칭·래퍼」가 실물로 있었다.***
// ⇒ 📌 그래서 소스 스캔 둘(`createWorktree` 누락 · `worktreeParentDir` 누락)은 «지웠다» —
//    타입이 그것을 더 강하게 판정하므로 남겨 두면 「약한 검사가 강한 검사를 가린다」.
//    아래 하나만 남긴다: 「값을 내는 자리가 둘로 갈라지지 않았나」(타입이 못 보는 축).
describe('the configured worktree root has exactly one producer (source-level)', () => {
  const repoRoot = join(import.meta.dir, '..');

  function rg(...args: string[]): string {
    const result = spawnSync('rg', args, { cwd: repoRoot, encoding: 'utf8' });
    // rg exit 1 = 매치 0 (정상). 2 이상이 진짜 오류다.
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`rg failed (status=${result.status}): ${result.stderr}`);
    }
    return result.stdout;
  }

  test('only user-config.ts reads tools.selfImplement.worktreeRoot directly', () => {
    // ⭐⭐ 이것이 2R 리뷰에 대한 «진짜» 답이다 — 값을 내는 표현식이 한 자리(`configuredWorktreeRoot`)에만
    //    있으면 소비처는 잘못된 값을 «만들 수 없다». 새 소비처가 표현식을 복사해 오면 여기서 걸린다.
    const lines = rg('-n', '--no-heading', '-g', 'src/**/*.ts', '-g', '!**/*.test.ts',
      String.raw`tools\.selfImplement\.worktreeRoot`, '-P')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      // 생산자 자신 ⊕ 설명 주석은 제외한다(주석은 계약을 «설명»하지 값을 «내지» 않는다).
      .filter((line) => !line.startsWith('src/user-config.ts:'))
      .filter((line) => !/^\S+:\d+:\s*(\/\/|\*|\/\*)/.test(line));
    expect(lines).toEqual([]);
  });

});

// ── ⭐ 런타임 검증 — 「값을 내는 그 함수」와 「그 값이 실제 배치에 쓰이는가」 (리뷰 2R·3R) ──
//
// ⛔ 한계를 갈라 적는다: 소비처가 그 함수를 «부르는지»는 이제 **타입**이 답하고(필수 인자),
//    값이 «맞는지»와 그 값이 «실제 배치»에 쓰이는지는 아래가 답한다.
describe('configuredWorktreeRoot() — runtime', () => {
  test('reads an explicit config path for an isolated simulation', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-wtroot-explicit-config-'));
    const configPath = join(root, 'config.json');
    const injected = join(root, 'isolated-worktrees');
    try {
      writeFileSync(configPath, JSON.stringify({ tools: { selfImplement: { worktreeRoot: injected } } }));
      expect(configuredWorktreeRoot(configPath)).toBe(injected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reflects the configured value and falls back to an absolute default', () => {
    const injected = mkdtempSync(join(tmpdir(), 'elanous-wtroot-runtime-'));
    try {
      setUserConfigOverlay((c) => ({
        ...c,
        tools: { ...c.tools, selfImplement: { ...c.tools.selfImplement, worktreeRoot: injected } },
      }));
      expect(configuredWorktreeRoot()).toBe(injected);
    } finally {
      setUserConfigOverlay(null);
      rmSync(injected, { recursive: true, force: true });
    }
    const restored = configuredWorktreeRoot();
    expect(typeof restored).toBe('string');
    expect(restored.length).toBeGreaterThan(0);
    expect(restored.startsWith('/')).toBe(true);
  });

  test('a created worktree actually lands under the configured root', () => {
    // ⭐ 「함수가 값을 낸다」와 「그 값이 실제 배치에 쓰인다」는 다른 주장이다 — 후자를 여기서 잰다.
    const injected = mkdtempSync(join(tmpdir(), 'elanous-wtroot-live-'));
    const repo = mkdtempSync(join(tmpdir(), 'elanous-wtroot-repo-'));
    try {
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'a.txt'), 'hi');
      git(repo, 'add', '.');
      git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
      const created = createWorktree({ repoRoot: repo, branch: 'feat/x', worktreeRoot: injected, base: 'HEAD' });
      // ⭐ 뿌리 아래에 있고 마지막 부모 마디가 `<저장소>.worktrees` 다(중간 폴더 한 겹은 5R ① 의 수리).
      expect(created.path.startsWith(`${injected}/`)).toBe(true);
      expect(created.path).toContain(`/${basename(repo)}.worktrees/`);
      expect(created.path.endsWith(worktreeDirName('feat/x'))).toBe(true);
      expect(existsSync(created.path)).toBe(true);
      // ⛔⭐ 옛 «형제» 배치에는 아무것도 안 생겼다 — ***옛 경로를 «문자 그대로» 쓴다.***
      //    종전 판은 `worktreeParentDir(repo, dirname(repo))` 를 썼는데 그것은 «새 규칙»(중간 폴더 포함)이라
      //    ***있지도 않았던 경로가 없는지를 검사하는 죽은 검사***였다(리뷰 7R must-fix ①).
      //    회귀로 옛 자리에 만들어져도 통과하면서 /tmp 잔존물까지 남는다.
      const legacySibling = join(dirname(repo), `${basename(repo)}.worktrees`);
      expect(existsSync(legacySibling)).toBe(false);
    } finally {
      rmSync(injected, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ── ⭐⭐⭐ 동명 저장소가 전역 뿌리를 «공유하지 않는다» (리뷰 5R must-fix ①②) ──
//
// 📏 이 기계 실측: /Users/…/source/{axon,elan,pilot,project,temp,test}/monad-agent
//    — ***여섯이 전부 같은 basename***. 형제 배치에선 부모 디렉터리가 갈랐지만 전역 뿌리로 모으면
//    한 경로를 공유하고, 정리가 «남의 저장소 worktree 를 지운다».
// ⛔ 5R 리뷰가 정확히 이것을 짚었고, ***현재 테스트가 basename 을 유일하게 만들어 그 회귀를 회피***한다고
//    지적했다 — 그것도 맞다. 그래서 이 검사는 **일부러 같은 basename** 을 쓴다.
describe('same-basename repositories do not share a worktree parent', () => {
  test('two repositories named alike under one root get different parents', () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-wtroot-collide-'));
    const a = mkdtempSync(join(tmpdir(), 'elanous-collide-a-'));
    const b = mkdtempSync(join(tmpdir(), 'elanous-collide-b-'));
    try {
      // ⭐ 두 저장소의 basename 을 «같게» 만든다 — 이것이 이 검사의 요점이다.
      const repoA = join(a, 'monad-agent');
      const repoB = join(b, 'monad-agent');
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });
      expect(basename(repoA)).toBe(basename(repoB));

      const parentA = worktreeParentDir(repoA, root);
      const parentB = worktreeParentDir(repoB, root);
      expect(parentA).not.toBe(parentB);
      // 둘 다 뿌리 아래에 있고, 마지막 마디는 «보존»된다(경로 문자열을 전제하는 소비처가 있다).
      expect(parentA.startsWith(root)).toBe(true);
      expect(parentB.startsWith(root)).toBe(true);
      expect(basename(parentA)).toBe('monad-agent.worktrees');
      expect(basename(parentB)).toBe('monad-agent.worktrees');
      // 결정론 — 같은 경로는 언제나 같은 자리로 간다.
      expect(worktreeParentDir(repoA, root)).toBe(parentA);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
