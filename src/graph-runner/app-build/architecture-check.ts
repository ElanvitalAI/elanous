import type { Root, RootContent } from 'mdast';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/** Pure structural check for the eight ARCH-DOC-PRO sections.
 * A successful result is not a semantic score, rendered-diagram review, or deployment parity proof.
 */
export const ARCHITECTURE_SECTION_KEYS = [
  'context', 'dataModel', 'api', 'sequences', 'deployment', 'security', 'tradeOffs', 'operations',
] as const;
export type ArchitectureSectionKey = typeof ARCHITECTURE_SECTION_KEYS[number];

export interface ArchitectureCheckInput {
  markdown: string;
  sections: Record<string, string>;
  /** Relative paths in the in-memory artifact bundle. No filesystem access occurs. */
  files?: string[];
}
export interface ArchitectureCheckIssue {
  code: string;
  section?: string;
  reference?: string;
}
export interface ArchitectureCheckResult {
  ok: boolean;
  issues: ArchitectureCheckIssue[];
}

const labels: Record<ArchitectureSectionKey, readonly string[]> = {
  context: ['context', 'systemcontext', 'systemcontextandcontainers', 'contextcontainers', '시스템맥락', '시스템맥락과컨테이너'],
  dataModel: ['datamodel', 'datamodelerd', 'erd', '데이터모델', '데이터모델erd'],
  api: ['api', 'apicontract', 'api계약'],
  sequences: ['sequences', 'coresequences', '시퀀스', '핵심흐름', '핵심시퀀스'],
  deployment: ['deployment', 'deploymenttopology', '배포토폴로지', '배포구성'],
  security: ['security', '보안'],
  tradeOffs: ['tradeoffs', 'scalabilitytradeoffs', '규모와대안', '확장성과대안', '용량과대안'],
  operations: ['operations', '운영'],
};

function normalizedHeading(value: string): string {
  return value.normalize('NFKC').replace(/^\s*\d+(?:\.\d+)*[.)]?\s*/u, '')
    .replace(/<[^>]+>/gu, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}
function sectionForHeading(value: string): ArchitectureSectionKey | undefined {
  const bilingual = /^\s*(context|dataModel|api|sequences|deployment|security|tradeOffs|operations)\s+—\s+\S/iu.exec(value);
  if (bilingual) return ARCHITECTURE_SECTION_KEYS.find(key => key.toLowerCase() === bilingual[1]!.toLowerCase());
  const normalized = normalizedHeading(value);
  return ARCHITECTURE_SECTION_KEYS.find((key) => labels[key].includes(normalized));
}
function normalizedLocalPath(value: string): string | null {
  let path = value.trim().replace(/^<|>$/gu, '');
  if (!path || path.startsWith('#') || /^(?:https?:|mailto:|data:)/iu.test(path)) return null;
  try { path = decodeURIComponent(path); } catch { return '!invalid-encoding'; }
  path = path.split(/[?#]/u, 1)[0]!.replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path)) return '!unsafe-path';
  const parts = path.split('/').filter((part) => part && part !== '.');
  if (parts.includes('..') || parts.length === 0) return '!unsafe-path';
  return parts.join('/');
}
function childrenOf(node: Root | RootContent): RootContent[] {
  return 'children' in node ? node.children as RootContent[] : [];
}
function nodeText(node: Root | RootContent): string {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('alt' in node && typeof node.alt === 'string') return node.alt;
  return childrenOf(node).map(nodeText).join('');
}
function visit(node: Root | RootContent, fn: (node: RootContent) => void): void {
  for (const child of childrenOf(node)) {
    fn(child);
    visit(child, fn);
  }
}
function references(root: Root): Array<{ target: string; image: boolean }> {
  const found: Array<{ target: string; image: boolean }> = [];
  const definitions = new Map<string, string>();
  visit(root, (node) => {
    if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node.url);
  });
  visit(root, (node) => {
    if (node.type === 'link' || node.type === 'image') found.push({ target: node.url, image: node.type === 'image' });
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      found.push({ target: definitions.get(node.identifier.toLowerCase()) ?? `!missing-definition:${node.identifier}`, image: node.type === 'imageReference' });
    }
    if (node.type === 'html') {
      for (const match of node.value.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu)) {
        found.push({ target: match[1]!.trim(), image: true });
      }
    }
  });
  return found;
}

/** Supported diagram contract: a Mermaid fence with the grammar for this section.
 * PlantUML, DOT, Markdown images and HTML img tags remain references, not diagrams.
 */
function diagramIn(nodes: RootContent[], kind: 'context' | 'dataModel' | 'sequences'): boolean {
  const root: Root = { type: 'root', children: nodes };
  let found = false;
  visit(root, (node) => {
    if (node.type !== 'code' || node.lang?.toLowerCase() !== 'mermaid' || !node.value.trim()) return;
    const language = node.lang?.toLowerCase();
    const firstLine = node.value.trimStart().split('\n', 1)[0]!.trim();
    if (language === 'mermaid' && (kind === 'context' ? /^(?:graph|flowchart)\b/iu.test(firstLine)
      : kind === 'dataModel' ? /^erDiagram\b/iu.test(firstLine) : /^sequenceDiagram\b/iu.test(firstLine))) found = true;
  });
  return found;
}

/** Inspect only supplied strings and in-memory file names; never read files or call a model. */
export function checkArchitectureDocument(input: ArchitectureCheckInput): ArchitectureCheckResult {
  const issues: ArchitectureCheckIssue[] = [];
  const markdown = typeof input.markdown === 'string' ? input.markdown.replace(/\r\n?/gu, '\n') : '';
  const sections = input.sections && typeof input.sections === 'object' ? input.sections : {};
  if (!markdown.trim()) issues.push({ code: 'empty-document' });
  const root = unified().use(remarkParse).parse(markdown) as Root;
  const bodies = new Map<ArchitectureSectionKey, RootContent[]>();
  const active: Array<{ key: ArchitectureSectionKey; depth: number }> = [];
  for (const node of root.children) {
    if (node.type === 'heading') {
      while (active.length && active[active.length - 1]!.depth >= node.depth) active.pop();
      const key = sectionForHeading(nodeText(node));
      if (key) {
        active.push({ key, depth: node.depth });
        if (!bodies.has(key)) bodies.set(key, []);
        continue;
      }
    }
    const current = active[active.length - 1];
    if (current) {
      bodies.get(current.key)?.push(node);
    }
  }
  for (const key of ARCHITECTURE_SECTION_KEYS) {
    if (typeof sections[key] !== 'string' || !sections[key]!.trim()) issues.push({ code: 'missing-section', section: key });
    if (!bodies.has(key)) issues.push({ code: 'missing-heading', section: key });
    else if (!bodies.get(key)?.some((node) => node.type !== 'heading' && node.type !== 'definition' && node.type !== 'html' && nodeText(node).trim())) {
      issues.push({ code: 'empty-markdown-section', section: key });
    }
  }
  for (const key of ['context', 'dataModel', 'sequences'] as const) {
    if (!diagramIn(bodies.get(key) ?? [], key)) issues.push({ code: 'missing-diagram', section: key });
  }
  const refs = references(root);
  if (!refs.some((ref) => normalizedLocalPath(ref.target))) issues.push({ code: 'missing-reference' });
  const available = input.files?.map(normalizedLocalPath).filter((path): path is string => Boolean(path) && !path!.startsWith('!'));
  const fileSet = available ? new Set(available) : undefined;
  for (const ref of refs) {
    const path = normalizedLocalPath(ref.target);
    if (ref.target.startsWith('!missing-definition:')) {
      issues.push({ code: 'missing-reference-definition', reference: ref.target.slice('!missing-definition:'.length) });
    } else if (path === '!unsafe-path' || path === '!invalid-encoding') {
      issues.push({ code: 'invalid-reference', reference: ref.target });
    } else if (path && fileSet && !fileSet.has(path)) {
      issues.push({ code: 'missing-reference-target', reference: path });
    }
  }
  return { ok: issues.length === 0, issues };
}
