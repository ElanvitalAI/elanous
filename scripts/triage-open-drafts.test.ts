import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('./triage-open-drafts.py', import.meta.url));
const bytecodePath = fileURLToPath(new URL('./__pycache__/triage-open-drafts.cpython-312.pyc', import.meta.url));
const importProgram = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location('triage_open_drafts', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
payload = json.loads(sys.stdin.read())
if sys.argv[2] == 'classify':
    print(json.dumps(module.classify_draft_body(payload)))
elif sys.argv[2] == 'measure':
    kwargs = {'head_sha': payload['head_sha']} if 'head_sha' in payload else {}
    print(json.dumps(module.measure_main_acceptance(payload['branch'], payload.get('pr_number'), **kwargs)))
elif sys.argv[2] == 'classify-acceptance':
    print(json.dumps(module.classify_main_acceptance(payload)))
elif sys.argv[2] == 'measure-metadata-failure':
    module.metadata_acceptance = lambda base, branch: None
    print(json.dumps(module.measure_main_acceptance(payload['branch'])))
elif sys.argv[2] == 'main':
    gh_responses = iter(payload['gh'])
    acceptance = iter(payload.get('acceptance', []))
    module.gh = lambda args: next(gh_responses)
    module.measure_main_acceptance = lambda branch, pr_number=None, run=module.git, head_sha=None: next(acceptance, module.MAIN_ACCEPTANCE_UNMEASURED)
    sys.exit(module.main())
elif sys.argv[2] == 'main-real':
    gh_responses = iter(payload['gh'])
    calls = []
    original_run = module.subprocess.run
    def traced_run(args, *args2, **kwargs):
        calls.append(args)
        return original_run(args, *args2, **kwargs)
    module.gh = lambda args: next(gh_responses)
    module.subprocess.run = traced_run
    exit_code = module.main()
    print(json.dumps({'exitCode': exit_code, 'gitCalls': calls}))
`;

type Mode = 'classify' | 'measure' | 'classify-acceptance' | 'measure-metadata-failure' | 'main' | 'main-real';
function runPython(mode: Mode, input: unknown, cwd?: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({ cmd: ['python3', '-B', '-c', importProgram, scriptPath, mode], cwd, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: result.exitCode ?? -1, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
function classifyDraftBody(body: string): string {
  const result = runPython('classify', body);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
}

const all = '🟢 main에 전부 있음';
const none = '🔴 main에 하나도 없음';
const partial = '🟡 main에 일부만 있음';
const unmeasured = '⚪ main 수용 못 쟀다';
const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode).toBe(0);
  return new TextDecoder().decode(result.stdout).trim();
}
function createRepository() {
  const dir = mkdtempSync(join(tmpdir(), 'triage-open-drafts-'));
  tempDirs.push(dir);
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'source.txt'), 'zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'goal.md'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'base');
  git(dir, 'remote', 'add', 'origin', dir);
  git(dir, 'fetch', 'origin', 'main:refs/remotes/origin/main');
  return dir;
}
function commit(cwd: string, message: string) { git(cwd, 'add', '.'); git(cwd, 'commit', '-m', message); }
function syncOriginMain(cwd: string) { git(cwd, 'fetch', 'origin', 'main:refs/remotes/origin/main'); }
type Acceptance = [string, string | null];
function measureAcceptance(cwd: string, branch = 'self-impl/topic', pr_number?: number, head_sha?: string | null): Acceptance {
  const result = runPython('measure', head_sha === undefined ? { branch, pr_number } : { branch, pr_number, head_sha }, cwd);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as Acceptance;
}
function measure(cwd: string, branch = 'self-impl/topic') { return measureAcceptance(cwd, branch)[0]; }


describe('triage-open-drafts classify_draft_body', () => {
  test.each([
    ['gate PASS and no must-fix', '[test] PASS\n', '① gate PASS · must-fix 0'],
    ['gate PASS and must-fix', '[test] PASS\n## 마지막 리뷰 must-fix\n- fix this\n', '② gate PASS · must-fix 있음'],
    ['gate FAIL', '[test] FAIL\n', '③ gate FAIL'],
    ['no gate verdict', 'review still running\n', '④ gate 판정 없음(예산 등)'],
  ])('%s returns the preserved bucket name', (_scenario, body, expected) => expect(classifyDraftBody(body)).toBe(expected));

  test('loads only the pure classifier and never invokes gh', () => expect(classifyDraftBody('[test] PASS\n')).toBe('① gate PASS · must-fix 0'));
  test('runs Python with bytecode writing disabled', () => { rmSync(bytecodePath, { force: true }); classifyDraftBody('[test] PASS\n'); expect(existsSync(bytecodePath)).toBe(false); });
});

describe('triage-open-drafts main acceptance measurement', () => {
  test('measures merge-base-relative source hunks rather than matching filenames', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(dir, 'branch changes first line');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\nmain-two\n');
    commit(dir, 'main changes another line');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(none);
  });

  test('reports partial when main contains only one hunk from the same source file', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\nbranch-two\n');
    commit(dir, 'branch changes two lines');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(dir, 'main accepts first hunk');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(partial);
  });

  test('reports all only when main contains every source hunk and ignores docs-only changes', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    writeFileSync(join(dir, 'docs', 'goal.md'), 'draft documentation\n');
    commit(dir, 'branch source and docs');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(dir, 'main accepts source');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(all);
  });

  test('reports none when the branch deletes a line that main still retains', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\ntwo\n');
    commit(dir, 'branch deletes keep-f');
    git(dir, 'checkout', 'main');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(none);
  });

  test('reports all when main accepts a branch line deletion', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\ntwo\n');
    commit(dir, 'branch deletes keep-f');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\ntwo\n');
    commit(dir, 'main accepts deletion');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(all);
  });

  test('does not accept an identical replacement at another line', () => {
    const dir = createRepository();
    writeFileSync(join(dir, 'source.txt'), 'old\nnew\n');
    commit(dir, 'replace base source');
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'new\nnew\n');
    commit(dir, 'branch replaces first line');
    git(dir, 'checkout', 'main');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(none);
  });

  test('preserves no-newline-at-EOF changes', () => {
    const dir = createRepository();
    writeFileSync(join(dir, 'source.txt'), 'without-newline');
    commit(dir, 'replace base source without newline');
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'branch-without-newline');
    commit(dir, 'branch changes no-newline EOF');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'branch-without-newline');
    commit(dir, 'main accepts no-newline EOF');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(all);
  });

  test('reports none for an unaccepted no-newline EOF replacement', () => {
    const dir = createRepository();
    writeFileSync(join(dir, 'source.txt'), 'x\nold');
    commit(dir, 'base no-newline source');
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'x\nnew');
    commit(dir, 'branch replaces no-newline EOF');
    git(dir, 'checkout', 'main');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(none);
  });

  test('accepts a branch replacement after main shifts its line with unrelated context', () => {
    const dir = createRepository();
    writeFileSync(join(dir, 'source.txt'), 'a\nold\n');
    commit(dir, 'short base source');
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'a\nnew\n');
    commit(dir, 'branch replacement');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'prefix\na\nnew\n');
    commit(dir, 'main shifts and accepts replacement');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(all);
  });

  test('reports all when main independently accepts adjacent branch replacements', () => {
    const dir = createRepository();
    writeFileSync(join(dir, 'source.txt'), 'a\nold1\nold2\nz\n');
    commit(dir, 'replace base for adjacent replacements');
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'a\nnew1\nnew2\nz\n');
    commit(dir, 'branch replaces adjacent lines');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'a\nnew1\nnew2\nz\n');
    writeFileSync(join(dir, 'main-noise.txt'), 'independent main change\n');
    commit(dir, 'main independently accepts adjacent replacements with noise');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(all);
  });

  test('reports partial when main accepts adjacent replacements but not a distant third change', () => {
    const dir = createRepository();
    writeFileSync(join(dir, 'source.txt'), 'a\nold1\nold2\nb\nc\nd\ne\nf\ng\nq\n');
    commit(dir, 'replace base for adjacent and distant replacements');
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'a\nnew1\nnew2\nb\nc\nd\ne\nf\ng\nQ\n');
    commit(dir, 'branch replaces adjacent lines and distant line');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'a\nnew1\nnew2\nb\nc\nd\ne\nf\ng\nq\n');
    writeFileSync(join(dir, 'main-noise.txt'), 'independent main change\n');
    commit(dir, 'main accepts adjacent replacements with unrelated noise');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    const acceptance = measure(dir);
    expect(acceptance).toBe(partial);
    expect(acceptance).not.toBe(none);
    expect(acceptance).not.toContain('못 쟀다');
  });

  test('reports all when main accepts a replacement while a duplicate removed value remains elsewhere', () => {
    const dir = createRepository();
    writeFileSync(join(dir, 'source.txt'), 'h1\nold1\nh2\nh3\nold1\n');
    commit(dir, 'replace base with a duplicate removed value');
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'h1\nnew1\nh2\nh3\nold1\n');
    commit(dir, 'branch replaces only the first duplicate value');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'h1\nnew1\nh2\nh3\nold1\n');
    writeFileSync(join(dir, 'main-noise.txt'), 'independent main change\n');
    commit(dir, 'main accepts replacement and retains the other duplicate');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(all);
  });

  test('reports none when main retains adjacent old replacements and inserts their new values', () => {
    const dir = createRepository();
    writeFileSync(join(dir, 'source.txt'), 'a\nold1\nold2\nb\nc\nd\ne\nf\ng\nq\n');
    commit(dir, 'replace base for adjacent positional replacements');
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'a\nnew1\nnew2\nb\nc\nd\ne\nf\ng\nQ\n');
    commit(dir, 'branch replaces adjacent lines and distant line');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'a\nold1\nold2\nnew1\nnew2\nb\nc\nd\ne\nf\ng\nq\n');
    writeFileSync(join(dir, 'main-noise.txt'), 'independent main change\n');
    commit(dir, 'main inserts adjacent new values beside retained old values');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(none);
  });

  test('reports all when main replaces the old value in the same context window', () => {
    const dir = createRepository();
    writeFileSync(join(dir, 'source.txt'), 'h1\nold1\nh2\nh3\n');
    commit(dir, 'replace base for contextual replacement check');
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'h1\nnew1\nh2\nh3\n');
    commit(dir, 'branch replaces old value in place');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'h1\nnew1\nh2\nh3\n');
    writeFileSync(join(dir, 'main-noise.txt'), 'independent main change\n');
    commit(dir, 'main replaces old value in the same context window');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(all);
  });

  test('reports none when main deletes a different duplicate line', () => {
    const dir = createRepository();
    writeFileSync(join(dir, 'source.txt'), 'a\nx\nb\nx\nc\n');
    commit(dir, 'replace base with duplicate lines');
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'a\nb\nx\nc\n');
    commit(dir, 'branch deletes first duplicate');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'a\nx\nb\nc\n');
    writeFileSync(join(dir, 'main-noise.txt'), 'independent main change\n');
    commit(dir, 'main deletes second duplicate with noise');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(none);
  });

  test('reports none when main retains one indistinguishable duplicate', () => {
    const dir = createRepository();
    writeFileSync(join(dir, 'source.txt'), 'x\nx\n');
    commit(dir, 'replace base with duplicates');
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'x\n');
    commit(dir, 'branch deletes duplicate');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'main-noise.txt'), 'independent main change\n');
    commit(dir, 'main retains duplicates with noise');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(none);
  });

  test('reports partial when main accepts one of adjacent branch line changes', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'zero\nbranch-a\nbranch-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(dir, 'branch changes adjacent lines');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'zero\nbranch-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(dir, 'main accepts one adjacent line');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(partial);
  });

  test.each([
    ['empty file addition', (dir: string) => writeFileSync(join(dir, 'empty.txt'), '')],
    ['rename', (dir: string) => renameSync(join(dir, 'source.txt'), join(dir, 'renamed.txt'))],
    ['executable mode', (dir: string) => chmodSync(join(dir, 'source.txt'), 0o755)],
  ])('does not silently accept an unmerged source metadata change: %s', (_scenario, change) => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    change(dir);
    commit(dir, 'branch metadata change');
    git(dir, 'checkout', 'main');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(none);
  });

  test.each([
    ['empty file addition', (dir: string) => writeFileSync(join(dir, 'empty.txt'), '')],
    ['rename', (dir: string) => renameSync(join(dir, 'source.txt'), join(dir, 'renamed.txt'))],
    ['executable mode', (dir: string) => chmodSync(join(dir, 'source.txt'), 0o755)],
  ])('reports all when main accepts the source metadata change: %s', (_scenario, change) => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    change(dir);
    commit(dir, 'branch metadata change');
    git(dir, 'checkout', 'main');
    change(dir);
    commit(dir, 'main accepts metadata change');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(all);
  });

  test('does not accept an addition with the same path but different blob content', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'added.txt'), 'branch blob\n');
    commit(dir, 'branch adds file');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'added.txt'), 'main blob\n');
    commit(dir, 'main adds a different file blob');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(none);
  });

  test('does not accept a rename with the same paths but different blob content', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    renameSync(join(dir, 'source.txt'), join(dir, 'renamed.txt'));
    commit(dir, 'branch renames file');
    git(dir, 'checkout', 'main');
    renameSync(join(dir, 'source.txt'), join(dir, 'renamed.txt'));
    writeFileSync(join(dir, 'renamed.txt'), 'main-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(dir, 'main renames with different content');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(none);
  });

  test('reports none when both branches add divergent contents at the same path', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'added-at-same-path.txt'), 'branch content\n');
    commit(dir, 'branch adds path');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'added-at-same-path.txt'), 'main content\n');
    commit(dir, 'main adds divergent path');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(none);
  });

  test('reports all after main fast-forwards the branch and adds unrelated noise', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(dir, 'branch change');
    git(dir, 'checkout', 'main');
    git(dir, 'merge', '--ff-only', 'self-impl/topic');
    writeFileSync(join(dir, 'unrelated-main-noise.txt'), 'unrelated main noise\n');
    commit(dir, 'main adds unrelated noise');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(all);
  });

  test('reports all when the branch is already an origin/main ancestor', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(dir, 'branch change');
    git(dir, 'checkout', 'main');
    git(dir, 'merge', '--no-ff', 'self-impl/topic', '-m', 'main merges branch');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(all);
  });

  test('reports partial when main accepts text but not a separate metadata change', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    chmodSync(join(dir, 'source.txt'), 0o755);
    commit(dir, 'branch text and mode changes');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(dir, 'main accepts only text');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measure(dir)).toBe(partial);
  });

  test('names a missing local branch separately from an ambiguous real-git patch mapping', () => {
    const missingDir = createRepository();
    expect(measureAcceptance(missingDir, 'self-impl/missing')).toEqual([unmeasured, '브랜치 없음']);

    const ambiguousDir = createRepository();
    git(ambiguousDir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(ambiguousDir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\nbranch-two\n');
    commit(ambiguousDir, 'branch source changes');
    git(ambiguousDir, 'checkout', 'main');
    writeFileSync(join(ambiguousDir, 'source.txt'), 'main-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    writeFileSync(join(ambiguousDir, 'unrelated-main-noise.txt'), 'unrelated main noise\n');
    commit(ambiguousDir, 'main divergent source and unrelated change');
    syncOriginMain(ambiguousDir);
    git(ambiguousDir, 'checkout', 'self-impl/topic');
    expect(measureAcceptance(ambiguousDir)).toEqual([`${none} (2칸 중 1칸 못 쟀다)`, '대응 모호']);

    const failedDir = createRepository();
    git(failedDir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(failedDir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(failedDir, 'branch source change');
    git(failedDir, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(measureAcceptance(failedDir)).toEqual([unmeasured, '명령 실패']);
  });

  test('returns command failure instead of a successful verdict when metadata measurement fails', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(dir, 'branch source change');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    writeFileSync(join(dir, 'unrelated-main-noise.txt'), 'always unrelated main line\n');
    commit(dir, 'main accepts source with unrelated change');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    const result = runPython('measure-metadata-failure', { branch: 'self-impl/topic' }, dir);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([unmeasured, '명령 실패']);
  });

  test('uses the current local branch instead of a stale fetched pull ref', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(dir, 'stale pull ref source change');
    git(dir, 'update-ref', 'refs/remotes/origin/pr/92', git(dir, 'rev-parse', 'self-impl/topic'));
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\nlatest-branch-two\n');
    commit(dir, 'latest local branch source change');
    git(dir, 'checkout', 'main');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    writeFileSync(join(dir, 'unrelated-main-noise.txt'), 'always unrelated main line\n');
    commit(dir, 'main accepts stale pull ref only');
    syncOriginMain(dir);
    git(dir, 'checkout', 'self-impl/topic');
    expect(measureAcceptance(dir, 'self-impl/topic', 92)).toEqual([partial, null]);
  });

  test('classifies rev-parse outside a Git repository as a command failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-open-drafts-non-git-'));
    tempDirs.push(dir);
    expect(measureAcceptance(dir, 'self-impl/missing')).toEqual([unmeasured, '명령 실패']);
  });

  test.each([[true, null, `${all} (2칸 중 1칸 못 쟀다)`], [false, null, `${none} (2칸 중 1칸 못 쟀다)`]])('preserves an unmeasured change count beside the measured verdict', (measured, unknown, expected) => {
    const result = runPython('classify-acceptance', [measured, unknown]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(expected);
  });

  test('main preserves unmeasured acceptance in its final aggregation', () => {
    const list = JSON.stringify([{ number: 1, title: 'ready', isDraft: true, headRefName: 'self-impl/ready', updatedAt: '2026-08-23T00:00:00Z' }]);
    const result = runPython('main', { gh: [list, '[test] PASS\n'], acceptance: [`${all} (2칸 중 1칸 못 쟀다)`] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(new RegExp(`${unmeasured}\\s+1건\\s+#1`));
    expect(result.stdout).not.toContain(`${all}                         1건`);
  });

  test('an absent or malformed headRefOid is a command failure, never a fallback to a stale named ref', () => {
    const dir = createRepository();
    git(dir, 'checkout', '-b', 'self-impl/topic');
    writeFileSync(join(dir, 'source.txt'), 'branch-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(dir, 'stale named ref');
    git(dir, 'update-ref', 'refs/remotes/origin/pr/91', git(dir, 'rev-parse', 'self-impl/topic'));
    git(dir, 'checkout', 'main');
    for (const head_sha of [null, '', 'not-a-sha', 'ABCDEF']) expect(measureAcceptance(dir, 'self-impl/topic', 91, head_sha)).toEqual([unmeasured, '명령 실패']);
    for (const headRefOid of [undefined, 'not-a-sha']) {
      const list = JSON.stringify([{ number: 91, title: 'no pin', isDraft: true, headRefName: 'self-impl/topic', ...(headRefOid === undefined ? {} : { headRefOid }), updatedAt: '2026-11-05T00:00:00Z' }]);
      const result = runPython('main-real', { gh: [list, ''] }, dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/명령 실패\s+1건\s+#91/);
      expect(result.stdout).not.toMatch(new RegExp(`${none}\\s+1건\\s+#91`));
      const trace = JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('{')));
      expect(trace.gitCalls).toEqual([]);
    }
  });

  test('main aggregates unmeasured reasons and prints but does not run the pull-ref fetch command', () => {
    const list = JSON.stringify([
      { number: 12, title: 'missing', isDraft: true, headRefName: 'self-impl/missing', updatedAt: '2026-08-23T00:00:00Z' },
      { number: 13, title: 'ambiguous', isDraft: true, headRefName: 'self-impl/ambiguous', updatedAt: '2026-08-24T00:00:00Z' },
      { number: 14, title: 'failed', isDraft: true, headRefName: 'self-impl/failed', updatedAt: '2026-08-25T00:00:00Z' },
    ]);
    const result = runPython('main', { gh: [list, '', '', ''], acceptance: [[unmeasured, '브랜치 없음'], [unmeasured, '대응 모호'], [unmeasured, '명령 실패']] });
    expect(result.exitCode).toBe(0);
    for (const reason of ['브랜치 없음', '대응 모호', '명령 실패']) expect(result.stdout).toMatch(new RegExp(`${reason}\\s+1건`));
    expect(result.stdout).toContain('가져오기 안내 (실행 안 함): git fetch origin refs/pull/12/head\n');
  });

  test('main calls the measurement while preserving four buckets, population, failure warning, and final warnings', () => {
    const list = JSON.stringify([
      { number: 4, title: 'no gate', isDraft: true, headRefName: 'self-impl/no-gate', updatedAt: '2026-08-26T00:00:00Z' },
      { number: 3, title: 'failed', isDraft: true, headRefName: 'self-impl/failed', updatedAt: '2026-08-25T00:00:00Z' },
      { number: 2, title: 'must fix', isDraft: true, headRefName: 'self-impl/must-fix', updatedAt: '2026-08-24T00:00:00Z' },
      { number: 1, title: 'ready', isDraft: true, headRefName: 'self-impl/ready', updatedAt: '2026-08-23T00:00:00Z' },
      { number: 5, title: 'ignored', isDraft: true, headRefName: 'other/ignored', updatedAt: '2026-08-27T00:00:00Z' },
    ]);
    const result = runPython('main', { gh: [list, '[test] PASS\n', '[test] PASS\n## 마지막 리뷰 must-fix\n- fix this\n', '[test] FAIL\n', 'review still running\n'] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('self-impl draft 4건');
    for (const line of ['① gate PASS · must-fix 0     1건  #1', '② gate PASS · must-fix 있음    1건  #2', '③ gate FAIL                  1건  #3', '④ gate 판정 없음(예산 등)           1건  #4', '⛔ ①이라고 「병합 가능」이 아니다', '⛔ 오래된 것은 리베이스 비용이 붙는다 — 나이를 같이 본다.']) expect(result.stdout).toContain(line);
    expect(result.stdout).toMatch(new RegExp(`${unmeasured}\\s+4건\\s+#1 #2 #3 #4`));
  });

  // PR-HEAD-FETCH-STATELESS (11-05 열차 관리자 602회 «unmeasured» 사건): a named, non-forced
  // destination ref is refused as non-fast-forward once the PR is rebased. The printed fetch is
  // stateless (FETCH_HEAD only) and the measurement pins the gh headRefOid, so a rebase is just a new SHA.
  function createPullRemote() {
    const root = mkdtempSync(join(tmpdir(), 'triage-open-drafts-pull-'));
    tempDirs.push(root);
    const seed = join(root, 'seed');
    const remote = join(root, 'remote.git');
    const local = join(root, 'local');
    mkdirSync(seed);
    git(seed, 'init', '--initial-branch=main');
    git(seed, 'config', 'user.email', 'test@example.com');
    git(seed, 'config', 'user.name', 'Test');
    writeFileSync(join(seed, 'source.txt'), 'zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(seed, 'base');
    git(root, 'init', '--bare', '--initial-branch=main', remote);
    git(seed, 'push', '-q', remote, 'main:refs/heads/main');
    git(root, 'clone', '-q', remote, local);
    return { root, seed, remote, local };
  }
  function pushPullHead(seed: string, remote: string, content: string, message: string) {
    git(seed, 'checkout', '-q', '--detach', 'main');
    writeFileSync(join(seed, 'source.txt'), content);
    commit(seed, message);
    const sha = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'push', '-q', '--force', remote, `${sha}:refs/pull/93/head`);
    return sha;
  }
  function runPrintedFetch(cwd: string, stdout: string) {
    const line = stdout.split('\n').find((entry) => entry.includes('가져오기 안내 (실행 안 함): '));
    expect(line).toBeDefined();
    const args = line!.split('가져오기 안내 (실행 안 함): ')[1]!.trim().split(/\s+/);
    expect(args.slice(0, 3)).toEqual(['git', 'fetch', 'origin']);
    git(cwd, ...args.slice(1));
  }

  test('a rebased (force-updated) PR head is re-fetched successfully and its new SHA is measured', () => {
    const { seed, remote, local } = createPullRemote();
    const v1 = pushPullHead(seed, remote, 'v1-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n', 'pr v1');
    const listFor = (sha: string) => JSON.stringify([{ number: 93, title: 'rebased', isDraft: true, headRefName: 'self-impl/rebased', headRefOid: sha, updatedAt: '2026-11-05T00:00:00Z' }]);
    const first = runPython('main-real', { gh: [listFor(v1), ''] }, local);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toMatch(/브랜치 없음\s+1건\s+#93/);
    runPrintedFetch(local, first.stdout);
    expect(measureAcceptance(local, 'self-impl/rebased', 93, v1)).toEqual([none, null]);
    // The incident's refspec: a named ref taken without «+» before the rebase …
    git(local, 'fetch', 'origin', 'refs/pull/93/head:refs/remotes/origin/pr/93');
    // … main moves (it accepts v1's hunk), and the PR is rebased onto it: refs/pull/93/head is
    // force-updated to a commit that does not descend from v1.
    git(seed, 'checkout', '-q', 'main');
    writeFileSync(join(seed, 'source.txt'), 'v1-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\ntwo\n');
    commit(seed, 'main accepts v1');
    git(seed, 'push', '-q', remote, 'main:refs/heads/main');
    git(local, 'fetch', '-q', 'origin');
    const v2 = pushPullHead(seed, remote, 'v1-zero\nkeep-a\nkeep-b\nkeep-c\nkeep-d\nkeep-e\nkeep-f\nv2-two\n', 'pr v2 rebased');
    expect(Bun.spawnSync({ cmd: ['git', 'merge-base', '--is-ancestor', v1, v2], cwd: seed }).exitCode).toBe(1);
    // The stale named ref is reported by name, not measured as if it were the PR head.
    const stale = runPython('main-real', { gh: [listFor(v2), ''] }, local);
    expect(stale.exitCode).toBe(0);
    expect(stale.stdout).toMatch(/로컬 ref 낡음\s+1건\s+#93/);
    expect(stale.stdout).not.toMatch(new RegExp(`${none}\\s+1건\\s+#93`));
    // The incident: re-taking the same named ref without «+» is refused as non-fast-forward.
    const refused = Bun.spawnSync({ cmd: ['git', 'fetch', 'origin', 'refs/pull/93/head:refs/remotes/origin/pr/93'], cwd: local, stdout: 'pipe', stderr: 'pipe' });
    expect(refused.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(refused.stderr)).toContain('non-fast-forward');
    // The printed stateless fetch succeeds after the rebase and the next run measures v2.
    runPrintedFetch(local, stale.stdout);
    expect(measureAcceptance(local, 'self-impl/rebased', 93, v2)).toEqual([none, null]);
    expect(measureAcceptance(local, 'self-impl/rebased', 93, v1)).toEqual([all, null]);
    const second = runPython('main-real', { gh: [listFor(v2), ''] }, local);
    expect(second.stdout).toMatch(new RegExp(`${none}\\s+1건\\s+#93`));
    expect(second.stdout).not.toContain('가져오기 안내');
  });

  test('main returns exit code 2 when the PR list cannot be obtained', () => {
    const result = runPython('main', { gh: [''] });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('⛔ PR 목록을 못 얻었다 — 「0건」이 아니라 «못 셌음»이다');
  });
});
