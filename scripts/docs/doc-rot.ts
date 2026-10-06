#!/usr/bin/env bun
// DOC-ROT① — 내부 매뉴얼(내부 문서 `*`)의 명령·저장소 경로를 실제와 대조한다.
//   bun scripts/docs/doc-rot.ts [--json] [files…]      (기본 = 내부 문서 `*`)
// 명령 판정은 scripts/docs-cli-check.ts 의 checkCommands 만 쓴다(같은 판정을 다시 짜지 않는다).
// 경로 판정은 인라인 코드 안의 src/ · scripts/ · docs/ · graphs/ · test/ 가 repoRoot 에 있는지다.
// ⛔ --help 를 못 잰 명령은 unmeasured 로 따로 센다 — «없다»로 세지 않는다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import {
  checkCommands,
  extractElanousCommands,
  type Finding,
  type HelpRunner,
} from '../docs-cli-check.js';

const REPO = resolve(import.meta.dir, '../..');
const PATH_ROOTS = ['src/', 'scripts/', 'docs/', 'graphs/', 'test/'] as const;
const PASSTHROUGH_COMMANDS = new Set(['gh', 'git']);

export interface MissingPath { line: number; path: string }
export interface DocRotFinding extends Omit<Finding, 'kind'> {
  kind: Finding['kind'] | 'passthrough' | 'globalFlag' | 'intentional';
}
export interface DocRotFile {
  file: string;
  commands: DocRotFinding[];
  missingPaths: MissingPath[];
}
export interface DocRotTotals {
  files: number;
  staleFiles: number;
  missingPaths: number;
  badCommands: number;
  unmeasured: number;
  passthrough: number;
  globalFlag: number;
  intentional: number;
}
export interface DocRotReport {
  files: DocRotFile[];
  totals: DocRotTotals;
}

export interface ScanDocRotInput {
  files: readonly string[];
  repoRoot: string;
  help?: HelpRunner;
  read?: (file: string) => string;
}

/** 인라인 코드에서 저장소 경로를 뽑는다. 줄번호 꼬리(`:12`)는 떼고, glob(`*`)은 건너뛴다. */
export function extractRepoPaths(text: string): MissingPath[] {
  const out: MissingPath[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1]!;
    if (raw.includes('*')) continue;
    if (!PATH_ROOTS.some((root) => raw.startsWith(root))) continue;
    const path = raw.replace(/:\d+$/, '');
    if (!PATH_ROOTS.some((root) => path.startsWith(root)) || path.endsWith('/')) continue;
    const line = text.slice(0, m.index ?? 0).split('\n').length;
    const key = `${line}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ line, path });
  }
  return out;
}

/** 파일마다 명령 findings(checkCommands 재사용)와 없는 경로를 센다. */
export function scanDocRot(input: ScanDocRotInput): DocRotReport {
  const read = input.read ?? ((file: string) => readFileSync(file, 'utf8'));
  const texts = input.files.map((file) => ({ file, text: read(file) }));
  const help: HelpRunner = input.help ?? ((args) => {
    const result = spawnSync('bun', ['bin/elanous.mjs', '--test', ...args, '--help'], {
      cwd: input.repoRoot, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' },
    });
    return { ok: result.status === 0, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
  });
  let commandRoot: ReturnType<HelpRunner> | undefined;
  const cachedHelp: HelpRunner = (args) => {
    if (args.length === 0) return commandRoot ??= help(args);
    return help(args);
  };
  const checked = texts.map(({ file, text }) => {
    const label = relative(input.repoRoot, file) || file;
    return { file: label, text, commands: checkCommands(extractElanousCommands(label, text), cachedHelp) };
  });
  const hasUnknownFlag = checked.some(({ commands }) => commands.some((finding) => finding.kind === 'unknown-flag'));
  // A separate lookup measures root Options; a failure must not mean "no global flags".
  const rootOptionsHelp = hasUnknownFlag ? help([]) : commandRoot;
  const rootOptions = rootOptionsHelp?.ok ? (rootOptionsHelp.out.split(/\nOptions:\s*\n/)[1] ?? '').split(/\n\S[^\n]*:\s*\n/)[0]! : '';
  const globalFlags = new Set([...rootOptions.matchAll(/^\s+(?:-\w,\s*)?(--[a-z][a-z0-9-]*)\b/gm)].map((match) => match[1]!));
  const files: DocRotFile[] = checked.map(({ file, text, commands }) => {
    const lines = text.split('\n');
    const classified: DocRotFinding[] = commands.map((finding) => {
      if (finding.kind !== 'unmeasured' && (lines[finding.ref.line - 1] ?? '').includes('⛔')) return { ...finding, kind: 'intentional' };
      if (finding.kind !== 'unknown-flag') return finding;
      if (PASSTHROUGH_COMMANDS.has(finding.ref.cmd)) return { ...finding, kind: 'passthrough' };
      if (!rootOptionsHelp?.ok) return { ...finding, kind: 'unmeasured' };
      const flag = /^--[a-z][a-z0-9-]*/.exec(finding.detail)?.[0];
      if (flag && globalFlags.has(flag)) return { ...finding, kind: 'globalFlag' };
      return finding;
    });
    const missingPaths = extractRepoPaths(text).filter((entry) => !existsSync(join(input.repoRoot, entry.path)));
    return { file, commands: classified, missingPaths };
  });
  const isBad = (finding: DocRotFinding) => finding.kind === 'unknown-command' || finding.kind === 'unknown-subcommand' || finding.kind === 'unknown-flag';
  const count = (kind: DocRotFinding['kind']) => files.reduce((sum, file) => sum + file.commands.filter((finding) => finding.kind === kind).length, 0);
  const totals: DocRotTotals = {
    files: files.length,
    staleFiles: files.filter((file) => file.missingPaths.length > 0 || file.commands.some(isBad)).length,
    missingPaths: files.reduce((sum, file) => sum + file.missingPaths.length, 0),
    badCommands: files.reduce((sum, file) => sum + file.commands.filter(isBad).length, 0),
    unmeasured: count('unmeasured'),
    passthrough: count('passthrough'),
    globalFlag: count('globalFlag'),
    intentional: count('intentional'),
  };
  return { files, totals };
}

export function defaultManualFiles(repoRoot: string = REPO): string[] {
  return readdirSync(join(repoRoot, 'docs', 'manual'))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => join(repoRoot, 'docs', 'manual', name));
}

function renderTable(report: DocRotReport): string {
  const lines = [
    `doc-rot — 매뉴얼 ${report.totals.files} · 낡은 파일 ${report.totals.staleFiles} · 없는 경로 ${report.totals.missingPaths} · 깨진 명령 ${report.totals.badCommands} · 못 잰 명령 ${report.totals.unmeasured} · 통과 래퍼 ${report.totals.passthrough} · 전역 옵션 ${report.totals.globalFlag} · 의도적 예시 ${report.totals.intentional}`,
  ];
  for (const file of report.files) {
    for (const finding of file.commands) lines.push(`  ${finding.kind}  ${file.file}:${finding.ref.line}  ${finding.detail}`);
    for (const missing of file.missingPaths) lines.push(`  missing-path  ${file.file}:${missing.line}  ${missing.path}`);
  }
  return lines.join('\n');
}

if (import.meta.main) {
  try {
    const { registerStandaloneLogSink } = await import('../../src/domains/standalone-log-sink.js');
    await registerStandaloneLogSink('doc-rot');
  } catch { /* fail-open — 관측 배선 실패가 측정을 막지 않는다 */ }
  const { debug } = await import('../../src/debug/log.js');
  const json = process.argv.includes('--json');
  const args = process.argv.slice(2).filter((arg) => arg !== '--json');
  const files = args.length ? args.map((arg) => resolve(arg)) : defaultManualFiles();
  const report = scanDocRot({ files, repoRoot: REPO });
  debug.log('docs.rot', 'scanned', {
    files: report.totals.files,
    staleFiles: report.totals.staleFiles,
    missingPaths: report.totals.missingPaths,
    badCommands: report.totals.badCommands,
    unmeasured: report.totals.unmeasured,
    passthrough: report.totals.passthrough,
    globalFlag: report.totals.globalFlag,
    intentional: report.totals.intentional,
  });
  console.log(json ? JSON.stringify(report) : renderTable(report));
  process.exit(report.totals.badCommands + report.totals.missingPaths > 0 ? 1 : 0);
}
