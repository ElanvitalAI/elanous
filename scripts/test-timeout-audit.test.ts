import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditTimeouts, classifyTimeouts, main } from './test-timeout-audit';

// Local git fixtures and Bun subprocess checks can exceed the 5 s default on gate pods.
setDefaultTimeout(60_000);

const spawn = "import { spawnSync } from 'node:child_process';\ntest('x', () => { spawnSync('bun', ['scripts/hello.ts']); });\n";

describe('real-process timeout audit', () => {
  test('classifies missing, file default, per-test and excludes no-spawn files', () => {
    const root = mkdtempSync(join(tmpdir(), 'timeout-audit-'));
    const files = ['missing.test.ts', 'default.test.ts', 'per-test.test.ts', 'no-spawn.test.ts'];
    const contents = [
      spawn,
      "import { setDefaultTimeout } from 'bun:test';\nsetDefaultTimeout(60_000);\n" + spawn,
      "import { spawnSync } from 'node:child_process';\ntest('x', () => { spawnSync('bun', ['scripts/hello.ts']); }, 30_000);\n",
      "test('x', () => expect(true).toBe(true));\n",
    ];
    try {
      files.forEach((file, index) => writeFileSync(join(root, file), contents[index]!));
      expect(auditTimeouts(root, files)).toEqual([
        { file: 'default.test.ts', spawnLines: 1, timeout: '파일 기본' },
        { file: 'missing.test.ts', spawnLines: 1, timeout: '없음' },
        { file: 'per-test.test.ts', spawnLines: 1, timeout: '시험별 일부' },
      ]);
      expect(files.map((file) => readFileSync(join(root, file), 'utf8'))).toEqual(contents);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('CLI exits 1 with a missing timeout, 0 with a default or per-test timeout, omitting non-spawn files', () => {
    const root = mkdtempSync(join(tmpdir(), 'timeout-audit-git-'));
    const run = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    const missing = join(root, 'missing.test.ts');
    try {
      expect(run('init').status).toBe(0);
      writeFileSync(missing, spawn);
      writeFileSync(join(root, 'plain.test.ts'), "test('plain', () => {});");
      expect(run('add', 'missing.test.ts', 'plain.test.ts').status).toBe(0);
      const cli = () => spawnSync(process.execPath, [join(import.meta.dir, 'test-timeout-audit.ts'), '--json'], { cwd: root, encoding: 'utf8' });
      const failed = cli();
      expect(failed.status).toBe(1);
      expect(JSON.parse(failed.stdout)).toEqual([{ file: 'missing.test.ts', spawnLines: 1, timeout: '없음' }]);
      const log = console.log;
      let output = '';
      console.log = (value: string) => { output = value; };
      try {
        expect(main(root, ['--json'])).toBe(1);
        expect(JSON.parse(output)).toEqual([{ file: 'missing.test.ts', spawnLines: 1, timeout: '없음' }]);
        writeFileSync(missing, "import { setDefaultTimeout } from 'bun:test';\nsetDefaultTimeout(60_000);\n" + spawn);
        expect(main(root, ['--json'])).toBe(0);
        expect(JSON.parse(output)[0]?.timeout).toBe('파일 기본');
        expect(cli().status).toBe(0);
        writeFileSync(missing, "test('x', () => { spawnSync('bun', ['scripts/hello.ts']); }, 30_000);");
        expect(main(root, [])).toBe(0);
        expect(output).toContain('시험별 일부');
      } finally { console.log = log; }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('does not let one timed test hide an uncovered spawn and follows local command constants', () => {
    expect(classifyTimeouts('mixed.test.ts', `
      const cmd = ['bun', 'scripts/tool.ts'];
      test('timed', () => { Bun.spawnSync(cmd); }, 30_000);
      test('untimed', () => { Bun.spawnSync(cmd); });
    `)).toEqual({ file: 'mixed.test.ts', spawnLines: 2, timeout: '없음' });
    expect(classifyTimeouts('indirect.test.ts', "const script = 'scripts/tool.ts'; const cmd = ['bun', script]; test('x', () => Bun.spawnSync(cmd));"))
      .toMatchObject({ timeout: '없음', spawnLines: 1 });
    expect(classifyTimeouts('timed.test.ts', "const cmd = ['bun', 'scripts/tool.ts']; test('x', () => Bun.spawnSync(cmd), 30_000);"))
      .toMatchObject({ timeout: '시험별 일부' });
  });

  test('ignores commented examples and non-process spawns', () => {
    expect(classifyTimeouts('fake.test.ts', "// spawnSync('bun', ['scripts/x.ts'])\nconst x = 'spawnSync(\\'bun\\')';\n")).toBeNull();
    expect(classifyTimeouts('fake.test.ts', "spawnSync('git', ['status', 'scripts/']);")).toBeNull();
    expect(classifyTimeouts('real.test.ts', "spawnSync('bash', ['scripts/install-role-watch.sh']);")).toMatchObject({ timeout: '없음' });
    expect(classifyTimeouts('real.test.ts', "Bun.spawn(['bun', 'bin/elanous.mjs']);")).toMatchObject({ timeout: '없음' });
    expect(classifyTimeouts('real.test.ts', "// prose with ) parenthesis\ntest('x', () => { Bun.spawnSync(['bun', 'scripts/x.ts']); });")).toMatchObject({ spawnLines: 1, timeout: '없음' });
    expect(classifyTimeouts('real.test.ts', "describe('suite', { timeout: 30_000 }, () => { execFileSync('bun', ['scripts/x.ts']); });"))
      .toMatchObject({ timeout: '시험별 일부' });
  });
});
