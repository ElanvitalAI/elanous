import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INVENTORY_REFRESH_COMMAND, auditTestStateWrites, classifyCandidates, classifyStaticIsolation, renderAudit } from '../scripts/audit-test-state-writes';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const repo = join(import.meta.dir, '..');
const inventory = join(repo, 'docs', 'TEST-home-state-write-audit.md');
const baseline = join(repo, 'test', 'test-home-state-write-audit-baseline.txt');
const auditScript = join(repo, 'scripts', 'audit-test-state-writes.ts');
const renameFailurePreload = join(import.meta.dir, 'fixtures', 'audit-test-state-writes-rename-failure-preload.ts');

function baselinePaths(): Set<string> {
  return new Set(
    readFileSync(baseline, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
}

function createAuditRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'test-home-state-write-audit-'));
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'test', 'candidate.test.ts'), [
    "import { writeFileSync } from 'node:fs';",
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "const stateDir = mkdtempSync(join(tmpdir(), 'audit-candidate-'));",
    "writeFileSync(join(stateDir, '.elanous', 'candidate.txt'), 'candidate');",
    '',
  ].join('\n'));
  return root;
}

/** ⛔⭐ 상태 증거가 «따옴표 안 경로»뿐인 후보 — 식별자(`homedir`·`ELANOUS_*_DIR`)를 한 번도 안 쓴다.
 *  종전 `statePattern` 은 선행 `\b` 가 전체 교대에 걸려 이 형태를 하나도 못 물었고, finding 은
 *  writer ⊕ state 줄이 «둘 다» 있어야 만들어지므로 그런 파일은 **통째로 누락**됐다.
 *  ⚠️ 위 `createAuditRepository` 픽스처는 `homedir()` 을 같이 써서 «다른 대안»으로 물렸다 —
 *     그래서 이 결함이 기존 회귀를 전부 통과했다. 이 픽스처가 그 구멍을 겨눈다. */
function createQuotedDotPathRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'test-home-state-write-audit-quoted-'));
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'test', 'quoted-dot-path.test.ts'), [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    'const base = process.env.SOME_ROOT ?? \'/tmp/x\';',
    "writeFileSync(join(base, '.elanous', 'candidate.txt'), 'candidate');",
    '',
  ].join('\n'));
  return root;
}

/** ⛔⭐ 홈 접근이 `process.env.HOME` 하나뿐인 후보 — 종전 목록은 `CODEX_HOME` 과
 *  `XDG_(CONFIG|DATA)_HOME` 만 알아서 «가장 흔한 형태»가 감사와 트립와이어를 둘 다 우회했다. */
function createBareHomeEnvRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'test-home-state-write-audit-home-'));
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'test', 'bare-home.test.ts'), [
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "writeFileSync(join(process.env.HOME!, 'candidate.txt'), 'candidate');",
    '',
  ].join('\n'));
  return root;
}

function createMixedWriterIsolationRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'test-home-state-write-audit-mixed-'));
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'test', 'mixed-writers.test.ts'), [
    "import { mkdtempSync, writeFileSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "const isolated = mkdtempSync(join(tmpdir(), 'isolated-'));",
    "writeFileSync(join(isolated, '.elanous', 'safe.txt'), 'safe');",
    "writeFileSync(join(process.env.HOME!, '.elanous', 'unsafe.txt'), 'unsafe');",
    '',
  ].join('\n'));
  return root;
}

/** ⛔⭐ 쓰기 호출이 «import 별칭»으로만 불리는 후보 — 종전엔 호출 시점 이름만 비교해서
 *  「새 후보를 막는다」는 계약이 별칭 한 줄로 우회됐다. */
function createAliasedWriterRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'test-home-state-write-audit-alias-'));
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'test', 'aliased-writer.test.ts'), [
    "import { writeFileSync as write } from 'node:fs';",
    "import { homedir } from 'node:os';",
    "import { join } from 'node:path';",
    "write(join(homedir(), 'candidate.txt'), 'candidate');",
    '',
  ].join('\n'));
  return root;
}

function createDatabaseConstructorRepository(usesDatabase: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'test-home-state-write-audit-database-'));
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'test', 'database-constructor.test.ts'), [
    "import { Database } from 'bun:sqlite';",
    "const path = process.env.ELANOUS_STATE_DIR + '/goal-runs.db';",
    ...(usesDatabase ? ['new Database(path);'] : ['Database;']),
    '',
  ].join('\n'));
  return root;
}

function updateBaseline(root: string, preload?: string, approveManualReview = false) {
  return spawnSync(process.execPath, [
    ...(preload ? ['--preload', preload] : []),
    auditScript,
    '--update-baseline',
    ...(approveManualReview ? ['--approve-manual-review'] : []),
  ], { cwd: root, encoding: 'utf8' });
}

function temporaryBaselineFiles(root: string): string[] {
  return readdirSync(join(root, 'test')).filter((name) => name.includes('.test-home-state-write-audit-baseline.txt.') && name.endsWith('.tmp'));
}

function expectInventoryMatches(actual: string, expected: string): void {
  expect(actual, `Refresh the committed audit inventory with: ${INVENTORY_REFRESH_COMMAND}`).toBe(expected);
}

/** 표 행의 2·4번째 칸(줄번호)과, 표 밖 산문의 `경로.확장자:숫자` 를 자리표시자로 바꾼다. */
function blankLineNumberColumns(markdown: string): string {
  return markdown.split('\n').map((line) => {
    if (line.startsWith('| `')) {
      const cells = line.split('|');
      if (cells.length < 8) return line;
      cells[2] = ' <lines> '; cells[4] = ' <lines> ';
      return cells.join('|');
    }
    return line.replace(/(`[^`\s]+\.[A-Za-z0-9]+):\d+/g, '$1:<line>');
  }).join('\n');
}

describe('test home/state write inventory contract', () => {
  test('scans both required roots and has a non-empty candidate denominator', () => {
    const report = auditTestStateWrites(repo);
    expect(report.total).toBeGreaterThan(3_000);
    expect(report.findings.length).toBeGreaterThan(0);
  });

  test('every potential home/state writer is listed with AST lines, text lines, risk, and isolation', () => {
    const report = auditTestStateWrites(repo);
    const document = readFileSync(inventory, 'utf8');
    for (const finding of report.findings) {
      const tail = `| ${finding.writerTargets.map((target) => `\`${target}\``).join('<br>')} | `;
      const rest = `| ${finding.risk} | ${finding.isolation} | ${finding.staticSafety} (${finding.staticIsolationSignals.join(', ') || 'none'}) |`;
      const line = document.split('\n').find((line) => line.startsWith(`| \`${finding.file}\` |`));
      expect(line, `no inventory row for ${finding.file}`).toBeDefined();
      expect(line!).toMatch(new RegExp(
        '^\\| `' + finding.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '` \\| [^|]*'
          + tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^|]*' + rest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
      ));
    }
  });

  test('the committed inventory exactly matches the complete current scan', () => {
    expect(existsSync(inventory)).toBe(true);
    const actualInventory = readFileSync(inventory, 'utf8');
    const expectedInventory = renderAudit(auditTestStateWrites(repo));
    let staleInventoryFailure: unknown;
    try {
      expectInventoryMatches(blankLineNumberColumns(`${expectedInventory}\n`), blankLineNumberColumns(expectedInventory));
    } catch (error) {
      staleInventoryFailure = error;
    }
    expect(String(staleInventoryFailure)).toContain('bun scripts/audit-test-state-writes.ts');
    expectInventoryMatches(blankLineNumberColumns(actualInventory), blankLineNumberColumns(expectedInventory));
  });

  // ⛔⭐⭐ 무인 리뷰가 잡은 실결함의 회귀 — 텍스트 경로 렌즈의 «체계적 거짓 음성».
  //   📏 이 저장소 실측: 고치기 전 기준선 203 경로 → 고친 뒤 262 경로(**59개가 숨어 있었다**).
  test('상태 증거가 따옴표 안 경로뿐인 후보도 잡는다 — 선행 경계가 점 경로를 삼키지 않는다', () => {
    const root = createQuotedDotPathRepository();
    try {
      const found = auditTestStateWrites(root).findings.map(({ file }) => file);
      expect(found).toContain('test/quoted-dot-path.test.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('홈 접근이 process.env.HOME 뿐이어도 잡는다 — 가장 흔한 형태가 빠져 있었다', () => {
    const root = createBareHomeEnvRepository();
    try {
      expect(auditTestStateWrites(root).findings.map(({ file }) => file)).toContain('test/bare-home.test.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('쓰기 호출이 import 별칭이어도 잡고, 표에는 원래 이름을 적는다', () => {
    const root = createAliasedWriterRepository();
    try {
      const finding = auditTestStateWrites(root).findings.find(({ file }) => file === 'test/aliased-writer.test.ts');
      expect(finding).toBeDefined();
      expect(finding!.writerTargets.join(' ')).toContain('writeFileSync');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('bun:sqlite Database 생성자는 writer로 잡고 생성하지 않으면 잡지 않는다', () => {
    const writerRoot = createDatabaseConstructorRepository(true);
    const readerRoot = createDatabaseConstructorRepository(false);
    try {
      const writer = auditTestStateWrites(writerRoot).findings.find(({ file }) => file === 'test/database-constructor.test.ts');
      const reader = auditTestStateWrites(readerRoot).findings.find(({ file }) => file === 'test/database-constructor.test.ts');
      expect(writer).toBeDefined();
      expect(writer!.writerTargets).toContain('Database(path)');
      expect(reader).toBeUndefined();
    } finally {
      rmSync(writerRoot, { recursive: true, force: true });
      rmSync(readerRoot, { recursive: true, force: true });
    }
  });

  test('classifies only ELANOUS_STATE_DIR, --config-dir, and mkdtemp as static isolation signals', () => {
    expect(classifyStaticIsolation("process.env.ELANOUS_STATE_DIR; run('--config-dir', '/tmp/cfg'); mkdtempSync('/tmp/a')")).toEqual({
      signals: ['ELANOUS_STATE_DIR', '--config-dir', 'mkdtemp'],
      safety: 'isolated',
    });
    expect(classifyStaticIsolation("writeFileSync(join(homedir(), '.elanous', 'unsafe'), 'x')")).toEqual({
      signals: [],
      safety: 'manual-review',
    });
  });

  test('classifies each writer call rather than approving a HOME writer because another call uses mkdtemp', () => {
    const root = createMixedWriterIsolationRepository();
    try {
      const finding = auditTestStateWrites(root).findings.find(({ file }) => file === 'test/mixed-writers.test.ts')!;
      expect(finding.writerCalls.map(({ line, staticSafety, staticIsolationSignals }) => ({ line, staticSafety, staticIsolationSignals }))).toEqual([
        { line: 4, staticSafety: 'isolated', staticIsolationSignals: ['mkdtemp'] },
        { line: 5, staticSafety: 'isolated', staticIsolationSignals: ['mkdtemp'] },
        { line: 6, staticSafety: 'manual-review', staticIsolationSignals: [] },
      ]);
      expect(finding.staticSafety).toBe('manual-review');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('classifies only a requested candidate window and preserves unsafe writer calls within a mixed file', () => {
    const root = createMixedWriterIsolationRepository();
    try {
      const report = auditTestStateWrites(root);
      const classification = classifyCandidates(report, new Set(['test/mixed-writers.test.ts']));
      expect(classification.findings).toHaveLength(1);
      expect(classification.isolated.map(({ line }) => line)).toEqual([4, 5]);
      expect(classification.manualReview.map(({ line, pattern }) => ({ line, pattern }))).toEqual([
        { line: 6, pattern: "writeFileSync(join(process.env.HOME!, '.elanous', 'unsafe.txt'))" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses to approve a new manual-review candidate without an explicit review flag', () => {
    const root = createBareHomeEnvRepository();
    try {
      const result = updateBaseline(root);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('Refusing --update-baseline until new manual-review candidates are inspected');
      const approved = updateBaseline(root, undefined, true);
      expect(approved.status, approved.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails for every new candidate path outside the committed baseline', () => {
    expect(existsSync(baseline)).toBe(true);
    const unexpected = auditTestStateWrites(repo).findings
      .map(({ file }) => file)
      .filter((file) => !baselinePaths().has(file));
    expect(unexpected, `New home/state write candidates require review and an intentional baseline refresh:\n${unexpected.join('\n')}`).toEqual([]);
  });

  test('updates a complete baseline atomically through the CLI', () => {
    const root = createAuditRepository();
    try {
      const result = updateBaseline(root, undefined, true);
      const writtenBaseline = join(root, 'test', 'test-home-state-write-audit-baseline.txt');
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(writtenBaseline, 'utf8')).toContain('test/candidate.test.ts');
      expect(temporaryBaselineFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('preserves the existing baseline and removes its temporary file when atomic rename fails', () => {
    const root = createAuditRepository();
    const writtenBaseline = join(root, 'test', 'test-home-state-write-audit-baseline.txt');
    const original = '# existing reviewed baseline\nlegacy.test.ts\n';
    writeFileSync(writtenBaseline, original);
    try {
      const result = updateBaseline(root, renameFailurePreload, true);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('injected rename failure');
      expect(readFileSync(writtenBaseline, 'utf8')).toBe(original);
      expect(temporaryBaselineFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
