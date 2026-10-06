import { expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { resetElanousConfigDir, setElanousConfigDir } from '../../src/elanous-config-dir.js';
import { addItem, setItem } from '../../src/release-loop/checklist.js';
import { debug } from '../../src/debug/log.js';
import { publishRelease, type ReleaseManifest, type Runner } from '../../src/cli/release-cli.js';
import { runGraph } from '../../src/graph-runner/runner.js';
import { runVaultNote } from './vault-note-node.js';
import type { GraphContext } from './node-verdict.js';

const version = '0.2.13';
const directory = '40. Project/엘라누스 릴리스';
const name = '엘라누스 v0.2.13 (2026-10-04).md';
const previous = '| [[엘라누스 v0.2.12 (2026-10-03)|v0.2.12]] | 10-03 18:00 | 사람이 쓴 한 줄 |';
const previousCommit = 'b'.repeat(40);

function writePublishedPrevious(root: string): void {
  const dir = join(root, 'release', '0.2.12');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'release.json'), JSON.stringify({ version: '0.2.12', tag: 'v0.2.12', sourceCommit: previousCommit, publishedAt: '2026-10-03T12:00:00Z' }));
}

function previousRun(runId: string, count: number, startedAt?: string, published = true) {
  return { graphId: 'release-loop', runId, ...(startedAt ? { startedAt } : {}), input: { version: '0.2.12' }, nodes: [
    { nodeId: 'version-release', ok: true, output: JSON.stringify({ commit: previousCommit }) },
    { nodeId: 'known-issues', ok: true, output: JSON.stringify({ count }) },
    { nodeId: 'publish', ok: published, output: JSON.stringify({ tag: 'v0.2.12' }) },
  ] };
}

async function fixture(fn: (f: { root: string; vault: string; context: GraphContext; note: string; index: string; run: () => ReturnType<typeof runVaultNote> }) => void | Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vault-note-root-')));
  const vault = realpathSync(mkdtempSync(join(tmpdir(), 'vault-note-vault-')));
  const target = join(vault, directory);
  const release = join(root, 'release', version);
  mkdirSync(join(release, 'prepared'), { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(release, 'release.json'), JSON.stringify({ version, tag: 'v0.2.13', sourceCommit: '8cd885efe701bf47c1df020c32ccd17e31cd4a25', publishedAt: '2026-10-04T09:00:00.000Z', publicRepo: 'ElanvitalAI/elanous' }));
  writeFileSync(join(release, 'prepared', 'notes-draft.md'), '# 0.2.13\n- 변경 A #1\n- 변경 B #2\n- 변경 C #3\n');
  const index = join(target, '_색인 — 엘라누스 릴리스.md');
  writeFileSync(index, `# 릴리스 색인\n\n| 판 | 발행 | 한 줄 |\n|---|---|---|\n${previous}\n\n사람의 메모\n`);
  const context: GraphContext = { input: { version, previousVersion: '0.2.12' }, outputs: { verify: { outcome: 'ok' } } };
  const checklist = () => [
    { id: 'CLI1', title: '명령: 설치 상태를 확인한다 `elanous doctor`', owner: 'TC', status: 'green' as const },
    { id: 'APP1', title: '화면: 릴리스 내역을 열람한다', owner: 'TC', status: 'green' as const },
    { id: 'CLI2', title: '명령: 판 상태를 확인한다 `elanous release verify`', owner: 'MK', status: 'green' as const },
    { id: 'OTHER', title: '출시하지 않은 칸', owner: 'MK', status: 'yellow' as const },
  ];
  try { await fn({ root, vault, context, note: join(target, '0.x', '0.2', name), index, run: () => runVaultNote(context, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist }) }); }
  finally { rmSync(root, { recursive: true, force: true }); rmSync(vault, { recursive: true, force: true }); }
}

test('published note groups original first clauses by feature family, preserves manual index rows and existing note', () => fixture(({ root, vault, run, note, index }) => {
  const recordPath = join(root, 'release', version, 'release.json');
  const draftPath = join(root, 'release', version, 'prepared', 'notes-draft.md');
  const recordBefore = readFileSync(recordPath, 'utf8');
  const draftBefore = readFileSync(draftPath, 'utf8');
  const logged = spyOn(debug, 'log');
  try {
    expect(run()).toMatchObject({ outcome: 'ok' });
    expect(logged).toHaveBeenCalledWith('release.vault-note', 'written', { version, reason: 'created' });
  } finally { logged.mockRestore(); }
  const content = readFileSync(note, 'utf8');
  expect(content).toContain('title: "엘라누스 v0.2.13 — 명령: 설치 상태를 확인한다 `elanous doctor` · 화면: 릴리스 내역을 열람한다 · 명령: 판 상태를 확인한다 `elanous release verify`"');
  expect(content).toContain('published: 2026-10-04 18:00 KST');
  expect(content).toContain('cut: 8cd885ef');
  expect(content).toContain('tags: [elanous, release]');
  expect(content).toContain('github: https://github.com/ElanvitalAI/elanous/releases/tag/v0.2.13');
  expect(content).toContain('npm: elanous@0.2.13');
  expect(content).toContain('### CLI\n\n- CLI1 — 명령: 설치 상태를 확인한다 `elanous doctor`\n  - 명령: `elanous doctor`\n\n- CLI2 — 명령: 판 상태를 확인한다 `elanous release verify`');
  expect(content).toContain('### APP\n\n- APP1 — 화면: 릴리스 내역을 열람한다');
  expect(content).not.toContain('### TC');
  expect(content).not.toContain('### 명령');
  expect(content).toContain('## 발행 경과\n\n- 2026-10-04 18:00 KST 발행');
  expect(content).toContain('- 변경 3건\n- green 칸 3개');
  const firstIndex = readFileSync(index, 'utf8');
  expect(firstIndex).toContain('|---|---|---|\n| [[엘라누스 v0.2.13 (2026-10-04)\\|v0.2.13]] | 10-04 18:00 |');
  expect(firstIndex).toContain(`${previous}\n\n사람의 메모\n`);
  writeFileSync(note, '사람이 손본 노트\n');
  expect(run()).toMatchObject({ outcome: 'ok', skipped: 'exists', summary: 'skipped: exists' });
  expect(readFileSync(note, 'utf8')).toBe('사람이 손본 노트\n');
  expect(readFileSync(index, 'utf8')).toBe(firstIndex);
  expect(firstIndex.match(/\|v0\.2\.13\]\]/g)).toHaveLength(1);
  expect(readFileSync(recordPath, 'utf8')).toBe(recordBefore);
  expect(readFileSync(draftPath, 'utf8')).toBe(draftBefore);
  expect(() => readFileSync(join(vault, directory, name))).toThrow(); // notes go under 0.x/0.2/, never flat
}));

test('an older release inserts after newer published rows without changing either row or duplicating on retry', () => fixture(({ run, index }) => {
  const newer = '| [[엘라누스 v0.2.14 (2026-10-05)\\|v0.2.14]] | 10-05 18:00 | 사람이 쓴 최신 판 |';
  const before = `# 릴리스 색인\n\n| 판 | 발행 | 한 줄 |\n|---|---|---|\n${newer}\n${previous}\n\n사람의 메모\n`;
  writeFileSync(index, before);
  expect(run().outcome).toBe('ok');
  const after = readFileSync(index, 'utf8');
  expect(after).toMatch(/^# 릴리스 색인\n\n\| 판 \| 발행 \| 한 줄 \|\n\|---\|---\|---\|\n\| \[\[엘라누스 v0\.2\.14/);
  expect(after).toContain(`${newer}\n| [[엘라누스 v0.2.13 (2026-10-04)\\|v0.2.13]] | 10-04 18:00 |`);
  expect(after).toContain(`${previous}\n\n사람의 메모\n`);
  expect(after.match(/\|v0\.2\.13\]\]/g)).toHaveLength(1);
  expect(run()).toMatchObject({ skipped: 'exists' });
  expect(readFileSync(index, 'utf8')).toBe(after);
}));

test('missing top-level index is created', () => fixture(({ run, index }) => {
  rmSync(index);
  expect(run().outcome).toBe('ok');
  expect(readFileSync(index, 'utf8')).toContain('| 판 | 발행 | 한 줄 |\n|---|---|---|\n| [[엘라누스 v0.2.13 (2026-10-04)\\|v0.2.13]]');
}));

test('a pre-existing handwritten note directly under the vault release directory is never replaced or duplicated', () => fixture(({ run, note, index, vault }) => {
  const flat = join(vault, directory, name);
  writeFileSync(flat, '손으로 고친 본문\n');
  expect(run()).toMatchObject({ outcome: 'ok', skipped: 'exists' });
  expect(readFileSync(flat, 'utf8')).toBe('손으로 고친 본문\n');
  expect(() => readFileSync(note)).toThrow();
  expect(readFileSync(index, 'utf8').match(/\|v0\.2\.13\]\]/g)).toHaveLength(1);
  expect(() => readFileSync(join(vault, directory, '0.x', '0.2', name))).toThrow();
}));

test('one feature family across different owners stays one group (OP 19:10 ①)', () => fixture(({ root, vault, context, note }) => {
  const checklist = () => [
    { id: 'HQ-FENCE2', title: '설치 확인 — 기존 설치를 점검한다 `elanous doctor`', owner: 'MK', status: 'green' as const },
    { id: 'HQ-REP', title: '업데이트 복원 — 새 판을 설치한다', owner: 'TC', status: 'green' as const },
    { id: 'LOOP-OBS1', title: '대시보드 표시 — 릴리스 정보를 보여준다', owner: 'TC', status: 'green' as const },
  ];
  expect(runVaultNote(context, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist }).outcome).toBe('ok');
  const content = readFileSync(note, 'utf8');
  expect(content).toContain('### HQ\n\n- HQ-FENCE2 — 설치 확인\n  - 명령: `elanous doctor`\n\n- HQ-REP — 업데이트 복원');
  expect(content).toContain('### LOOP\n\n- LOOP-OBS1 — 대시보드 표시');
  expect(content).not.toContain('### MK');
}));

test('published release record with publicRepo supplies the GitHub release link', () => fixture(({ root, run, note }) => {
  const recordPath = join(root, 'release', version, 'release.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, string>;
  writeFileSync(recordPath, JSON.stringify({ ...record, publicRepo: 'Example/release-mirror' }));
  expect(run().outcome).toBe('ok');
  expect(readFileSync(note, 'utf8')).toContain('github: https://github.com/Example/release-mirror/releases/tag/v0.2.13');
}));

test('missing publicRepo fails instead of asserting a default GitHub link', () => fixture(({ root, run, note, index }) => {
  const recordPath = join(root, 'release', version, 'release.json');
  const { publicRepo: _omitted, ...record } = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, string>;
  writeFileSync(recordPath, JSON.stringify(record));
  const before = readFileSync(index, 'utf8');
  expect(run()).toMatchObject({ outcome: 'fail', reason: 'release.json publicRepo missing or invalid' });
  expect(() => readFileSync(note)).toThrow();
  expect(readFileSync(index, 'utf8')).toBe(before);
}));

test('a pipe in a command title stays in the note but is escaped in the index one-line cell', () => fixture(({ root, vault, context, note, index }) => {
  const checklist = () => [
    { id: 'CLI1', title: '명령: `elanous logs | head` 확인', owner: 'TC', status: 'green' as const },
    { id: 'CLI2', title: '릴리스 링크 확인', owner: 'MK', status: 'green' as const },
  ];
  expect(runVaultNote(context, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist }).outcome).toBe('ok');
  expect(readFileSync(note, 'utf8')).toContain('명령: `elanous logs | head` 확인');
  const rows = readFileSync(index, 'utf8').split('\n');
  expect(rows[4]).toBe('| [[엘라누스 v0.2.13 (2026-10-04)\\|v0.2.13]] | 10-04 18:00 | 명령: `elanous logs \\| head` 확인 · 릴리스 링크 확인 |');
  expect(rows[5]).toBe(previous);
}));

test('publication writes its real release.json shape and the vault note uses its GitHub repo', () => fixture(async ({ root, vault, context }) => {
  const out = join(root, 'prepared-publication');
  const dist = join(out, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'SHA256SUMS'), '');
  const notesFile = join(out, 'notes.md');
  writeFileSync(notesFile, '# Release notes\n');
  const manifest: ReleaseManifest = {
    version, tag: `v${version}`, prerelease: false, publicRepo: 'ElanvitalAI/elanous', sourceRef: 'origin/main',
    sourceCommit: '8cd885efe701bf47c1df020c32ccd17e31cd4a25', publicCommit: 'b'.repeat(40),
    publicDir: out, distDir: dist, files: [], webUi: true, e2e: { ran: false }, preparedAt: '2026-10-04T08:00:00.000Z',
  };
  writeFileSync(join(out, 'release.json'), JSON.stringify(manifest));
  const runPublish: Runner = (command, args) => {
    if (command === 'gh' && args[1] === 'view') return { status: 1, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'show-ref') return { status: 1, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${manifest.sourceCommit}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  setElanousConfigDir(root);
  try {
    await publishRelease({ dir: out, notesFile, yes: true, repoRoot: root, instanceRoot: root, ledgerRoot: root, log: () => {} }, runPublish);
    const publishedRecord = JSON.parse(readFileSync(join(root, 'release', version, 'release.json'), 'utf8')) as ReleaseManifest & { publishedAt: string };
    const publishedAt = publishedRecord.publishedAt;
    expect(publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(publishedRecord).toMatchObject({ ...manifest, publishedAt: expect.any(String) });
    const result = runVaultNote(context, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] });
    expect(result.outcome).toBe('ok');
    const publicationDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(publishedAt));
    const publishedNote = join(vault, directory, `${version.split('.')[0]}.x`, version.split('.').slice(0, 2).join('.'), `엘라누스 v${version} (${publicationDate}).md`);
    expect(readFileSync(publishedNote, 'utf8')).toContain('github: https://github.com/ElanvitalAI/elanous/releases/tag/v0.2.13');
  } finally { resetElanousConfigDir(); }
}));

test('real checklist ledger supplies only green cells to the note', () => fixture(({ root, vault, context, note }) => {
  setElanousConfigDir(root);
  try {
    addItem(version, { id: 'L1', title: '기록: 발행 내역을 확인한다', owner: 'TC' });
    addItem(version, { id: 'L2', title: '미완료 기능', owner: 'MK' });
    setItem(version, 'L1', { status: 'green' }, 'TC');
    expect(runVaultNote(context, { instanceRoot: root, productionRoot: root, vaultRoot: vault }).outcome).toBe('ok');
    const content = readFileSync(note, 'utf8');
    expect(content).toContain('- L1 — 기록: 발행 내역을 확인한다');
    expect(content).not.toContain('미완료 기능');
    expect(content).toContain('- green 칸 1개');
  } finally { resetElanousConfigDir(); }
}));

test('write failure is fail yet the vault-note graph edge leads through release-story to ops-upgrade', () => fixture(({ root, vault, context }) => {
  const fileVault = join(root, 'vault-file');
  writeFileSync(fileVault, 'not a directory');
  const result = runVaultNote(context, { instanceRoot: root, productionRoot: root, vaultRoot: fileVault, checklist: () => [] });
  expect(result.outcome).toBe('fail');
  expect(result.reason).toBeTruthy();
  const graph = parse(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as { edges: Array<{ from: string; map: Record<string, string> }> };
  expect(graph.edges.find((edge) => edge.from === 'vault-note')?.map).toEqual({ ok: 'release-story', fail: 'release-story', error: 'release-story' });
  expect(graph.edges.find((edge) => edge.from === 'verify')?.map).toEqual({ ok: 'vault-note', fail: 'failed', error: 'failed' });
  const recipes = parse(readFileSync(join(import.meta.dir, '../../graphs/release/recipes.yaml'), 'utf8')) as Record<string, { command: string; timeout_ms: number }>;
  expect(recipes['vault-note']).toEqual({ command: 'bun scripts/release-loop/vault-note-node.ts', timeout_ms: 60000 });
  expect(readFileSync(join(root, 'release', version, 'release.json'), 'utf8')).toContain('8cd885efe701bf47c1df020c32ccd17e31cd4a25');
  expect(readFileSync(join(vault, directory, '_색인 — 엘라누스 릴리스.md'), 'utf8')).toContain(previous);
}));

test('malformed existing index fails without replacing the handwritten index or creating a note', () => fixture(({ run, note, index }) => {
  writeFileSync(index, '# 사람이 쓰는 릴리스 메모\n');
  expect(run()).toMatchObject({ outcome: 'fail', verdict: 'fail' });
  expect(readFileSync(index, 'utf8')).toBe('# 사람이 쓰는 릴리스 메모\n');
  expect(() => readFileSync(note)).toThrow();
}));

test('unreadable publication record fails without writing a vault note or changing the manual index', () => fixture(({ root, vault, context, note, index }) => {
  const before = readFileSync(index, 'utf8');
  rmSync(join(root, 'release', version, 'release.json'));
  const result = runVaultNote(context, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] });
  expect(result).toMatchObject({ outcome: 'fail', verdict: 'fail' });
  expect(result.reason).toContain('release.json');
  expect(() => readFileSync(note)).toThrow();
  expect(readFileSync(index, 'utf8')).toBe(before);
}));

test('missing configured vaultRoot skips with a log line (OP 19:10 ③); isolated instance skips even with a vault path', () => fixture(({ root, vault, context, note }) => {
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ obsidian: {} }));
  const logged = spyOn(debug, 'log');
  try {
    expect(runVaultNote(context, { instanceRoot: root, productionRoot: root, configPath })).toMatchObject({ outcome: 'ok', skipped: 'no-vault' });
    expect(logged).toHaveBeenCalledWith('release.vault-note', 'skipped', { version, reason: 'no-vault' });
    expect(runVaultNote(context, { instanceRoot: root, productionRoot: join(root, 'prod'), vaultRoot: vault })).toMatchObject({ outcome: 'ok', skipped: 'isolated' });
    expect(logged).toHaveBeenCalledWith('release.vault-note', 'skipped', { version, reason: 'isolated' });
  } finally { logged.mockRestore(); }
  expect(() => readFileSync(note)).toThrow();
}));

test('configured vaultRoot takes precedence over the legacy vault setting', () => fixture(({ root, vault, context, note }) => {
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ obsidian: { vaultRoot: vault, vault: join(root, 'wrong-vault') } }));
  expect(runVaultNote(context, { instanceRoot: root, productionRoot: root, configPath, checklist: () => [] }).outcome).toBe('ok');
  expect(readFileSync(note, 'utf8')).toContain('cut: 8cd885ef');
  expect(() => readFileSync(join(root, 'wrong-vault', directory, name))).toThrow();
}));

test('configured vaultRoot and the existing obsidian.vault setting both select the vault', () => fixture(({ root, vault, context, note }) => {
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ obsidian: { vaultRoot: vault } }));
  expect(runVaultNote(context, { instanceRoot: root, productionRoot: root, configPath, checklist: () => [] }).outcome).toBe('ok');
  expect(readFileSync(note, 'utf8')).toContain('cut: 8cd885ef');
  rmSync(note);
  writeFileSync(configPath, JSON.stringify({ obsidian: { vault } }));
  expect(runVaultNote(context, { instanceRoot: root, productionRoot: root, configPath, checklist: () => [] }).outcome).toBe('ok');
  expect(readFileSync(note, 'utf8')).toContain('cut: 8cd885ef');
}));

test('only the matching release graph run reports gate retries and recuts with recorded reasons', () => fixture(({ root, vault, context }) => {
  const runId = 'fixture-run';
  mkdirSync(join(root, 'graph-runs', 'release-loop'), { recursive: true });
  writeFileSync(join(root, 'graph-runs', 'release-loop', `${runId}.json`), JSON.stringify({ graphId: 'release-loop', runId, input: { version }, nodes: [
    { nodeId: 'gate', ok: false, output: JSON.stringify({ outcome: 'fail', summary: '타입 검사 실패' }) }, { nodeId: 'gate', ok: true, output: '{"outcome":"ok"}' },
    { nodeId: 'cutoff', ok: false, output: JSON.stringify({ outcome: 'fail', summary: '컷 커밋 누락' }) }, { nodeId: 'cutoff', ok: true, output: '{"outcome":"ok"}' },
  ] }));
  const matched = { ...context, graphId: 'release-loop', runId };
  expect(runVaultNote(matched, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] }).outcome).toBe('ok');
  const note = readFileSync(join(vault, directory, '0.x', '0.2', name), 'utf8');
  expect(note).toContain('## 발행 경과\n\n- 2026-10-04 18:00 KST 발행\n- 게이트 재시도: 타입 검사 실패\n- 재컷: 컷 커밋 누락');
}));

test('a prior failed run of the same version supplies the retry reason, not unrelated versions', () => fixture(({ root, vault, context, note }) => {
  const graphDir = join(root, 'graph-runs', 'release-loop');
  mkdirSync(graphDir, { recursive: true });
  const earlier = (runId: string, v: string, summary: string) => ({ graphId: 'release-loop', runId, startedAt: '2026-10-04T07:00:00Z', input: { version: v }, nodes: [
    { nodeId: 'gate', ok: false, output: JSON.stringify({ outcome: 'fail', summary }) },
  ] });
  writeFileSync(join(graphDir, 'earlier.json'), JSON.stringify(earlier('earlier', version, '게이트 기준 미달')));
  writeFileSync(join(graphDir, 'unrelated.json'), JSON.stringify(earlier('unrelated', '0.2.12', '다른 판 실패')));
  const current = { graphId: 'release-loop', runId: 'now', startedAt: '2026-10-04T08:00:00Z', input: { version }, nodes: [
    { nodeId: 'gate', ok: true, output: '{"outcome":"ok"}' },
  ] };
  writeFileSync(join(graphDir, 'now.json'), JSON.stringify(current));
  const matched = { ...context, graphId: 'release-loop', runId: 'now' };
  expect(runVaultNote(matched, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] }).outcome).toBe('ok');
  const content = readFileSync(note, 'utf8');
  expect(content).toContain('- 게이트 재시도: 게이트 기준 미달');
  expect(content).not.toContain('다른 판 실패');
}));

test('stability line compares known-issues with the newest published version, skipping an unpublished folded one', () => fixture(({ root, vault, context, note }) => {
  const dir = join(root, 'graph-runs', 'release-loop');
  mkdirSync(dir, { recursive: true });
  // 0.2.11 was published; 0.2.12 was cut and folded into the next version without publishing (no release.json).
  mkdirSync(join(root, 'release', '0.2.11'), { recursive: true });
  writeFileSync(join(root, 'release', '0.2.11', 'release.json'), JSON.stringify({ version: '0.2.11', tag: 'v0.2.11', sourceCommit: previousCommit, publishedAt: '2026-10-02T12:00:00Z' }));
  mkdirSync(join(root, 'release', '0.2.12'), { recursive: true });
  const published = previousRun('previous', 4);
  writeFileSync(join(dir, 'previous.json'), JSON.stringify({ ...published, input: { version: '0.2.11' }, nodes: published.nodes.map((node) => node.nodeId === 'publish' ? { ...node, output: JSON.stringify({ tag: 'v0.2.11' }) } : node) }));
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ graphId: 'release-loop', runId: 'current', input: { version }, nodes: [
    { nodeId: 'gate', ok: true, output: JSON.stringify({ introduced: [], preexisting: 0 }) },
    { nodeId: 'known-issues', ok: true, output: JSON.stringify({ count: 3 }) },
  ] }));
  const matched = { ...context, graphId: 'release-loop', runId: 'current' };
  expect(context.input.previousVersion).toBe('0.2.12');
  expect(runVaultNote(matched, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] }).outcome).toBe('ok');
  expect(readFileSync(note, 'utf8')).toContain('known-issues 직전 판 대비 -1');
}));

test('stability line reads same-run ledger values and previous version known-issues count', () => fixture(({ root, vault, context, note }) => {
  const dir = join(root, 'graph-runs', 'release-loop');
  mkdirSync(dir, { recursive: true });
  writePublishedPrevious(root);
  writeFileSync(join(dir, 'previous.json'), JSON.stringify(previousRun('previous', 2)));
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ graphId: 'release-loop', runId: 'current', input: { version }, nodes: [
    { nodeId: 'gate', ok: true, output: JSON.stringify({ introduced: ['one'], preexisting: 3 }) },
    { nodeId: 'cutoff', ok: true, output: JSON.stringify({ baseline: { sha: 'base' }, cutoff: { sha: 'cut' }, in: [] }) },
    { nodeId: 'known-issues', ok: true, output: JSON.stringify({ count: 5 }) },
  ] }));
  const matched = { ...context, graphId: 'release-loop', runId: 'current' };
  const currentBefore = readFileSync(join(dir, 'current.json'), 'utf8');
  const previousBefore = readFileSync(join(dir, 'previous.json'), 'utf8');
  const logged = spyOn(debug, 'log');
  try {
    expect(runVaultNote(matched, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] }).outcome).toBe('ok');
    const content = readFileSync(note, 'utf8');
    expect(content).toContain('안정: 게이트 introduced 1 · preexisting 3 · 재컷 ? · 호스트 판올림 성공 ? · known-issues 직전 판 대비 +3');
    expect(content.match(/^안정: /gm)).toHaveLength(1);
    expect(readFileSync(join(dir, 'current.json'), 'utf8')).toBe(currentBefore);
    expect(readFileSync(join(dir, 'previous.json'), 'utf8')).toBe(previousBefore);
    expect(logged).toHaveBeenCalledWith('release-loop.vault-note', 'stability-line', { fields: { introduced: 1, preexisting: 3, recut: '?', hosts: '?', knownIssuesDelta: '+3' }, unreadable: ['cutoff.pick count not recorded', 'ops-upgrade.hosts not yet available'] });
  } finally { logged.mockRestore(); }
}));

test('known-issues delta uses the published previous run, not a later failed run', () => fixture(({ root, vault, context, note }) => {
  const dir = join(root, 'graph-runs', 'release-loop');
  mkdirSync(dir, { recursive: true });
  writePublishedPrevious(root);
  for (const [runId, startedAt, count, published] of [
    ['early', '2026-10-03T07:00:00Z', 4, true], ['late', '2026-10-03T09:00:00Z', 9, false], ['future', '2026-10-05T09:00:00Z', 8, false],
  ] as const) {
    writeFileSync(join(dir, `${runId}.json`), JSON.stringify(previousRun(runId, count, startedAt, published)));
  }
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ graphId: 'release-loop', runId: 'current', startedAt: '2026-10-04T09:00:00Z', input: { version }, nodes: [
    { nodeId: 'known-issues', ok: true, output: JSON.stringify({ count: 5 }) },
  ] }));
  const matched = { ...context, graphId: 'release-loop', runId: 'current' };
  expect(runVaultNote(matched, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] }).outcome).toBe('ok');
  expect(readFileSync(note, 'utf8')).toContain('known-issues 직전 판 대비 +1');
}));

test('ambiguous published previous runs with different counts leave delta unknown', () => fixture(({ root, vault, context, note }) => {
  const dir = join(root, 'graph-runs', 'release-loop');
  mkdirSync(dir, { recursive: true });
  writePublishedPrevious(root);
  writeFileSync(join(dir, 'first.json'), JSON.stringify(previousRun('first', 2, '2026-10-03T07:00:00Z')));
  writeFileSync(join(dir, 'second.json'), JSON.stringify(previousRun('second', 9, '2026-10-03T08:00:00Z')));
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ graphId: 'release-loop', runId: 'current', input: { version }, nodes: [
    { nodeId: 'known-issues', ok: true, output: JSON.stringify({ count: 5 }) },
  ] }));
  const matched = { ...context, graphId: 'release-loop', runId: 'current' };
  expect(runVaultNote(matched, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] }).outcome).toBe('ok');
  expect(readFileSync(note, 'utf8')).toContain('known-issues 직전 판 대비 ?');
}));

test('unknown previous publication never substitutes a failed previous run count', () => fixture(({ root, vault, context, note }) => {
  const dir = join(root, 'graph-runs', 'release-loop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'previous.json'), JSON.stringify(previousRun('previous', 8, undefined, false)));
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ graphId: 'release-loop', runId: 'current', input: { version }, nodes: [
    { nodeId: 'gate', ok: true, output: JSON.stringify({ introduced: [], preexisting: 0 }) },
    { nodeId: 'known-issues', ok: true, output: JSON.stringify({ count: 5 }) },
  ] }));
  const matched = { ...context, graphId: 'release-loop', runId: 'current' };
  expect(runVaultNote(matched, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] })).toMatchObject({ outcome: 'ok', verdict: 'pass' });
  expect(readFileSync(note, 'utf8')).toContain('안정: 게이트 introduced 0 · preexisting 0 · 재컷 ? · 호스트 판올림 성공 ? · known-issues 직전 판 대비 ?');
}));

test('known-issues delta distinguishes a measured zero and a decrease', () => fixture(({ root, vault, context, note }) => {
  const dir = join(root, 'graph-runs', 'release-loop');
  mkdirSync(dir, { recursive: true });
  writePublishedPrevious(root);
  writeFileSync(join(dir, 'previous.json'), JSON.stringify(previousRun('previous', 0)));
  const currentPath = join(dir, 'current.json');
  const matched = { ...context, graphId: 'release-loop', runId: 'current' };
  writeFileSync(currentPath, JSON.stringify({ graphId: 'release-loop', runId: 'current', input: { version }, nodes: [
    { nodeId: 'known-issues', ok: true, output: JSON.stringify({ count: 0 }) },
  ] }));
  expect(runVaultNote(matched, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] }).outcome).toBe('ok');
  expect(readFileSync(note, 'utf8')).toContain('known-issues 직전 판 대비 +0');
  writeFileSync(join(dir, 'previous.json'), JSON.stringify(previousRun('previous', 2)));
  rmSync(note);
  expect(runVaultNote(matched, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] }).outcome).toBe('ok');
  expect(readFileSync(note, 'utf8')).toContain('known-issues 직전 판 대비 -2');
}));

test('partial ledger preserves measured zeros and marks only missing fields unknown', () => fixture(({ root, vault, context, note }) => {
  const dir = join(root, 'graph-runs', 'release-loop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ graphId: 'release-loop', runId: 'current', input: { version }, nodes: [
    { nodeId: 'gate', ok: true, output: JSON.stringify({ introduced: [], preexisting: 0 }) },
    { nodeId: 'cutoff', ok: true, output: JSON.stringify({ baseline: { sha: 'base' }, cutoff: { sha: 'base' }, in: [] }) },
    { nodeId: 'known-issues', ok: true, output: JSON.stringify({ count: 0 }) },
  ] }));
  const matched = { ...context, graphId: 'release-loop', runId: 'current' };
  const logged = spyOn(debug, 'log');
  try {
    expect(runVaultNote(matched, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] }).outcome).toBe('ok');
    expect(readFileSync(note, 'utf8')).toContain('안정: 게이트 introduced 0 · preexisting 0 · 재컷 ? · 호스트 판올림 성공 ? · known-issues 직전 판 대비 ?');
    expect(logged).toHaveBeenCalledWith('release-loop.vault-note', 'stability-line', { fields: { introduced: 0, preexisting: 0, recut: '?', hosts: '?', knownIssuesDelta: '?' }, unreadable: ['cutoff.pick count not recorded', 'ops-upgrade.hosts not yet available', 'known-issues.count(previous/current)'] });
  } finally { logged.mockRestore(); }
}));

test('graph runner context supplies run identity even when readGraphContext strips it', () => fixture(({ root, vault, context, note }) => {
  const dir = join(root, 'graph-runs', 'release-loop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ graphId: 'release-loop', runId: 'current', input: { version }, nodes: [
    { nodeId: 'gate', ok: true, output: JSON.stringify({ outcome: 'ok', introduced: [], preexisting: 0 }) },
    { nodeId: 'cutoff', ok: true, output: JSON.stringify({ version, baseline: { sha: 'base' }, cutoff: { sha: 'cut' }, in: [] }) },
    { nodeId: 'known-issues', ok: true, output: JSON.stringify({ outcome: 'ok', count: 0 }) },
  ] }));
  const saved = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = JSON.stringify({ graphId: 'release-loop', runId: 'current', input: context.input, outputs: context.outputs });
  try {
    expect(runVaultNote(context, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] })).toMatchObject({ outcome: 'ok', verdict: 'pass' });
    expect(readFileSync(note, 'utf8')).toContain('안정: 게이트 introduced 0 · preexisting 0 · 재컷 ? · 호스트 판올림 성공 ? · known-issues 직전 판 대비 ?');
    const graph = parse(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as { edges: Array<{ from: string; map: Record<string, string> }> };
    expect(graph.edges.find((edge) => edge.from === 'vault-note')?.map.ok).toBe('release-story');
  } finally {
    if (saved === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = saved;
  }
}));

test('release graph runner writes note before later ops-upgrade results in its run ledger', () => fixture(async ({ root, vault, context, note }) => {
  const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const runId = 'graph-order';
  const nodes: Array<{ nodeId: string; ok: boolean; output: string }> = [];
  const output = (nodeId: string, data: Record<string, unknown>) => {
    const result = JSON.stringify(data);
    nodes.push({ nodeId, ok: true, output: result });
    return { stdout: `${result}\n`, stderr: '', exitCode: 0 };
  };
  const saved = process.env.ELANOUS_GRAPH_CONTEXT;
  try {
    const state = await runGraph(graphPath, { runId, input: context.input, deps: { root, log: () => {}, runBash: async (_body, options) => {
      const location = options.env!.ELANOUS_GRAPH_CONTEXT!;
      const nodeId = JSON.parse(readFileSync(location, 'utf8')).nodeId as string;
      if (nodeId === 'vault-note') {
        process.env.ELANOUS_GRAPH_CONTEXT = location;
        const result = runVaultNote(context, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] });
        expect(result.outcome).toBe('ok');
        const text = readFileSync(note, 'utf8');
        expect(text).toContain('안정: 게이트 introduced 0 · preexisting 0 · 재컷 ? · 호스트 판올림 성공 ?');
        expect(nodes.some((node) => node.nodeId === 'ops-upgrade')).toBe(false);
        return output(nodeId, result);
      }
      if (nodeId === 'gate') return output(nodeId, { outcome: 'ok', introduced: [], preexisting: 0 });
      if (nodeId === 'cutoff') return output(nodeId, { outcome: 'ok', baseline: { sha: 'base' }, cutoff: { sha: 'cut' }, in: [] });
      if (nodeId === 'known-issues') return output(nodeId, { outcome: 'ok', count: 0 });
      if (nodeId === 'ops-upgrade') return output(nodeId, { outcome: 'ok', hosts: [{ ok: true }, { ok: false }] });
      return output(nodeId, { outcome: 'ok' });
    } } });
    expect(state.path.indexOf('vault-note')).toBeLessThan(state.path.indexOf('ops-upgrade'));
    const ledger = JSON.parse(readFileSync(join(root, 'graph-runs', 'release-loop', `${runId}.json`), 'utf8')) as { nodes: Array<{ nodeId: string; output?: string }> };
    expect(readFileSync(note, 'utf8')).toContain('안정: 게이트 introduced 0 · preexisting 0 · 재컷 ? · 호스트 판올림 성공 ?');
    expect(JSON.parse(ledger.nodes.find((node) => node.nodeId === 'ops-upgrade')!.output!)).toMatchObject({ hosts: [{ ok: true }, { ok: false }] });
  } finally {
    if (saved === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = saved;
  }
}));

test('unreadable graph identity cannot fail an otherwise publishable note', () => fixture(({ root, vault, context, note }) => {
  const saved = process.env.ELANOUS_GRAPH_CONTEXT;
  process.env.ELANOUS_GRAPH_CONTEXT = '{malformed';
  try {
    expect(runVaultNote(context, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] })).toMatchObject({ outcome: 'ok', verdict: 'pass' });
    expect(readFileSync(note, 'utf8')).toContain('안정: 측정 불가: 런 식별자 없음');
  } finally {
    if (saved === undefined) delete process.env.ELANOUS_GRAPH_CONTEXT;
    else process.env.ELANOUS_GRAPH_CONTEXT = saved;
  }
}));

test('missing run ledger writes one unavailable stability line and retains ok result', () => fixture(({ root, vault, context, note }) => {
  const matched = { ...context, graphId: 'release-loop', runId: 'missing' };
  const logged = spyOn(debug, 'log');
  try {
    expect(runVaultNote(matched, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist: () => [] })).toMatchObject({ outcome: 'ok', verdict: 'pass' });
    const text = readFileSync(note, 'utf8');
    expect(text.match(/^안정: 측정 불가: 런 원장 없음\(missing\.json\)$/gm)).toHaveLength(1);
    expect(logged).toHaveBeenCalledWith('release-loop.vault-note', 'stability-line', { fields: { introduced: '?', preexisting: '?', recut: '?', hosts: '?', knownIssuesDelta: '?' }, unreadable: [expect.stringContaining('missing.json')] });
  } finally { logged.mockRestore(); }
}));

test('actual node CLI emits skipped isolated and never writes to vault in a test universe', () => fixture(({ root, vault, context, note }) => {
  const run = spawnSync('bun', [join(import.meta.dir, 'vault-note-node.ts')], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) } });
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout.trim())).toMatchObject({ outcome: 'ok', skipped: 'isolated' });
  expect(() => readFileSync(note)).toThrow();
  expect(readFileSync(join(vault, directory, '_색인 — 엘라누스 릴리스.md'), 'utf8')).toContain(previous);
}));

test('30 cut landings including next.md lines appear in four counted topics; three leading topic clauses skip broken punctuation', () => fixture(({ root, run, note, index }) => {
  const entries = [
    ...Array.from({ length: 9 }, (_, i) => ({ sha: `${i + 1}`.padStart(40, 'a'), title: `조직 루프 개선 ${i}`, line: `조직 루프 개선 ${i}`, prNumber: i + 1 })),
    ...Array.from({ length: 8 }, (_, i) => ({ sha: `${i + 10}`.padStart(40, 'b'), title: `하니스 검증 ${i}`, line: i === 0 ? '하니스 «잘린 제목' : `하니스 검증 ${i}` })),
    ...Array.from({ length: 7 }, (_, i) => ({ sha: `${i + 18}`.padStart(40, 'c'), title: `텔레그램 발송 ${i}`, line: `텔레그램 발송 ${i}` })),
    ...Array.from({ length: 6 }, (_, i) => ({ sha: '', title: `지식 교훈 ${i}`, line: `지식 교훈 ${i}` })),
  ];
  mkdirSync(join(root, 'release', version), { recursive: true });
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'b'.repeat(40) }, cutoff: { sha: '8cd885efe701bf47c1df020c32ccd17e31cd4a25' }, in: entries }));
  expect(run().outcome).toBe('ok');
  const content = readFileSync(note, 'utf8');
  const landings = content.split('## 이번 판 착지 (직전 판 컷 ~ 이번 판 컷)\n\n')[1]!.split('## 이제 할 수 있는 것')[0]!;
  expect([...landings.matchAll(/^### (.+) \((\d+)건\)$/gm)].map((match) => [match[1], Number(match[2])])).toEqual([
    ['조직·루프', 9], ['하니스', 8], ['채널·PWA', 7], ['지식·교훈', 6],
  ]);
  expect([...landings.matchAll(/^### .+ \((\d+)건\)$/gm)].reduce((sum, match) => sum + Number(match[1]), 0)).toBe(30);
  expect(landings.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(30);
  expect(landings).toContain('- 하니스 «잘린 제목');
  expect(landings).toContain('- 지식 교훈 5');
  expect(content).toContain('title: "엘라누스 v0.2.13 — 조직 루프 개선 0 · 하니스 검증 1 · 텔레그램 발송 0"');
  expect(readFileSync(index, 'utf8')).toContain('조직 루프 개선 0 · 하니스 검증 1 · 텔레그램 발송 0');
}));

test('representative skips an invalid third topic and takes a valid fourth topic', () => fixture(({ root, run, note, index }) => {
  const cut = '8cd885efe701bf47c1df020c32ccd17e31cd4a25';
  const entries = [
    ...Array.from({ length: 4 }, (_, i) => ({ sha: 'a'.repeat(40), title: `조직 루프 ${i}`, line: `조직 루프 ${i}` })),
    ...Array.from({ length: 3 }, (_, i) => ({ sha: 'b'.repeat(40), title: `하니스 검증 ${i}`, line: `하니스 검증 ${i}` })),
    ...Array.from({ length: 2 }, (_, i) => ({ sha: 'c'.repeat(40), title: `텔레그램 «잘림 ${i}`, line: `텔레그램 «잘림 ${i}` })),
    { sha: 'd'.repeat(40), title: '지식 교훈 축적', line: '지식 교훈 축적' },
  ];
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'e'.repeat(40) }, cutoff: { sha: cut }, in: entries }));
  expect(run().outcome).toBe('ok');
  const content = readFileSync(note, 'utf8');
  expect(content).toContain('### 채널·PWA (2건)');
  expect(content).toContain('### 지식·교훈 (1건)');
  expect(parse(content.split('---\n')[1]!)).toMatchObject({ title: `엘라누스 v${version} — 조직 루프 0 · 하니스 검증 0 · 지식 교훈 축적` });
  expect(readFileSync(index, 'utf8')).toContain('조직 루프 0 · 하니스 검증 0 · 지식 교훈 축적');
  expect(content).not.toContain('title: "엘라누스 v0.2.13 — 조직 루프 0 · 하니스 검증 0 · 텔레그램');
}));

test('balanced quotes and backslashes in a landing title round-trip through parsed YAML frontmatter', () => fixture(({ root, run, note }) => {
  const title = '하니스 "검증" 개선 \\ 경로';
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({
    version, baseline: { sha: 'b'.repeat(40) }, cutoff: { sha: '8cd885efe701bf47c1df020c32ccd17e31cd4a25' },
    in: [{ sha: 'c'.repeat(40), title, line: title, prNumber: 42 }],
  }));
  expect(run().outcome).toBe('ok');
  const content = readFileSync(note, 'utf8');
  const frontmatter = content.split('---\n')[1]!;
  expect(parse(frontmatter)).toMatchObject({ title: `엘라누스 v${version} — ${title}` });
  expect(content).toContain(`- ${title} (#42)`);
}));

test('unreadable or mismatched cut manifest marks the landing section with a reason instead of silently omitting it', () => fixture(({ root, run, note }) => {
  const path = join(root, 'release', version, 'manifest.json');
  expect(run().outcome).toBe('ok');
  expect(readFileSync(note, 'utf8')).toContain('## 이번 판 착지 (직전 판 컷 ~ 이번 판 컷)\n\n- 못 읽음 · manifest.json:');
  expect(readFileSync(note, 'utf8')).toContain('ENOENT');
  rmSync(note);
  writeFileSync(path, JSON.stringify({ version, baseline: { sha: 'b'.repeat(40) }, cutoff: { sha: 'f'.repeat(40) }, in: [] }));
  expect(run().outcome).toBe('ok');
  expect(readFileSync(note, 'utf8')).toContain('- 못 읽음 · manifest.json: 판·직전 컷·이번 컷 또는 착지 줄 불일치');
}));

test('title keeps guillemets paired when a cell title opens « without closing it (0.2.14)', () => fixture(({ root, vault, context, note }) => {
  const checklist = () => [
    { id: 'OUT1', title: '/v1/outbound 가 «delivered:true · 착지 동결 장치', owner: 'TC', status: 'green' as const },
    { id: 'OUT2', title: '발송이 «보냄 · 받음» 을 가른다 — 세부', owner: 'TC', status: 'green' as const },
  ];
  expect(runVaultNote(context, { instanceRoot: root, productionRoot: root, vaultRoot: vault, checklist })).toMatchObject({ outcome: 'ok' });
  const title = readFileSync(note, 'utf8').match(/^title: "(.*)"$/m)![1]!;
  expect(title).toBe('엘라누스 v0.2.13 — 발송이 «보냄 · 받음» 을 가른다');
  expect(title.split('«').length).toBe(title.split('»').length);
}));

test("representative skips a topic whose title leaves an ASCII ' unclosed, but keeps a word-internal apostrophe (ACP must-fix)", () => fixture(({ root, run, note }) => {
  const cut = '8cd885efe701bf47c1df020c32ccd17e31cd4a25';
  const entries = [
    ...Array.from({ length: 4 }, (_, i) => ({ sha: 'a'.repeat(40), title: `조직 루프 ${i}`, line: `조직 루프 ${i}` })),
    ...Array.from({ length: 3 }, (_, i) => ({ sha: 'b'.repeat(40), title: `하니스 검증 ${i}`, line: `하니스 검증 ${i}` })),
    ...Array.from({ length: 2 }, (_, i) => ({ sha: 'c'.repeat(40), title: `텔레그램 'open ${i}`, line: `텔레그램 'open ${i}` })),
    { sha: 'd'.repeat(40), title: "지식 교훈 doesn't break", line: "지식 교훈 doesn't break" },
  ];
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'e'.repeat(40) }, cutoff: { sha: cut }, in: entries }));
  expect(run().outcome).toBe('ok');
  const content = readFileSync(note, 'utf8');
  expect(parse(content.split('---\n')[1]!)).toMatchObject({ title: `엘라누스 v${version} — 조직 루프 0 · 하니스 검증 0 · 지식 교훈 doesn't break` });
}));

test('real release/next.md lines lead with their kind; the headline keeps the change, not «feat» (ACP must-fix)', () => fixture(({ root, run, note }) => {
  const cut = '8cd885efe701bf47c1df020c32ccd17e31cd4a25';
  const entries = [
    ...Array.from({ length: 3 }, (_, i) => ({ sha: 'a'.repeat(40), title: `조직 루프 ${i}`, line: `feat — seat requests can be listed and closed from the CLI ${i}.` })),
    ...Array.from({ length: 2 }, (_, i) => ({ sha: 'b'.repeat(40), title: `하니스 검증 ${i}`, line: `internal — clarification tests no longer write into the card bridge ${i}.` })),
    { sha: 'd'.repeat(40), title: '지식 교훈 축적', line: 'fix — lessons handbook folds every table' },
  ];
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'e'.repeat(40) }, cutoff: { sha: cut }, in: entries }));
  expect(run().outcome).toBe('ok');
  const title = (parse(readFileSync(note, 'utf8').split('---\n')[1]!) as { title: string }).title;
  expect(title).toContain('seat requests can be listed and closed from the CLI 0.');
  expect(title).toContain('lessons handbook folds every table');
  expect(title).not.toMatch(/— feat( ·|$)/);
}));

test('a separator inside a balanced quoted or parenthesized span does not cut the headline clause (ACP must-fix)', () => fixture(({ root, run, note }) => {
  const cut = '8cd885efe701bf47c1df020c32ccd17e31cd4a25';
  const entries = [
    ...Array.from({ length: 3 }, (_, i) => ({ sha: 'a'.repeat(40), title: `조직 루프 ${i}`, line: `조직 루프 "기능 · 개선" ${i}` })),
    ...Array.from({ length: 2 }, (_, i) => ({ sha: 'b'.repeat(40), title: `하니스 검증 ${i}`, line: `하니스 검증 (재시도 · 회수) ${i}` })),
  ];
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'e'.repeat(40) }, cutoff: { sha: cut }, in: entries }));
  expect(run().outcome).toBe('ok');
  const title = (parse(readFileSync(note, 'utf8').split('---\n')[1]!) as { title: string }).title;
  expect(title).toContain('조직 루프 "기능 · 개선" 0');
  expect(title).toContain('하니스 검증 (재시도 · 회수) 0');
}));

test('a manifest whose baseline is not the previous published cut marks the landing section instead of publishing wrong landings (ACP must-fix)', () => fixture(({ root, run, note }) => {
  const cut = '8cd885efe701bf47c1df020c32ccd17e31cd4a25';
  const previous = '0.2.12';
  mkdirSync(join(root, 'release', previous), { recursive: true });
  writeFileSync(join(root, 'release', previous, 'release.json'), JSON.stringify({ version: previous, tag: `v${previous}`, sourceCommit: 'f'.repeat(40), publishedAt: '2026-10-01T00:00:00Z' }));
  const entries = [{ sha: 'a'.repeat(40), title: '조직 루프', line: '조직 루프' }];
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'e'.repeat(40) }, cutoff: { sha: cut }, in: entries }));
  run();
  expect(readFileSync(note, 'utf8')).toContain('직전 판 컷 불일치');
}));

test('a manifest whose baseline equals the previous published cut keeps its landings', () => fixture(({ root, run, note }) => {
  const previous = '0.2.12';
  mkdirSync(join(root, 'release', previous), { recursive: true });
  writeFileSync(join(root, 'release', previous, 'release.json'), JSON.stringify({ version: previous, tag: `v${previous}`, sourceCommit: 'f'.repeat(40), publishedAt: '2026-10-01T00:00:00Z' }));
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'f'.repeat(40) },
    cutoff: { sha: '8cd885efe701bf47c1df020c32ccd17e31cd4a25' }, in: [{ sha: 'a'.repeat(40), title: '조직 루프', line: '조직 루프' }] }));
  expect(run().outcome).toBe('ok');
  const content = readFileSync(note, 'utf8');
  expect(content).not.toContain('직전 판 컷 불일치');
  expect(content).toContain('조직 루프');
}));

test("single quotes ('…' and ‘…’) keep their inner separator in the headline clause (ACP must-fix)", () => fixture(({ root, run, note }) => {
  const entries = [
    ...Array.from({ length: 3 }, (_, i) => ({ sha: 'a'.repeat(40), title: `조직 루프 ${i}`, line: `조직 루프 '검증 · 회수' ${i}` })),
    ...Array.from({ length: 2 }, (_, i) => ({ sha: 'b'.repeat(40), title: `하니스 검증 ${i}`, line: `하니스 검증 ‘재시도 · 회수’ ${i}` })),
  ];
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'e'.repeat(40) },
    cutoff: { sha: '8cd885efe701bf47c1df020c32ccd17e31cd4a25' }, in: entries }));
  expect(run().outcome).toBe('ok');
  const title = (parse(readFileSync(note, 'utf8').split('---\n')[1]!) as { title: string }).title;
  expect(title).toContain("조직 루프 '검증 · 회수' 0");
  expect(title).toContain('하니스 검증 ‘재시도 · 회수’ 0');
}));

test('an earlier unpublished version with no published one marks the landing section unverified (ACP must-fix)', () => fixture(({ root, run, note }) => {
  mkdirSync(join(root, 'release', '0.2.12'), { recursive: true });
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'e'.repeat(40) },
    cutoff: { sha: '8cd885efe701bf47c1df020c32ccd17e31cd4a25' }, in: [{ sha: 'a'.repeat(40), title: '조직 루프', line: '조직 루프' }] }));
  run();
  expect(readFileSync(note, 'utf8')).toContain('못 읽음 · manifest.json: 직전 판 컷 확인 못 함');
}));

test('0.2.15 real cut lines: version bumps and «docs: release» never headline, commit prefixes drop, long clauses shorten', () => fixture(({ root, run, note }) => {
  // Real lines from the 0.2.15 cut manifest (10-06) — the published note's title was the version bump and prefixed subjects.
  const real = [
    'docs: LOOP-VIZ 활동 지도 설계',
    'docs: release 0.2.14',
    'version: 0.2.15-dev.0',
    'docs(marketing): restore AX-BRIEF (deleted out-of-scope by #23901); managed seats move past December',
    'the harness no longer deletes files that were added to main after a run started when they are outside the run\'s target paths.',
  ];
  const entries = real.map((line, i) => ({ sha: String(i).repeat(40).slice(0, 40), title: line, line }));
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'e'.repeat(40) },
    cutoff: { sha: '8cd885efe701bf47c1df020c32ccd17e31cd4a25' }, in: entries }));
  expect(run().outcome).toBe('ok');
  const title = (parse(readFileSync(note, 'utf8').split('---\n')[1]!) as { title: string }).title;
  expect(title).not.toContain('version:');
  expect(title).not.toContain('release 0.2.14');
  expect(title).not.toMatch(/(^|· )docs(\([^)]*\))?:/);
  for (const part of title.replace(/^엘라누스 v[\d.]+ — /, '').split(' · ')) expect([...part].length).toBeLessThanOrEqual(61);
}));

test('a long headline clause is cut at its first comma or semicolon (ACP must-fix)', () => fixture(({ root, run, note }) => {
  const line = 'seat requests can be listed, closed with a reason; and audited later from the command line interface';
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'e'.repeat(40) },
    cutoff: { sha: '8cd885efe701bf47c1df020c32ccd17e31cd4a25' }, in: [{ sha: 'a'.repeat(40), title: line, line }] }));
  expect(run().outcome).toBe('ok');
  const title = (parse(readFileSync(note, 'utf8').split('---\n')[1]!) as { title: string }).title;
  expect(title).toBe(`엘라누스 v${version} — seat requests can be listed`);
}));

test('a separator without a following space still ends a long headline clause (ACP must-fix)', () => fixture(({ root, run, note }) => {
  const line = 'abcdefghijk,다음 절은 길게 이어진다 그래서 육십 자를 넘기려고 계속 쓰는 문장이다 끝까지 더 길게 이어서 육십 자를 확실히 넘긴다';
  writeFileSync(join(root, 'release', version, 'manifest.json'), JSON.stringify({ version, baseline: { sha: 'e'.repeat(40) },
    cutoff: { sha: '8cd885efe701bf47c1df020c32ccd17e31cd4a25' }, in: [{ sha: 'a'.repeat(40), title: line, line }] }));
  expect(run().outcome).toBe('ok');
  expect((parse(readFileSync(note, 'utf8').split('---\n')[1]!) as { title: string }).title).toBe(`엘라누스 v${version} — abcdefghijk`);
}));
