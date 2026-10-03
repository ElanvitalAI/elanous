import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts/ci-ledger-changed.ts');

const validEntry = (title: string, body = 'same body'): string => `### I-1 · 2026-09-05 · **fixed** — ${title}\n\n**근본** ${body}\n**근거** F-1\n`;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function fixture(): { dir: string; ledger: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ci-ledger-changed-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'src/harness'), { recursive: true });
  cpSync(SCRIPT, join(dir, 'scripts/ci-ledger-changed.ts'));
  cpSync(join(ROOT, 'src/harness/ledger-lint.ts'), join(dir, 'src/harness/ledger-lint.ts'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  const ledger = join(dir, 'docs/harness/example/ISSUES.md');
  mkdirSync(join(dir, 'docs/harness/example'), { recursive: true });
  git(dir, ['init', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  return { dir, ledger };
}

function commit(dir: string, message: string): void {
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', message]);
}

function runGate(dir: string, env?: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
  return spawnSync('bun', ['run', join(dir, 'scripts/ci-ledger-changed.ts')], { cwd: dir, encoding: 'utf8', env });
}

function output(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

describe('ci-ledger-changed — 기준 원장 관측은 fail-closed', () => {
  test('서로 다른 본문의 동일한 중복 제목과 1MB 초과 원장은 변경 0건으로 PASS한다', () => {
    const { dir, ledger } = fixture();
    try {
      const huge = 'x'.repeat(1_100_000);
      writeFileSync(ledger, `${validEntry('duplicate', huge)}\n${validEntry('duplicate', 'second distinct body')}`);
      commit(dir, 'base ledger');
      writeFileSync(join(dir, 'marker.txt'), 'head changes without changing the ledger\n');
      commit(dir, 'head marker');

      const result = runGate(dir);
      expect(result.status).toBe(0);
      expect(output(result)).toContain('[ledger-gate] 변경 항목 0건 검사 (변경분 스코프).');
      expect(output(result)).toContain('[ledger-gate] PASS — 이 브랜치가 더하거나 고친 원장 항목이 없다.');
      expect(output(result)).not.toContain('duplicate');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('기준 ref를 읽지 못하면 파일 경로를 내고 변경 항목으로 세지 않으며 fail-closed한다', () => {
    const { dir, ledger } = fixture();
    try {
      writeFileSync(ledger, validEntry('read failure'));
      commit(dir, 'base ledger');
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = show ]; then echo '任意の読み取り失敗' >&2; exit 128; fi\nexec '${realGit}' "$@"\n`);
      execFileSync('chmod', ['+x', join(bin, 'git')]);

      const result = runGate(dir, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
      expect(result.status).not.toBe(0);
      expect(output(result)).toContain('docs/harness/example/ISSUES.md');
      expect(output(result)).toContain('기준 revision 원장 파일을 읽지 못했다');
      expect(output(result)).toContain('fail-closed');
      expect(output(result)).not.toContain('변경 항목 1건 검사');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ls-tree를 읽지 못하면 경로 부재로 축약하지 않고 fail-closed한다', () => {
    const { dir, ledger } = fixture();
    try {
      writeFileSync(ledger, validEntry('tree failure'));
      commit(dir, 'base ledger');
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1" = ls-tree ]; then echo 'échec de lecture' >&2; exit 128; fi\nexec '${realGit}' "$@"\n`);
      execFileSync('chmod', ['+x', join(bin, 'git')]);

      const result = runGate(dir, { ...process.env, PATH: `${bin}:${process.env.PATH}` });
      expect(result.status).not.toBe(0);
      expect(output(result)).toContain('docs/harness/example/ISSUES.md');
      expect(output(result)).toContain('기준 revision 원장 파일을 읽지 못했다');
      expect(output(result)).not.toContain('변경 항목 1건 검사');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('base에 없는 유효한 원장 파일은 새 항목으로 검사하고 PASS한다', () => {
    const { dir, ledger } = fixture();
    try {
      writeFileSync(join(dir, 'README.md'), 'base\n');
      commit(dir, 'base without ledger');
      writeFileSync(ledger, validEntry('new file'));

      const result = runGate(dir);
      expect(result.status).toBe(0);
      expect(output(result)).toContain('[ledger-gate] 변경 항목 1건 검사');
      expect(output(result)).toContain('[ledger-gate] PASS — 변경 항목에 규약 위반 없음.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('본문 편집은 변경 항목으로 감지한다', () => {
    const { dir, ledger } = fixture();
    try {
      writeFileSync(ledger, validEntry('body edit', 'before'));
      commit(dir, 'base ledger');
      writeFileSync(ledger, validEntry('body edit', 'after'));

      const result = runGate(dir);
      expect(result.status).toBe(0);
      expect(output(result)).toContain('[ledger-gate] 변경 항목 1건 검사');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('기존 blind 파서 fail-closed 문면을 유지한다', () => {
    const { dir, ledger } = fixture();
    try {
      writeFileSync(ledger, validEntry('base'));
      commit(dir, 'base ledger');
      writeFileSync(ledger, '본문은 있는데 heading이 없다\n');

      const result = runGate(dir);
      expect(result.status).not.toBe(0);
      expect(output(result)).toContain('[ledger-gate] ⛔ FAIL — 파서가 눈이 먼 파일이 있다(검사하지 못했다):');
      expect(output(result)).toContain('"위반 없음" 과 "못 읽었다" 는 다른 값이다 — fail-closed.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
