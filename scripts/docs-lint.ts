#!/usr/bin/env bun
// ── DocOps P1 · docs 컨벤션 린터 CLI (경고만·차단 없음) ──────────────────────
//
//   bun scripts/docs-lint.ts               # 전체 docs/ 요약(규칙별 카운트 + 상위 예시)
//   bun scripts/docs-lint.ts --changed     # git 변경분(.md)만 — 커밋 전 셀프체크
//
// PLAN §3 L0. 규칙 상세 = src/autopilot/discovery/doc-lint.ts.

import {
  lintDoc, lintDocLinks, lintGitHubIssueCommentPointers, createGitHubIssueCommentFetchStatus,
  lintStaleSourceCitations,
  type LintWarning, type LinkWarning, type GitHubIssueCommentWarning, type StaleSourceCitationWarning,
} from '../src/autopilot/discovery/doc-lint.js';
import { parseIndexLinks } from '../src/autopilot/discovery/doc-inventory.js';
import { execFileSync } from 'node:child_process';
import { runGitCommand } from '../src/git-fs/runner.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { sourceIdentifierInventory, inlineCodeIdentifiers } from '../src/autopilot/discovery/source-identifiers.js';

const repoRoot = join(import.meta.dir, '..');
const docsDir = join(repoRoot, 'docs');
const changedOnly = process.argv.includes('--changed');
// ⭐ 네트워크를 쓰는 포인터 검사 스위치 — 기본 OFF(위 주석).
const checkPointers = process.argv.includes('--check-pointers');
// ⭐ 문서 코드 이름 대조도 명시 실행만 한다 — 기본 lint 호출의 비용·출력은 그대로다.
const checkCodeIdentifiers = process.argv.includes('--check-code-identifiers');
const codeIdentifierOption = process.argv.indexOf('--code-identifier');
const codeIdentifier = codeIdentifierOption === -1 ? undefined : process.argv[codeIdentifierOption + 1];
if (codeIdentifierOption !== -1 && (!codeIdentifier || codeIdentifier.startsWith('-'))) {
  console.error('docs lint --code-identifier 뒤에 이름이 필요함');
  process.exit(2);
}
const inputPath = process.argv.slice(2).find((arg, index, args) => !arg.startsWith('-') && args[index - 1] !== '--code-identifier');

const indexPath = join(docsDir, '_index.md');
const indexLinks = existsSync(indexPath) ? parseIndexLinks(readFileSync(indexPath, 'utf-8')) : new Set<string>();

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === '_archive' || f === '_superseded' || f === 'archive' || f === 'node_modules') continue;
    const full = join(dir, f);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (f.endsWith('.md')) out.push(full);
  }
  return out;
}

const vaultPaths = walk(docsDir);
const vaultFiles = vaultPaths.map((path) => relative(repoRoot, path));
let files: string[];
if (inputPath) {
  const full = join(repoRoot, inputPath);
  if (!inputPath.endsWith('.md') || !existsSync(full)) {
    console.error(`docs lint 입력 문서를 찾을 수 없음: ${inputPath}`);
    process.exit(2);
  }
  files = [full];
} else if (changedOnly) {
  const diff = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'docs'], { cwd: repoRoot, encoding: 'utf-8' })
    + execFileSync('git', ['diff', '--cached', '--name-only', '--', 'docs'], { cwd: repoRoot, encoding: 'utf-8' });
  files = [...new Set(diff.split('\n').filter((l) => l.endsWith('.md')))].map((l) => join(repoRoot, l)).filter(existsSync);
} else {
  files = vaultPaths;
}

// 모든 lint 결과는 file·rule·message를 공유한다.
type CodeIdentifierWarning = { file: string; rule: 'missing-code-identifier'; message: string };
type DocLintWarning = LintWarning | LinkWarning | GitHubIssueCommentWarning | CodeIdentifierWarning | StaleSourceCitationWarning;
const warnings: DocLintWarning[] = [];
const issuecommentWarnings: GitHubIssueCommentWarning[] = [];
const sourceIdentifiers = checkCodeIdentifiers ? sourceIdentifierInventory(repoRoot) : new Set<string>();
const githubToken = process.env.GITHUB_TOKEN;
const githubHeaders: Record<string, string> = { Accept: 'application/vnd.github+json' };
if (githubToken) githubHeaders.Authorization = `Bearer ${githubToken}`;
const issueCommentFetchStatus = createGitHubIssueCommentFetchStatus(fetch, githubHeaders);
// 링크 정합 검사용 fs — repo 상대 경로 존재/본문(anchor). 결정론.
const fileExists = (relPath: string): boolean => existsSync(join(repoRoot, relPath));
const readText = (relPath: string): string | null => { try { return readFileSync(join(repoRoot, relPath), 'utf-8'); } catch { return null; } };
// ⭐ 문서는 인용을 «파일명만»으로 적는다(`launch-preflight.ts:216`). 그대로 repo 상대 경로로 읽으면
//   전부 「못 읽음」이 되어 이 규칙이 통째로 잡음이 된다. 그래서 파일명 → repo 경로를 «한 번» 만든다.
//   ⛔ 같은 파일명이 둘 이상이면 «해석하지 않는다** — 틀린 파일을 대면 「어긋남」이 거짓으로 난다.
const sourcePathsByBasename = new Map<string, string | null>();
const lsFiles = runGitCommand(repoRoot, ['ls-files', '*.ts', '*.tsx'], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
if (lsFiles.status !== 0) throw new Error(`git ls-files failed: ${lsFiles.stderr.trim() || `rc=${lsFiles.status}`}`);
for (const relPath of lsFiles.stdout.split('\n')) {
  if (relPath === '') continue;
  const base = basename(relPath);
  sourcePathsByBasename.set(base, sourcePathsByBasename.has(base) ? null : relPath);
}
const readSource = (cited: string): string | null => {
  if (cited.includes('/')) return readText(cited);
  const resolved = sourcePathsByBasename.get(basename(cited));
  return resolved == null ? null : readText(resolved);
};
for (const full of files) {
  const rel = relative(docsDir, full);
  const sourceRepoRel = relative(repoRoot, full);
  let fullText: string | undefined;
  try { fullText = readFileSync(full, 'utf-8'); } catch { /* skip */ }
  warnings.push(...lintDoc(basename(full), { ...(fullText !== undefined ? { text: fullText.slice(0, 600) } : {}), indexLinks, relPath: rel }));
  // ★ 링크·anchor 정합(arc3·2026-07-14) — parseIndexLinks refs 를 실제 검사에 배선(dead-code 아님).
  if (fullText !== undefined) {
    warnings.push(...lintDocLinks(sourceRepoRel, fullText, { fileExists, readText, vaultFiles }));
    warnings.push(...lintStaleSourceCitations(sourceRepoRel, fullText, { readSource }));
    if (checkCodeIdentifiers) {
      for (const identifier of inlineCodeIdentifiers(fullText)) {
        if (!sourceIdentifiers.has(identifier)) {
          warnings.push({ file: sourceRepoRel, rule: 'missing-code-identifier', message: `\`${identifier}\` — TypeScript source identifier inventory에 없음` });
        }
      }
    }
    // ⛔⭐ **네트워크 검사는 opt-in 이다**(리뷰 2R must-fix) — 기본·`--changed` 경로가 매번 GitHub 을
    //    두드리면 rate limit 에 걸리고, 그러면 전 문서가 `unverifiable` 로 시끄러워진다.
    //    ⇒ `--check-pointers` 를 명시했을 때만 돈다(야간 배선이 그 플래그를 준다).
    if (checkPointers) issuecommentWarnings.push(...await lintGitHubIssueCommentPointers(sourceRepoRel, fullText, {
      repository: { owner: 'ElanvitalAI', repo: 'elanous-agent' },
      apiBase: process.env.GITHUB_API_URL,
      fetchStatus: issueCommentFetchStatus,
    }));
  }
}
warnings.push(...issuecommentWarnings);

const byRule = new Map<string, DocLintWarning[]>();
for (const w of warnings) {
  const arr = byRule.get(w.rule) ?? [];
  arr.push(w);
  byRule.set(w.rule, arr);
}

console.log(`docs lint — ${files.length}개 검사 · 경고 ${warnings.length}건 (차단 없음)`);
if (checkCodeIdentifiers) {
  console.log('코드 식별자 기준: 문서의 단일 inline code(`name`)만 TypeScript AST Identifier 인벤토리와 대조한다; 외부 라이브러리·예시 이름도 경고될 수 있다.');
}
for (const [rule, ws] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n[${rule}] ${ws.length}건`);
  const displayedWarnings = rule === 'missing-code-identifier' && codeIdentifier
    ? ws.filter((w) => w.message.includes(`\`${codeIdentifier}\``))
    : ws.slice(0, changedOnly ? 50 : 5);
  for (const w of displayedWarnings) console.log(`  - ${w.file}: ${w.message}`);
  if (!(rule === 'missing-code-identifier' && codeIdentifier) && ws.length > (changedOnly ? 50 : 5)) console.log(`  … 외 ${ws.length - (changedOnly ? 50 : 5)}건`);
}
if (warnings.length === 0) console.log('컨벤션 위반 없음 ✨');
// ⛔⭐ **`missing`(404) 만 실패다**(리뷰 must-fix · 2026-07-30) — `unverifiable`(403·429·5xx·네트워크)과
//    `mismatched`(2xx 인데 다른 이슈 소속)는 **보고만** 한다.
//    ⚠️ 그러지 않으면 오프라인·무인증·rate-limit 에서 **전 문서가 빨개진다** — 그리고 그때 사람이
//      배우는 것은 *"린터를 끄자"* 다. ***"못 봤다" 를 "없다" 로 올리지 않는다***(이 PR 의 요지).
const missingPointers = issuecommentWarnings.filter((w) => w.rule === 'missing-issuecomment');
// ⭐ 요약도 **분류를 보존한다**(리뷰 5R should-fix) — 개별 진단은 셋으로 갈라 놓고 요약에서 합치면
//    사람이 읽는 마지막 줄에서 다시 *"확인 불가"* 한 덩어리가 된다(야간 경로와 같은 결함).
const unverifiablePointers = issuecommentWarnings.filter((w) => w.rule === 'unverifiable-issuecomment');
const mismatchedPointers = issuecommentWarnings.filter((w) => w.rule === 'mismatched-issuecomment');
if (unverifiablePointers.length > 0) {
  console.warn(`⚠️ issuecomment 포인터 ${unverifiablePointers.length}건은 **확인 불가**(unverifiable) — 실패로 올리지 않는다`);
}
if (mismatchedPointers.length > 0) {
  console.warn(`⚠️ issuecomment 포인터 ${mismatchedPointers.length}건은 **다른 이슈 소속**(mismatched) — 실패로 올리지 않는다`);
}
if (missingPointers.length > 0) {
  console.error(`⛔ GitHub issuecomment 포인터 ${missingPointers.length}건이 **404(missing)** — 검사 실패`);
  process.exitCode = 1;
}
