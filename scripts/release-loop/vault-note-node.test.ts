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
import { runVaultNote } from './vault-note-node.js';
import type { GraphContext } from './node-verdict.js';

const version = '0.2.13';
const directory = '40. Project/엘라누스 릴리스';
const name = '엘라누스 v0.2.13 (2026-10-04).md';
const previous = '| [[엘라누스 v0.2.12 (2026-10-03)|v0.2.12]] | 10-03 18:00 | 사람이 쓴 한 줄 |';

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

test('write failure is fail yet the vault-note graph edge leads to ops-upgrade', () => fixture(({ root, vault, context }) => {
  const fileVault = join(root, 'vault-file');
  writeFileSync(fileVault, 'not a directory');
  const result = runVaultNote(context, { instanceRoot: root, productionRoot: root, vaultRoot: fileVault, checklist: () => [] });
  expect(result.outcome).toBe('fail');
  expect(result.reason).toBeTruthy();
  const graph = parse(readFileSync(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), 'utf8')) as { edges: Array<{ from: string; map: Record<string, string> }> };
  expect(graph.edges.find((edge) => edge.from === 'vault-note')?.map).toEqual({ ok: 'ops-upgrade', fail: 'ops-upgrade', error: 'ops-upgrade' });
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

test('actual node CLI emits skipped isolated and never writes to vault in a test universe', () => fixture(({ root, vault, context, note }) => {
  const run = spawnSync('bun', [join(import.meta.dir, 'vault-note-node.ts')], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: root, ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) } });
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout.trim())).toMatchObject({ outcome: 'ok', skipped: 'isolated' });
  expect(() => readFileSync(note)).toThrow();
  expect(readFileSync(join(vault, directory, '_색인 — 엘라누스 릴리스.md'), 'utf8')).toContain(previous);
}));
