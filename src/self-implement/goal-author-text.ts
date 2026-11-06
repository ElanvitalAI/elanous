import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { extractGoalDocSections, type GoalDocSourceLine } from './goal-doc/section.js';

export interface TracedPathReference {
  path: string;
  line: number | null;
  endLine: number | null;
}

export type TracedPathTokenKind = 'path' | 'bare' | 'residual' | 'repository-root' | 'empty-cover';
export interface TracedPathTokenClassification {
  readonly token: string;
  readonly kind: TracedPathTokenKind;
  readonly path: string | null;
  readonly residual: string | null;
}

const EMPTY_COVER_TOKEN = '(빈 대상 경로)';
const TRACED_PATH_RESIDUAL_TOKEN = /^((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)([^A-Za-z0-9./\\:\s,;]+)$/;
// 저작기가 목록 기호를 두 겹으로 쓸 수 있다 (`- - src/x.ts`, `- [code] - src/x.ts`).
// 한 겹만 벗기면 나머지가 경로에 붙어 missing-path 오류가 나므로 기호와 태그를 반복해서 벗긴다.
const TRACED_PATH_LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;
export const TRACED_PATH_LEADING_LIST_MARKERS = /^(?:\s*(?:[-*+]|\d+[.)])\s+)+/;
const TRACED_PATH_EVIDENCE_TAG = /^\[(?:code|skill|memory|doc|pty|unknown)\]\s+/;
export const TRACED_PATHS_EVIDENCE_UNAVAILABLE = 'Evidence unavailable — grounding found no persistent evidence and the cause remains undifferentiated. Grounding needs behavior and causation, not only locations: state what the target code does today and why that is a problem, and name a function, constant, or type that the target file exports. A pure-addition ask ("also record field X") often fails here because it names no current behavior to ground. Re-authoring the same input may also produce different evidence, but try that first. See docs/manual/MANUAL-goal-authoring-method-2026-08-03.md';
export const TRACED_PATHS_PERSISTENT_CHANNEL_UNAVAILABLE = /^Evidence unavailable — grounding found \d+ categorized evidence items, but no persistent evidence; only the persistent channel is empty\. Strengthening the ask's prose may not resolve this channel gap; inspect or restore persistent grounding evidence instead\. See docs\/manual\/MANUAL-goal-authoring-method-2026-08-03\.md$/;
export const TRACED_PATH_LINE = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/;
const INLINE_CODE_WRAPPED = /^(`+)([^`]*)\1$/;
export const TRACED_PATH_DESCRIPTION_DELIMITER = /\s+(?:—|-)\s+|:\s+/;
export const TRACED_PATH_READ_ANNOTATION = /\s+\(Read,\s*\d+\s+lines?\)\s*$/i;
const TRACED_PATH_EXCLUSION_DESCRIPTION = /\b(?:related|relevant)\b.*\b(?:but|however)\b.*\b(?:not here|elsewhere|another (?:location|place|path))\b|\b(?:not here|elsewhere|another (?:location|place|path))\b.*\b(?:related|relevant)\b/i;
export const ORIGINAL_ASK_MARKER = 'Original ask (verbatim, unmodified):';

// 빈 인라인 코드(`` ``)는 벗기지 않는다. 빈 문자열이 되면 호출자가 경로 검사를 건너뛰어
// 예전의 missing-path 오류가 사라지므로, 관대한 파싱이 검사를 약하게 만들면 안 된다.
export function stripInlineCode(field: string): string {
  const inner = INLINE_CODE_WRAPPED.exec(field)?.[2].trim();
  return inner ? inner : field;
}

function isEmptyCoverToken(token: string): boolean {
  const trimmed = token.trim();
  return trimmed === '' || trimmed === EMPTY_COVER_TOKEN;
}

function isSameOrNestedPath(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function repositoryRootFileExists(path: string, repositoryRoot: string): boolean {
  if (path.includes('/') || path.includes('\\') || isAbsolute(path)) return false;
  try {
    const realRoot = realpathSync(resolve(repositoryRoot));
    const absolutePath = resolve(realRoot, path);
    if (dirname(absolutePath) !== realRoot || !isSameOrNestedPath(absolutePath, realRoot)) return false;
    return lstatSync(absolutePath).isFile();
  } catch { return false; }
}

export function classifyTracedPathToken(token: string, repositoryRoot?: string): TracedPathTokenClassification {
  const trimmed = token.trim();
  if (isEmptyCoverToken(trimmed)) return { token: trimmed, kind: 'empty-cover', path: null, residual: null };
  const unwrapped = stripInlineCode(trimmed).replace(TRACED_PATH_LEADING_LIST_MARKERS, '').trim();
  if (isEmptyCoverToken(unwrapped)) return { token: trimmed, kind: 'empty-cover', path: null, residual: null };
  const residualMatch = TRACED_PATH_RESIDUAL_TOKEN.exec(unwrapped);
  if (residualMatch?.[1] && residualMatch[2]) return { token: trimmed, kind: 'residual', path: residualMatch[1], residual: residualMatch[2] };
  const normalized = unwrapped.replaceAll('\\', '/');
  if (!normalized.includes('/')) {
    if (repositoryRoot && repositoryRootFileExists(normalized, repositoryRoot)) return { token: trimmed, kind: 'repository-root', path: normalized, residual: null };
    return { token: trimmed, kind: 'bare', path: normalized, residual: null };
  }
  return { token: trimmed, kind: 'path', path: normalized, residual: null };
}

export function canonicalTracedPathToken(token: string, repositoryRoot?: string): string | null {
  const classification = classifyTracedPathToken(token, repositoryRoot);
  return classification.kind === 'path' || classification.kind === 'repository-root' ? classification.path : null;
}

export function tracedPathListItem(line: string): string | undefined {
  const item = TRACED_PATH_LIST_ITEM.exec(line)?.[1];
  if (item === undefined) return undefined;
  let evidence = item;
  for (;;) {
    const next = evidence.replace(TRACED_PATH_LEADING_LIST_MARKERS, '').replace(TRACED_PATH_EVIDENCE_TAG, '');
    if (next === evidence) return evidence;
    evidence = next;
  }
}

export function isTracedPathsEvidenceUnavailable(entry: string): boolean {
  return entry === TRACED_PATHS_EVIDENCE_UNAVAILABLE || TRACED_PATHS_PERSISTENT_CHANNEL_UNAVAILABLE.test(entry);
}
export function isTracedPathExclusionDescription(item: string): boolean {
  const description = item.split(TRACED_PATH_DESCRIPTION_DELIMITER).slice(1).join(' — ').trim();
  return description.length > 0 && TRACED_PATH_EXCLUSION_DESCRIPTION.test(description);
}

function section(document: string, title: string): string | null {
  const linesOutsideFencedCode = (text: string): GoalDocSourceLine[] => {
    let fence: { marker: string; length: number } | null = null;
    const outside: GoalDocSourceLine[] = [];
    const parts = text.split(/(\r?\n)/);
    let cursor = 0;
    for (let index = 0; index < parts.length; index += 2) {
      const line = parts[index] ?? '';
      const lineStart = cursor;
      cursor += line.length + (parts[index + 1]?.length ?? 0);
      const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (!fence && (marker !== '`' || !fenceMatch[2].includes('`'))) fence = { marker, length: fenceMatch[1].length };
        else if (fence && marker === fence.marker && fenceMatch[1].length >= fence.length && fenceMatch[2].trim() === '') fence = null;
        continue;
      }
      if (!fence) outside.push({ text: line, start: lineStart });
    }
    return outside;
  };
  return extractGoalDocSections(document, {
    search: 'exact-trimmed-line',
    heading: `## ${title}`,
    lines: linesOutsideFencedCode,
    endHeading: /^#{1,2}(?:\s|$)/,
  })[0]?.body ?? null;
}

export function tracedPathReferences(document: string): TracedPathReference[] {
  const body = section(document, 'TRACED PATHS');
  if (!body) return [];
  const references: TracedPathReference[] = [];
  let normalizedAnnotationCount = 0;
  for (const line of body.split(/\r?\n/)) {
    const evidence = tracedPathListItem(line);
    if (!evidence || isTracedPathsEvidenceUnavailable(evidence) || evidence.startsWith('미해석:') || isTracedPathExclusionDescription(evidence)) continue;
    const pathField = evidence.split(TRACED_PATH_DESCRIPTION_DELIMITER, 1)[0].trim();
    for (const fragment of pathField.split(' · ')) {
      const trimmed = fragment.trim();
      if (!trimmed) continue;
      const withoutAnnotation = trimmed.replace(TRACED_PATH_READ_ANNOTATION, '').trim();
      if (withoutAnnotation !== trimmed) normalizedAnnotationCount += 1;
      const unwrapped = stripInlineCode(withoutAnnotation).replace(TRACED_PATH_LEADING_LIST_MARKERS, '');
      const match = TRACED_PATH_LINE.exec(unwrapped);
      const path = match ? stripInlineCode(match[1].trim()).replace(TRACED_PATH_LEADING_LIST_MARKERS, '') : undefined;
      if (!path) continue;
      const classification = classifyTracedPathToken(path);
      if (classification.kind === 'residual' || classification.kind === 'empty-cover') continue;
      references.push({ path, line: match?.[2] ? Number(match[2]) : null, endLine: match?.[3] ? Number(match[3]) : null });
    }
  }
  if (normalizedAnnotationCount > 0) {
    try { debug.log('goal-author', 'traced-path-annotation-normalized', { count: normalizedAnnotationCount }); }
    catch { /* observation must not prevent path validation */ }
  }
  return references;
}

export interface VerbatimOriginalAsk { ask: string; range?: { start: number; end: number } }
function escapeRegularExpression(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function extractVerbatimOriginalAsk(document: string): VerbatimOriginalAsk | null {
  const lines = [...document.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)]
    .filter((match) => match[0] !== '')
    .map((match) => ({ text: match[1], start: match.index!, end: match.index! + match[0].length, contentEnd: match.index! + match[1].length }));
  // 원문 문자열을 다시 쓰지 않고 단일 마커 상수에서 파생한다.
  const heading = lines.findIndex(({ text }) => text === ORIGINAL_ASK_MARKER);
  if (heading < 0) return null;
  const opening = /^(\s*)(`{3,})[^`]*\s*$/.exec(lines[heading + 1]?.text ?? '');
  if (!opening) return null;
  const [, indentation, fence] = opening;
  const closing = new RegExp(`^${escapeRegularExpression(indentation)}${escapeRegularExpression(fence)}\\s*$`);
  const end = lines.findIndex(({ text }, index) => index > heading + 1 && closing.test(text));
  if (end < 0) return null;
  const start = lines[heading + 1].end;
  const range = { start, end: end === heading + 2 ? lines[end].start : lines[end - 1].contentEnd };
  return { ask: document.slice(range.start, range.end), range };
}
export function verbatimOriginalAsk(document: string): string | null { return extractVerbatimOriginalAsk(document)?.ask ?? null; }
