// R1 측정·분류 시험 — 가짜가 아니라 실제 git 저장소(임시 디렉터리)에서 실제 `git merge-tree` 로 잰다.
// 기대값은 이 파일의 독립 리터럴이다(제품 상수·렌더 함수로 만들지 않는다).
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { simCli } from '../ux-sim/in-process-cli.js';
import { classifyConflictFile, defaultRestackGit, lineHunks, measureRestack, merge3, renderRestackMeasurement } from './pr-land-restack.js';

class Repo {
  readonly dir = mkdtempSync(join(tmpdir(), 'restack-'));
  constructor() {
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'user.name', 'Restack fixture');
    this.git('config', 'user.email', 'restack-fixture@example.invalid');
  }
  git(...args: string[]): string {
    const result = spawnSync('git', args, { cwd: this.dir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }
  write(path: string, body: string): void {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), body);
  }
  commit(message: string): string {
    this.git('add', '-A');
    this.git('commit', '-q', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }
  rm(): void { rmSync(this.dir, { recursive: true, force: true }); }
}

const lines = (...rows: string[]): string => `${rows.join('\n')}\n`;
const NINE = lines('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine');

function withRepo(fn: (repo: Repo) => void): void {
  const repo = new Repo();
  try { fn(repo); } finally { repo.rm(); }
}

/** base 위에서 main 과 PR 이 갈라진 모양을 만든다. 돌려주는 값 = [mainTip, prHead]. */
function diverge(repo: Repo, base: Record<string, string>, main: Record<string, string>, pr: Record<string, string>): [string, string] {
  for (const [path, body] of Object.entries(base)) repo.write(path, body);
  repo.commit('base');
  repo.git('checkout', '-q', '-b', 'pr');
  for (const [path, body] of Object.entries(pr)) repo.write(path, body);
  const head = repo.commit('pr');
  repo.git('checkout', '-q', 'main');
  for (const [path, body] of Object.entries(main)) repo.write(path, body);
  const tip = repo.commit('main');
  return [tip, head];
}

test('no conflict: different files → clean', () => withRepo((repo) => {
  const [mainTip, head] = diverge(repo, { 'a.ts': NINE, 'b.ts': NINE }, { 'a.ts': NINE.replace('five', 'FIVE') }, { 'b.ts': NINE.replace('five', 'cinq') });
  const result = measureRestack({ cwd: repo.dir, mainTip, head });
  expect(result.verdict).toBe('clean');
  expect(result.files).toEqual([]);
}));

test('사례① #38352→#38378 꼴: 앞 착지와 같은 파일의 «인접 hunk» → 텍스트, 양쪽 유지 결과 = 두 수정 모두', () => withRepo((repo) => {
  // 앞 PR(main)은 six 줄을, 뒤 PR 은 바로 다음 seven 줄을 고쳤다 — 줄은 안 겹치지만 git 은 충돌로 본다.
  const [mainTip, head] = diverge(repo, { 'pod.ts': NINE }, { 'pod.ts': NINE.replace('six', 'SIX_MAIN') }, { 'pod.ts': NINE.replace('seven', 'SEVEN_PR') });
  // 대조: 실제 git 은 이것을 충돌(exit 1)로 본다.
  const status = spawnSync('git', ['merge-tree', '--write-tree', mainTip, head], { cwd: repo.dir }).status;
  expect(status).toBe(1);
  const result = measureRestack({ cwd: repo.dir, mainTip, head });
  expect(result.verdict).toBe('text');
  expect(result.files).toHaveLength(1);
  const file = result.files[0]!;
  expect(file.path).toBe('pod.ts');
  expect(file.class).toBe('text');
  expect(file.hunks.map((hunk) => hunk.kind)).toEqual(['adjacent']);
  expect(file.hunks[0]!.main).toEqual(['SIX_MAIN']);
  expect(file.hunks[0]!.pr).toEqual(['SEVEN_PR']);
  // 양쪽 유지 결과(R2 가 쓸 합성)는 분류기가 돌려주지 않는다 — 같은 입력의 실제 hunk 로 merge3 를 직접 대조한다.
  const mainHunks = lineHunks(NINE, NINE.replace('six', 'SIX_MAIN'))!;
  const prHunks = lineHunks(NINE, NINE.replace('seven', 'SEVEN_PR'))!;
  expect(merge3(NINE.split('\n'), mainHunks, prHunks).merged).toBe(lines('one', 'two', 'three', 'four', 'five', 'SIX_MAIN', 'SEVEN_PR', 'eight', 'nine'));
}));

test('같은 지점 삽입(두 PR 이 같은 줄 뒤에 각자 import 추가) → 텍스트 · hunk 는 «2 줄 뒤 삽입» 단일 번호(역전 범위 없음)', () => withRepo((repo) => {
  const base = lines("import a from 'a';", "import z from 'z';", 'export const k = 1;');
  const mainBody = lines("import a from 'a';", "import m from 'm';", "import z from 'z';", 'export const k = 1;');
  const prBody = lines("import a from 'a';", "import p from 'p';", "import z from 'z';", 'export const k = 1;');
  const [mainTip, head] = diverge(repo, { 'x.ts': base }, { 'x.ts': mainBody }, { 'x.ts': prBody });
  const result = measureRestack({ cwd: repo.dir, mainTip, head });
  expect(result.verdict).toBe('text');
  const hunk = result.files[0]!.hunks[0]!;
  expect(result.files[0]!.hunks.map((h) => h.kind)).toEqual(['same-point']);
  expect(hunk.insertion).toBe(true);
  expect(hunk.baseLines).toEqual([1, 1]); // base 1 줄 «뒤»에 삽입 — lo ≤ hi
  expect(renderRestackMeasurement(result)).toContain('hunk same-point base 1 줄 뒤 삽입');
  expect(JSON.parse(JSON.stringify(result)).files[0].hunks[0]).toMatchObject({ insertion: true, baseLines: [1, 1], main: ["import m from 'm';"], pr: ["import p from 'p';"] });
  expect(merge3(base.split('\n'), lineHunks(base, mainBody)!, lineHunks(base, prBody)!).merged).toBe(lines("import a from 'a';", "import m from 'm';", "import p from 'p';", "import z from 'z';", 'export const k = 1;'));
}));

test('의미: 같은 줄을 서로 다르게 고침 → 의미(작성자), 합친 결과 없음, hunk 근거 출력', () => withRepo((repo) => {
  const [mainTip, head] = diverge(repo, { 'a.ts': NINE }, { 'a.ts': NINE.replace('five', 'FIVE_MAIN') }, { 'a.ts': NINE.replace('five', 'FIVE_PR') });
  const result = measureRestack({ cwd: repo.dir, mainTip, head });
  expect(result.verdict).toBe('semantic');
  const file = result.files[0]!;
  expect(file.class).toBe('semantic');
  expect(file.reasons).toEqual(['shared-base-lines']);
  expect(file.hunks[0]).toMatchObject({ kind: 'overlap', insertion: false, baseLines: [5, 5], main: ['FIVE_MAIN'], pr: ['FIVE_PR'] });
}));

test('의미: 한쪽이 지운 구간 «안»에 다른 쪽이 삽입 → 의미', () => withRepo((repo) => {
  const [mainTip, head] = diverge(repo, { 'a.ts': NINE }, { 'a.ts': lines('one', 'two', 'three', 'eight', 'nine') },
    { 'a.ts': lines('one', 'two', 'three', 'four', 'INSERTED', 'five', 'six', 'seven', 'eight', 'nine') });
  const result = measureRestack({ cwd: repo.dir, mainTip, head });
  expect(result.verdict).toBe('semantic');
  expect(result.files[0]!.hunks[0]!.kind).toBe('inside-replaced');
}));

test('의미: 양쪽이 같은 이름의 함수를 추가(정의 중복) → 의미', () => withRepo((repo) => {
  const base = lines('export const a = 1;', '', 'export const z = 2;');
  const [mainTip, head] = diverge(repo, { 'd.ts': base },
    { 'd.ts': lines('export const a = 1;', '', 'export function helper() { return 1; }', '', 'export const z = 2;') },
    { 'd.ts': lines('export const a = 1;', '', 'export function helper() { return 2; }', '', 'export const z = 2;') });
  const result = measureRestack({ cwd: repo.dir, mainTip, head });
  expect(result.verdict).toBe('semantic');
  expect(result.files[0]!.reasons.join(' ')).toContain('duplicate-definition:helper');
}));

test('의미: 합친 결과가 구문 오류 / 지원하지 않는 확장자 / 지운 파일을 고친 충돌 → 의미', () => withRepo((repo) => {
  repo.write('s.ts', lines('export function f() {', '  return 1;', '}'));
  repo.write('conf.yaml', lines('a: 1', 'b: 2'));
  repo.write('gone.ts', NINE);
  repo.commit('base');
  repo.git('checkout', '-q', '-b', 'pr');
  // PR: f 의 둘째 줄을 고침 · yaml 둘째 줄을 고침 · gone.ts 삭제
  repo.write('s.ts', lines('export function f() {', '  return 2;', '}'));
  repo.write('conf.yaml', lines('a: 1', 'b: 20'));
  repo.git('rm', '-q', 'gone.ts');
  const head = repo.commit('pr');
  repo.git('checkout', '-q', 'main');
  // main: f 의 첫 줄을 한 줄 함수로 바꿈(합치면 `return 2;` 와 `}` 가 함수 밖에 남는다) · yaml 첫 줄 · gone.ts 수정
  repo.write('s.ts', lines('export function f() { return 1; }', '  return 1;', '}'));
  repo.write('conf.yaml', lines('a: 10', 'b: 2'));
  repo.write('gone.ts', NINE.replace('five', '5'));
  const mainTip = repo.commit('main');
  const files = measureRestack({ cwd: repo.dir, mainTip, head }).files;
  const reasons = (path: string) => files.find((f) => f.path === path)?.reasons.join(' ');
  expect(reasons('s.ts')).toContain('merged-syntax-error');
  expect(reasons('conf.yaml')).toBe('unsupported-extension:.yaml');
  expect(reasons('gone.ts')).toBe('add-delete-or-rename');
  expect(files.every((f) => f.class === 'semantic')).toBe(true);
}));

test('사례② #38367→#38381 꼴: 아래 PR 이 squash 착지한 뒤 그 옛 head 를 실은 스택 → 스택 squash, 자기 커밋만 cherry-pick 대상', () => withRepo((repo) => {
  const pad = ['// pad 1', '// pad 2', '// pad 3', '// pad 4'];
  const base = lines('export const a = 1;', ...pad, 'export const z = 2;');
  repo.write('lib.ts', base);
  repo.commit('base');
  // X(아래 PR): 함수 추가. Y(위 PR): X 위에서 그 함수를 고침.
  repo.git('checkout', '-q', '-b', 'x');
  repo.write('lib.ts', lines('export const a = 10;', ...pad, 'export function f() { return 1; }', 'export const z = 2;'));
  const xHead = repo.commit('x1');
  repo.git('checkout', '-q', '-b', 'y');
  repo.write('lib.ts', lines('export const a = 10;', ...pad, 'export function f() { return 2; }', 'export const z = 2;'));
  const yHead = repo.commit('y1');
  // X 가 squash 로 main 에 착지 — main 에는 X 의 옛 커밋이 아니라 새 커밋이 생긴다.
  repo.git('checkout', '-q', 'main');
  repo.write('lib.ts', lines('export const a = 10;', ...pad, 'export function f() { return 1; }', 'export const z = 2;'));
  const mainTip = repo.commit('squash of x');
  const result = measureRestack({ cwd: repo.dir, mainTip, head: yHead, stackBase: xHead });
  expect(result.verdict).toBe('stack-squash');
  expect(result.stack).toEqual({ carried: xHead, ownCommits: [yHead] });
  expect(renderRestackMeasurement(result)).toContain(yHead.slice(0, 12)); // cherry-pick 대상 SHA 가 사람 출력에 보인다
  // 스택 정보를 모르면(stackBase 없음) 같은 충돌은 정의 중복 → 의미로 보인다 — 그래서 호출자가 stackBase 를 줘야 한다.
  expect(measureRestack({ cwd: repo.dir, mainTip, head: yHead }).verdict).toBe('semantic');
  // 스택이 아닌 무관한 가지의 head 를 stackBase 로 주면 스택으로 보지 않는다.
  repo.git('checkout', '-q', 'main');
  expect(measureRestack({ cwd: repo.dir, mainTip, head: yHead, stackBase: mainTip }).stack).toBeUndefined();
}));

test('측정 불가는 clean 이 아니다: sha 형식 오류 · 없는 객체', () => withRepo((repo) => {
  repo.write('a.ts', NINE);
  const tip = repo.commit('base');
  expect(measureRestack({ cwd: repo.dir, mainTip: tip, head: 'not-a-sha' }).verdict).toBe('unmeasured');
  expect(measureRestack({ cwd: repo.dir, mainTip: tip, head: 'f'.repeat(40) }).verdict).toBe('unmeasured');
}));

// ── merge3 / lineHunks: 실제 git 을 정답으로 대조 ──
test('merge3 = git merge-file 과 같은 결과(겹치지 않는 수정)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'restack-mf-'));
  try {
    const base = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h');
    const main = lines('a', 'B', 'c', 'd', 'e', 'f', 'g', 'h');
    const pr = lines('a', 'b', 'c', 'd', 'e', 'F', 'g', 'h');
    for (const [name, body] of [['base', base], ['main', main], ['pr', pr]] as const) writeFileSync(join(dir, name), body);
    const git = spawnSync('git', ['merge-file', '-p', join(dir, 'main'), join(dir, 'base'), join(dir, 'pr')], { encoding: 'utf8' });
    expect(git.status).toBe(0);
    const mine = merge3(base.split('\n'), lineHunks(base, main)!, lineHunks(base, pr)!);
    expect(mine.blocked).toBe(false);
    expect(`${mine.merged}`).toBe(git.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('classifyConflictFile: 끝 줄바꿈 없는 파일 · 바이너리 → 의미(보수적)', () => {
  expect(classifyConflictFile('a.ts', 'x', 'y', 'z').reasons).toEqual(['no-trailing-newline']);
  expect(classifyConflictFile('a.ts', 'a\0\n', 'b\0\n', 'c\0\n').reasons).toEqual(['binary']);
  expect(classifyConflictFile('a.ts', null, 'y\n', 'z\n').reasons).toEqual(['add-delete-or-rename']);
});

// ── r1 must: 선언 이름·구문 오류·blob 읽기 실패 ──
const PAD = ['// pad 1', '// pad 2', '// pad 3', '// pad 4'];

test('정의 중복: interface 이름과 구조 분해 변수 이름도 잡는다(양쪽이 같은 이름을 추가) → 의미', () => withRepo((repo) => {
  const base = lines('export const a = 1;', ...PAD, 'export const z = 2;');
  const body = (insert: string[]) => lines('export const a = 1;', ...PAD, ...insert, 'export const z = 2;');
  const [mainTip, head] = diverge(repo, { 'i.ts': base, 'd.ts': base },
    { 'i.ts': body(['export interface Opts { a: number }']), 'd.ts': body(['export const { alpha } = one;']) },
    { 'i.ts': body(['export interface Opts { b: string }']), 'd.ts': body(['export const { alpha } = two;']) });
  const files = measureRestack({ cwd: repo.dir, mainTip, head }).files;
  expect(files.find((f) => f.path === 'i.ts')).toMatchObject({ class: 'semantic', reasons: ['duplicate-definition:Opts'] });
  expect(files.find((f) => f.path === 'd.ts')).toMatchObject({ class: 'semantic', reasons: ['duplicate-definition:alpha'] });
}));

test('구문 오류: 기존 오류 하나가 고쳐지고 새 오류 하나가 생겨 «개수»가 같아도 의미(합친 결과에 오류가 있으면 의미)', () => withRepo((repo) => {
  const [mainTip, head] = diverge(repo,
    { 'e.ts': lines('export const a = ;', 'export const b = 1;') },       // base 에 구문 오류 1
    { 'e.ts': lines('export const a = 1;', 'export const b = 1;') },      // main 이 고침
    { 'e.ts': lines('export const a = ;', 'export const b = ;') });       // PR 이 다른 줄에 새 오류(합치면 오류 1 개 — 개수는 그대로)
  const result = measureRestack({ cwd: repo.dir, mainTip, head });
  expect(result.verdict).toBe('semantic');
  expect(result.files[0]!.reasons).toContain('merged-syntax-error');
}));

test('blob 읽기 실패는 «파일 없음» 이 아니다: ls-tree/cat-file 실패 → unmeasured blob-unreadable (결함 주입)', () => withRepo((repo) => {
  const [mainTip, head] = diverge(repo, { 'pod.ts': NINE }, { 'pod.ts': NINE.replace('six', 'SIX') }, { 'pod.ts': NINE.replace('seven', 'SEVEN') });
  for (const failing of ['ls-tree', 'cat-file']) {
    const result = measureRestack({ cwd: repo.dir, mainTip, head,
      git: (args, cwd, env, input) => args[0] === failing ? { status: 128, stdout: '', stderr: 'fatal: injected' } : defaultRestackGit(args, cwd, env, input) });
    expect([failing, result.verdict, result.reasons]).toEqual([failing, 'unmeasured', ['blob-unreadable:pod.ts']]);
  }
  // 실제 «경로 없음» 은 여전히 add-delete 의미 분류다(위 «지운 파일을 고친 충돌» 시험).
}));

// ── CLI: simCli 의 spawn 모드(실제 엔트리포인트를 별도 프로세스로)로 종료 코드 0·3·4·5·6 과 출력을 확인 ──
// 이 한 경로만 «프로세스 경계» E2E 다(R-LIVE10: 시험 CLI 호출은 simCli 단일 창구).
async function plan(repo: Repo, ...args: string[]): Promise<{ code: number; out: string }> {
  const result = await simCli(['pr', 'restack-plan', '--cwd', repo.dir, ...args], { mode: 'spawn', allowPaths: [['pr', 'restack-plan']] });
  return { code: result.exitCode, out: result.stdout };
}

test('실프로세스 `eln pr restack-plan`: exit 0 clean · 3 text · 4 semantic · 5 stack-squash · 6 unmeasured, 사유는 파일·hunk', async () => {
  // 0 · 3
  const a = new Repo();
  try {
    const [mainTip, head] = diverge(a, { 'pod.ts': NINE }, { 'pod.ts': NINE.replace('six', 'SIX_MAIN') }, { 'pod.ts': NINE.replace('seven', 'SEVEN_PR') });
    const text = await plan(a, '--head', head, '--main', mainTip);
    expect(text.code).toBe(3);
    expect(text.out).toContain('restack text');
    expect(text.out).toContain('텍스트 pod.ts');
    expect(text.out).toContain('main| SIX_MAIN');
    expect(text.out).toContain('PR  | SEVEN_PR');
    const json = await plan(a, '--head', head, '--main', mainTip, '--json');
    expect(json.code).toBe(3);
    expect(JSON.parse(json.out).files[0]).toMatchObject({ path: 'pod.ts', class: 'text' });
    expect(JSON.parse(json.out).files[0].merged).toBeUndefined();
    const clean = await plan(a, '--head', mainTip, '--main', mainTip);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain('restack clean');
    // 6 — 없는 객체
    const bad = await plan(a, '--head', 'f'.repeat(40), '--main', mainTip);
    expect(bad.code).toBe(6);
    expect(bad.out).toContain('restack unmeasured');
  } finally { a.rm(); }
  // 4
  const b = new Repo();
  try {
    const [mainTip, head] = diverge(b, { 'a.ts': NINE }, { 'a.ts': NINE.replace('five', 'FIVE_MAIN') }, { 'a.ts': NINE.replace('five', 'FIVE_PR') });
    const semantic = await plan(b, '--head', head, '--main', mainTip);
    expect(semantic.code).toBe(4);
    expect(semantic.out).toContain('의미 a.ts — shared-base-lines');
    expect(semantic.out).toContain('hunk overlap base 5-5');
  } finally { b.rm(); }
  // 5
  const c = new Repo();
  try {
    const pad = ['// pad 1', '// pad 2', '// pad 3', '// pad 4'];
    c.write('lib.ts', lines('export const a = 1;', ...pad, 'export const z = 2;'));
    c.commit('base');
    c.git('checkout', '-q', '-b', 'x');
    c.write('lib.ts', lines('export const a = 10;', ...pad, 'export function f() { return 1; }', 'export const z = 2;'));
    const xHead = c.commit('x1');
    c.git('checkout', '-q', '-b', 'y');
    c.write('lib.ts', lines('export const a = 10;', ...pad, 'export function f() { return 2; }', 'export const z = 2;'));
    const yHead = c.commit('y1');
    c.git('checkout', '-q', 'main');
    c.write('lib.ts', lines('export const a = 10;', ...pad, 'export function f() { return 1; }', 'export const z = 2;'));
    const mainTip = c.commit('squash of x');
    const stack = await plan(c, '--head', yHead, '--main', mainTip, '--stack-base', xHead);
    expect(stack.code).toBe(5);
    expect(stack.out).toContain('restack stack-squash');
    expect(stack.out).toContain(yHead.slice(0, 12));
  } finally { c.rm(); }
}, 300_000); // Source: 5 프로세스 spawn(각 simCli 기본 30s 한도 안) + git 저장소 3개 구성의 상한 여유.
