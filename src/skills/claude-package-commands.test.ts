import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import {
  INSTALLED_PLUGINS_FILENAME,
  KNOWN_MARKETPLACES_FILENAME,
  readClaudePackageLedger,
} from '../plugins/adapters/claude-package.js';
import {
  CLAUDE_PACKAGE_COMMAND_DESCRIPTION_ABSENT,
  buildSkillIndex,
  claudePackageCommandToIndexEntry,
  collectClaudePackageCommandEntries,
  listClaudePackageCommandFiles,
  parseClaudePackageCommandMarkdown,
  resetSkillIndex,
} from './index.js';
import { buildUserConfig, resetUserConfig } from '../user-config.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

type ObservedLog = { category: string; event: string; data?: unknown };

function captureDebugLog<T>(run: () => T): { value: T; logs: ObservedLog[] } {
  const logs: ObservedLog[] = [];
  const spy = spyOn(debug, 'log').mockImplementation(((
    category: string,
    event: string,
    data?: unknown,
  ) => {
    logs.push({ category, event, data });
  }) as typeof debug.log);
  try {
    return { value: run(), logs };
  } finally {
    spy.mockRestore();
  }
}

function claudePackageLogs(logs: ObservedLog[]): ObservedLog[] {
  return logs.filter((e) => e.category === 'skills.claude-package');
}

function writeLedger(root: string, installed: unknown, marketplaces: unknown): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, INSTALLED_PLUGINS_FILENAME), JSON.stringify(installed));
  writeFileSync(join(root, KNOWN_MARKETPLACES_FILENAME), JSON.stringify(marketplaces));
}

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'claude-package-commands-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeFixtureSkill(root: string, name: string, description = `fixture skill ${name}`): void {
  const sd = join(root, name);
  mkdirSync(sd, { recursive: true });
  writeFileSync(
    join(sd, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
  );
}

function writeCommand(dir: string, file: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, body);
  return path;
}

function withCommandFlag(enabled: boolean, run: () => void): void {
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const xdg = mkdtempSync(join(tmpdir(), 'xdg-cmd-flag-'));
  try {
    mkdirSync(join(xdg, 'elanous'), { recursive: true });
    const skills: Record<string, unknown> = {};
    if (enabled) skills.includeClaudePackageCommands = true;
    writeFileSync(join(xdg, 'elanous', 'config.json'), JSON.stringify({ skills }));
    process.env.XDG_CONFIG_HOME = xdg;
    setElanousConfigDir(join(xdg, 'elanous'));
    resetUserConfig();
    resetSkillIndex();
    run();
  } finally {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    resetElanousConfigDir();
    resetUserConfig();
    resetSkillIndex();
    rmSync(xdg, { recursive: true, force: true });
  }
}

describe('includeClaudePackageCommands config — independent of skills', () => {
  test('true 만 명시적 true 로 파싱되고 skills 스위치와 독립이다', () => {
    withTempRoot((root) => {
      const cfgPath = join(root, 'config.json');

      writeFileSync(cfgPath, JSON.stringify({ skills: { includeClaudePackageCommands: true } }));
      const commandsOnly = buildUserConfig(cfgPath);
      expect(commandsOnly.skills.includeClaudePackageCommands).toBe(true);
      expect(commandsOnly.skills.includeClaudePackageSkills).toBeUndefined();

      writeFileSync(cfgPath, JSON.stringify({ skills: { includeClaudePackageSkills: true } }));
      const skillsOnly = buildUserConfig(cfgPath);
      expect(skillsOnly.skills.includeClaudePackageSkills).toBe(true);
      expect(skillsOnly.skills.includeClaudePackageCommands).toBeUndefined();

      writeFileSync(cfgPath, JSON.stringify({
        skills: { includeClaudePackageSkills: true, includeClaudePackageCommands: true },
      }));
      const both = buildUserConfig(cfgPath);
      expect(both.skills.includeClaudePackageSkills).toBe(true);
      expect(both.skills.includeClaudePackageCommands).toBe(true);

      writeFileSync(cfgPath, JSON.stringify({ skills: { includeClaudePackageCommands: false } }));
      expect(buildUserConfig(cfgPath).skills.includeClaudePackageCommands).toBeUndefined();

      writeFileSync(cfgPath, JSON.stringify({ skills: {} }));
      expect(buildUserConfig(cfgPath).skills.includeClaudePackageCommands).toBeUndefined();
    });
  });
});

describe('parseClaudePackageCommandMarkdown', () => {
  test('이름은 첫 ATX 제목에서 오고 설명은 그 다음 첫 산문 문단에서 온다', () => {
    const parsed = parseClaudePackageCommandMarkdown(
      '# cli-anything:list Command\n\nList all available CLI-Anything tools (installed and generated).\n',
      'list',
    );
    expect(parsed.name).toBe('cli-anything:list Command');
    expect(parsed.description).toBe(
      'List all available CLI-Anything tools (installed and generated).',
    );
  });

  test('제목이 없으면 파일 이름을 쓰고 산문은 본문 첫 문단에서 온다', () => {
    const parsed = parseClaudePackageCommandMarkdown(
      'Just a prose paragraph with no heading.\n',
      'no-heading',
    );
    expect(parsed.name).toBe('no-heading');
    expect(parsed.description).toBe('Just a prose paragraph with no heading.');
  });

  test('제목도 산문도 없으면 이름은 파일 이름이고 설명은 부재가 드러난다', () => {
    const parsed = parseClaudePackageCommandMarkdown('', 'empty-cmd');
    expect(parsed.name).toBe('empty-cmd');
    expect(parsed.name.length).toBeGreaterThan(0);
    expect(parsed.description).toBe(CLAUDE_PACKAGE_COMMAND_DESCRIPTION_ABSENT);
    expect(parsed.description.length).toBeGreaterThan(0);
  });

  test('제목 없는 YAML frontmatter 의 description: 메타데이터는 산문이 아니다', () => {
    const parsed = parseClaudePackageCommandMarkdown(
      '---\nname: from-yaml\ndescription: metadata not prose\n---\n',
      'yaml-only',
    );
    expect(parsed.name).toBe('yaml-only');
    expect(parsed.description).toBe(CLAUDE_PACKAGE_COMMAND_DESCRIPTION_ABSENT);
    expect(parsed.description).not.toContain('metadata not prose');
  });

  test('닫히지 않은 YAML 의 description: 과 들여쓴 연속 줄은 산문이 아니다', () => {
    const parsed = parseClaudePackageCommandMarkdown(
      '---\ndescription: |\n  indented yaml continuation\nname: still-meta\n',
      'open-yaml',
    );
    expect(parsed.name).toBe('open-yaml');
    expect(parsed.description).toBe(CLAUDE_PACKAGE_COMMAND_DESCRIPTION_ABSENT);
    expect(parsed.description).not.toContain('indented yaml continuation');
  });

  test('목록 항목과 들여쓴 연속 줄은 산문이 아니고 그 다음 문단이 설명이다', () => {
    const parsed = parseClaudePackageCommandMarkdown(
      '# Title\n\n- first item\n  indented continuation that is not prose\n- second item\n\nThe actual prose paragraph.\n',
      'list-cmd',
    );
    expect(parsed.name).toBe('Title');
    expect(parsed.description).toBe('The actual prose paragraph.');
    expect(parsed.description).not.toContain('indented continuation');
  });

  test('변환기가 항상 빈 이름을 주면 이 시험이 실패한다', () => {
    const parsed = parseClaudePackageCommandMarkdown('# Named Command\n\nA sentence.\n', 'stem');
    expect(parsed.name).not.toBe('');
    expect(parsed.name).toBe('Named Command');
  });
});

describe('listClaudePackageCommandFiles / claudePackageCommandToIndexEntry', () => {
  test('평면 commands/*.md 만 모으고 변환 항목은 비어 있지 않은 이름·설명을 갖는다', () => {
    withTempRoot((root) => {
      const commands = join(root, 'commands');
      writeCommand(
        commands,
        'list.md',
        '# cli-anything:list Command\n\nList all available CLI-Anything tools.\n',
      );
      writeCommand(commands, 'empty.md', '');
      writeCommand(commands, 'skip.txt', 'not markdown');
      mkdirSync(join(commands, 'nested'), { recursive: true });
      writeFileSync(join(commands, 'nested', 'inner.md'), '# nested\n');

      const files = listClaudePackageCommandFiles(commands);
      expect(files.map((f) => f.slice(commands.length + 1)).sort()).toEqual(['empty.md', 'list.md']);

      const list = claudePackageCommandToIndexEntry(join(commands, 'list.md'));
      expect(list?.name).toBe('cli-anything:list Command');
      expect(list?.description).toContain('List all available');

      const empty = claudePackageCommandToIndexEntry(join(commands, 'empty.md'));
      expect(empty?.name).toBe('empty');
      expect(empty?.description.length).toBeGreaterThan(0);
    });
  });
});

describe('collectClaudePackageCommandEntries — ledger reuse', () => {
  test('원장의 installPath/commands/*.md 를 항목으로 변환한다', () => {
    withTempRoot((root) => {
      const install = join(root, 'cli-anything');
      const commands = join(install, 'commands');
      writeCommand(commands, 'list.md', '# cli-anything:list Command\n\nList tools.\n');
      writeCommand(commands, 'run.md', '# cli-anything:run Command\n\nRun a tool.\n');
      writeLedger(root, {
        version: 2,
        plugins: {
          'cli-anything@market': [{ scope: 'user', installPath: install, version: '1' }],
        },
      }, {});

      const entries = collectClaudePackageCommandEntries({ pluginsRoot: root });
      expect(entries.map((e) => e.name).sort()).toEqual([
        'cli-anything:list Command',
        'cli-anything:run Command',
      ]);
    });
  });
});

describe('collectClaudePackageCommandEntries — observation branches', () => {
  test('원장이 ok 가 아니면 ledger-unreadable 갈래와 실패 이유·못 본 수가 남고 반환은 빈 배열이다', () => {
    withTempRoot((root) => {
      const { value, logs } = captureDebugLog(() =>
        collectClaudePackageCommandEntries({ pluginsRoot: root }),
      );
      expect(value).toEqual([]);
      const observed = claudePackageLogs(logs);
      expect(observed.map((e) => e.event)).toEqual(['ledger-unreadable']);
      expect(observed[0]?.data).toEqual({
        reason: 'installed-plugins-unreadable',
        unseenCount: 'unknown',
      });
      expect(observed.some((e) => e.event === 'empty')).toBe(false);
      expect(observed.some((e) => e.event === 'read-error')).toBe(false);
    });
  });

  test('원장은 정상이지만 command 가 없으면 empty 갈래가 남고 ledger-unreadable 과 다르다', () => {
    withTempRoot((root) => {
      const install = join(root, 'pkg-no-commands');
      mkdirSync(install, { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: { 'pkg@m': [{ scope: 'user', installPath: install, version: '1' }] },
      }, {});

      const { value, logs } = captureDebugLog(() =>
        collectClaudePackageCommandEntries({ pluginsRoot: root }),
      );
      expect(value).toEqual([]);
      const observed = claudePackageLogs(logs);
      expect(observed.map((e) => e.event)).toEqual(['empty']);
      expect(observed[0]?.data).toEqual({ count: 0 });
      expect(observed.some((e) => e.event === 'ledger-unreadable')).toBe(false);
      expect(observed.some((e) => e.event === 'read-error')).toBe(false);
    });
  });

  test('원장 읽기가 예외를 던지면 반환은 빈 배열이고 read-error 갈래와 사유·못 본 수가 남는다', () => {
    const { value, logs } = captureDebugLog(() => collectClaudePackageCommandEntries({
      pluginsRoot: '/does-not-matter',
      readLedger: () => {
        throw new Error('ledger exploded');
      },
    }));
    expect(value).toEqual([]);
    const observed = claudePackageLogs(logs);
    expect(observed.map((e) => e.event)).toEqual(['read-error']);
    expect(observed[0]?.data).toEqual({
      reason: 'ledger exploded',
      unseenCount: 'unknown',
    });
    expect(observed.some((e) => e.event === 'empty')).toBe(false);
    expect(observed.some((e) => e.event === 'ledger-unreadable')).toBe(false);
  });

  test('실제 수집기를 세 조건으로 부르면 event 집합이 ledger-unreadable, read-error, empty 이다', () => {
    const events: string[] = [];

    withTempRoot((root) => {
      const unread = captureDebugLog(() =>
        collectClaudePackageCommandEntries({ pluginsRoot: root }),
      );
      events.push(...claudePackageLogs(unread.logs).map((e) => e.event));
    });

    const thrown = captureDebugLog(() => collectClaudePackageCommandEntries({
      pluginsRoot: '/does-not-matter',
      readLedger: () => {
        throw new Error('ledger exploded');
      },
    }));
    events.push(...claudePackageLogs(thrown.logs).map((e) => e.event));

    withTempRoot((root) => {
      const install = join(root, 'pkg-no-commands');
      mkdirSync(install, { recursive: true });
      writeLedger(root, {
        version: 2,
        plugins: { 'pkg@m': [{ scope: 'user', installPath: install, version: '1' }] },
      }, {});
      const empty = captureDebugLog(() =>
        collectClaudePackageCommandEntries({ pluginsRoot: root }),
      );
      events.push(...claudePackageLogs(empty.logs).map((e) => e.event));
    });

    expect(new Set(events)).toEqual(new Set(['ledger-unreadable', 'read-error', 'empty']));
    expect(events).toEqual(['ledger-unreadable', 'read-error', 'empty']);
  });
});

describe('buildSkillIndex — includeClaudePackageCommands wiring', () => {
  const savedXdg = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    resetElanousConfigDir();
    resetUserConfig();
    resetSkillIndex();
  });

  test('키가 꺼져 있으면 command 항목이 없고 기존 스킬 이름·설명·개수가 그대로다', () => {
    withTempRoot((root) => {
      const skillRoot = join(root, 'skills');
      writeFixtureSkill(skillRoot, 'keep-me', 'unchanged description');
      const install = join(root, 'pkg');
      writeCommand(join(install, 'commands'), 'list.md', '# pkg:list Command\n\nListed.\n');
      writeLedger(root, {
        version: 2,
        plugins: { 'pkg@m': [{ scope: 'user', installPath: install, version: '1' }] },
      }, {});

      const before = buildSkillIndex([skillRoot], { pluginsRoot: root });
      expect(before.map((e) => e.name)).toEqual(['keep-me']);
      expect(before[0]?.description).toBe('unchanged description');

      withCommandFlag(false, () => {
        const off = buildSkillIndex([skillRoot], { pluginsRoot: root });
        expect(off.map((e) => ({ name: e.name, description: e.description }))).toEqual(
          before.map((e) => ({ name: e.name, description: e.description })),
        );
        expect(off.some((e) => e.name.includes('pkg:list'))).toBe(false);
      });
    });
  });

  test('includeClaudePackageSkills 만 켜면 command 항목이 들어가지 않는다', () => {
    withTempRoot((root) => {
      const skillRoot = join(root, 'skills');
      writeFixtureSkill(skillRoot, 'keep-me', 'unchanged description');
      const install = join(root, 'pkg');
      writeCommand(join(install, 'commands'), 'list.md', '# pkg:list Command\n\nListed.\n');
      writeLedger(root, {
        version: 2,
        plugins: { 'pkg@m': [{ scope: 'user', installPath: install, version: '1' }] },
      }, {});

      const saved = process.env.XDG_CONFIG_HOME;
      const xdg = mkdtempSync(join(tmpdir(), 'xdg-skills-only-'));
      try {
        mkdirSync(join(xdg, 'elanous'), { recursive: true });
        writeFileSync(join(xdg, 'elanous', 'config.json'), JSON.stringify({
          skills: { includeClaudePackageSkills: true },
        }));
        process.env.XDG_CONFIG_HOME = xdg;
        setElanousConfigDir(join(xdg, 'elanous'));
        resetUserConfig();
        resetSkillIndex();
        const idx = buildSkillIndex([skillRoot], { pluginsRoot: root });
        expect(idx.map((e) => e.name)).toEqual(['keep-me']);
        expect(idx[0]?.description).toBe('unchanged description');
        expect(idx.some((e) => e.name.includes('pkg:list'))).toBe(false);
      } finally {
        if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = saved;
        resetElanousConfigDir();
        rmSync(xdg, { recursive: true, force: true });
      }
    });
  });

  test('키를 켜면 command 항목이 들어가고 기존 스킬은 이름·설명이 그대로다', () => {
    withTempRoot((root) => {
      const skillRoot = join(root, 'skills');
      writeFixtureSkill(skillRoot, 'keep-me', 'unchanged description');
      const install = join(root, 'pkg');
      writeCommand(join(install, 'commands'), 'list.md', '# pkg:list Command\n\nListed.\n');
      writeCommand(join(install, 'commands'), 'empty.md', '');
      writeLedger(root, {
        version: 2,
        plugins: { 'pkg@m': [{ scope: 'user', installPath: install, version: '1' }] },
      }, {});

      const before = buildSkillIndex([skillRoot], { pluginsRoot: root });
      withCommandFlag(true, () => {
        const on = buildSkillIndex([skillRoot], { pluginsRoot: root });
        const kept = on.find((e) => e.name === 'keep-me');
        expect(kept?.description).toBe('unchanged description');
        expect(on.filter((e) => e.name === 'keep-me')).toHaveLength(1);
        expect(on.some((e) => e.name === 'pkg:list Command')).toBe(true);
        const empty = on.find((e) => e.name === 'empty');
        expect(empty?.name).toBe('empty');
        expect((empty?.description ?? '').length).toBeGreaterThan(0);
        expect(on.length).toBe(before.length + 2);
      });
    });
  });
});

function liveCliAnythingCommandsDir(): string | null {
  const ledger = readClaudePackageLedger();
  if (ledger.status !== 'ok') return null;
  const pkg = ledger.packages.find((p) =>
    p.plugin === 'cli-anything' || p.name.includes('cli-anything'),
  );
  if (!pkg?.installPath) return null;
  const dir = join(pkg.installPath, 'commands');
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  return dir;
}

const liveCommands = liveCliAnythingCommandsDir();
const liveTest = liveCommands ? test : test.skip;

describe('collectClaudePackageCommandEntries — live cli-anything', () => {
  liveTest('[live] 실제 설치로 수집하면 cli-anything command 다섯 개가 그대로 들어 있다', () => {
    const entries = collectClaudePackageCommandEntries();
    const files = listClaudePackageCommandFiles(liveCommands!);
    expect(files.length).toBe(5);
    const converted = files.map((f) => claudePackageCommandToIndexEntry(f));
    for (const entry of converted) {
      expect(entry).toBeTruthy();
      expect(entry!.name.length).toBeGreaterThan(0);
      expect(entries.map((e) => e.name)).toContain(entry!.name);
    }
  });
});

describe('buildSkillIndex — live cli-anything commands', () => {
  liveTest('[live] 키를 켜면 cli-anything command 다섯 개가 이름을 갖고 들어 있다', () => {
    withCommandFlag(true, () => {
      const names = buildSkillIndex([]).map((e) => e.name);
      const files = listClaudePackageCommandFiles(liveCommands!);
      expect(files.length).toBe(5);
      const converted = files.map((f) => claudePackageCommandToIndexEntry(f));
      for (const entry of converted) {
        expect(entry).toBeTruthy();
        expect(entry!.name.length).toBeGreaterThan(0);
        expect(names).toContain(entry!.name);
      }
    });
  });

  liveTest('[live] 키를 끄면 착지 이전과 항목 수가 같다', () => {
    const off = buildSkillIndex([]);
    withCommandFlag(false, () => {
      expect(buildSkillIndex([]).length).toBe(off.length);
    });
  });
});
