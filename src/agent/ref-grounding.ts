// ── ref-grounding — 로컬 canonical 소스 자동 그라운딩 (2026-07-19) ──
//
// 갭(실증): 골이 참조 이름(lazycodex·ouroboros·mattpocock 등)만 주면, elanous 이
// 로컬 `~/source/ref/<name>/`(대표 canonical 사본)이 있는 줄 모르고 WebSearch/
// GitHub raw 로 우회한다 — 원문 대신 요약이거나, 로컬보다 느리고 lossy.
// → 골 토큰이 ref 루트 아래 **실존 디렉터리**면 그 경로를 주입해 "웹 대신 이걸
// Read/Grep 하라"고 그라운딩한다.
//
// 명시룰·결정론(대표 지침): 트리거 = **디렉터리 실존 검사**(파일시스템이 곧 규칙)
// → false positive 0(없는 이름은 무시). 무매치면 무주입(무노이즈). READ-ONLY·fail-soft.
// ⚠️ ref-grounding 은 자기인지(self-ambient)와 직교 — 별 모듈.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';

/** 로컬 참조 루트(기본 ~/source/ref). 다른 환경엔 없으면 무동작(graceful). */
export const DEFAULT_REFERENCE_ROOTS = [join(homedir(), 'source', 'ref')];

// 대표 2026-10-14 — 비공개 소스(Claude Code 사본) 통로 차단. Claude Code 는 공개 계약(code.claude.com)만 본다.
// ref 루트 아래 디렉터리가 실존해도 이 이름이면 그라운딩·조회 대상에서 뺀다(대소문자·`_`/`-` 변형 포함).
const NON_PUBLIC_REFERENCE_PATTERN = /^claude[-_]?code[-_]?(?:fork|src|source|leak|leaked)$/i;

/** 공개 계약이 아닌 참조 사본 이름인가. `owner/repo` 꼴이면 마지막 칸으로 본다. */
export function isNonPublicReferenceName(name: string): boolean {
  const last = name.trim().replace(/\/+$/, '').split('/').pop() ?? '';
  return NON_PUBLIC_REFERENCE_PATTERN.test(last);
}

/** 거부 판정 ⊕ 관측 한 줄. 거부면 true. */
export function denyNonPublicReference(name: string): boolean {
  if (!isNonPublicReferenceName(name)) return false;
  try { debug.log('ref.grounding', 'denied', { name, reason: 'non-public-source' }); } catch { /* fail-soft */ }
  return true;
}

function expandTilde(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

export type LocalReferenceMetadata = {
  category: string;
  repo: string;
  path: string;
  reason: string;
};

function markdownText(value: string): string {
  return value.trim().replace(/^`|`$/g, '').replace(/^\*\*|\*\*$/g, '').trim();
}

/** README의 카테고리별 참조 표를 파싱한다. 형식이 맞지 않는 행은 무시한다. */
export function parseLocalReferenceMetadata(readme: string): LocalReferenceMetadata[] {
  const lines = readme.split(/\r?\n/);
  const metadata: LocalReferenceMetadata[] = [];
  let category = '';

  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^#{3,}\s+(.+?)\s*$/);
    if (heading) {
      category = heading[1].trim();
      continue;
    }
    if (!category || !/^\s*\|/.test(lines[index])) continue;

    const headers = lines[index].split('|').slice(1, -1).map((cell) => markdownText(cell).toLowerCase());
    const repoIndex = headers.indexOf('repo');
    const pathIndex = headers.indexOf('path');
    const reasonIndex = headers.indexOf('참조 이유');
    const separator = lines[index + 1];
    if (repoIndex < 0 || pathIndex < 0 || reasonIndex < 0 || !separator || !/^\s*\|\s*:?-{3,}/.test(separator)) continue;

    index += 2;
    while (index < lines.length && /^\s*\|/.test(lines[index])) {
      const cells = lines[index].split('|').slice(1, -1).map(markdownText);
      const repo = cells[repoIndex];
      const path = cells[pathIndex];
      const reason = cells[reasonIndex];
      if (repo && path && reason) metadata.push({ category, repo, path, reason });
      index += 1;
    }
    index -= 1;
  }
  return metadata;
}

function referenceMetadata(root: string, token: string): LocalReferenceMetadata | undefined {
  try {
    const entries = parseLocalReferenceMetadata(readFileSync(join(root, 'README.md'), 'utf8'));
    return entries.find((entry) => entry.repo.toLowerCase() === token || entry.path.replace(/^`|`$/g, '').replace(/\/+$/, '').split('/').pop()?.toLowerCase() === token);
  } catch {
    return undefined;
  }
}

/** 테스트 코어 — 골 토큰 ∩ (roots 아래 실존 디렉터리) 를 그라운딩 노트로.
 *  토큰 길이 ≥4(흔한 단어 노이즈 감소)·최대 8개·중복 제거. 무매치 → 빈 문자열. */
export function localRefGroundingDigest(taskText: string, roots: string[] = DEFAULT_REFERENCE_ROOTS): string {
  if (!taskText || !taskText.trim()) return '';
  const tokens = new Set<string>();
  for (const m of taskText.toLowerCase().matchAll(/[a-z0-9][a-z0-9_-]{3,}/g)) tokens.add(m[0]);
  if (!tokens.size) return '';
  const found: Array<{ path: string; root: string; token: string }> = [];
  const seen = new Set<string>();
  for (const rawRoot of roots) {
    const root = expandTilde(rawRoot);
    if (!existsSync(root)) continue;
    for (const token of tokens) {
      if (seen.has(token)) continue;
      if (denyNonPublicReference(token)) { seen.add(token); continue; }
      try {
        const path = join(root, token);
        if (statSync(path).isDirectory()) { found.push({ path, root, token }); seen.add(token); }
      } catch { /* not a dir · skip */ }
      if (found.length >= 8) break;
    }
    if (found.length >= 8) break;
  }
  if (!found.length) return '';
  let withMeta = 0;
  const sources = found.map(({ path, root, token }) => {
    const metadata = referenceMetadata(root, token);
    if (metadata) {
      withMeta += 1;
      return `- ${path}\n  카테고리: ${metadata.category}\n  경로: ${metadata.path}\n  참조 이유: ${metadata.reason}`;
    }
    return `- ${path}`;
  });
  debug.log('ref-grounding', 'digest', { matched: found.length, withMeta });
  return `참조 소스 로컬 canonical (웹/GitHub 우회 대신 이걸 Read/Grep 하라 — 원문·최신·로컬):\n${sources.join('\n')}`;
}

/** ambient wrapper — fail-soft·매 턴 fresh. roots 기본 = ~/source/ref. */
export function localRefGroundingAmbient(taskText: string, roots: string[] = DEFAULT_REFERENCE_ROOTS): string {
  try { return localRefGroundingDigest(taskText, roots); } catch { return ''; }
}
