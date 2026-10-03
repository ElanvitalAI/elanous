#!/usr/bin/env bun
// PWA build gate (GATE-PWA · 10-02 MAT1b near-miss: a PWA-bundled src module gained a TUI import and every gate passed).
// The PWA is a static export outside `bun test`/tsc, so a change that reaches its bundle graph is built here.
// Reach is decided by the TypeScript program of apps/pwa/tsconfig.json (aliases, extends, type imports included);
// anything the program cannot decide is treated as reaching the PWA — «unsure» builds, it never skips.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { debug } from '../src/debug/log.js';
import { checkPwaBuildDeps } from '../src/cli/pwa-build.js';
import { prepareDeterministicChildEnvironment } from './lib/deterministic-env.js';
import { parseChangedFiles } from './ci-ios-unit-tests.js';

const ROOT = join(import.meta.dir, '..');
const PWA_PREFIX = 'apps/pwa/';
const PWA_IGNORED = /^apps\/pwa\/(?:node_modules|\.next|out)\//;
const TS_SOURCE = /\.(?:tsx?|mts|cts)$/;
const CODE_OR_ASSET = /\.(?:[cm]?[jt]sx?|json|css|scss|svg|png|jpe?g|webp|woff2?)$/;

export type BuildResult = { status: number | null; output: string; error?: Error };
export type PwaGraph = { files: Set<string>; uncertain: string | null };
export type PwaGateIo = {
  args?: readonly string[];
  cwd?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Repo-relative changed files when `--changed-files` is absent (test seam · default git diff vs origin/main). */
  changedFiles?: (root: string) => string[] | null;
  graph?: (root: string) => PwaGraph;
  runBuild?: (root: string) => BuildResult;
};

function defaultBuild(root: string): BuildResult {
  const pwa = join(root, 'apps/pwa');
  let deps = checkPwaBuildDeps(pwa);
  if (!deps.ok) {
    // Pod worktrees and fresh harvest trees often have no apps/pwa/node_modules — install once from the lockfile, then re-check.
    const install = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: pwa, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    try { debug.log('gate.pwa', 'deps-install', { status: install.status }); } catch { /* fail-soft */ }
    deps = checkPwaBuildDeps(pwa);
    if (!deps.ok) return { status: null, output: `apps/pwa/node_modules incomplete after install (rc=${install.status}): ${deps.missing.slice(0, 3).join(', ')}` };
  }
  const isolated = prepareDeterministicChildEnvironment('elanous-pwa-build-gate-');
  try {
    // Same build `nexus build` runs (runPwaBuild → bun run build), with HOME/state/config confined to a temp child env.
    const result = spawnSync('bun', ['run', 'build'], { cwd: pwa, env: isolated.env, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
    return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`, error: result.error };
  } finally {
    isolated.cleanup();
  }
}

function defaultChangedFiles(root: string): string[] | null {
  const r = spawnSync('git', ['diff', '--name-only', 'origin/main...HEAD'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Dynamic import()/require() whose argument is not a string literal — the program cannot follow it. */
function opaqueLoad(sf: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0];
      if (!arg || !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) { found = true; return; }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Every repo file the PWA program loads, plus same-stem siblings (a `.d.ts` may stand in for the `.js` the bundler reads). */
export function pwaGraph(root: string): PwaGraph {
  const configPath = join(root, 'apps/pwa/tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) return { files: new Set(), uncertain: `tsconfig unreadable: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}` };
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  if (parsed.errors.some((d) => d.category === ts.DiagnosticCategory.Error)) {
    return { files: new Set(), uncertain: `tsconfig invalid: ${ts.flattenDiagnosticMessageText(parsed.errors[0]!.messageText, ' ')}` };
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
  const files = new Set<string>();
  const absRoot = resolve(root) + sep;
  for (const sf of program.getSourceFiles()) {
    const abs = resolve(sf.fileName);
    if (!abs.startsWith(absRoot) || abs.includes(`${sep}node_modules${sep}`)) continue;
    const rel = relative(root, abs).split(sep).join('/');
    files.add(rel);
    // A non-literal import()/require() is a bundler «context»: anything beside it may be loaded — take the whole directory.
    if (opaqueLoad(sf)) {
      const dir = dirname(abs);
      try {
        for (const name of readdirSync(dir)) if (/\.(?:[cm]?[jt]sx?|json)$/.test(name)) files.add(relative(root, join(dir, name)).split(sep).join('/'));
      } catch { return { files, uncertain: `cannot list ${relative(root, dir)} beside a non-literal import` }; }
    }
    const stem = basename(rel).replace(/\.d\.ts$|\.[^.]+$/, '');
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.json', '.css']) {
      const sibling = join(dirname(rel), stem + ext).split(sep).join('/');
      if (existsSync(join(root, sibling))) files.add(sibling);
    }
  }
  return { files, uncertain: null };
}

export type PwaReach = { reaches: boolean; reason: string; hits: string[] };

/** Decide whether a change set reaches the PWA build. Unknowns reach. */
export function pwaReach(changed: readonly string[], graph: () => PwaGraph): PwaReach {
  const pwaHits = changed.filter((f) => f.startsWith(PWA_PREFIX) && !PWA_IGNORED.test(f));
  if (pwaHits.length) return { reaches: true, reason: `apps/pwa 변경 ${pwaHits.length}개`, hits: pwaHits };
  // Any repo file the PWA program loads counts (src/, scripts/, shared roots); non-code files under src/ build conservatively.
  const candidates = changed.filter((f) => CODE_OR_ASSET.test(f));
  if (!candidates.length) return { reaches: false, reason: `변경 ${changed.length}개 중 코드·자산 파일 0개`, hits: [] };
  let g: PwaGraph;
  try { g = graph(); } catch (err) { return { reaches: true, reason: `PWA 그래프를 못 읽었다(${err instanceof Error ? err.message : String(err)}) — 닿는 것으로 본다`, hits: candidates }; }
  if (g.uncertain) return { reaches: true, reason: `PWA 그래프 판정 불가(${g.uncertain}) — 닿는 것으로 본다`, hits: candidates };
  const hits = candidates.filter((f) => g.files.has(f) || (f.startsWith('src/') && !TS_SOURCE.test(f)));
  if (hits.length) return { reaches: true, reason: `PWA 가 닿는 파일 ${hits.length}개`, hits };
  return { reaches: false, reason: `코드 변경 ${candidates.length}개 — PWA 그래프(${g.files.size}개) 밖`, hits: [] };
}

export function runPwaBuildGate(io: PwaGateIo = {}): number {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const root = io.cwd ?? ROOT;
  if (!io.graph && !existsSync(join(root, 'apps/pwa/package.json'))) {
    log('[pwa-gate] 해당 없음 — 이 트리에 apps/pwa 가 없다.');
    return 0;
  }
  const changed = parseChangedFiles(io.args ?? process.argv.slice(2)) ?? (io.changedFiles ?? defaultChangedFiles)(root);
  if (changed === null) {
    error('[pwa-gate] 측정 불가 — 변경 파일 목록을 못 얻었다(git diff 실패).');
    return 1;
  }
  const reach = pwaReach(changed, () => (io.graph ?? pwaGraph)(root));
  try { debug.log('gate.pwa', reach.reaches ? 'reach' : 'skip', { changed: changed.length, hits: reach.hits.slice(0, 20), reason: reach.reason }); } catch { /* fail-soft */ }
  if (!reach.reaches) {
    log(`[pwa-gate] 해당 없음 — ${reach.reason}.`);
    return 0;
  }
  log(`[pwa-gate] 대상 — ${reach.reason}${reach.hits.length ? ` (${reach.hits.slice(0, 5).join(', ')}${reach.hits.length > 5 ? ' …' : ''})` : ''} — PWA 빌드를 돌린다.`);
  const started = Date.now();
  const result = (io.runBuild ?? defaultBuild)(root);
  const seconds = Math.round((Date.now() - started) / 1000);
  try { debug.log('gate.pwa', 'build', { status: result.status, seconds }); } catch { /* fail-soft */ }
  if (result.status === 0) {
    log(`[pwa-gate] PASS — PWA 빌드 성공(${seconds}s).`);
    return 0;
  }
  const tail = result.output.trim().split('\n').slice(-15).join('\n');
  if (result.status === null) error(`[pwa-gate] 측정 불가 — 빌드를 못 돌렸다: ${result.error?.message ?? tail.split('\n').pop() ?? 'unknown'}`);
  else error(`[pwa-gate] FAIL — PWA 빌드 실패(rc=${result.status} · ${seconds}s):\n${tail}`);
  return 1;
}

if (import.meta.main) process.exit(runPwaBuildGate());
