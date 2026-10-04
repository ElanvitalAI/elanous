import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import ts from 'typescript';

const repo = process.cwd();
const testRoots = ['test', 'src'];
const baselinePath = join(repo, 'test', 'test-home-state-write-audit-baseline.txt');
export const AUGUST_8_INVENTORY_COMMIT = '05b8ee5da';
export const AUGUST_8_INVENTORY_PATH = 'test/test-home-state-write-audit-baseline.txt';
export const INVENTORY_REFRESH_COMMAND = 'bun scripts/audit-test-state-writes.ts';
const testFile = /\.(test|spec)\.[cm]?[jt]sx?$/;
const writerNames = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync',
  'mkdtemp', 'mkdtempSync', 'rm', 'rmSync', 'rename', 'renameSync', 'copyFile',
  'copyFileSync', 'symlink', 'symlinkSync', 'saveTokens', 'setTestStateRoot',
  'setElanousConfigDir', 'openDatabase', 'Database',
]);
// ⛔⭐ **경계를 «두 갈래»로 가른다** — 종전엔 선행 `\b` 가 전체 교대에 걸려 있어서,
//   점으로 시작하는 경로 대안(`.elanous`·`.codex`·`.config`)이 ***실제 코드에 나타나는 형태에서
//   하나도 안 물렸다***. `\b` 는 앞 글자가 단어 문자일 것을 요구하는데 그 자리엔 따옴표나
//   슬래시가 온다. 📏 실측: `join(root, '.elanous')` · `dir + '/.codex'` · `` `${home}/.elanous/x` ``
//   전부 MISS 였고, 물린 것은 `foo.elanous` 처럼 «단어 뒤»에 오는 드문 형태뿐이었다.
//   ⇒ 텍스트 경로 렌즈에 체계적 거짓 음성이 있었다.
//   🩹 식별자 대안은 `\b` 를 유지하고, 경로 대안은 선행 `\b` 를 뗀다. 후행 `\b` 는 남겨서
//      `.configuration` 같은 더 긴 낱말이 `.config` 로 오인되지 않게 한다.
//   ⊕ ⛔⭐ **`HOME` 과 `XDG_STATE_HOME` 이 빠져 있었다**(무인 리뷰 2라운드) — 종전 목록은
//     `CODEX_HOME` 과 `XDG_(CONFIG|DATA)_HOME` 만 알아서, ***가장 흔한 홈 접근인
//     `process.env.HOME` 이 감사와 트립와이어를 «둘 다» 우회했다***(실측 MISS).
//     🩹 맨 `HOME` 을 넣는다. `CODEX_HOME` 안의 `HOME` 은 앞 글자가 `_`(단어 문자)라
//        선행 `\b` 가 안 서므로 오작동하지 않는다.
const statePattern = /(?:\b(?:homedir|HOME|ELANOUS_(?:STATE|CONFIG|NEXUS)_DIR|ELANOUS_SESSION_ROOT|CODEX_HOME|XDG_(?:CONFIG|DATA|STATE)_HOME)\b|(?:\.elanous|\.codex|\.config)\b)/;

export type StaticIsolationSignal = 'ELANOUS_STATE_DIR' | '--config-dir' | 'mkdtemp';
export type StaticSafetyClassification = 'isolated' | 'manual-review';

export type WriterCall = {
  line: number;
  pattern: string;
  staticIsolationSignals: StaticIsolationSignal[];
  staticSafety: StaticSafetyClassification;
  /** The expanded target names the real home (homedir(), $HOME, ~/) — the only writer calls that fail the audit. */
  realHomeTarget: boolean;
};

type AuditFinding = {
  file: string;
  writerCalls: WriterCall[];
  writerLines: number[];
  writerTargets: string[];
  stateLines: number[];
  risk: 'high' | 'medium';
  isolation: string;
  staticIsolationSignals: StaticIsolationSignal[];
  staticSafety: StaticSafetyClassification;
};

function formatWriterPattern(name: string, node: ts.CallExpression | ts.NewExpression, source: ts.SourceFile): string {
  const first = node.arguments?.[0];
  const target = first ? first.getText(source).replace(/\s+/g, ' ').slice(0, 100) : 'indirect store or override';
  return `${name}(${target})`;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (testFile.test(entry.name)) out.push(path);
  }
}

function calleeName(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return null;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** ⛔⭐ **import 별칭을 원래 이름으로 되돌린다**(무인 리뷰 2라운드) — 종전엔 호출 시점의 이름만
 *  비교해서 `import { writeFileSync as write } from 'node:fs'; write(…)` 를 «놓쳤다».
 *  ⇒ 「새 후보를 막는다」는 트립와이어의 계약이 별칭 한 줄로 우회됐다.
 *  ⚠️ 이름 기반 해석이라 «지역 재바인딩»(`const write = writeFileSync`)까지는 못 잡는다 —
 *     그건 심볼 해석이 필요하고 이 감사의 층이 아니다. 여기서는 import 절만 편다. */
function importAliases(source: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.propertyName) aliases.set(element.name.text, element.propertyName.text);
    }
  }
  return aliases;
}

function isolationFor(text: string): string {
  const methods: string[] = [];
  if (/\bmkdtemp(?:Sync)?\b|\btmpdir\(\)/.test(text)) methods.push('temporary directory');
  // ⛔⭐ 이 목록은 `statePattern` 의 환경 변수 목록과 «같이» 움직여야 한다 — 한쪽에만 넣으면
  //   그 변수로 «격리한» 파일이 후보로는 잡히고 격리 증거는 못 받아 `high` 로 오분류된다
  //   (무인 리뷰 3라운드 should-fix · `XDG_STATE_HOME` 을 넣으면서 실제로 그 비대칭이 났다).
  if (/\bHOME\b|ELANOUS_(?:STATE|CONFIG|NEXUS)_DIR|ELANOUS_SESSION_ROOT|CODEX_HOME|XDG_(?:CONFIG|DATA|STATE)_HOME/.test(text)) methods.push('environment redirect');
  if (/setTestStateRoot|setElanousConfigDir/.test(text)) methods.push('test state override');
  if (/afterEach|finally\s*\{/.test(text) && /\brm(?:Sync)?\b/.test(text)) methods.push('cleanup');
  return methods.length ? methods.join(' + ') : 'no local isolation evidence';
}

/** Static triage deliberately recognizes only the three approval-safe signals named by the audit contract. */
export function classifyStaticIsolation(text: string): { signals: StaticIsolationSignal[]; safety: StaticSafetyClassification } {
  const signals: StaticIsolationSignal[] = [];
  if (/\bELANOUS_STATE_DIR\b/.test(text)) signals.push('ELANOUS_STATE_DIR');
  if (/--config-dir\b/.test(text)) signals.push('--config-dir');
  if (/\bmkdtemp(?:Sync)?\b/.test(text)) signals.push('mkdtemp');
  return { signals, safety: signals.length ? 'isolated' : 'manual-review' };
}

const REAL_HOME_TARGET = /\bhomedir\s*\(|process\.env\.HOME\b|process\.env\[\s*['"]HOME['"]\s*\]|['"`]~\//;

function writerIsolation(source: ts.SourceFile, writer: ts.CallExpression | ts.NewExpression, name: string): { signals: StaticIsolationSignal[]; safety: StaticSafetyClassification; realHomeTarget: boolean } {
  if (name === 'mkdtemp' || name === 'mkdtempSync') return { signals: ['mkdtemp'], safety: 'isolated', realHomeTarget: false };
  const variables = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) variables.set(node.name.text, node.initializer.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  const seen = new Set<string>();
  const expand = (text: string): string => text.replace(/\b[A-Za-z_$][\w$]*\b/g, (name) => {
    if (seen.has(name) || !variables.has(name)) return name;
    seen.add(name);
    return `(${expand(variables.get(name)!)})`;
  });
  const argumentsText = writer.arguments?.map((argument) => argument.getText(source)).join(' ') ?? '';
  return { ...classifyStaticIsolation(expand(argumentsText)), realHomeTarget: realHomeTarget(source, writer) };
}

/** Lexically nearest declaration of `name` visible before `at` (same file-wide name reused across tests must not leak). */
function scopedInitializer(source: ts.SourceFile, at: ts.Node, name: string): ts.Expression | undefined {
  for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isModuleBlock(scope)) continue;
    let found: ts.Expression | undefined;
    for (const statement of scope.statements) {
      if (statement.pos >= at.pos) break;
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) found = declaration.initializer;
      }
    }
    if (found) return found;
  }
  return undefined;
}

/** Only the target path (first argument) counts — written content may mention homedir() as fixture text. */
function realHomeTarget(source: ts.SourceFile, writer: ts.CallExpression | ts.NewExpression): boolean {
  const target = writer.arguments?.[0];
  if (!target) return false;
  const seen = new Set<string>();
  const expand = (node: ts.Node, text: string): string => text.replace(/\b[A-Za-z_$][\w$]*\b/g, (name) => {
    if (seen.has(name)) return name;
    const initializer = scopedInitializer(source, node, name);
    if (!initializer) return name;
    seen.add(name);
    return `(${expand(initializer, initializer.getText(source))})`;
  });
  const expanded = expand(target, target.getText(source));
  return REAL_HOME_TARGET.test(expanded) && classifyStaticIsolation(expanded).safety !== 'isolated';
}

export type CandidateClassification = {
  findings: AuditFinding[];
  isolated: Array<WriterCall & { file: string }>;
  manualReview: Array<WriterCall & { file: string }>;
};

/** Classifies only the supplied candidate paths, preserving writer-call evidence instead of file-wide signals. */
export function classifyCandidates(report: ReturnType<typeof auditTestStateWrites>, candidates: ReadonlySet<string>): CandidateClassification {
  const findings = report.findings.filter(({ file }) => candidates.has(file));
  const calls = findings.flatMap(({ file, writerCalls }) => writerCalls.map((writer) => ({ file, ...writer })));
  return { findings, isolated: calls.filter(({ staticSafety }) => staticSafety === 'isolated'), manualReview: calls.filter(({ staticSafety }) => staticSafety === 'manual-review') };
}

export function addedCandidates(report: ReturnType<typeof auditTestStateWrites>, previousInventory: ReadonlySet<string>): Set<string> {
  return new Set(report.findings.map(({ file }) => file).filter((file) => !previousInventory.has(file)));
}

/**
 * Fails only writer calls whose target reaches the real home without isolation evidence. A static scan cannot
 * follow a temp directory through function returns or parameters, so "no evidence" alone stays visible as
 * manual review in the rendered inventory instead of failing hundreds of mkdtemp-backed writes.
 */
export function unclassifiedCandidates(report: ReturnType<typeof auditTestStateWrites>, previousInventory: ReadonlySet<string>): string[] {
  const { isolated, manualReview } = classifyCandidates(report, addedCandidates(report, previousInventory));
  // The file-wide isolation label can be borrowed from a same-named temp variable in another test, so the
  // scoped real-HOME judgement decides on every call, including ones labelled isolated.
  return [...isolated, ...manualReview].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    .filter(({ realHomeTarget }) => realHomeTarget)
    .map(({ file, line, pattern }) => `${file}:${line} ${pattern} — writes a real HOME path without isolation evidence`);
}

function classificationSummary(classification: CandidateClassification): string {
  const { findings, isolated, manualReview } = classification;
  const manualReviewFiles = findings.filter(({ staticSafety }) => staticSafety === 'manual-review');
  return [
    `- August 8 candidate window: **${findings.length} files** (current inventory minus the preserved August 8 inventory).`,
    `- Candidate classification (files): **${findings.length - manualReviewFiles.length} ㉠ isolated** / **${manualReviewFiles.length} ㉡ manual review**.`,
    `- Writer-call evidence in the August 8 window: **${isolated.length} isolated** / **${manualReview.length} manual review**; a file is ㉡ whenever any writer call lacks a direct approved signal.`,
    `- ㉡ writer calls: ${manualReview.length ? manualReview.map(({ file, line, pattern }) => `\`${file}:${line} ${pattern}\``).join(', ') : '0건'}.`,
    `- Manual review required: **${manualReviewFiles.length}** candidate files. This static audit does not establish whether an unclassified write targets a real HOME/state path.`,
    ...manualReviewFiles.map(({ file }) => `- Manual review pending — \`${file}\`: isolation is unverified.`),
  ].join('\n');
}

export function august8Inventory(root = repo): Set<string> {
  const content = execFileSync('git', ['show', `${AUGUST_8_INVENTORY_COMMIT}:${AUGUST_8_INVENTORY_PATH}`], { cwd: root, encoding: 'utf8' });
  return new Set(content.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
}

export function auditTestStateWrites(root = repo): { total: number; findings: AuditFinding[] } {
  const files: string[] = [];
  for (const dir of testRoots) walk(join(root, dir), files);
  const findings: AuditFinding[] = [];
  for (const file of files.sort()) {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const writerNodes: Array<{ name: string; node: ts.CallExpression | ts.NewExpression }> = [];
    const aliases = importAliases(source);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const called = calleeName(node.expression);
        const name = called ? aliases.get(called) ?? called : null;
        if (name && writerNames.has(name)) writerNodes.push({ name, node });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    const writerCalls = writerNodes.map(({ name, node }) => {
      const classification = writerIsolation(source, node, name);
      return { line: lineOf(source, node), pattern: formatWriterPattern(name, node, source), staticIsolationSignals: classification.signals, staticSafety: classification.safety, realHomeTarget: classification.realHomeTarget };
    });
    const stateLines = text.split('\n').flatMap((line, index) => statePattern.test(line) ? [index + 1] : []);
    if (writerCalls.length && stateLines.length) {
      const isolation = isolationFor(text);
      const staticIsolationSignals = [...new Set(writerCalls.flatMap(({ staticIsolationSignals: signals }) => signals))];
      const staticSafety: StaticSafetyClassification = writerCalls.every(({ staticSafety }) => staticSafety === 'isolated') ? 'isolated' : 'manual-review';
      findings.push({
        file: relative(root, file),
        writerCalls,
        writerLines: [...new Set(writerCalls.map(({ line }) => line))].sort((a, b) => a - b),
        writerTargets: [...new Set(writerCalls.map(({ pattern }) => pattern))],
        stateLines,
        risk: isolation === 'no local isolation evidence' ? 'high' : 'medium',
        isolation,
        staticIsolationSignals,
        staticSafety,
      });
    }
  }
  return { total: files.length, findings };
}

export function renderAudit(report: ReturnType<typeof auditTestStateWrites>, previous = august8Inventory(repo), reviewed = new Set(readFileSync(baselinePath, 'utf8').split('\n').filter((line) => line && !line.startsWith('#')))): string {
  const candidateWindow = classifyCandidates(report, addedCandidates(report, previous));
  const automatic = classifyCandidates(report, addedCandidates(report, reviewed));
  const rows = report.findings.map((finding) =>
    `| \`${finding.file}\` | ${finding.writerLines.join(', ')} | ${finding.writerTargets.map((target) => `\`${target}\``).join('<br>')} | ${finding.stateLines.join(', ')} | ${finding.risk} | ${finding.isolation} | ${finding.staticSafety} (${finding.staticIsolationSignals.join(', ') || 'none'}) |`,
  );
  return [
    '# Test Home and State Write Audit',
    '',
    'This inventory is generated by `scripts/audit-test-state-writes.ts` using TypeScript AST call detection for filesystem/state writer calls and text detection for home/state-root evidence. It covers every `*.test.*` and `*.spec.*` file under `test/` and `src/`.',
    `Rows for files outside the reviewed baseline are a snapshot from generation time; refresh with \`${INVENTORY_REFRESH_COMMAND}\`.`,
    '',
    `- Scanned test files: **${report.total}**`,
    `- Potential home/state writers: **${report.findings.length}**`,
    '- Risk: **high** means the file has a writer and home/state-root evidence but no local temporary-root, redirect, override, or cleanup evidence; **medium** means it has at least one such isolation signal and still requires context review.',
    '- Writer lines are AST-derived call expressions; state lines are text-derived path/environment evidence. The two lenses intentionally intersect to reduce false positives while retaining indirect store writers.',
    '- Static safety classification is approval-gating: only `ELANOUS_STATE_DIR`, `--config-dir`, or `mkdtemp` counts as isolated; all other candidates require manual inspection.',
    classificationSummary(candidateWindow),
    '',
    '## 분류기 통과(자동) — 사람 검토 기준선 밖',
    '',
    `Reviewed baseline: \`test/test-home-state-write-audit-baseline.txt\`. Regenerate with \`${INVENTORY_REFRESH_COMMAND}\`. Only candidates with every writer call statically isolated appear below; manual-review calls fail the audits rather than expanding the baseline.`,
    '',
    '| File | Writer lines | Approved isolation signals |',
    '| --- | --- | --- |',
    ...automatic.findings.filter(({ staticSafety }) => staticSafety === 'isolated').map(({ file, writerLines, staticIsolationSignals }) =>
      `| \`${file}\` | ${writerLines.join(', ')} | ${staticIsolationSignals.join(', ')} |`),
    '',
    '## 전체 스캔 (사람 검토 + 자동 분류)',
    '',
    '| File | Writer call lines (AST) | Write target or store argument | Home/state evidence lines (text) | Risk | Current isolation evidence | Static safety |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function writeBaseline(report: ReturnType<typeof auditTestStateWrites>, root = repo, approveManualReview = false): void {
  const existingBaseline = existsSync(join(root, 'test', 'test-home-state-write-audit-baseline.txt'))
    ? new Set(readFileSync(join(root, 'test', 'test-home-state-write-audit-baseline.txt'), 'utf8').split('\n').filter((line) => line && !line.startsWith('#')))
    : new Set<string>();
  const manualReview = report.findings.filter(({ file, staticSafety }) => staticSafety === 'manual-review' && !existingBaseline.has(file));
  if (manualReview.length && !approveManualReview) {
    throw new Error(`Refusing --update-baseline until new manual-review candidates are inspected; rerun only after inspection with --approve-manual-review: ${manualReview.map(({ file }) => file).join(', ')}`);
  }
  const content = [
    '# Committed baseline for test home/state write audit candidates.',
    '# New scanned paths fail test/test-home-state-write-audit.test.ts; disappeared paths are allowed.',
    '# Refresh intentionally after reviewing new candidates:',
    '# bun scripts/audit-test-state-writes.ts --update-baseline --approve-manual-review',
    '',
    ...report.findings.map(({ file }) => file),
    '',
  ].join('\n');
  const targetBaselinePath = join(root, 'test', 'test-home-state-write-audit-baseline.txt');
  const temporaryBaselinePath = join(dirname(targetBaselinePath), `.${basename(targetBaselinePath)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporaryBaselinePath, content);
    renameSync(temporaryBaselinePath, join(root, 'test', 'test-home-state-write-audit-baseline.txt'));
  } catch (error) {
    if (existsSync(temporaryBaselinePath)) unlinkSync(temporaryBaselinePath);
    throw error;
  }
}

export function main(args = process.argv.slice(2)): void {
  const report = auditTestStateWrites();
  if (args.includes('--update-baseline')) {
    writeBaseline(report, repo, args.includes('--approve-manual-review'));
    console.log(`[test-home-state-write-audit] wrote ${report.findings.length} baseline paths to ${baselinePath}.`);
  } else {
    writeFileSync(join(repo, 'docs', 'TEST-home-state-write-audit.md'), renderAudit(report));
  }
}

if (import.meta.main) main();
