import { describe, expect, test } from 'bun:test';
import { accessSync, chmodSync, constants as fsConstants, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  INSTALLED_PLUGINS_FILENAME,
  KNOWN_MARKETPLACES_FILENAME,
  readClaudePackageLedger,
} from './plugins/adapters/claude-package.js';
import { buildSkillIndex } from './skills/index.js';
import {
  __claudePackageSkillDirsLedgerReadCountForTests,
  __resetClaudePackageSkillDirsCacheForTests,
  buildUserConfig,
  bundledSkillsDir,
  defaultSkillDirs as realDefaultSkillDirs,
  resetUserConfig,
  skillSetDir,
  type UserConfig,
} from './user-config.js';

// The shared ~/.agents/skills root exists on many real machines (codex·openclaw·hermes); these tests pin the
// list without it unless a test passes its own `sharedAgentHome`, so they read the same on every host.
const EMPTY_SHARED_HOME = mkdtempSync(join(tmpdir(), 'no-shared-agent-skills-'));
const defaultSkillDirs: typeof realDefaultSkillDirs = (cfg, opts) => realDefaultSkillDirs(cfg, { sharedAgentHome: EMPTY_SHARED_HOME, ...opts });

// defaultSkillDirs 는 cfg.skills.{activeSet,dirs,includeClaudePackageSkills} 만 읽으므로 부분 config 로 검증(나머지 필드 무관).
function cfgWith(skills: Partial<UserConfig['skills']>): UserConfig {
  return { skills: { activeSet: 'claudecode', dirs: [], allow: [], deny: [], ...skills } } as unknown as UserConfig;
}

function writeLedger(root: string, installed: unknown, marketplaces: unknown): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, INSTALLED_PLUGINS_FILENAME), JSON.stringify(installed));
  writeFileSync(join(root, KNOWN_MARKETPLACES_FILENAME), JSON.stringify(marketplaces));
}

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'claude-package-skill-dirs-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function emptyMarketplaces(): Record<string, unknown> {
  return {};
}

/** Live machine ledger. Isolated gate HOME has no ~/.claude/plugins — skip then. */
function liveAntvSkillsDir(): string | null {
  const ledger = readClaudePackageLedger();
  if (ledger.status !== 'ok') return null;
  const antv = ledger.packages.find((pkg) => pkg.name === 'antv-infographic-skills@antv-infographic');
  if (!antv?.installPath) return null;
  const skillsDir = join(antv.installPath, 'skills');
  try {
    if (!statSync(skillsDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return skillsDir;
}

const liveAntv = liveAntvSkillsDir();
const liveTest = liveAntv ? test : test.skip;

describe('defaultSkillDirs — G9 P5a user-config 존중(skills.activeSet/dirs)', () => {
  const bundled = bundledSkillsDir();

  test('기본 activeSet=claudecode → ~/.claude/skills 뒤 bundled skills/', () => {
    expect(defaultSkillDirs(cfgWith({ activeSet: 'claudecode' }))).toEqual([skillSetDir('claudecode')!, bundled]);
  });

  test('preset activeSet=codex → ~/.codex/skills 뒤 bundled skills/', () => {
    expect(defaultSkillDirs(cfgWith({ activeSet: 'codex' }))).toEqual([skillSetDir('codex')!, bundled]);
  });

  test('preset activeSet=opencode → ~/.config/opencode/skills 뒤 bundled skills/', () => {
    expect(defaultSkillDirs(cfgWith({ activeSet: 'opencode' }))).toEqual([skillSetDir('opencode')!, bundled]);
  });

  test('custom + dirs → 명시 dirs 순서를 보존하고 bundled skills/ 를 맨 뒤에 붙인다', () => {
    expect(defaultSkillDirs(cfgWith({ activeSet: 'custom', dirs: ['/a/skills', '/b/skills'] }))).toEqual(['/a/skills', '/b/skills', bundled]);
  });

  test('custom + dirs 비면 → ~/.claude/skills fallback 뒤 bundled skills/', () => {
    expect(defaultSkillDirs(cfgWith({ activeSet: 'custom', dirs: [] }))).toEqual([skillSetDir('claudecode')!, bundled]);
  });
});

describe('defaultSkillDirs — shared agent skills', () => {
  test('missing shared root preserves preset/custom and bundled directory order', () => {
    withTempRoot((home) => {
      const opts = { sharedAgentHome: home, bundledSkillsRoot: home };
      expect(defaultSkillDirs(cfgWith({ activeSet: 'codex' }), opts)).toEqual([skillSetDir('codex')!]);
      expect(defaultSkillDirs(cfgWith({ activeSet: 'custom', dirs: ['/a', '/b'] }), opts)).toEqual(['/a', '/b']);
    });
  });

  test('existing shared root follows custom dirs and precedes package and bundled skills', () => {
    withTempRoot((home) => {
      const shared = join(home, '.agents', 'skills');
      const pkg = join(home, 'pkg');
      mkdirSync(shared, { recursive: true });
      mkdirSync(join(pkg, 'skills'), { recursive: true });
      mkdirSync(bundledSkillsDir(home));
      writeLedger(home, { version: 2, plugins: {
        'alpha@market': [{ scope: 'user', installPath: pkg, version: '1' }],
      } }, emptyMarketplaces());
      const opts = { sharedAgentHome: home, pluginsRoot: home, bundledSkillsRoot: home };
      expect(defaultSkillDirs(cfgWith({ activeSet: 'custom', dirs: ['/first'], includeClaudePackageSkills: true }), opts))
        .toEqual(['/first', shared, join(pkg, 'skills'), bundledSkillsDir(home)]);
      expect(defaultSkillDirs(cfgWith({ activeSet: 'custom', dirs: [shared] }), opts)).toEqual([shared, bundledSkillsDir(home)]);
      expect(defaultSkillDirs(cfgWith({ activeSet: 'custom', dirs: ['/first'], includeSharedAgentSkills: false }), opts))
        .toEqual(['/first', bundledSkillsDir(home)]);
      const before = readdirSync(shared);
      defaultSkillDirs(cfgWith({}), opts);
      expect(readdirSync(shared)).toEqual(before);
    });
  });

  test('config parsing retains explicit false through config load; omission defaults true', () => {
    withTempRoot((root) => {
      const path = join(root, 'config.json');
      writeFileSync(path, JSON.stringify({ skills: { includeSharedAgentSkills: false } }));
      expect(buildUserConfig(path).skills.includeSharedAgentSkills).toBe(false);
      writeFileSync(path, JSON.stringify({ skills: {} }));
      expect(buildUserConfig(path).skills.includeSharedAgentSkills).toBe(true);
      writeFileSync(path, JSON.stringify({ skills: { includeSharedAgentSkills: true } }));
      expect(buildUserConfig(path).skills.includeSharedAgentSkills).toBe(true);
    });
  });
});

describe('defaultSkillDirs — bundled package skills', () => {
  test('새 설치에서 사용자 경로가 없어도 실재하는 bundled skills/ 를 더한다', () => {
    withTempRoot((root) => {
      const bundled = bundledSkillsDir(root);
      mkdirSync(bundled, { recursive: true });
      expect(defaultSkillDirs(cfgWith({
        activeSet: 'custom',
        dirs: ['/missing/user-skills'],
      }), { bundledSkillsRoot: root })).toEqual(['/missing/user-skills', bundled]);
    });
  });

  test('사용자 경로를 먼저 보존하고 bundled skills/ 를 맨 뒤에 붙인다', () => {
    withTempRoot((root) => {
      const bundled = bundledSkillsDir(root);
      mkdirSync(bundled, { recursive: true });
      expect(defaultSkillDirs(cfgWith({
        activeSet: 'custom',
        dirs: ['/user/first', '/user/second'],
      }), { bundledSkillsRoot: root })).toEqual(['/user/first', '/user/second', bundled]);
    });
  });

  test('사용자 경로가 bundled skills/ 와 같으면 중복해서 넣지 않는다', () => {
    withTempRoot((root) => {
      const bundled = bundledSkillsDir(root);
      mkdirSync(bundled, { recursive: true });
      const dirs = defaultSkillDirs(cfgWith({
        activeSet: 'custom',
        dirs: [bundled],
      }), { bundledSkillsRoot: root });
      expect(dirs).toEqual([bundled]);
      expect(dirs.filter((dir) => dir === bundled)).toHaveLength(1);
    });
  });

  test('bundled skills/ 가 없으면 추가하지 않는다', () => {
    withTempRoot((root) => {
      const bundled = bundledSkillsDir(root);
      const dirs = defaultSkillDirs(cfgWith({
        activeSet: 'custom',
        dirs: ['/user/skills'],
      }), { bundledSkillsRoot: root });
      expect(dirs).toEqual(['/user/skills']);
      expect(dirs).not.toContain(bundled);
    });
  });

  test('설정 파싱 실패에서도 fallback 뒤에 실재하는 bundled skills/ 를 더한다', () => {
    withTempRoot((root) => {
      const savedXdg = process.env.XDG_CONFIG_HOME;
      const bundled = bundledSkillsDir(root);
      try {
        mkdirSync(bundled, { recursive: true });
        mkdirSync(join(root, 'elanous'), { recursive: true });
        writeFileSync(join(root, 'elanous', 'config.json'), '{not-json');
        process.env.XDG_CONFIG_HOME = root;
        resetUserConfig();

        expect(defaultSkillDirs(undefined, { bundledSkillsRoot: root })).toEqual([
          skillSetDir('claudecode')!,
          bundled,
        ]);
      } finally {
        if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = savedXdg;
        resetUserConfig();
      }
    });
  });
});

describe('defaultSkillDirs — includeClaudePackageSkills opt-in', () => {
  test('opt-out (설정 없음) → 이전과 완전히 같은 목록', () => {
    withTempRoot((root) => {
      const install = join(root, 'pkg');
      mkdirSync(join(install, 'skills'), { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: {
          'alpha@market': [{ scope: 'user', installPath: install, version: '1' }],
        },
      }, emptyMarketplaces());
      const cfg = cfgWith({ activeSet: 'custom', dirs: ['/a/skills'] });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual(['/a/skills']);
    });
  });

  test('opt-out (false) → 이전과 완전히 같은 목록', () => {
    withTempRoot((root) => {
      const install = join(root, 'pkg');
      mkdirSync(join(install, 'skills'), { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: {
          'alpha@market': [{ scope: 'user', installPath: install, version: '1' }],
        },
      }, emptyMarketplaces());
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: ['/a/skills'],
        includeClaudePackageSkills: false,
      });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual(['/a/skills']);
    });
  });

  test('opt-in → 사용자 경로 뒤에 실재하는 package skills/ 가 더해진다', () => {
    withTempRoot((root) => {
      const install = join(root, 'pkg');
      const skillsDir = join(install, 'skills');
      mkdirSync(skillsDir, { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: {
          'alpha@market': [{ scope: 'user', installPath: install, version: '1' }],
        },
      }, emptyMarketplaces());
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: ['/a/skills'],
        includeClaudePackageSkills: true,
      });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual(['/a/skills', skillsDir]);
    });
  });

  test('사용자 지정 경로가 먼저 오고 package 경로가 뒤에 온다', () => {
    withTempRoot((root) => {
      const a = join(root, 'pkg-a');
      const b = join(root, 'pkg-b');
      mkdirSync(join(a, 'skills'), { recursive: true });
      mkdirSync(join(b, 'skills'), { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: {
          'a@m': [{ scope: 'user', installPath: a, version: '1' }],
          'b@m': [{ scope: 'user', installPath: b, version: '1' }],
        },
      }, emptyMarketplaces());
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: ['/user/first', '/user/second'],
        includeClaudePackageSkills: true,
      });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual([
        '/user/first',
        '/user/second',
        join(a, 'skills'),
        join(b, 'skills'),
      ]);
    });
  });

  test('같은 경로는 두 번 들어가지 않는다', () => {
    withTempRoot((root) => {
      const install = join(root, 'pkg');
      const skillsDir = join(install, 'skills');
      mkdirSync(skillsDir, { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: {
          'alpha@market': [{ scope: 'user', installPath: install, version: '1' }],
          'alpha-dup@market': [{ scope: 'user', installPath: install, version: '1' }],
        },
      }, emptyMarketplaces());
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: [skillsDir],
        includeClaudePackageSkills: true,
      });
      const dirs = defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root });
      expect(dirs).toEqual([skillsDir]);
      expect(dirs.filter((d) => d === skillsDir)).toHaveLength(1);
    });
  });

  test('opt-in 에서 사용자 dirs 중복도 한 번만 남는다', () => {
    withTempRoot((root) => {
      const install = join(root, 'pkg');
      mkdirSync(join(install, 'skills'), { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: {
          'alpha@market': [{ scope: 'user', installPath: install, version: '1' }],
        },
      }, emptyMarketplaces());
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: ['/a/skills', '/a/skills'],
        includeClaudePackageSkills: true,
      });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual([
        '/a/skills',
        join(install, 'skills'),
      ]);
    });
  });

  test('opt-out 에서는 사용자 dirs 중복이 이전과 같다', () => {
    expect(defaultSkillDirs(cfgWith({
      activeSet: 'custom',
      dirs: ['/a/skills', '/a/skills'],
    }))).toEqual(['/a/skills', '/a/skills', bundledSkillsDir()]);
  });

  test('실재하지 않는 경로는 목록에 안 들어간다', () => {
    withTempRoot((root) => {
      const existing = join(root, 'exists');
      const missing = join(root, 'missing');
      mkdirSync(join(existing, 'skills'), { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: {
          'exists@m': [{ scope: 'user', installPath: existing, version: '1' }],
          'missing@m': [{ scope: 'user', installPath: missing, version: '1' }],
        },
      }, emptyMarketplaces());
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: ['/user'],
        includeClaudePackageSkills: true,
      });
      const dirs = defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root });
      expect(dirs).toEqual(['/user', join(existing, 'skills')]);
      expect(dirs).not.toContain(join(missing, 'skills'));
    });
  });

  test('원장이 없으면 기존 목록만 나오고 오류가 나지 않는다', () => {
    withTempRoot((root) => {
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: ['/a/skills'],
        includeClaudePackageSkills: true,
      });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual(['/a/skills']);
    });
  });

  test('원장을 못 읽으면 기존 목록만 나온다', () => {
    withTempRoot((root) => {
      writeFileSync(join(root, INSTALLED_PLUGINS_FILENAME), '{not-json');
      writeFileSync(join(root, KNOWN_MARKETPLACES_FILENAME), '{}');
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: ['/a/skills'],
        includeClaudePackageSkills: true,
      });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual(['/a/skills']);
    });
  });

  // 🚨 뒤집힌 시험 — 앞선 판은 「캐시해서 한 번만 읽는다」를 요구했고 리뷰가 그것을 막았다.
  //    성공 뒤 원장이 «읽기 불가»가 되어도 mtime 이 같으면 캐시된 경로를 계속 더해
  //    「원장을 못 읽으면 기존 목록 그대로」라는 수용 기준을 위반하기 때문이다.
  //    ⇒ 이제 «매 호출 다시 읽는» 것이 계약이고, 이 시험이 그것을 문다.
  test('반복 호출은 원장을 «매번» 다시 읽는다 — 낡은 답을 주지 않는다', () => {
    withTempRoot((root) => {
      const install = join(root, 'pkg');
      mkdirSync(join(install, 'skills'), { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: {
          'alpha@market': [{ scope: 'user', installPath: install, version: '1' }],
        },
      }, emptyMarketplaces());
      __resetClaudePackageSkillDirsCacheForTests();
      const before = __claudePackageSkillDirsLedgerReadCountForTests();
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: ['/a/skills'],
        includeClaudePackageSkills: true,
      });
      const first = defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root });
      const second = defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root });
      const third = defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root });
      expect(second).toEqual(first);
      expect(third).toEqual(first);
      expect(__claudePackageSkillDirsLedgerReadCountForTests() - before).toBe(3);
    });
  });

  test('캐시된 원장이어도 skills/ 가 사라지면 목록에서 빠진다', () => {
    withTempRoot((root) => {
      const install = join(root, 'pkg');
      const skillsDir = join(install, 'skills');
      mkdirSync(skillsDir, { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: {
          'alpha@market': [{ scope: 'user', installPath: install, version: '1' }],
        },
      }, emptyMarketplaces());
      __resetClaudePackageSkillDirsCacheForTests();
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: ['/a/skills'],
        includeClaudePackageSkills: true,
      });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual(['/a/skills', skillsDir]);
      rmSync(skillsDir, { recursive: true, force: true });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual(['/a/skills']);
    });
  });

  test('캐시된 원장이어도 skills/ 가 생기면 목록에 더해진다', () => {
    withTempRoot((root) => {
      const install = join(root, 'pkg');
      const skillsDir = join(install, 'skills');
      writeLedger(root, {
        version: 2,
        plugins: {
          'alpha@market': [{ scope: 'user', installPath: install, version: '1' }],
        },
      }, emptyMarketplaces());
      __resetClaudePackageSkillDirsCacheForTests();
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: ['/a/skills'],
        includeClaudePackageSkills: true,
      });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual(['/a/skills']);
      mkdirSync(skillsDir, { recursive: true });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual(['/a/skills', skillsDir]);
    });
  });

  test('캐시된 원장이어도 skills/ 읽기 권한이 복구되면 목록에 다시 들어간다', () => {
    withTempRoot((root) => {
      const install = join(root, 'pkg');
      const skillsDir = join(install, 'skills');
      mkdirSync(skillsDir, { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: {
          'alpha@market': [{ scope: 'user', installPath: install, version: '1' }],
        },
      }, emptyMarketplaces());
      __resetClaudePackageSkillDirsCacheForTests();
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: ['/a/skills'],
        includeClaudePackageSkills: true,
      });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual(['/a/skills', skillsDir]);
      chmodSync(skillsDir, 0);
      let denied = false;
      try {
        accessSync(skillsDir, fsConstants.R_OK | fsConstants.X_OK);
      } catch {
        denied = true;
      }
      try {
        if (denied) {
          expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual(['/a/skills']);
        }
      } finally {
        chmodSync(skillsDir, 0o755);
      }
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual(['/a/skills', skillsDir]);
    });
  });

  test('원장 mtime 이 바뀌면 캐시가 무효화되어 새 경로를 본다', () => {
    withTempRoot((root) => {
      const firstInstall = join(root, 'pkg-1');
      mkdirSync(join(firstInstall, 'skills'), { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: {
          'one@m': [{ scope: 'user', installPath: firstInstall, version: '1' }],
        },
      }, emptyMarketplaces());
      __resetClaudePackageSkillDirsCacheForTests();
      const cfg = cfgWith({
        activeSet: 'custom',
        dirs: ['/a/skills'],
        includeClaudePackageSkills: true,
      });
      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual([
        '/a/skills',
        join(firstInstall, 'skills'),
      ]);

      const secondInstall = join(root, 'pkg-2');
      mkdirSync(join(secondInstall, 'skills'), { recursive: true });
      // Ensure mtime advances past the previous ledger write.
      const later = new Date(Date.now() + 1500);
      writeLedger(root, {
        version: 2,
        plugins: {
          'two@m': [{ scope: 'user', installPath: secondInstall, version: '2' }],
        },
      }, emptyMarketplaces());
      utimesSync(join(root, INSTALLED_PLUGINS_FILENAME), later, later);

      expect(defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root })).toEqual([
        '/a/skills',
        join(secondInstall, 'skills'),
      ]);
    });
  });

  test('config.json 에서 includeClaudePackageSkills:true 만 명시적 true 로 파싱된다', () => {
    withTempRoot((root) => {
      const cfgPath = join(root, 'config.json');
      writeFileSync(cfgPath, JSON.stringify({ skills: { includeClaudePackageSkills: true } }));
      expect(buildUserConfig(cfgPath).skills.includeClaudePackageSkills).toBe(true);
      writeFileSync(cfgPath, JSON.stringify({ skills: { includeClaudePackageSkills: false } }));
      expect(buildUserConfig(cfgPath).skills.includeClaudePackageSkills).toBeUndefined();
      writeFileSync(cfgPath, JSON.stringify({ skills: {} }));
      expect(buildUserConfig(cfgPath).skills.includeClaudePackageSkills).toBeUndefined();
    });
  });

  liveTest('[live] 이 기계에서 설정을 켜면 설치된 package 지침 경로가 들어 있다', () => {
    const off = defaultSkillDirs(cfgWith({ activeSet: 'claudecode' }));
    const on = defaultSkillDirs(cfgWith({
      activeSet: 'claudecode',
      includeClaudePackageSkills: true,
    }));
    expect(off).toEqual([skillSetDir('claudecode')!, bundledSkillsDir()]);
    expect(on.length).toBeGreaterThan(off.length);
    expect(on.slice(0, 1)).toEqual([skillSetDir('claudecode')!]);
    expect(on.at(-1)).toBe(bundledSkillsDir());
    expect(on.some((d) => d.includes('antv-infographic-skills') && d.endsWith('/skills'))).toBe(true);
  });

  liveTest('[live] 그 목록으로 스킬 인덱스를 지으면 infographic 지침 다섯이 나온다', () => {
    const dirs = defaultSkillDirs(cfgWith({
      activeSet: 'claudecode',
      includeClaudePackageSkills: true,
    }));
    const names = buildSkillIndex(dirs).map((e) => e.name);
    const required = [
      'infographic-creator',
      'infographic-item-creator',
      'infographic-structure-creator',
      'infographic-syntax-creator',
      'infographic-template-updater',
    ];
    for (const name of required) expect(names).toContain(name);
  });
});

// ── 2026-09-03 리뷰 must-fix — 캐시가 「원장을 못 읽으면 기존 목록 그대로」를 깨뜨렸다 ──
describe('defaultSkillDirs — 원장이 «성공 뒤» 읽기 불가가 되면', () => {
  test('캐시된 package 경로를 계속 더하지 않는다', () => {
    withTempRoot((root) => {
      const install = join(root, 'pkg');
      mkdirSync(join(install, 'skills'), { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: { 'alpha@market': [{ scope: 'user', installPath: install, version: '1' }] },
      }, emptyMarketplaces());
      const cfg = cfgWith({ activeSet: 'custom', dirs: ['/a/skills'], includeClaudePackageSkills: true });
      const withLedger = defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root });
      expect(withLedger).toContain(join(install, 'skills'));
      // 원장을 «지운다» — 성공 뒤 못 읽게 된 판.
      rmSync(join(root, 'installed_plugins.json'), { force: true });
      const afterLoss = defaultSkillDirs(cfg, { pluginsRoot: root, bundledSkillsRoot: root });
      // ⛔ 캐시가 남아 있으면 여기서 여전히 package 경로가 들어 있다.
      expect(afterLoss).not.toContain(join(install, 'skills'));
      expect(afterLoss).toEqual(['/a/skills']);
    });
  });
});
