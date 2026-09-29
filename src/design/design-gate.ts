// 프로젝트 단위 디자인 관문 — 고른 방향의 토큰 대비 HTML 준수를 한 판정으로 낸다.
// 그래프 노드는 인자 없는 한 줄을 부르므로, 이 모듈은 LLM·네트워크를 부르지 않고
// 대상 프로젝트의 파일도 쓰지 않는다.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { debug } from '../debug/log.js';
import { listAllDesignDirections, parseDeclaredDirection } from './design-directions.js';
import { runLintDesign, type TokensSource } from './lint-artifact-run.js';

export type DesignGateVerdict = 'pass' | 'fail' | 'not-applicable';

export type DesignGateReason = 'no-design-document' | 'no-direction' | 'no-html';

export interface DesignGateFinding {
  readonly rule: string;
  readonly severity: 'p0' | 'advisory';
  readonly line: number | null;
}

export interface DesignGateFile {
  readonly path: string;
  readonly p0: number;
  readonly advisory: number;
  readonly skipped: readonly string[];
  readonly findings: readonly DesignGateFinding[];
}

export interface DesignGateResult {
  readonly verdict: DesignGateVerdict;
  readonly reason?: DesignGateReason;
  readonly direction: string | null;
  readonly tokensSource: TokensSource | null;
  readonly p0Total: number;
  readonly advisoryTotal: number;
  readonly files: readonly DesignGateFile[];
  readonly truncated: boolean;
  readonly omitted: number;
  readonly checkedAt: string;
}

export interface DesignGateInput {
  readonly projectDir: string;
  readonly base?: string;
  readonly maxFiles?: number;
}

export interface DesignGateDeps {
  readonly readFile?: (path: string) => string;
  readonly exists?: (path: string) => boolean;
  readonly listHtml?: (projectDir: string) => readonly string[];
  readonly gitDiffNames?: (projectDir: string, base: string) => readonly string[];
  readonly gitUntracked?: (projectDir: string) => readonly string[];
  readonly now?: () => string;
  readonly lint?: typeof runLintDesign;
  readonly directions?: () => ReturnType<typeof listAllDesignDirections>;
}

const DEFAULT_MAX_FILES = 50;
const EXCLUDED_PREFIXES = ['node_modules/', '.git/', 'design/previews/', 'design/system/'];

function posixRelative(projectDir: string, filePath: string): string {
  return relative(projectDir, filePath).split(sep).join('/');
}

function isExcludedHtml(rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.endsWith('.html')) return true;
  return EXCLUDED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function walkHtml(projectDir: string, dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    const rel = posixRelative(projectDir, full);
    let isDirectory = false;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) {
      if (EXCLUDED_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix))) continue;
      if (name === 'node_modules' || name === '.git') continue;
      walkHtml(projectDir, full, out);
      continue;
    }
    if (!isExcludedHtml(rel)) out.push(full);
  }
}

function defaultListHtml(projectDir: string): string[] {
  const out: string[] = [];
  walkHtml(projectDir, projectDir, out);
  return out.sort();
}

function gitLines(projectDir: string, args: readonly string[]): string[] {
  const text = execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8' });
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

function resolveChangedHtml(
  projectDir: string,
  base: string,
  deps: Required<Pick<DesignGateDeps, 'gitDiffNames' | 'gitUntracked' | 'exists'>>,
): string[] {
  const names = [...deps.gitDiffNames(projectDir, base), ...deps.gitUntracked(projectDir)];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const name of names) {
    const rel = name.replace(/\\/g, '/').replace(/^\.\//, '');
    if (isExcludedHtml(rel) || seen.has(rel)) continue;
    const full = join(projectDir, rel);
    if (!deps.exists(full)) continue;
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    seen.add(rel);
    files.push(full);
  }
  return files.sort();
}

function emptyResult(
  verdict: DesignGateVerdict,
  reason: DesignGateReason | undefined,
  direction: string | null,
  checkedAt: string,
): DesignGateResult {
  return {
    verdict,
    ...(reason ? { reason } : {}),
    direction,
    tokensSource: null,
    p0Total: 0,
    advisoryTotal: 0,
    files: [],
    truncated: false,
    omitted: 0,
    checkedAt,
  };
}

export function runDesignGate(input: DesignGateInput, deps: DesignGateDeps = {}): DesignGateResult {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const exists = deps.exists ?? existsSync;
  const listHtml = deps.listHtml ?? defaultListHtml;
  const gitDiffNames = deps.gitDiffNames ?? ((projectDir: string, base: string) => gitLines(projectDir, ['diff', '--name-only', `${base}...HEAD`]));
  const gitUntracked = deps.gitUntracked ?? ((projectDir: string) => gitLines(projectDir, ['ls-files', '--others', '--exclude-standard']));
  const now = deps.now ?? (() => new Date().toISOString());
  const lint = deps.lint ?? runLintDesign;
  const directions = deps.directions ?? (() => listAllDesignDirections());
  const checkedAt = now();
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const designPath = join(input.projectDir, 'DESIGN.md');

  let result: DesignGateResult;
  if (!exists(designPath)) {
    result = emptyResult('not-applicable', 'no-design-document', null, checkedAt);
  } else {
    const document = readFile(designPath);
    const parsed = parseDeclaredDirection(document, directions());
    if (parsed.declared === null) {
      result = emptyResult('not-applicable', 'no-direction', null, checkedAt);
    } else {
      const htmlFiles = input.base
        ? resolveChangedHtml(input.projectDir, input.base, { gitDiffNames, gitUntracked, exists })
        : [...listHtml(input.projectDir)].filter((file) => !isExcludedHtml(posixRelative(input.projectDir, file))).sort();
      if (htmlFiles.length === 0) {
        result = emptyResult('not-applicable', 'no-html', parsed.declared, checkedAt);
      } else {
        const limited = htmlFiles.slice(0, Math.max(0, maxFiles));
        const omitted = htmlFiles.length - limited.length;
        let tokensSource: TokensSource | null = null;
        const files: DesignGateFile[] = limited.map((htmlPath, index) => {
          const run = lint({ htmlPath, designPath });
          if (index === 0) tokensSource = run.tokensSource;
          return {
            path: posixRelative(input.projectDir, htmlPath) || htmlPath,
            p0: run.p0Count,
            advisory: run.advisoryCount,
            skipped: [...run.skipped],
            findings: run.findings.map((finding) => ({
              rule: finding.rule,
              severity: finding.severity,
              line: finding.line,
            })),
          };
        });
        const p0Total = files.reduce((sum, file) => sum + file.p0, 0);
        const advisoryTotal = files.reduce((sum, file) => sum + file.advisory, 0);
        result = {
          verdict: p0Total >= 1 ? 'fail' : 'pass',
          direction: parsed.declared,
          tokensSource,
          p0Total,
          advisoryTotal,
          files,
          truncated: omitted > 0,
          omitted,
          checkedAt,
        };
      }
    }
  }

  debug.log('design.gate', 'verdict', {
    projectDir: input.projectDir,
    direction: result.direction,
    verdict: result.verdict,
    p0Total: result.p0Total,
    fileCount: result.files.length,
  });
  return result;
}

export function formatDesignGate(result: DesignGateResult): string[] {
  const headline = result.verdict === 'not-applicable'
    ? `design-gate ${result.verdict} (${result.reason ?? 'unknown'})`
    : `design-gate ${result.verdict} direction=${result.direction ?? '(none)'} p0=${result.p0Total} advisory=${result.advisoryTotal}`;
  const lines = [headline];
  for (const file of result.files) {
    const firstP0 = file.findings.find((finding) => finding.severity === 'p0');
    lines.push(`${file.path} p0=${file.p0}${firstP0 ? ` ${firstP0.rule}` : ''}`);
  }
  const unchecked = result.files.reduce((sum, file) => sum + file.skipped.length, 0);
  lines.push(`unchecked ${unchecked}`);
  if (result.truncated) lines.push(`truncated omitted=${result.omitted}`);
  return lines;
}
