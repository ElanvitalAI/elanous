import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Command } from 'commander';

import { listDesignDirections } from '../design/design-directions.js';
import { defaultDesignSystemsDir, listDesignSystems } from '../design/design-systems.js';
import type { ProjectScaffoldDeps, ProjectScaffoldResult } from '../self-implement/project-scaffold.js';
import { registerRepoCommands, resolveRepositoryDesignCheck, resolveRepositoryDesignTarget, runRepositoryDesignCheck, runRepositoryDesignDirection, runRepositoryDesignPreview, runRepositoryDesignSystemFromPalette, runRepositoryDesignSystemFromUrl, runRepositoryScaffold } from './repo-cli.js';
import type { DesignGateResult } from '../design/design-gate.js';
import { debug } from '../debug/log.js';
import * as standaloneLogSink from '../domains/standalone-log-sink.js';
import type { ArchiveRecord } from '../webclone/archive-run.js';
import * as extractDesignRun from '../webclone/extract-design-run.js';

const archiveRecord = (overrides: Partial<ArchiveRecord> = {}): ArchiveRecord => ({
  slug: 'archive', url: 'https://example.test', out: '/workspace/archive', dbPath: '/workspace/archive.db', capturedAt: '2026-09-09T00:00:00Z', title: null,
  originFiles: 2, mirrorOk: true, mirrorCompletion: 'completed', mirrorExitCode: 0, mirrorDepth: 1, fullPageScreenshot: { bytes: 1024, dimensions: '1280x720' }, tokens: 1,
  derived: ['DESIGN.md'], uploaded: ['s3://public/derived/DESIGN.md'], notes: [], archiveNote: '🔴 public: 공개 읽기 정책', archivedCount: 0,
  renderLocation: 'server', entryPath: '/workspace/archive/origin/index.html',
  visibleText: { mirrored: 10, rendered: 10, mirrorRendered: 10 }, mirrorCollapse: 'intact', renderedSnapshot: null, canvasCount: null,
  integrity: { checked: 2, broken: [], brokenRatio: 0 },
  ...overrides,
});

const successfulScaffold = (target: string, _deps?: ProjectScaffoldDeps): ProjectScaffoldResult => ({
  status: 'provisioned',
  target,
  resolution: { status: 'git-repo', kind: 'git-repo', target, repoRoot: target },
  ignoreFile: { added: 3, preserved: 1, created: false },
  created: [`${target}/AGENTS.md`],
  existing: [],
});

describe('repository scaffold CLI', () => {
  test('reports paths created on the first scaffold run through injected dependencies', async () => {
    const output: string[] = [];
    const code = await runRepositoryScaffold('/workspace/new-project', {
      out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      scaffoldProject: successfulScaffold,
    });

    expect(code).toBe(0);
    expect(output).toEqual([
      'Created: /workspace/new-project/AGENTS.md',
      'Ignore file added 3 entries and preserved 1 human-authored lines.',
    ]);
  });

  test('reports existing paths separately on a repeated scaffold run', async () => {
    const output: string[] = [];
    const code = await runRepositoryScaffold('/workspace/existing-project', {
      out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      scaffoldProject: (target, _deps) => ({
        status: 'provisioned',
        target,
        resolution: { status: 'git-repo', kind: 'git-repo', target, repoRoot: target },
        ignoreFile: { added: 0, preserved: 4, created: false },
        created: [],
        existing: [`${target}/AGENTS.md`],
      }),
    });

    expect(code).toBe(0);
    expect(output).toEqual([
      'Existing: /workspace/existing-project/AGENTS.md',
      'Ignore file already contained all required entries; preserved 4 human-authored lines.',
    ]);
  });

  // ⭐ 대표 2026-08-25 — *"프로젝트를 셋업하게 되면 디자인을 선택할 수 있는 «옵션이 나오도록»"*.
  //   📏 그 지시 «전»의 실측: 개설 산출 전문에 `direction`/`방향` 이 ***0건***이었다.
  //   기전(목록·`--set`·PWA 화면)은 «전부» 있었는데 방금 개설한 사람이 그것을 «모른다».
  //   ⛔ 그래서 이 저장소 자신의 DESIGN.md 가 사흘 동안 `None declared` 였다.
  test('⭐ 방향이 «안» 선언됐으면 고를 수 있음을 알린다 (대표 지시)', async () => {
    const output: string[] = [];
    const code = await runRepositoryScaffold('/workspace/fresh', {
      out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      scaffoldProject: successfulScaffold,
      readFile: () => '# Design\n\n## Craft rulebooks\n\n- color\n',
    });

    expect(code).toBe(0);
    expect(output).toContain('Design direction: (none declared) — pick one, or leave it and decide later:');
    // ⛔ 목록을 «여기서 다시 세지» 않는다 — 정본이 늘거나 줄면 이 시험이 아니라 정본이 답한다.
    expect(output.some((line) => line.trim().startsWith('elanous-pastel-default'))).toBe(true);
    expect(output.at(-1)).toBe('  → elanous repo design-direction /workspace/fresh --set <direction>');
  });

  test('⭐ 방향이 «이미» 선언됐으면 목록 대신 «그 값 한 줄»만 낸다', async () => {
    const output: string[] = [];
    const code = await runRepositoryScaffold('/workspace/decided', {
      out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      scaffoldProject: successfulScaffold,
      readFile: () => '# Design\n\n## Craft rulebooks\n\n- color\n\n## Design direction\n\n- nord-light\n',
    });

    expect(code).toBe(0);
    expect(output.at(-1)).toBe('Design direction: nord-light');
    expect(output.some((line) => line.includes('pick one'))).toBe(false);
  });

  // ⛔ 개설 «자체»는 성공했다 — 방향 안내를 못 낸다고 실패로 만들지 않는다.
  test('⭐ DESIGN.md 를 못 읽어도 개설을 «실패로 만들지 않는다»', async () => {
    const output: string[] = [];
    const code = await runRepositoryScaffold('/workspace/unreadable', {
      out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      scaffoldProject: successfulScaffold,
      readFile: () => { throw new Error('ENOENT'); },
    });

    expect(code).toBe(0);
    expect(output.some((line) => line.includes('Design direction'))).toBe(false);
  });

  test('reports a non-applicable reason and fails rather than succeeding silently', async () => {
    const errors: string[] = [];
    const code = await runRepositoryScaffold('/workspace/missing-project', {
      out: { log: () => {}, error: (line) => errors.push(line) },
      scaffoldProject: (target) => ({ status: 'not-applicable', target, reason: 'missing', created: [], existing: [] }),
    });

    expect(code).toBe(1);
    expect(errors).toEqual(['Project scaffold blocked: missing']);
  });

  test('registers and executes scaffold beside the retained public and publish subcommands', async () => {
    const output: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerRepoCommands(program, {
      out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      scaffoldProject: successfulScaffold,
      setExitCode: (code) => exitCodes.push(code),
    });
    const repo = program.commands.find((command) => command.name() === 'repo');

    expect(repo?.commands.map((command) => command.name())).toEqual(expect.arrayContaining(['public', 'publish', 'scaffold']));
    await program.parseAsync(['node', 'test', 'repo', 'scaffold', '/workspace/registered-project']);
    expect(output).toEqual([
      'Created: /workspace/registered-project/AGENTS.md',
      'Ignore file added 3 entries and preserved 1 human-authored lines.',
    ]);
    expect(exitCodes).toEqual([]);
  });
});

describe('repository design-system selection', () => {
  test('registered --set minimal keeps its success lines and installs the bundled system', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'repo-direction-command-'));
    try {
      const documentPath = join(directory, 'DESIGN.md');
      writeFileSync(documentPath, '# Design\n');
      const output: string[] = [];
      const errors: string[] = [];
      const exitCodes: number[] = [];
      const program = new Command();
      registerRepoCommands(program, {
        out: { log: (line) => output.push(line), error: (line) => errors.push(line) },
        setExitCode: (code) => exitCodes.push(code),
      });
      await program.parseAsync(['node', 'test', 'repo', 'design-direction', directory, '--set', 'minimal']);
      expect(output).toEqual([`Design document: ${documentPath}`, 'Design direction: minimal']);
      expect(errors).toEqual([]);
      expect(exitCodes).toEqual([]);
      const source = join(defaultDesignSystemsDir(), 'minimal');
      expect(readFileSync(join(directory, 'design/system/DESIGN.md'), 'utf8')).toBe(readFileSync(join(source, 'DESIGN.md'), 'utf8'));
      expect(readFileSync(join(directory, 'design/system/tokens.css'), 'utf8')).toBe(readFileSync(join(source, 'tokens.css'), 'utf8'));
      expect(readFileSync(documentPath, 'utf8')).toContain('- minimal\n- tokens: design/system/tokens.css\n');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('--set retains the read failure and resolved directory hint without reporting success', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'repo-direction-unreadable-'));
    try {
      const documentPath = join(directory, 'DESIGN.md');
      const output: string[] = [];
      const errors: string[] = [];
      const exitCodes: number[] = [];
      const program = new Command();
      registerRepoCommands(program, {
        out: { log: (line) => output.push(line), error: (line) => errors.push(line) },
        setExitCode: (code) => exitCodes.push(code),
      });
      await program.parseAsync(['node', 'test', 'repo', 'design-direction', directory, '--set', 'minimal']);
      expect(output).toEqual([]);
      expect(errors).toEqual([
        `Repository design direction blocked: cannot read ${documentPath}.`,
        `Repository design target ${directory} resolved to ${documentPath}.`,
      ]);
      expect(exitCodes).toEqual([1]);
      expect(existsSync(join(directory, 'design'))).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('a restricted DESIGN.md keeps its permission bits after selecting a system', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-system-mode-'));
    try {
      const documentPath = join(project, 'DESIGN.md');
      writeFileSync(documentPath, '# Design\n');
      chmodSync(documentPath, 0o600);
      expect(await runRepositoryDesignDirection(project, 'minimal', { out: { log: () => {}, error: () => {} } })).toBe(0);
      expect(statSync(documentPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(documentPath, 'utf8')).toContain('- minimal');
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('a symlinked DESIGN.md stays a link and its target receives the direction', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-system-link-'));
    try {
      mkdirSync(join(project, 'docs'));
      const real = join(project, 'docs', 'DESIGN-real.md');
      writeFileSync(real, '# Design\n');
      symlinkSync('docs/DESIGN-real.md', join(project, 'DESIGN.md'));
      expect(await runRepositoryDesignDirection(project, 'minimal', { out: { log: () => {}, error: () => {} } })).toBe(0);
      expect(lstatSync(join(project, 'DESIGN.md')).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, 'utf8')).toContain('- minimal');
      expect(readdirSync(join(project, 'docs')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('--set minimal copies both bundled files verbatim and writes three direction lines', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-system-'));
    try {
      const documentPath = join(project, 'DESIGN.md');
      writeFileSync(documentPath, '# Design\n\n## Craft rulebooks\n\n- color\n');
      const output: string[] = [];
      expect(await runRepositoryDesignDirection(project, 'minimal', {
        out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      })).toBe(0);
      expect(readFileSync(join(project, 'design/system/DESIGN.md'), 'utf8'))
        .toBe(readFileSync(join(defaultDesignSystemsDir(), 'minimal/DESIGN.md'), 'utf8'));
      expect(readFileSync(join(project, 'design/system/tokens.css'), 'utf8'))
        .toBe(readFileSync(join(defaultDesignSystemsDir(), 'minimal/tokens.css'), 'utf8'));
      const commit = listDesignSystems(defaultDesignSystemsDir()).find((system) => system.id === 'minimal')!.sourceCommit.slice(0, 10);
      expect(readFileSync(documentPath, 'utf8')).toContain(`## Design direction\n\n- minimal\n- tokens: design/system/tokens.css\n- source: open-design@${commit}\n`);
      expect(readFileSync(documentPath, 'utf8')).toContain('- color');
      expect(output).toEqual([`Design document: ${documentPath}`, 'Design direction: minimal']);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('replacing an existing direction with a system replaces only that section with three lines', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-system-replace-'));
    try {
      const documentPath = join(project, 'DESIGN.md');
      writeFileSync(documentPath, '# Design\n\n## Design direction\n\n- old-theme\n\n## Craft rulebooks\n\n- color\n');
      expect(await runRepositoryDesignDirection(project, 'minimal', { out: { log: () => {}, error: () => {} } })).toBe(0);
      const document = readFileSync(documentPath, 'utf8');
      const commit = listDesignSystems(defaultDesignSystemsDir()).find((system) => system.id === 'minimal')!.sourceCommit.slice(0, 10);
      expect(document).toContain(`## Design direction\n\n- minimal\n- tokens: design/system/tokens.css\n- source: open-design@${commit}\n\n## Craft rulebooks`);
      expect(document).not.toContain('- old-theme');
      expect(document).toContain('- color');
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('a conflicting system file blocks selection without changing user files or the declaration', async () => {
    for (const conflictingFile of ['DESIGN.md', 'tokens.css']) {
      const project = mkdtempSync(join(tmpdir(), 'repo-system-conflict-'));
      try {
        const documentPath = join(project, 'DESIGN.md');
        const original = '# Design\n\n## Design direction\n\n- nord-light\n';
        writeFileSync(documentPath, original);
        const destination = join(project, 'design', 'system');
        mkdirSync(destination, { recursive: true });
        const source = join(defaultDesignSystemsDir(), 'minimal');
        for (const file of ['DESIGN.md', 'tokens.css']) {
          writeFileSync(join(destination, file), file === conflictingFile ? 'user customization\n' : readFileSync(join(source, file), 'utf8'));
        }
        const errors: string[] = [];
        expect(await runRepositoryDesignDirection(project, 'minimal', {
          out: { log: () => {}, error: (line) => errors.push(line) },
        })).toBe(1);
        expect(errors).toContain(`Repository design direction blocked: conflicting system file ${join(destination, conflictingFile)}; preserve or move the existing file before retrying.`);
        expect(readFileSync(documentPath, 'utf8')).toBe(original);
        expect(readFileSync(join(destination, conflictingFile), 'utf8')).toBe('user customization\n');
        const otherFile = conflictingFile === 'DESIGN.md' ? 'tokens.css' : 'DESIGN.md';
        expect(readFileSync(join(destination, otherFile), 'utf8')).toBe(readFileSync(join(source, otherFile), 'utf8'));
      } finally { rmSync(project, { recursive: true, force: true }); }
    }
  });

  test('selecting a system twice preserves identical existing files', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-system-repeat-'));
    try {
      writeFileSync(join(project, 'DESIGN.md'), '# Design\n');
      expect(await runRepositoryDesignDirection(project, 'minimal', { out: { log: () => {}, error: () => {} } })).toBe(0);
      const destination = join(project, 'design', 'system');
      const before = ['DESIGN.md', 'tokens.css'].map((file) => readFileSync(join(destination, file), 'utf8'));
      expect(await runRepositoryDesignDirection(project, 'minimal', { out: { log: () => {}, error: () => {} } })).toBe(0);
      expect(['DESIGN.md', 'tokens.css'].map((file) => readFileSync(join(destination, file), 'utf8'))).toEqual(before);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('an injected write blocker cannot create files or directories through live filesystem defaults', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-system-blocked-'));
    try {
      const original = '# Design\n';
      writeFileSync(join(project, 'DESIGN.md'), original);
      expect(await runRepositoryDesignDirection(project, 'minimal', {
        writeFile: () => { throw new Error('writes blocked'); },
        out: { log: () => {}, error: () => {} },
      })).toBe(1);
      expect(existsSync(join(project, 'design'))).toBe(false);
      expect(readFileSync(join(project, 'DESIGN.md'), 'utf8')).toBe(original);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('complete injected filesystem writes a system without touching the live disk', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-system-virtual-'));
    try {
      const documentPath = join(project, 'DESIGN.md');
      const virtualFiles = new Map<string, string>([[documentPath, '# Design\n']]);
      const virtualDirs = new Set([project]);
      const sourceDir = defaultDesignSystemsDir();
      const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
      expect(await runRepositoryDesignDirection(project, 'minimal', {
        readFile: (path) => {
          if (virtualFiles.has(path)) return virtualFiles.get(path)!;
          if (path.startsWith(sourceDir)) return readFileSync(path, 'utf8');
          throw missing();
        },
        readdir: (path) => { if (!virtualDirs.has(path)) throw missing(); return []; },
        writeFile: (path, content, options) => {
          if (options?.exclusive && virtualFiles.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          virtualFiles.set(path, content);
          options?.onCreated?.();
        },
        mkdir: (path) => { virtualDirs.add(path); },
        removeFile: (path) => { virtualFiles.delete(path); },
        removeDir: (path) => { virtualDirs.delete(path); },
        renameFile: (from, to) => { virtualFiles.set(to, virtualFiles.get(from)!); virtualFiles.delete(from); },
        out: { log: () => {}, error: () => {} },
      })).toBe(0);
      expect(virtualFiles.get(join(project, 'design/system/tokens.css'))).toBe(readFileSync(join(sourceDir, 'minimal/tokens.css'), 'utf8'));
      expect(virtualFiles.get(join(project, 'design/system/DESIGN.md'))).toBe(readFileSync(join(sourceDir, 'minimal/DESIGN.md'), 'utf8'));
      expect(virtualFiles.get(documentPath)).toContain('- minimal\n- tokens: design/system/tokens.css\n');
      expect(existsSync(join(project, 'design'))).toBe(false);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('a virtual filesystem uses only injected operations, then rolls back only newly created paths on document failure', async () => {
    const project = '/virtual/project';
    const documentPath = join(project, 'DESIGN.md');
    const designDir = join(project, 'design');
    const systemDir = join(designDir, 'system');
    const existingPath = join(systemDir, 'DESIGN.md');
    const tokensPath = join(systemDir, 'tokens.css');
    const source = join(defaultDesignSystemsDir(), 'minimal');
    const original = '# Design\n';
    const files = new Map<string, string>([[documentPath, original], [existingPath, readFileSync(join(source, 'DESIGN.md'), 'utf8')]]);
    const dirs = new Set([project, designDir, systemDir]);
    const errors: string[] = [];
    const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
    const deps = {
      readdir: (path: string) => { if (!dirs.has(path)) throw missing(); return []; },
      readFile: (path: string, _encoding: 'utf8') => {
        if (files.has(path)) return files.get(path)!;
        if (path.startsWith(defaultDesignSystemsDir())) return readFileSync(path, 'utf8');
        throw missing();
      },
      writeFile: (path: string, content: string, options?: { exclusive?: boolean; onCreated?: () => void }) => {
        if (path.startsWith(`${documentPath}.`) && path.endsWith('.tmp')) throw new Error('document write failed');
        if (options?.exclusive && files.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        files.set(path, content);
        options?.onCreated?.();
      },
      mkdir: (path: string) => { dirs.add(path); },
      removeFile: (path: string) => { files.delete(path); },
      removeDir: (path: string) => { dirs.delete(path); },
      renameFile: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from); },
      out: { log: () => {}, error: (line: string) => errors.push(line) },
    };
    expect(await runRepositoryDesignDirection(project, 'minimal', deps)).toBe(1);
    expect(errors).toContain(`Repository design direction blocked: cannot write ${documentPath}.`);
    expect(files.get(documentPath)).toBe(original);
    expect(files.get(existingPath)).toBe(readFileSync(join(source, 'DESIGN.md'), 'utf8'));
    expect(files.has(tokensPath)).toBe(false);
    expect(dirs.has(designDir)).toBe(true);
    expect(dirs.has(systemDir)).toBe(true);
  });

  test('a confirmed exclusive create with a partial write is removed before failure returns', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-system-partial-'));
    try {
      const documentPath = join(project, 'DESIGN.md');
      const destination = join(project, 'design/system');
      writeFileSync(documentPath, '# Design\n');
      expect(await runRepositoryDesignDirection(project, 'minimal', {
        readFile: (path) => readFileSync(path, 'utf8'),
        readdir: (path) => readdirSync(path),
        writeFile: (path, content, options) => {
          const fd = openSync(path, 'wx');
          options?.onCreated?.();
          try {
            writeFileSync(fd, path === join(destination, 'tokens.css') ? content.slice(0, 10) : content);
            if (path === join(destination, 'tokens.css')) throw new Error('partial write');
          } finally { closeSync(fd); }
        },
        mkdir: (path) => mkdirSync(path),
        removeFile: (path) => rmSync(path),
        removeDir: (path) => rmdirSync(path),
        renameFile: (from, to) => renameSync(from, to),
        out: { log: () => {}, error: () => {} },
      })).toBe(1);
      expect(existsSync(join(project, 'design'))).toBe(false);
      expect(readFileSync(documentPath, 'utf8')).toBe('# Design\n');
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('partial staged document write preserves the original and removes the temporary file', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-system-partial-document-'));
    try {
      const documentPath = join(project, 'DESIGN.md');
      const original = '# Design\n\n## Craft rulebooks\n\n- color\n';
      writeFileSync(documentPath, original);
      let stagedPath: string | undefined;
      expect(await runRepositoryDesignDirection(project, 'minimal', {
        readFile: (path) => readFileSync(path, 'utf8'),
        readdir: (path) => readdirSync(path),
        writeFile: (path, content, options) => {
          const fd = openSync(path, 'wx');
          options?.onCreated?.();
          try {
            if (path.startsWith(`${documentPath}.`) && path.endsWith('.tmp')) {
              stagedPath = path;
              writeFileSync(fd, content.slice(0, 9));
              throw new Error('partial staged document write');
            }
            writeFileSync(fd, content);
          } finally { closeSync(fd); }
        },
        mkdir: (path) => mkdirSync(path),
        removeFile: (path) => rmSync(path),
        removeDir: (path) => rmdirSync(path),
        renameFile: (from, to) => renameSync(from, to),
        out: { log: () => {}, error: () => {} },
      })).toBe(1);
      expect(readFileSync(documentPath, 'utf8')).toBe(original);
      expect(existsSync(join(project, 'design'))).toBe(false);
      expect(stagedPath).toBeDefined();
      expect(existsSync(stagedPath!)).toBe(false);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('non-EEXIST failure before exclusive creation preserves a concurrent writer’s file', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-system-failed-create-'));
    try {
      const documentPath = join(project, 'DESIGN.md');
      const original = '# Design\n';
      const collision = join(project, 'design/system/tokens.css');
      writeFileSync(documentPath, original);
      expect(await runRepositoryDesignDirection(project, 'minimal', {
        readFile: (path) => readFileSync(path, 'utf8'),
        readdir: (path) => readdirSync(path),
        writeFile: (path, content, options) => {
          if (path === collision) {
            writeFileSync(path, 'concurrent author\n');
            throw Object.assign(new Error('failed before exclusive create'), { code: 'EIO' });
          }
          const fd = openSync(path, 'wx');
          options?.onCreated?.();
          try { writeFileSync(fd, content); } finally { closeSync(fd); }
        },
        mkdir: (path) => mkdirSync(path),
        removeFile: (path) => rmSync(path),
        removeDir: (path) => rmdirSync(path),
        renameFile: (from, to) => renameSync(from, to),
        out: { log: () => {}, error: () => {} },
      })).toBe(1);
      expect(readFileSync(collision, 'utf8')).toBe('concurrent author\n');
      expect(existsSync(join(project, 'design/system/DESIGN.md'))).toBe(false);
      expect(readFileSync(documentPath, 'utf8')).toBe(original);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('exclusive-write collision preserves the file created between preflight and write', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-system-race-'));
    try {
      const documentPath = join(project, 'DESIGN.md');
      const destination = join(project, 'design/system');
      const collision = join(destination, 'tokens.css');
      const original = '# Design\n';
      writeFileSync(documentPath, original);
      const errors: string[] = [];
      expect(await runRepositoryDesignDirection(project, 'minimal', {
        readFile: (path) => readFileSync(path, 'utf8'),
        readdir: (path) => readdirSync(path),
        writeFile: (path, content, options) => {
          if (path === join(destination, 'DESIGN.md')) writeFileSync(collision, 'someone else\n', 'utf8');
          writeFileSync(path, content, { encoding: 'utf8', flag: options?.exclusive ? 'wx' : 'w' });
          options?.onCreated?.();
        },
        mkdir: (path) => mkdirSync(path),
        removeFile: (path) => rmSync(path),
        removeDir: (path) => rmdirSync(path),
        renameFile: (from, to) => renameSync(from, to),
        out: { log: () => {}, error: (line) => errors.push(line) },
      })).toBe(1);
      expect(errors).toContain(`Repository design direction blocked: conflicting system file ${collision}; preserve or move the existing file before retrying.`);
      expect(readFileSync(collision, 'utf8')).toBe('someone else\n');
      expect(existsSync(join(destination, 'DESIGN.md'))).toBe(false);
      expect(readFileSync(documentPath, 'utf8')).toBe(original);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('a failed document write removes only directories and files created by that selection', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-system-rollback-'));
    try {
      const documentPath = join(project, 'DESIGN.md');
      const original = '# Design\n';
      writeFileSync(documentPath, original);
      expect(await runRepositoryDesignDirection(project, 'minimal', {
        readFile: (path) => readFileSync(path, 'utf8'),
        writeFile: (path, content, options) => {
          if (path.startsWith(`${documentPath}.`) && path.endsWith('.tmp')) throw new Error('blocked document');
          writeFileSync(path, content, { encoding: 'utf8', flag: options?.exclusive ? 'wx' : 'w' });
          options?.onCreated?.();
        },
        readdir: (path) => readdirSync(path),
        mkdir: (path) => mkdirSync(path),
        removeFile: (path) => rmSync(path),
        removeDir: (path) => rmdirSync(path),
        renameFile: (from, to) => renameSync(from, to),
        out: { log: () => {}, error: () => {} },
      })).toBe(1);
      expect(existsSync(join(project, 'design'))).toBe(false);
      expect(readFileSync(documentPath, 'utf8')).toBe(original);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('theme --set still writes only its id, without creating system files', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-theme-'));
    try {
      const documentPath = join(project, 'DESIGN.md');
      writeFileSync(documentPath, '# Design\n');
      const theme = listDesignDirections()[0]!.id;
      expect(await runRepositoryDesignDirection(project, theme, { out: { log: () => {}, error: () => {} } })).toBe(0);
      expect(readFileSync(documentPath, 'utf8')).toBe(`# Design\n\n## Design direction\n\n- ${theme}\n`);
      expect(existsSync(join(project, 'design/system'))).toBe(false);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  test('lists bundled systems and themes separately, and rejects unknown ids', async () => {
    const project = mkdtempSync(join(tmpdir(), 'repo-list-'));
    try {
      writeFileSync(join(project, 'DESIGN.md'), '# Design\n');
      const output: string[] = [];
      const errors: string[] = [];
      const deps = { out: { log: (line: string) => output.push(line), error: (line: string) => errors.push(line) } };
      expect(await runRepositoryDesignDirection(project, undefined, deps)).toBe(0);
      expect(listDesignSystems(defaultDesignSystemsDir()).length).toBeGreaterThanOrEqual(50);
      expect(output).toContain(`Design systems (web · tokens) (${listDesignSystems(defaultDesignSystemsDir()).length})`);
      expect(output).toContain(`Terminal themes (${listDesignDirections().length})`);
      const minimal = listDesignSystems(defaultDesignSystemsDir()).find((system) => system.id === 'minimal')!;
      expect(output).toContain(`  minimal  [${minimal.category}] ${minimal.summary}  bg: ${minimal.swatch.bg}  fg: ${minimal.swatch.fg}  accent: ${minimal.swatch.accent}`);
      expect(await runRepositoryDesignDirection(project, 'unknown-style-id', deps)).toBe(1);
      expect(errors).toContain('Repository design direction blocked: unknown direction unknown-style-id.');
      expect(readFileSync(join(project, 'DESIGN.md'), 'utf8')).toBe('# Design\n');
    } finally { rmSync(project, { recursive: true, force: true }); }
  });
});

describe('repository design target resolution', () => {
  test('resolves no argument, a project directory, and a file path with a failing probe', () => {
    const cwd = '/workspace/default-project';
    const project = '/workspace/explicit-project';
    const file = '/workspace/explicit-project/custom-design.md';
    const readdir = (path: string) => {
      if (path === project) return [];
      throw new Error('ENOTDIR');
    };

    expect(resolveRepositoryDesignTarget(undefined, cwd, readdir)).toBe(resolve(cwd, 'DESIGN.md'));
    expect(resolveRepositoryDesignTarget(project, cwd, readdir)).toBe(join(project, 'DESIGN.md'));
    expect(resolveRepositoryDesignTarget(file, cwd, readdir)).toBe(resolve(file));
  });

  test('resolves relative directory and file targets from the injected cwd rather than process cwd', () => {
    const cwd = '/injected/project';
    const directory = resolve(cwd, 'nested-project');
    const file = resolve(cwd, 'custom/DESIGN.md');
    const readdir = (path: string) => {
      if (path === directory) return [];
      throw new Error('ENOTDIR');
    };

    expect(resolveRepositoryDesignTarget('nested-project', cwd, readdir)).toBe(join(directory, 'DESIGN.md'));
    expect(resolveRepositoryDesignTarget('custom/DESIGN.md', cwd, readdir)).toBe(file);
  });

  test('uses the common resolver from design-check and design-direction', async () => {
    const target = '/workspace/project';
    const documentPath = join(target, 'DESIGN.md');
    const reads: string[] = [];
    const output: string[] = [];
    const deps = {
      readdir: (path: string) => path === target ? [] : [],
      readFile: (path: string) => { reads.push(path); return '# Design\n'; },
      designCraftDirectory: () => '/workspace/craft',
      out: { log: (line: string) => output.push(line), error: () => {} },
    };

    const outcome = resolveRepositoryDesignCheck(target, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.documentPath).toBe(documentPath);
    expect(await runRepositoryDesignDirection(target, undefined, deps)).toBe(0);
    expect(reads).toEqual([documentPath, documentPath]);
    expect(output).toContain(`Design document: ${documentPath}`);
  });

  test('renders the resolved document before reporting a successful direction selection', async () => {
    const documentPath = '/workspace/project/DESIGN.md';
    const chosen = listDesignDirections()[0]?.id;
    const output: string[] = [];
    const writes: Array<[string, string]> = [];

    expect(chosen).toBeDefined();
    expect(await runRepositoryDesignDirection(documentPath, chosen, {
      readdir: () => { throw new Error('ENOTDIR'); },
      readFile: () => '# Design\n',
      writeFile: (path, contents) => writes.push([path, contents]),
      out: { log: (line) => output.push(line), error: () => {} },
    })).toBe(0);

    expect(output).toEqual([
      `Design document: ${documentPath}`,
      `Design direction: ${chosen}`,
    ]);
    expect(writes).toEqual([[documentPath, expect.stringContaining(`- ${chosen}`)]]);
  });

  test('succeeds when a directory target contains DESIGN.md and preserves file-target success', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'repo-design-target-'));
    const documentPath = join(directory, 'DESIGN.md');
    const output: string[] = [];
    writeFileSync(documentPath, '# Design\n\n## Craft rulebooks\n\n', 'utf8');
    try {
      const deps = {
        readdir: (path: string) => {
          if (path === directory) return readdirSync(path);
          if (path === '/workspace/craft') return [];
          throw new Error('ENOTDIR');
        },
        readFile: (path: string, encoding: 'utf8') => readFileSync(path, encoding),
        designCraftDirectory: () => '/workspace/craft',
        out: { log: (line: string) => output.push(line), error: (line: string) => output.push(`error:${line}`) },
      };
      expect(await runRepositoryDesignCheck(directory, deps)).toBe(0);
      expect(await runRepositoryDesignCheck(documentPath, deps)).toBe(0);
      expect(output).toEqual([
        `Design document: ${documentPath}`,
        'Craft rulebooks directory: /workspace/craft',
        'Available craft rulebooks: 0 (declared: 0)',
        'Declared craft rulebooks: (none)',
        'Unavailable craft rulebooks: (none)',
        `Design document: ${documentPath}`,
        'Craft rulebooks directory: /workspace/craft',
        'Available craft rulebooks: 0 (declared: 0)',
        'Declared craft rulebooks: (none)',
        'Unavailable craft rulebooks: (none)',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('adds target mapping only after the unchanged blocked line when a directory resolution fails', async () => {
    const errors: string[] = [];
    const target = '/workspace/project';
    const documentPath = join(target, 'DESIGN.md');
    const code = await runRepositoryDesignCheck(target, {
      readdir: (path: string) => path === target ? [] : [],
      readFile: () => { throw new Error('ENOENT'); },
      designCraftDirectory: () => '/workspace/craft',
      out: { log: () => {}, error: (line) => errors.push(line) },
    });

    expect(code).toBe(1);
    expect(errors).toEqual([
      `Repository design check blocked: cannot read ${documentPath}.`,
      `Repository design target ${target} resolved to ${documentPath}.`,
    ]);
  });

  test('omits target mapping when an explicit file path fails', async () => {
    const errors: string[] = [];
    const target = '/workspace/missing-DESIGN.md';
    const code = await runRepositoryDesignCheck(target, {
      readdir: (path: string) => {
        if (path === '/workspace/craft') return [];
        throw new Error('ENOTDIR');
      },
      readFile: () => { throw new Error('ENOENT'); },
      designCraftDirectory: () => '/workspace/craft',
      out: { log: () => {}, error: (line) => errors.push(line) },
    });

    expect(code).toBe(1);
    expect(errors).toEqual([`Repository design check blocked: cannot read ${target}.`]);
  });
});

describe('repository design-check CLI default rulebooks', () => {
  test('uses the repository craft rulebooks from external working directories and excludes non-rulebook files', async () => {
    const firstOutput: string[] = [];
    const secondOutput: string[] = [];
    const document = '# Design\n\n## Craft rulebooks\n\n- anti-ai-slop\n- accessibility-baseline\n';
    const nonRulebookDocument = '# Design\n\n## Craft rulebooks\n\n- LICENSE\n';
    const originalCwd = process.cwd();
    const externalCwds = [
      mkdtempSync(join(tmpdir(), 'repo-design-check-a-')),
      mkdtempSync(join(tmpdir(), 'repo-design-check-b-')),
    ];
    const craftDirectories: string[] = [];
    const runFrom = async (cwd: string, output: string[]) => {
      process.chdir(cwd);
      return runRepositoryDesignCheck('/external-project/DESIGN.md', {
        readdir: (directory) => {
          if (directory.endsWith('DESIGN.md')) throw new Error('ENOTDIR');
          craftDirectories.push(directory);
          return readdirSync(directory);
        },
        readFile: () => document,
        out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      });
    };

    try {
      expect(await runFrom(externalCwds[0], firstOutput)).toBe(0);
      expect(await runFrom(externalCwds[1], secondOutput)).toBe(0);
    } finally {
      process.chdir(originalCwd);
      for (const cwd of externalCwds) rmSync(cwd, { recursive: true, force: true });
    }

    expect(craftDirectories).toHaveLength(2);
    expect(craftDirectories[0]).toBe(craftDirectories[1]);
    expect(existsSync(craftDirectories[0])).toBe(true);
    expect(readdirSync(craftDirectories[0])).toEqual(expect.arrayContaining(['anti-ai-slop.md', 'accessibility-baseline.md', 'NOTICE.md', 'LICENSE']));
    expect(firstOutput).toEqual([
      'Design document: /external-project/DESIGN.md',
      `Craft rulebooks directory: ${craftDirectories[0]}`,
      'Available craft rulebooks: 11 (declared: 2)',
      'Declared craft rulebooks: anti-ai-slop, accessibility-baseline',
      'Unavailable craft rulebooks: (none)',
    ]);
    expect(secondOutput).toEqual(firstOutput);

    const filteredOutput: string[] = [];
    expect(await runRepositoryDesignCheck('/external-project/DESIGN.md', {
      readdir: (directory) => readdirSync(directory),
      readFile: () => nonRulebookDocument,
      out: { log: (line) => filteredOutput.push(line), error: (line) => filteredOutput.push(`error:${line}`) },
    })).toBe(1);
    expect(filteredOutput).toEqual([
      'Design document: /external-project/DESIGN.md',
      `Craft rulebooks directory: ${craftDirectories[0]}`,
      'Available craft rulebooks: 11 (declared: 1)',
      'Declared craft rulebooks: LICENSE',
      'Unavailable craft rulebooks: LICENSE',
    ]);

    const noticeOutput: string[] = [];
    expect(await runRepositoryDesignCheck('/external-project/DESIGN.md', {
      readdir: (directory) => readdirSync(directory),
      readFile: () => '# Design\n\n## Craft rulebooks\n\n- NOTICE\n',
      out: { log: (line) => noticeOutput.push(line), error: (line) => noticeOutput.push(`error:${line}`) },
    })).toBe(1);
    expect(noticeOutput).toEqual([
      'Design document: /external-project/DESIGN.md',
      `Craft rulebooks directory: ${craftDirectories[0]}`,
      'Available craft rulebooks: 11 (declared: 1)',
      'Declared craft rulebooks: NOTICE',
      'Unavailable craft rulebooks: NOTICE',
    ]);
  });
});

describe('repository command help', () => {
  test('names directory-only and directory-or-DESIGN.md targets in command help', () => {
    const program = new Command();
    registerRepoCommands(program);
    const repo = program.commands.find((command) => command.name() === 'repo');
    const commands = new Map(repo?.commands.map((command) => [command.name(), command]));

    for (const name of ['public', 'scaffold', 'publish']) {
      expect(commands.get(name)?.usage()).toContain('[project-directory]');
      expect(commands.get(name)?.description()).toContain('프로젝트 디렉토리');
    }
    for (const name of ['design-check', 'design-direction']) {
      expect(commands.get(name)?.usage()).toContain('[project-directory-or-design-path]');
      expect(commands.get(name)?.description()).toContain('프로젝트 디렉토리 또는 DESIGN.md 경로');
    }
  });
});

describe('repository design CLI command wiring', () => {
  test('registered design-check and design-direction commands render their successful document evidence', async () => {
    const output: string[] = [];
    const exitCodes: number[] = [];
    const documentPath = '/workspace/project/DESIGN.md';
    const chosen = listDesignDirections()[0]?.id;
    const program = new Command();
    registerRepoCommands(program, {
      readdir: (path: string) => {
        if (path === '/workspace/craft') return ['color.md'];
        throw new Error('ENOTDIR');
      },
      readFile: () => '# Design\n\n## Craft rulebooks\n\n- color\n',
      writeFile: () => {},
      designCraftDirectory: () => '/workspace/craft',
      out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      setExitCode: (code) => exitCodes.push(code),
    });

    expect(chosen).toBeDefined();
    await program.parseAsync(['node', 'test', 'repo', 'design-check', documentPath]);
    await program.parseAsync(['node', 'test', 'repo', 'design-direction', documentPath]);
    await program.parseAsync(['node', 'test', 'repo', 'design-direction', '--set', chosen!, documentPath]);

    expect(output.filter((line) => line === `Design document: ${documentPath}`)).toHaveLength(3);
    expect(output).toContain('Craft rulebooks directory: /workspace/craft');
    expect(output).toContain('Available craft rulebooks: 1 (declared: 1)');
    expect(output).toContain('Declared craft rulebooks: color');
    expect(output).toContain('Unavailable craft rulebooks: (none)');
    expect(exitCodes).toEqual([]);
  });
});

describe('repository design-archive CLI', () => {
  const execute = async (record: ArchiveRecord, args: string[]) => {
    const output: string[] = [];
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerRepoCommands(program, {
      runArchive: async () => record,
      out: { log: (line) => output.push(line), error: (line) => errors.push(line) },
      setExitCode: (code) => exitCodes.push(code),
    });
    await program.parseAsync(['node', 'test', 'repo', 'design-archive', 'https://example.test', ...args]);
    return { output, errors, exitCodes };
  };

  test('fails an explicitly requested archive that was not retained while preserving its rejection and derived upload output', async () => {
    const result = await execute(archiveRecord(), ['--archive-bucket', 'public', '--upload']);

    expect(result.output).toContain('  ☁️ 공개     s3://public/derived/DESIGN.md');
    expect(result.output).toContain('  🔒 원문     🔴 public: 공개 읽기 정책');
    expect(result.errors).toEqual(['✗ 요청한 원문 보관이 이뤄지지 않았다 — --archive-bucket과 --upload를 확인하라']);
    expect(result.exitCodes).toEqual([1]);
  });

  test('preserves success when the requested archive was retained and when no archive bucket was requested', async () => {
    const retained = await execute(archiveRecord({ archiveNote: '✅ private(비공개) 로 ***2개*** 보관', archivedCount: 2 }), ['--archive-bucket', 'private', '--upload']);
    const localOnly = await execute(archiveRecord(), []);

    expect(retained.exitCodes).toEqual([]);
    expect(localOnly.exitCodes).toEqual([]);
  });

  test('preserves the existing obtained-nothing failure and its human-readable line', async () => {
    const result = await execute(archiveRecord({ originFiles: 0, tokens: null, fullPageScreenshot: { bytes: 0, dimensions: '못 쟀다' } }), ['--archive-bucket', 'public', '--upload']);

    expect(result.errors).toEqual(['✗ 아무것도 못 얻었다 — 원문 0개 · 캡처 0바이트 · 토큰 없음']);
    expect(result.exitCodes).toEqual([1]);
  });
});

describe('repository design-screen-contrast CLI', () => {
  test('registers help and emits human-readable threshold findings with exit code 1', async () => {
    const output: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerRepoCommands(program, {
      readFile: () => '\x1b[38;2;0;0;0mfaint\x1b[0m',
      out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      setExitCode: (code) => exitCodes.push(code),
    });
    const repo = program.commands.find((command) => command.name() === 'repo');
    const command = repo?.commands.find((candidate) => candidate.name() === 'design-screen-contrast');

    expect(command?.usage()).toContain('<ansi-path>');
    expect(command?.description()).toContain('elanous pty snapshot <ref> --ansi');
    expect(command?.options.map((option) => option.flags)).toEqual(expect.arrayContaining([
      '--background <hex>', '--foreground <hex>', '--threshold <n>', '--json',
    ]));
    expect(command?.options.find((option) => option.flags === '--foreground <hex>')?.description).toBe('터미널 기본 전경색 (#rrggbb)');
    await program.parseAsync(['node', 'test', 'repo', 'design-screen-contrast', '/workspace/faint.ansi', '--background', '#000000']);

    expect(output).toContain('below-threshold: "faint" 1.00:1');
    expect(output).toContain('unresolved: 0');
    expect(exitCodes).toEqual([1]);
  });

  test('forwards an explicit terminal foreground and preserves absence as unresolved', async () => {
    const withForegroundOutput: string[] = [];
    const withoutForegroundOutput: string[] = [];
    const withForegroundProgram = new Command();
    const withoutForegroundProgram = new Command();
    const depsFor = (output: string[]) => ({
      readFile: () => 'implicit-foreground',
      out: { log: (line: string) => output.push(line), error: () => {} },
      setExitCode: () => {},
    });
    registerRepoCommands(withForegroundProgram, depsFor(withForegroundOutput));
    registerRepoCommands(withoutForegroundProgram, depsFor(withoutForegroundOutput));

    await withForegroundProgram.parseAsync([
      'node', 'test', 'repo', 'design-screen-contrast', '/workspace/implicit.ansi',
      '--background', '#000000', '--foreground', '#000000',
    ]);
    await withoutForegroundProgram.parseAsync([
      'node', 'test', 'repo', 'design-screen-contrast', '/workspace/implicit.ansi', '--background', '#000000',
    ]);

    expect(withForegroundOutput).toEqual(expect.arrayContaining(['measured: 1', 'unresolved: 0']));
    expect(withoutForegroundOutput).toEqual(expect.arrayContaining(['measured: 0', 'unresolved: 1']));
  });

  test('fails when no contrast run was measured and unresolved runs remain', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerRepoCommands(program, {
      readFile: () => '\x1b[31munresolved\x1b[0m',
      out: { log: (line) => output.push(line), error: (line) => errors.push(line) },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['node', 'test', 'repo', 'design-screen-contrast', '/workspace/unresolved.ansi']);

    expect(output).toEqual(expect.arrayContaining(['measured: 0', 'unresolved: 1']));
    expect(errors).toEqual(['✗ 대비를 잰 묶음이 없고 못 잰 묶음이 남아 있다 — 깨끗한 결과가 아니다']);
    expect(exitCodes).toEqual([1]);
  });

  test('preserves exit 0 for an empty ANSI snapshot with nothing unresolved', async () => {
    const exitCodes: number[] = [];
    const program = new Command();
    registerRepoCommands(program, {
      readFile: () => '',
      out: { log: () => {}, error: () => {} },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['node', 'test', 'repo', 'design-screen-contrast', '/workspace/empty.ansi']);

    expect(exitCodes).toEqual([]);
  });

  test('emits JSON and exits 0 for a passing ANSI snapshot', async () => {
    const output: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerRepoCommands(program, {
      readFile: () => '\x1b[38;2;255;0;0mred\x1b[38;2;0;255;0mgreen\x1b[0m',
      out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['node', 'test', 'repo', 'design-screen-contrast', '/workspace/clear.ansi', '--background', '#000000', '--json']);

    expect(JSON.parse(output[0]!)).toMatchObject({ report: { findings: [], unresolved: 0 } });
    expect(exitCodes).toEqual([]);
  });

  test('reports an unreadable ANSI file as one safe line with exit code 2', async () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerRepoCommands(program, {
      readFile: () => { throw new Error('ENOENT: source details and stack trace'); },
      out: { log: () => {}, error: (line) => errors.push(line) },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['node', 'test', 'repo', 'design-screen-contrast', '/workspace/missing.ansi']);

    expect(errors).toEqual(['Cannot read ANSI snapshot: /workspace/missing.ansi.']);
    expect(errors.join('\n')).not.toContain('ENOENT');
    expect(errors.join('\n')).not.toContain('stack trace');
    expect(exitCodes).toEqual([2]);
  });

  test('reports invalid threshold as an input error rather than a read failure', async () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerRepoCommands(program, {
      readFile: () => '\x1b[38;2;255;255;255mclear\x1b[0m',
      out: { log: () => {}, error: (line) => errors.push(line) },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['node', 'test', 'repo', 'design-screen-contrast', '/workspace/clear.ansi', '--background', '#000000', '--threshold', '0']);

    expect(errors).toEqual(['✗ Invalid threshold: 0. Expected a positive number.']);
    expect(errors.join('\n')).not.toContain('Cannot read ANSI snapshot');
    expect(exitCodes).toEqual([1]);
  });

  test('reports invalid background as an input error rather than a read failure', async () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerRepoCommands(program, {
      readFile: () => '\x1b[38;2;255;255;255mclear\x1b[0m',
      out: { log: () => {}, error: (line) => errors.push(line) },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['node', 'test', 'repo', 'design-screen-contrast', '/workspace/clear.ansi', '--background', 'not-a-hex']);

    expect(errors).toEqual(['✗ Invalid background color: not-a-hex. Expected #rrggbb.']);
    expect(errors.join('\n')).not.toContain('Cannot read ANSI snapshot');
    expect(exitCodes).toEqual([1]);
  });
});

describe('repository design command observability', () => {
  test('records divergent design-check verdicts with their returned exit codes', async () => {
    const logs: { category: string; event: string; data?: unknown }[] = [];
    const originalLog = debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      const cleanTarget = '/workspace/clean/DESIGN.md';
      const blockedTarget = '/workspace/blocked/DESIGN.md';
      const cleanCode = await runRepositoryDesignCheck(cleanTarget, {
        readFile: () => '# Design\n\n## Craft rulebooks\n\n- color\n',
        readdir: (path) => {
          if (path === '/workspace/craft') return ['color.md'];
          throw new Error('ENOTDIR');
        },
        designCraftDirectory: () => '/workspace/craft',
        out: { log: () => {}, error: () => {} },
      });
      const blockedCode = await runRepositoryDesignCheck(blockedTarget, {
        readFile: () => { throw new Error('ENOENT'); },
        readdir: (path) => {
          if (path === '/workspace/craft') return [];
          throw new Error('ENOTDIR');
        },
        designCraftDirectory: () => '/workspace/craft',
        out: { log: () => {}, error: () => {} },
      });
      const checkLogs = logs.filter((log) => log.category === 'repo-design-check' && log.event === 'done');

      expect(cleanCode).toBe(0);
      expect(blockedCode).toBe(1);
      expect(checkLogs).toContainEqual(expect.objectContaining({
        data: expect.objectContaining({ target: cleanTarget, exitCode: cleanCode }),
      }));
      expect(checkLogs).toContainEqual(expect.objectContaining({
        data: expect.objectContaining({ target: blockedTarget, exitCode: blockedCode }),
      }));
      const [cleanLog, blockedLog] = checkLogs;
      expect((cleanLog?.data as { verdict: unknown }).verdict).not.toBe((blockedLog?.data as { verdict: unknown }).verdict);

      const defaultCwd = '/workspace/default-project';
      const defaultDocumentPath = join(defaultCwd, 'DESIGN.md');
      expect(await runRepositoryDesignCheck(undefined, {
        cwd: () => defaultCwd,
        readFile: () => '# Design\n',
        readdir: (path) => path === '/workspace/craft' ? [] : [],
        designCraftDirectory: () => '/workspace/craft',
        out: { log: () => {}, error: () => {} },
      })).toBe(0);
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'repo-design-check',
        event: 'done',
        data: expect.objectContaining({ target: defaultDocumentPath, verdict: 'clean', exitCode: 0 }),
      }));
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });

  test('records successful design-direction reads and writes with distinct modes', async () => {
    const logs: { category: string; event: string; data?: unknown }[] = [];
    const originalLog = debug.log;
    const target = '/workspace/project/DESIGN.md';
    const direction = listDesignDirections()[0]!.id;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: unknown) => {
      logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      expect(await runRepositoryDesignDirection(target, undefined, {
        readFile: () => '# Design\n',
        readdir: () => { throw new Error('ENOTDIR'); },
        out: { log: () => {}, error: () => {} },
      })).toBe(0);
      expect(await runRepositoryDesignDirection(target, direction, {
        readFile: () => '# Design\n',
        readdir: () => { throw new Error('ENOTDIR'); },
        writeFile: () => {},
        out: { log: () => {}, error: () => {} },
      })).toBe(0);
      const directionLogs = logs.filter((log) => log.category === 'repo-design-direction' && log.event === 'done');

      expect(directionLogs).toContainEqual(expect.objectContaining({
        data: { target, direction: null, mode: 'read' },
      }));
      expect(directionLogs).toContainEqual(expect.objectContaining({
        data: { target, direction, mode: 'write' },
      }));

      const defaultCwd = '/workspace/default-direction';
      const defaultDocumentPath = join(defaultCwd, 'DESIGN.md');
      expect(await runRepositoryDesignDirection(undefined, undefined, {
        cwd: () => defaultCwd,
        readFile: () => '# Design\n',
        readdir: () => { throw new Error('ENOTDIR'); },
        out: { log: () => {}, error: () => {} },
      })).toBe(0);
      expect(logs).toContainEqual(expect.objectContaining({
        category: 'repo-design-direction',
        event: 'done',
        data: { target: defaultDocumentPath, direction: null, mode: 'read' },
      }));

      const unavailable = 'removed-direction';
      expect(await runRepositoryDesignDirection(target, undefined, {
        readFile: () => `# Design\n\n## Design direction\n\n- ${unavailable}\n`,
        readdir: () => { throw new Error('ENOTDIR'); },
        out: { log: () => {}, error: () => {} },
      })).toBe(1);
      expect(logs.filter((log) => log.category === 'repo-design-direction' && log.event === 'done')).toHaveLength(3);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });
});

describe('repository design-check CLI input errors', () => {
  test('reports an unreadable craft directory with one safe error line and a nonzero code', async () => {
    const errors: string[] = [];
    const code = await runRepositoryDesignCheck('/workspace/DESIGN.md', {
      designCraftDirectory: () => '/workspace/docs/design/craft',
      readdir: () => { throw new Error('ENOENT: source details and stack trace'); },
      out: { log: () => {}, error: (line) => errors.push(line) },
    });

    expect(code).toBe(1);
    expect(errors).toEqual(['Repository design check blocked: cannot read /workspace/docs/design/craft.']);
    expect(errors.join('\n')).not.toContain('ENOENT');
    expect(errors.join('\n')).not.toContain('stack trace');
  });

  test('reports an unreadable file with one safe error line and a nonzero code', async () => {
    const errors: string[] = [];
    const code = await runRepositoryDesignCheck('/workspace/missing-DESIGN.md', {
      readFile: () => { throw new Error('ENOENT: source details and stack trace'); },
      readdir: (path: string) => {
        if (path === '/workspace/missing-DESIGN.md') throw new Error('ENOTDIR');
        return [];
      },
      out: { log: () => {}, error: (line) => errors.push(line) },
    });

    expect(code).toBe(1);
    expect(errors).toEqual(['Repository design check blocked: cannot read /workspace/missing-DESIGN.md.']);
    expect(errors.join('\n')).not.toContain('ENOENT');
    expect(errors.join('\n')).not.toContain('stack trace');
  });

  test('reports a directory through the registered command without raw filesystem details', async () => {
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerRepoCommands(program, {
      readFile: () => { throw new Error('EISDIR: illegal operation on a directory, read'); },
      readdir: () => [],
      out: { log: () => {}, error: (line) => errors.push(line) },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['node', 'test', 'repo', 'design-check', '/workspace/design-directory']);

    expect(errors).toEqual([
      'Repository design check blocked: cannot read /workspace/design-directory/DESIGN.md.',
      'Repository design target /workspace/design-directory resolved to /workspace/design-directory/DESIGN.md.',
    ]);
    expect(errors.join('\n')).not.toContain('EISDIR');
    expect(exitCodes).toEqual([1]);
  });
});

// ── `A4`/`A5` 선결 — 개설을 «잴 수 있나» (2026-08-24) ──
//
// ⛔ 이 시험은 «기능»이 아니라 ***관측***을 문다. 21차가 `A4` 의 판정 기준을
//    「스코프할 프로젝트가 실재해야 한다」로 못 박았는데, 그것을 답할 계측이 «없었다»
//    (`project-scaffold.ts` 의 debug.log = 0). ⇒ 「0행」이 「안 했다」인지
//    「계측이 없다」인지 «구별할 수 없었다».
describe('runRepositoryScaffold — 개설이 «관측에» 남는다', () => {
  test('성공하면 project-scaffold/done 이 «만든 수»와 함께 남는다', async () => {
    debug.enable(); debug.clear();
    await runRepositoryScaffold('/workspace/observed', {
      out: { log: () => {}, error: () => {} },
      scaffoldProject: successfulScaffold,
    });
    const text = debug.tail(20).join('\n');
    expect(text).toContain('[project-scaffold]');
    expect(text).toContain('done');
    expect(text).toContain('"created":1');
    expect(text).toContain('"ignoreAdded":3');
    expect(text).toContain('"ignorePreserved":1');
    debug.disable();
  });

  test('⛔ 막혀도 «남는다» — 성공만 남기면 「막혔다」가 「안 했다」와 같은 0이 된다', async () => {
    debug.enable(); debug.clear();
    await runRepositoryScaffold('/tmp/outside', {
      out: { log: () => {}, error: () => {} },
      scaffoldProject: () => ({ status: 'not-applicable', reason: 'outside-home' }) as ProjectScaffoldResult,
    });
    const text = debug.tail(20).join('\n');
    expect(text).toContain('[project-scaffold]');
    expect(text).toContain('blocked');
    expect(text).toContain('outside-home');
    debug.disable();
  });
});

describe('repo design-direction list with a custom library system', () => {
  test('lists bundled and my systems in separate groups instead of crashing (09-28 live)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-direction-custom-'));
    const library = join(root, 'library');
    const project = join(root, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'DESIGN.md'), '# Design\n');
    const quiet = { log: () => {}, error: () => {} };
    const output: string[] = [];
    try {
      expect(await runRepositoryDesignSystemFromPalette('#1f3a2e,#f4efe6,#c8553d', { id: 'forest-note', base: 'paper' }, {
        designLibraryDirectory: () => library, designSystemsDirectory: defaultDesignSystemsDir, out: quiet,
      })).toBe(0);
      const code = await runRepositoryDesignDirection(project, undefined, {
        designLibraryDirectory: () => library,
        designSystemsDirectory: defaultDesignSystemsDir,
        out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      });
      expect(code).toBe(0);
      const bundledHeader = output.findIndex((line) => line.startsWith('Design systems (web · tokens) ('));
      const customHeader = output.findIndex((line) => line === `My design systems (${library}) (1)`);
      expect(bundledHeader).toBeGreaterThanOrEqual(0);
      expect(customHeader).toBeGreaterThan(bundledHeader);
      expect(output[customHeader + 1]).toContain('forest-note  [Custom]');
      expect(output.slice(bundledHeader + 1, customHeader).some((line) => line.includes('forest-note'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repo design-system from-url extract root', () => {
  const tokens = JSON.stringify({
    customProperties: { '--bg': '#ffffff', '--fg': '#111111' },
  });
  const quiet = { log: () => {}, error: () => {} };
  const fakeExtract = (outRoot: string) => ({
    slug: 'linear-app',
    outDir: join(outRoot, 'linear-app'),
    viewport: { w: 1280, h: 800 },
    tokenCount: 2,
    paletteCount: 2,
    roleCount: 0,
    missingRoles: [] as readonly string[],
    assets: [] as readonly string[],
    assetNote: null,
    honoursReducedMotion: null,
    browserForcedReducedMotion: false,
  });

  test('--out 이 없으면 출력 뿌리가 designExtractRoot 아래이고 cwd 아래가 아니다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-from-url-'));
    const project = join(root, 'project');
    const cache = join(root, 'state', 'design', 'extracts');
    mkdirSync(project, { recursive: true });
    const seen: string[] = [];
    const output: string[] = [];
    try {
      const code = await runRepositoryDesignSystemFromUrl('https://linear.app', {}, {
        cwd: () => project,
        designExtractRoot: () => cache,
        designLibraryDirectory: () => join(root, 'library'),
        designSystemsDirectory: defaultDesignSystemsDir,
        readFile: () => tokens,
        runExtractDesign: async (options) => {
          seen.push(options.outRoot);
          return fakeExtract(options.outRoot);
        },
        out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      });
      expect(code).toBe(0);
      expect(seen).toEqual([cache]);
      expect(seen[0]!.startsWith(project)).toBe(false);
      expect(output.some((line) => line === `추출 원본  ${join(cache, 'linear-app')}`)).toBe(true);
      expect(existsSync(join(project, '.design-extract'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--out 을 주면 그 폴더가 출력 뿌리다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-from-url-out-'));
    const explicit = join(root, 'explicit-out');
    const seen: string[] = [];
    try {
      const code = await runRepositoryDesignSystemFromUrl('https://linear.app', { out: explicit }, {
        cwd: () => join(root, 'project'),
        designExtractRoot: () => join(root, 'unused-cache'),
        designLibraryDirectory: () => join(root, 'library'),
        designSystemsDirectory: defaultDesignSystemsDir,
        readFile: () => tokens,
        runExtractDesign: async (options) => {
          seen.push(options.outRoot);
          return fakeExtract(options.outRoot);
        },
        out: quiet,
      });
      expect(code).toBe(0);
      expect(seen).toEqual([explicit]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--json 에 extractDir 이 있다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-from-url-json-'));
    const cache = join(root, 'cache');
    const output: string[] = [];
    try {
      const code = await runRepositoryDesignSystemFromUrl('https://linear.app', { json: true }, {
        cwd: () => join(root, 'project'),
        designExtractRoot: () => cache,
        designLibraryDirectory: () => join(root, 'library'),
        designSystemsDirectory: defaultDesignSystemsDir,
        readFile: () => tokens,
        runExtractDesign: async (options) => fakeExtract(options.outRoot),
        out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      });
      expect(code).toBe(0);
      const parsed = JSON.parse(output.join('\n')) as { extractDir?: string };
      expect(parsed.extractDir).toBe(join(cache, 'linear-app'));
      expect(output.join('\n')).not.toContain('추출 원본');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repo design-system from-palette', () => {
  test('저장하고 토큰 표와 못 읽은 칸 수와 경로를 낸다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-palette-'));
    const library = join(root, 'library');
    const output: string[] = [];
    try {
      const code = await runRepositoryDesignSystemFromPalette('#ffffff,#111111,#cc3344', {
        id: 'ink-note', name: 'Ink Note', base: 'minimal',
      }, {
        designLibraryDirectory: () => library,
        designSystemsDirectory: defaultDesignSystemsDir,
        out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      });
      expect(code).toBe(0);
      expect(output.some((line) => line.startsWith('bg  #ffffff'))).toBe(true);
      expect(output.some((line) => line.startsWith('accent  #cc3344'))).toBe(true);
      expect(output.some((line) => line.startsWith('못 읽은 칸 '))).toBe(true);
      expect(output.some((line) => line === `저장  ${join(library, 'ink-note')}`)).toBe(true);
      expect(listDesignSystems(library).map((system) => system.id)).toEqual(['ink-note']);
      const program = new Command();
      const logged: string[] = [];
      registerRepoCommands(program, {
        designLibraryDirectory: () => library,
        out: { log: (line) => logged.push(line), error: (line) => logged.push(`error:${line}`) },
        setExitCode: () => {},
      });
      await program.parseAsync(['node', 'test', 'repo', 'design-system', 'from-palette', '#fff,#111', '--id', 'second-ink', '--base', 'minimal']);
      expect(logged.some((line) => line.includes(join(library, 'second-ink')))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repository command standalone log sink registration', () => {
  const surfaces: string[] = [];
  let sinkShouldFail = false;
  let sinkSpy: ReturnType<typeof spyOn>;
  let extractSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    sinkSpy?.mockRestore();
    extractSpy?.mockRestore();
    surfaces.length = 0;
    sinkShouldFail = false;
  });

  const installSinkSpy = () => {
    sinkSpy = spyOn(standaloneLogSink, 'registerStandaloneLogSink').mockImplementation(async (surface: string) => {
      surfaces.push(surface);
      if (sinkShouldFail) throw new Error('logs.db unavailable');
      return true;
    });
  };

  const programFor = (overrides: Parameters<typeof registerRepoCommands>[1] = {}) => {
    const program = new Command();
    registerRepoCommands(program, {
      out: { log: () => {}, error: () => {} },
      setExitCode: () => {},
      ...overrides,
    });
    return program;
  };

  test('each logging repo action registers its own repo-<subcommand> sink', async () => {
    installSinkSpy();
    const documentPath = '/workspace/project/DESIGN.md';
    const designProgram = programFor({
      readdir: (path: string) => {
        if (path === '/workspace/craft') return ['color.md'];
        throw new Error('ENOTDIR');
      },
      readFile: () => '# Design\n\n## Craft rulebooks\n\n- color\n',
      writeFile: () => {},
      designCraftDirectory: () => '/workspace/craft',
    });
    await designProgram.parseAsync(['node', 'test', 'repo', 'design-check', documentPath]);
    await designProgram.parseAsync(['node', 'test', 'repo', 'design-direction', documentPath]);

    extractSpy = spyOn(extractDesignRun, 'runExtractDesign').mockImplementation(async () => ({
      slug: 'example-test',
      outDir: 'design-extract/example-test',
      viewport: { w: 1280, h: 900 },
      tokenCount: 0,
      paletteCount: 0,
      roleCount: 0,
      missingRoles: [],
      assets: [],
      assetNote: '자산 수집을 «건너뛰었다»',
      honoursReducedMotion: null,
      browserForcedReducedMotion: false,
    }));
    const extractProgram = programFor();
    await extractProgram.parseAsync(['node', 'test', 'repo', 'design-extract', 'https://example.test', '--no-assets']);

    const contrastProgram = programFor({
      readFile: () => '',
    });
    await contrastProgram.parseAsync(['node', 'test', 'repo', 'design-screen-contrast', '/workspace/empty.ansi']);

    const archiveProgram = programFor({
      runArchive: async () => archiveRecord(),
    });
    await archiveProgram.parseAsync(['node', 'test', 'repo', 'design-archive', 'https://example.test']);

    expect(surfaces).toEqual([
      'repo-design-check',
      'repo-design-direction',
      'repo-design-extract',
      'repo-design-screen-contrast',
      'repo-design-archive',
    ]);
  });

  test('sink registration failure does not block command execution', async () => {
    installSinkSpy();
    sinkShouldFail = true;
    const output: string[] = [];
    const exitCodes: number[] = [];
    const program = programFor({
      readdir: (path: string) => {
        if (path === '/workspace/craft') return ['color.md'];
        throw new Error('ENOTDIR');
      },
      readFile: () => '# Design\n\n## Craft rulebooks\n\n- color\n',
      designCraftDirectory: () => '/workspace/craft',
      out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync(['node', 'test', 'repo', 'design-check', '/workspace/project/DESIGN.md']);

    expect(surfaces).toEqual(['repo-design-check']);
    expect(output).toContain('Design document: /workspace/project/DESIGN.md');
    expect(exitCodes).toEqual([]);
  });

  test('design-lint --tokens names the tokens file and its source', async () => {
    installSinkSpy();
    const directory = mkdtempSync(join(tmpdir(), 'repo-design-lint-tokens-'));
    const htmlPath = join(directory, 'index.html');
    const tokensPath = join(directory, 'tokens.css');
    writeFileSync(htmlPath, '<h1>Title</h1>', 'utf8');
    writeFileSync(join(directory, 'styles.css'), 'h1 { color: var(--fg); }', 'utf8');
    writeFileSync(join(directory, 'DESIGN.md'), '# Design\n', 'utf8');
    writeFileSync(tokensPath, ':root { --fg: #111111; --font-display: Georgia, serif; }', 'utf8');
    const output: string[] = [];
    const program = programFor({ out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) } });
    try {
      await program.parseAsync(['node', 'test', 'repo', 'design-lint', htmlPath, '--tokens', tokensPath]);
      expect(output.join('\n')).toContain(`토큰    ${tokensPath} (출처 flag)`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('existing public, scaffold, design-lint, and publish sink names stay unchanged', async () => {
    installSinkSpy();
    const program = programFor({
      isTerminal: () => false,
      scaffoldProject: successfulScaffold,
      readFile: () => { throw new Error('ENOENT: missing html'); },
    });

    await program.parseAsync(['node', 'test', 'repo', 'public', '/workspace/public-project']);
    await program.parseAsync(['node', 'test', 'repo', 'scaffold', '/workspace/registered-project']);
    await program.parseAsync(['node', 'test', 'repo', 'design-lint', '/workspace/missing.html']);
    await program.parseAsync(['node', 'test', 'repo', 'publish', '/workspace/publish-project']);

    expect(surfaces).toEqual(['repo-public', 'repo-scaffold', 'repo-design-lint', 'repo-publish']);
  });
});

describe('repository design-gate CLI', () => {
  const gate = (verdict: DesignGateResult['verdict'], reason?: DesignGateResult['reason']): DesignGateResult => ({
    verdict,
    ...(reason ? { reason } : {}),
    direction: verdict === 'not-applicable' && reason !== 'no-html' ? null : 'editorial',
    tokensSource: verdict === 'not-applicable' ? null : 'design-direction',
    p0Total: verdict === 'fail' ? 1 : 0,
    advisoryTotal: 0,
    files: verdict === 'not-applicable' ? [] : [{
      path: 'index.html',
      p0: verdict === 'fail' ? 1 : 0,
      advisory: 0,
      skipped: [],
      findings: verdict === 'fail' ? [{ rule: 'display-font-mismatch', severity: 'p0', line: 1 }] : [],
    }],
    truncated: false,
    omitted: 0,
    checkedAt: '2026-09-27T00:00:00.000Z',
  });

  async function run(verdict: DesignGateResult['verdict'], options: { json?: boolean; throw?: boolean; reason?: DesignGateResult['reason'] } = {}) {
    const output: string[] = [];
    const errors: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerRepoCommands(program, {
      cwd: () => '/workspace/sample',
      out: { log: (line) => output.push(line), error: (line) => errors.push(line) },
      setExitCode: (code) => exitCodes.push(code),
      runDesignGate: () => {
        if (options.throw) throw new Error('git failed');
        return gate(verdict, options.reason);
      },
    });
    const args = ['node', 'test', 'repo', 'design-gate', '/workspace/sample'];
    if (options.json) args.push('--json');
    await program.parseAsync(args);
    return { output, errors, exitCodes };
  }

  test('fail exits 1 and the last line parses as the result JSON', async () => {
    const result = await run('fail');
    expect(result.exitCodes).toEqual([1]);
    expect(result.output[0]).toContain('design-gate fail');
    expect(result.output.some((line) => line.includes('display-font-mismatch'))).toBe(true);
    const parsed = JSON.parse(result.output.at(-1)!) as DesignGateResult;
    expect(parsed.verdict).toBe('fail');
    expect(parsed.p0Total).toBeGreaterThanOrEqual(1);
  });

  test('pass exits 0 and still ends with one JSON line', async () => {
    const result = await run('pass');
    expect(result.exitCodes).toEqual([]);
    const parsed = JSON.parse(result.output.at(-1)!) as DesignGateResult;
    expect(parsed.verdict).toBe('pass');
  });

  test('not-applicable exits 0', async () => {
    const result = await run('not-applicable', { reason: 'no-direction' });
    expect(result.exitCodes).toEqual([]);
    const parsed = JSON.parse(result.output.at(-1)!) as DesignGateResult;
    expect(parsed.verdict).toBe('not-applicable');
    expect(parsed.reason).toBe('no-direction');
  });

  test('a git or read failure exits 2', async () => {
    const result = await run('pass', { throw: true });
    expect(result.exitCodes).toEqual([2]);
    expect(result.errors).toEqual(['✗ git failed']);
  });

  test('--json prints only the result object', async () => {
    const result = await run('fail', { json: true });
    expect(result.output).toHaveLength(1);
    expect(JSON.parse(result.output[0]!).verdict).toBe('fail');
    expect(result.exitCodes).toEqual([1]);
  });
});

describe('repository design-preview CLI', () => {
  test('refuses with exit 2 when OpenDesign is not configured', async () => {
    const errors: string[] = [];
    const code = await runRepositoryDesignPreview('/workspace/sample', {
      brief: 'a landing page',
      systems: 'minimal,editorial',
    }, {
      openDesignConfig: () => null,
      out: { log: () => {}, error: (line) => errors.push(line) },
    });

    expect(code).toBe(2);
    expect(errors).toEqual(['OpenDesign 이 설정되지 않았다 — design.openDesign.url · tokenFile']);
  });

  test('--json prints one object per system', async () => {
    const output: string[] = [];
    const exitCodes: number[] = [];
    const program = new Command();
    registerRepoCommands(program, {
      cwd: () => '/workspace',
      openDesignConfig: () => ({ url: 'http://open-design.test', token: 'not-printed' }),
      makeDesignPreviews: async () => ([
        { system: 'minimal', ok: true, path: '/workspace/sample/design/previews/minimal.html', runId: 'run-a', status: 'succeeded' },
        { system: 'editorial', ok: false, runId: 'run-b', status: 'failed', reason: 'failed' },
      ]),
      out: { log: (line) => output.push(line), error: (line) => output.push(`error:${line}`) },
      setExitCode: (code) => exitCodes.push(code),
    });

    await program.parseAsync([
      'node', 'test', 'repo', 'design-preview', 'sample',
      '--brief', 'a landing page',
      '--systems', 'minimal,editorial',
      '--json',
    ]);

    const parsed = JSON.parse(output.join('\n')) as Array<{ system: string; ok: boolean; path?: string; runId?: string; status: string; reason?: string }>;
    expect(parsed).toEqual([
      { system: 'minimal', ok: true, path: '/workspace/sample/design/previews/minimal.html', runId: 'run-a', status: 'succeeded' },
      { system: 'editorial', ok: false, runId: 'run-b', status: 'failed', reason: 'failed' },
    ]);
    expect(output.join('\n')).not.toContain('not-printed');
    expect(exitCodes).toEqual([]);
  });
});
