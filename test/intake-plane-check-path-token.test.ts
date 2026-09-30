import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAP_VERDICTS, runIntakeCheck, runIntakeCheckDocument } from '../src/intake-plane/check.js';
import { buildIntakeDocumentStageCallables } from '../src/intake-plane/runtime-callables.js';
import { createIntakeFakeRepo } from './helpers/intake-fake-repo.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const fixture = () => createIntakeFakeRepo(roots, 'intake-path-');

const claim = (name: string) => ({ text: `elanous 에 \`${name}\` 가 있다` });

test('an existing path is observed by file existence, not a content match', () => {
  const deps = fixture();
  writeFileSync(join(deps.root, 'src/tool.ts'), 'export const tool = 1;\n');
  const report = runIntakeCheck([claim('src/tool.ts')], deps);
  expect(report.items[0]?.verdict).toBe('있음');
  expect(report.items[0]?.evidence).toContainEqual(expect.objectContaining({ axis: 'repo', path: 'src/tool.ts' }));
  expect(report.goalDraftPaths).toEqual([]);
});

test('a repository root filename is observed by existence even when its contents never name it', () => {
  const deps = fixture();
  writeFileSync(join(deps.root, 'rootonly.rs'), 'pub const value: u32 = 1;\n');
  const report = runIntakeCheck([claim('rootonly.rs'), claim('rootonly.rs:12')], deps);
  // The bare name is ambiguous (file or identifier); the :line form is certainly a file.
  expect(report.items.map((item) => item.verdict)).toEqual(['판단 필요', '있음']);
  expect(report.items[0]?.evidence).toContainEqual(expect.objectContaining({ axis: 'repo', path: 'rootonly.rs' }));
  expect(report.items[1]?.evidence).toContainEqual(expect.objectContaining({ axis: 'repo', path: 'rootonly.rs', pattern: 'rootonly.rs:12' }));
  expect(report.goalDraftPaths).toEqual([]);
});

test('an absent repository root filename is a measured gap', () => {
  const deps = fixture();
  const report = runIntakeCheck([claim('missing.ts')], deps);
  expect(report.items[0]?.verdict).toBe('없음');
  expect(report.items[0]?.patterns).toContain('file exists missing.ts');
  expect(report.goalDraftPaths).toHaveLength(1);
});

test('a content mention cannot establish a missing file', () => {
  const deps = fixture();
  writeFileSync(join(deps.root, 'src/index.ts'), "export const reference = 'src/missing.ts';\n");
  const report = runIntakeCheck([claim('src/missing.ts')], deps);
  expect(report.items[0]?.verdict).toBe('없음');
  expect(report.items[0]?.patterns).toContain('file exists src/missing.ts');
  expect(report.items[0]?.patterns).not.toContain('rg -F -e src/missing.ts');
  expect(report.items[0]?.evidence).not.toContainEqual(expect.objectContaining({ summary: '파일 존재: src/missing.ts' }));
  expect(report.goalDraftPaths).toHaveLength(1);
  expect(existsSync(report.goalDraftPaths[0]!)).toBe(true);
});

test('a dotted identifier with a same-named root file still uses content search', () => {
  const deps = fixture();
  writeFileSync(join(deps.root, 'system.status'), 'root file\n');
  writeFileSync(join(deps.root, 'src/index.ts'), "export const status = 'system.status';\n");
  const report = runIntakeCheck([claim('system.status')], deps);
  expect(report.items[0]?.verdict).toBe('있음');
  expect(report.items[0]?.patterns).toContain('file exists system.status');
  expect(report.items[0]?.patterns).toContain('rg -F -e system.status');
  expect(report.items[0]?.evidence).toContainEqual(expect.objectContaining({ axis: 'repo', path: 'src/index.ts', repoKind: 'behavior' }));
  expect(report.goalDraftPaths).toEqual([]);
});

test('a line-numbered path measures the file without treating the line as content', () => {
  const deps = fixture();
  writeFileSync(join(deps.root, 'src/tool.ts'), 'export const tool = 1;\n');
  const report = runIntakeCheck([claim('src/tool.ts:12')], deps);
  expect(report.items[0]?.verdict).toBe('있음');
  expect(report.items[0]?.evidence).toContainEqual(expect.objectContaining({ axis: 'repo', path: 'src/tool.ts', pattern: 'src/tool.ts:12' }));
  expect(report.goalDraftPaths).toEqual([]);
});

test('existence alone does not assert a behavioral claim', () => {
  const deps = fixture();
  writeFileSync(join(deps.root, 'src/tool.ts'), 'export const tool = 1;\n');
  const report = runIntakeCheck([{ text: 'elanous 는 `src/tool.ts` 에 비용을 기록한다' }], deps);
  expect(report.items[0]?.verdict).toBe('판단 필요');
  expect(report.goalDraftPaths).toEqual([]);
});

test('a genuinely absent path is 없음 and writes only the gap draft', () => {
  const deps = fixture();
  const report = runIntakeCheck([claim('src/missing.ts')], deps);
  expect(GAP_VERDICTS).toEqual(['없음']);
  expect(report.items[0]?.verdict).toBe('없음');
  expect(report.goalDraftPaths).toHaveLength(1);
  expect(existsSync(report.goalDraftPaths[0]!)).toBe(true);
});

test('identifier contents and the no-name verdict remain distinct from paths', () => {
  const deps = fixture();
  writeFileSync(join(deps.root, 'src/tool.ts'), "export const tool = 'sample-marker';\n");
  const report = runIntakeCheck([claim('sample-marker'), { text: 'elanous 에 이름 없는 기능이 있다' }], deps);
  expect(report.items[0]?.verdict).toBe('있음');
  expect(report.items[0]?.patterns).toContain('rg -F -e sample-marker');
  expect(report.items[1]?.verdict).toBe('판단 필요');
  expect(report.items[1]?.current).toContain('잴 이름이 없다');
  expect(report.goalDraftPaths).toEqual([]);
});

test('an incomplete identifier search cannot yield a confident absence', () => {
  const deps = fixture();
  const report = runIntakeCheck([claim('missing-marker')], {
    ...deps,
    listFiles: () => { throw new Error('search failed'); },
  });
  expect(report.items[0]?.verdict).toBe('못 쟀다');
  expect(report.items[0]?.failures).toContain('search failed');
  expect(report.goalDraftPaths).toEqual([]);
});

test('a path that cannot be observed is 못 쟀다, never a gap draft', () => {
  const deps = fixture();
  symlinkSync('loop.ts', join(deps.root, 'src/loop.ts'));
  const report = runIntakeCheck([claim('src/loop.ts')], deps);
  expect(report.items[0]?.verdict).toBe('못 쟀다');
  expect(report.items[0]?.failures.length).toBeGreaterThan(0);
  expect(report.goalDraftPaths).toEqual([]);
});

test('a missing file under a working parent symlink is a measured gap', () => {
  const deps = fixture();
  mkdirSync(join(deps.root, 'actual'));
  symlinkSync('../actual', join(deps.root, 'src/link'));
  const report = runIntakeCheck([claim('src/link/tool.rs')], deps);
  expect(report.items[0]?.verdict).toBe('없음');
  expect(report.items[0]?.failures).toEqual([]);
  expect(report.goalDraftPaths).toHaveLength(1);
});

test('a broken parent symlink is an observation failure, not a gap', () => {
  const deps = fixture();
  symlinkSync('absent-directory', join(deps.root, 'src/link'));
  const report = runIntakeCheck([claim('src/link/tool.rs')], deps);
  expect(report.items[0]?.verdict).toBe('못 쟀다');
  expect(report.items[0]?.failures.length).toBeGreaterThan(0);
  expect(report.goalDraftPaths).toEqual([]);
});

test('fact mode does not invoke document preprocessing', () => {
  const deps = fixture();
  writeFileSync(join(deps.root, 'src/rootonly.ts'), 'export const value = 1;\n');
  let calls = 0;
  const report = runIntakeCheck([claim('src/rootonly.ts')], {
    ...deps,
    preprocess: () => { calls++; throw new Error('fact mode must not preprocess'); },
  });
  expect(calls).toBe(0);
  expect(report.items[0]?.verdict).toBe('있음');
  expect(report.goalDraftPaths).toEqual([]);
});

test('document preprocess excludes the elanous check section but retains following sections', async () => {
  const deps = fixture();
  let prompt = '';
  const stages = buildIntakeDocumentStageCallables({
    resolveRoleProvider: () => ({ provider: { name: 'fixture' } }),
    streamLLM: async (messages) => {
      prompt = messages[0]?.content ?? '';
      return JSON.stringify({ claims: [], discards: [{ quote: 'external', reason: 'not a claim' }] });
    },
  });
  const document = '# 노트\n- 외부 사실만\n## 🧭 elanous 점검\n- 사람 판정 전용 문장\n  ## 다음 절\n- 다음 절 외부 문장\n';
  await runIntakeCheckDocument([], { ...deps, preprocess: stages.preprocess }, { document });
  expect(prompt).toContain('외부 사실만');
  expect(prompt).toContain('다음 절 외부 문장');
  expect(prompt).not.toContain('사람 판정 전용 문장');
  expect(prompt).not.toContain('## 🧭 elanous 점검');
});

test('a check section written before the rename is also kept out of preprocessing', async () => {
  const deps = fixture();
  let prompt = '';
  const stages = buildIntakeDocumentStageCallables({
    resolveRoleProvider: () => ({ provider: { name: 'fixture' } }),
    streamLLM: async (messages) => {
      prompt = messages[0]?.content ?? '';
      return JSON.stringify({ claims: [], discards: [{ quote: 'external', reason: 'not a claim' }] });
    },
  });
  const document = '# 노트\n- 외부 사실만\n## 🧭 monad 점검\n- 옛 판정 문장\n## 다음 절\n- 다음 절 외부 문장\n';
  await runIntakeCheckDocument([], { ...deps, preprocess: stages.preprocess }, { document });
  expect(prompt).toContain('다음 절 외부 문장');
  expect(prompt).not.toContain('옛 판정 문장');
});

test('a same-named root file alone does not make a dotted identifier present', () => {
  const deps = fixture();
  writeFileSync(join(deps.root, 'system.status'), 'root file\n');
  const report = runIntakeCheck([claim('system.status')], deps);
  expect(report.items[0]?.verdict).toBe('판단 필요');
  expect(report.items[0]?.evidence).toContainEqual(expect.objectContaining({ axis: 'repo', path: 'system.status' }));
  expect(report.goalDraftPaths).toEqual([]);
});

test('a missing file under a parent symlink that leaves the repository is unmeasured', () => {
  const deps = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'intake-outside-'));
  roots.push(outside);
  symlinkSync(outside, join(deps.root, 'linked'));
  const report = runIntakeCheck([claim('linked/missing.ts')], deps);
  expect(report.items[0]?.verdict).toBe('못 쟀다');
  expect(report.goalDraftPaths).toEqual([]);
});
