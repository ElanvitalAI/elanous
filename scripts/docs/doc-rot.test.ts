import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractElanousCommands, type HelpRunner } from '../docs-cli-check.js';
import { defaultManualFiles, extractRepoPaths, scanDocRot } from './doc-rot.js';

const help: HelpRunner = (args) => {
  const key = args.join(' ');
  if (key === '') return { ok: true, out: 'Usage: elanous\n\nCommands:\n  doctor [options]   check\n' };
  if (key === 'doctor') return { ok: true, out: 'Usage: elanous doctor\n\nOptions:\n  --fix   repair\n' };
  return { ok: false, out: '' };
};

describe('doc-rot — 내부 매뉴얼의 명령·경로를 실제와 대조', () => {
  test('bun bin/elanous.mjs 접두도 같은 명령으로 읽는다', () => {
    const refs = extractElanousCommands('x.md', '`bun bin/elanous.mjs doctor --fix`');
    expect(refs.map((ref) => [ref.cmd, ref.flags])).toEqual([['doctor', ['--fix']]]);
  });

  test('줄번호 꼬리는 떼고 glob 은 건너뛴다', () => {
    const found = extractRepoPaths('see `src/does-not-exist.ts:12` and `scripts/*.ts` and `docs/manual/`');
    expect(found).toEqual([{ line: 1, path: 'src/does-not-exist.ts' }]);
  });

  test('없는 명령 1 · 없는 경로 1 · 있는 경로는 missing 아님 · help 실패는 unmeasured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-rot-'));
    const manual = join(dir, 'manual.md');
    writeFileSync(manual, [
      'Run `bun bin/elanous.mjs nosuchcmd` once.',
      'The extractor lives at `scripts/docs-cli-check.ts`.',
      'A missing file is `src/does-not-exist.ts:12`.',
    ].join('\n'));
    const repo = resolve(import.meta.dir, '../..');
    const report = scanDocRot({ files: [manual], repoRoot: repo, help });
    expect(report.files).toHaveLength(1);
    expect(report.files[0]!.commands.filter((finding) => finding.kind === 'unknown-command')).toHaveLength(1);
    expect(report.files[0]!.commands.find((finding) => finding.kind === 'unknown-command')?.detail).toBe('elanous nosuchcmd');
    expect(report.files[0]!.missingPaths).toEqual([{ line: 3, path: 'src/does-not-exist.ts' }]);
    expect(report.files[0]!.missingPaths.some((entry) => entry.path === 'scripts/docs-cli-check.ts')).toBe(false);
    expect(report.totals.badCommands).toBe(1);
    expect(report.totals.missingPaths).toBe(1);
    expect(report.totals.unmeasured).toBe(0);

    const down: HelpRunner = () => ({ ok: false, out: '' });
    const failed = scanDocRot({ files: [manual], repoRoot: repo, help: down });
    expect(failed.files[0]!.commands.map((finding) => finding.kind)).toEqual(['unmeasured']);
    expect(failed.totals.unmeasured).toBe(1);
    expect(failed.totals.badCommands).toBe(0);
    expect(failed.files[0]!.missingPaths).toEqual([{ line: 3, path: 'src/does-not-exist.ts' }]);
  });

  test('래퍼 플래그 · 루트 전역 옵션 · 의도적 실패를 실제 낡음과 따로 센다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-rot-'));
    const manual = join(dir, 'manual.md');
    writeFileSync(manual, [
      '```sh',
      'elanous gh pr list --state open',
      'elanous doctor --config-dir x',
      '⛔ `elanous doctor --was-never-a-flag`',
      'elanous doctor --nope',
      '```',
    ].join('\n'));
    const injected: HelpRunner = (args) => {
      const out: Record<string, string> = {
        '': 'Usage: elanous\n\nOptions:\n  --config-dir <dir>   config\n\nCommands:\n  gh [options]   wrapper\n  doctor [options]   check\n',
        gh: 'Usage: elanous gh\n\nCommands:\n  pr   pull requests\n',
        'gh pr': 'Usage: elanous gh pr\n\nCommands:\n  list   list pull requests\n',
        'gh pr list': 'Usage: elanous gh pr list\n\nOptions:\n  --json   json\n',
        doctor: 'Usage: elanous doctor\n\nOptions:\n  --fix   repair\n',
      };
      return { ok: Object.hasOwn(out, args.join(' ')), out: out[args.join(' ')] ?? '' };
    };
    const report = scanDocRot({ files: [manual], repoRoot: dir, help: injected });
    expect(report.totals).toEqual({
      files: 1, staleFiles: 1, missingPaths: 0, badCommands: 1, unmeasured: 0,
      passthrough: 1, globalFlag: 1, intentional: 1,
    });
    expect(report.files[0]!.commands.map(({ kind, detail }) => [kind, detail])).toEqual([
      ['passthrough', '--state (elanous gh pr list)'],
      ['globalFlag', '--config-dir (elanous doctor)'],
      ['intentional', '--was-never-a-flag (elanous doctor)'],
      ['unknown-flag', '--nope (elanous doctor)'],
    ]);
    const onlyExceptions = scanDocRot({
      files: [manual], repoRoot: dir, help: injected,
      read: () => [
        '`elanous gh pr list --state open`',
        '`elanous doctor --config-dir x`',
        '⛔ `elanous doctor --was-never-a-flag`',
      ].join('\n'),
    });
    expect(onlyExceptions.totals.staleFiles).toBe(0);
    expect(onlyExceptions.totals.badCommands).toBe(0);
  });

  test('루트 Options 조회만 실패하면 하위 help 성공의 unknown-flag 는 unmeasured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-rot-'));
    const manual = join(dir, 'manual.md');
    writeFileSync(manual, [
      '`elanous doctor --config-dir x`',
      '`elanous doctor --nope`',
      '`elanous gh --state open`',
      '⛔ `elanous doctor --was-never-a-flag`',
    ].join('\n'));
    let rootCalls = 0;
    const injected: HelpRunner = (args) => {
      if (args.length === 0) {
        rootCalls++;
        return rootCalls === 1
          ? { ok: true, out: 'Usage: elanous\n\nCommands:\n  doctor   check\n  gh   wrapper\n' }
          : { ok: false, out: '' };
      }
      if (args[0] === 'doctor' || args[0] === 'gh') return { ok: true, out: 'Usage: elanous command\n' };
      return { ok: false, out: '' };
    };
    const report = scanDocRot({ files: [manual], repoRoot: dir, help: injected });
    expect(rootCalls).toBe(2);
    expect(report.files[0]!.commands.map((finding) => finding.kind)).toEqual([
      'unmeasured', 'unmeasured', 'passthrough', 'intentional',
    ]);
    expect(report.totals.badCommands).toBe(0);
    expect(report.totals.unmeasured).toBe(2);
    expect(report.totals.staleFiles).toBe(0);

    const rootDown: HelpRunner = (args) => args.length === 0
      ? { ok: false, out: '' }
      : { ok: true, out: 'Usage: elanous doctor\n\nOptions:\n  --fix   repair\n' };
    const failed = scanDocRot({ files: [manual], repoRoot: dir, help: rootDown });
    expect(failed.files[0]!.commands.every((finding) => finding.kind === 'unmeasured')).toBe(true);
    expect(failed.totals.unmeasured).toBe(4);
    expect(failed.totals.badCommands).toBe(0);
  });

  test('git 래퍼와 전역 옵션은 가르되 측정 실패는 의도적 줄에서도 unmeasured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-rot-'));
    const manual = join(dir, 'manual.md');
    writeFileSync(manual, [
      '`elanous git status --short`',
      '`elanous doctor --remote x --test`',
      '⛔ `elanous doctor --nope`',
    ].join('\n'));
    const injected: HelpRunner = (args) => {
      const out: Record<string, string> = {
        '': 'Usage: elanous\n\nOptions:\n  -r, --remote [name]   remote\n  --test   isolated\n\nCommands:\n  git   wrapper\n  doctor   check\n',
        git: 'Usage: elanous git\n',
        doctor: 'Usage: elanous doctor\n',
      };
      return { ok: Object.hasOwn(out, args.join(' ')), out: out[args.join(' ')] ?? '' };
    };
    const report = scanDocRot({ files: [manual], repoRoot: dir, help: injected });
    expect(report.files[0]!.commands.map((finding) => finding.kind)).toEqual([
      'passthrough', 'globalFlag', 'globalFlag', 'intentional',
    ]);
    expect([report.totals.badCommands, report.totals.passthrough, report.totals.globalFlag, report.totals.intentional]).toEqual([0, 1, 2, 1]);
    const down = scanDocRot({ files: [manual], repoRoot: dir, help: () => ({ ok: false, out: '' }) });
    expect(down.files[0]!.commands.map((finding) => finding.kind)).toEqual(['unmeasured', 'unmeasured', 'unmeasured']);
    expect(down.totals.unmeasured).toBe(3);
    expect(down.totals.intentional).toBe(0);
  });

  test('래퍼 하위 명령과 은퇴 명령은 계속 낡음으로 남는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-rot-'));
    const manual = join(dir, 'manual.md');
    writeFileSync(manual, '`elanous gh missing --state open`\n`elanous repro`');
    const injected: HelpRunner = (args) => {
      const out: Record<string, string> = {
        '': 'Usage: elanous\n\nCommands:\n  gh [options]   wrapper\n',
        gh: 'Usage: elanous gh\n\nCommands:\n  pr   pull requests\n',
      };
      return { ok: Object.hasOwn(out, args.join(' ')), out: out[args.join(' ')] ?? '' };
    };
    const report = scanDocRot({ files: [manual], repoRoot: dir, help: injected });
    expect(report.files[0]!.commands.map((finding) => finding.kind)).toEqual(['unknown-subcommand', 'unknown-command']);
    expect(report.totals.badCommands).toBe(2);
    expect(report.totals.passthrough).toBe(0);
  });

  test('실제 docs/manual 로 부르면 결과 배열 길이 = 매뉴얼 파일 수', () => {
    const repo = resolve(import.meta.dir, '../..');
    const manuals = defaultManualFiles(repo);
    const counted = readdirSync(join(repo, 'docs', 'manual')).filter((name) => name.endsWith('.md'));
    expect(manuals).toHaveLength(counted.length);
    const report = scanDocRot({
      files: manuals,
      repoRoot: repo,
      help: () => ({ ok: false, out: '' }),
    });
    expect(report.files).toHaveLength(counted.length);
    expect(report.totals.files).toBe(counted.length);
    expect(report.totals.badCommands).toBe(0);
    expect(report.totals.unmeasured).toBeGreaterThan(0);
  });
});
