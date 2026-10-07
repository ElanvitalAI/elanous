import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderCliAnatomy } from './generate-cli-anatomy.js';

const BRIEF = `const brief = program.command('brief').description('브리핑');
brief.command('add').description('추가');
brief.command('list').description('목록');
`;

function rows(markdown: string): string[][] {
  return markdown.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
    .slice(1).map((line) => line.split(' | ').map((part) => part.replace(/^\| ?| ?\|$/g, '')));
}

test('임시 cli/ 의 변수 부모·설명·시험 제외·추가 명령과 생성 시각 외 결정성', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-anatomy-'));
  const cliRoot = join(root, 'cli');
  try {
    mkdirSync(cliRoot);
    const brief = join(cliRoot, 'brief-cli.ts');
    writeFileSync(brief, BRIEF);
    writeFileSync(join(cliRoot, 'brief-cli.test.ts'), "program.command('zzz').description('시험');\n");
    const input = { cliRoot, repoRoot: root, commit: 'abc123', generatedAt: '2026-10-06T00:00:00.000Z' };
    const first = renderCliAnatomy(input);
    expect(first).toContain('| 명령 | 설명 | 정의 파일 |');
    expect(first).toContain('- generatedAt: 2026-10-06T00:00:00.000Z');
    expect(first).toContain('- commit: abc123');
    expect(rows(first)).toEqual([
      ['brief', '브리핑', 'cli/brief-cli.ts'],
      ['brief add', '추가', 'cli/brief-cli.ts'],
      ['brief list', '목록', 'cli/brief-cli.ts'],
    ]);
    expect(first).not.toContain('zzz');

    const second = renderCliAnatomy({ ...input, generatedAt: '2026-10-07T00:00:00.000Z' });
    const withoutTime = (markdown: string) => markdown.split('\n').filter((line) => !line.startsWith('- generatedAt:')).join('\n');
    expect(Buffer.from(withoutTime(first)).equals(Buffer.from(withoutTime(second)))).toBe(true);

    writeFileSync(brief, `${BRIEF}brief.command('compose').description('한 장');\n`);
    const changed = renderCliAnatomy(input);
    expect(rows(changed)).toEqual([
      ['brief', '브리핑', 'cli/brief-cli.ts'],
      ['brief add', '추가', 'cli/brief-cli.ts'],
      ['brief compose', '한 장', 'cli/brief-cli.ts'],
      ['brief list', '목록', 'cli/brief-cli.ts'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('서로 다른 함수의 같은 변수명은 각 선언의 부모 명령을 가리킨다', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-anatomy-scopes-'));
  const cliRoot = join(root, 'cli');
  try {
    mkdirSync(cliRoot);
    writeFileSync(join(cliRoot, 'scoped-cli.ts'), `
function first() {
  const brief = program.command('first').description('첫 함수');
  brief.command('add').description('첫 자식');
}
function second() {
  const brief = program.command('second').description('둘째 함수');
  brief.command('list').description('둘째 자식');
  {
    const brief = program.command('inner').description('안쪽 블록');
    brief.command('compose').description('안쪽 자식');
  }
  brief.command('after').description('바깥 자식');
}
`);
    const output = renderCliAnatomy({ cliRoot, repoRoot: root, commit: 'abc123', generatedAt: '2026-10-06T00:00:00.000Z' });
    expect(rows(output)).toEqual([
      ['first', '첫 함수', 'cli/scoped-cli.ts'],
      ['first add', '첫 자식', 'cli/scoped-cli.ts'],
      ['inner', '안쪽 블록', 'cli/scoped-cli.ts'],
      ['inner compose', '안쪽 자식', 'cli/scoped-cli.ts'],
      ['second', '둘째 함수', 'cli/scoped-cli.ts'],
      ['second after', '바깥 자식', 'cli/scoped-cli.ts'],
      ['second list', '둘째 자식', 'cli/scoped-cli.ts'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main 은 옵션 없이 격리된 저장소의 docs/generated/cli-anatomy.md 에 쓰고 경로를 출력한다', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-anatomy-main-'));
  try {
    const repoRoot = join(import.meta.dir, '..', '..');
    const scriptDir = join(root, 'scripts', 'docs');
    const cliRoot = join(root, 'src', 'cli');
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(cliRoot, { recursive: true });
    const script = join(scriptDir, 'generate-cli-anatomy.ts');
    copyFileSync(join(import.meta.dir, 'generate-cli-anatomy.ts'), script);
    symlinkSync(join(import.meta.dir, 'generate-graph-anatomy.ts'), join(scriptDir, 'generate-graph-anatomy.ts'));
    symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    writeFileSync(join(root, 'package.json'), '{"version":"0.0.1"}\n');
    writeFileSync(join(cliRoot, 'brief-cli.ts'), BRIEF);
    writeFileSync(join(cliRoot, 'brief-cli.test.ts'), "program.command('zzz').description('시험');\n");

    const result = spawnSync('bun', [script], { cwd: root, encoding: 'utf8' });
    const out = join(root, 'docs', 'generated', 'cli-anatomy.md');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${out}\n`);
    const markdown = readFileSync(out, 'utf8');
    expect(markdown).toContain('| 명령 | 설명 | 정의 파일 |');
    expect(markdown).toContain('- commit: (설치본 v0.0.1)');
    expect(markdown).toMatch(/- generatedAt: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/);
    expect(rows(markdown)).toEqual([
      ['brief', '브리핑', 'src/cli/brief-cli.ts'],
      ['brief add', '추가', 'src/cli/brief-cli.ts'],
      ['brief list', '목록', 'src/cli/brief-cli.ts'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main --out 은 지정된 마크다운에 쓴다', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-anatomy-out-'));
  try {
    const out = join(root, 'nested', 'cli.md');
    const script = join(import.meta.dir, 'generate-cli-anatomy.ts');
    const result = spawnSync('bun', [script, '--out', out], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(out);
    const markdown = readFileSync(out, 'utf8');
    expect(markdown).toContain('| 명령 | 설명 | 정의 파일 |');
    expect(markdown).toContain('- commit: ');
    expect(markdown).toContain('- generatedAt: ');
    expect(rows(markdown)).toContainEqual([
      'a2a serve', 'A2A JSON-RPC 서버를 포그라운드에서 실행', 'src/cli/a2a-cli.ts',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
