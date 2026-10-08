'use client';

// ── VaultMarkdown — Obsidian-flavored 렌더러 (OP3b · 2026-07-09) ───────────
//
// 대표 지시: 기본 View 모드에서 헤더 크기 차등·테이블 렌더 + raw 모드. 손수 파서 대신
// 검증된 remark 플러그인(omni-crawl 조사 추천): react-markdown + remark-gfm(테이블) +
// remark-wiki-link([[...]]) + remark-callout(> [!note]). 헤더/테이블은 typography 플러그인
// 부재로 명시적 components 스타일(h1>h2>h3 크기·테이블 보더). wikilink 는 클릭 네비.

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkWikiLink from 'remark-wiki-link';
import remarkCallout from 'remark-callout';
import { MermaidDiagram } from '@/components/vault/MermaidDiagram';

const WIKILINK_HREF = 'wikilink:';

/** hast 노드의 최소 모양 — react-markdown 이 components 에 `node` 로 넘긴다. */
interface HastLike {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastLike[];
}

function hastText(node: HastLike | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

/**
 * ```mermaid 펜스면 그 소스를, 아니면 null 을 낸다 (2026-10-08 · «옵시디언 mermaid 가 안 그려진다»).
 * react-markdown 은 펜스를 `pre > code.language-<lang>` 로 만든다 — `pre` 에서 가로채야
 * 도식이 코드 상자(<pre>) «안»에 갇히지 않는다.
 */
export function mermaidSourceFromPre(node: HastLike | undefined): string | null {
  const code = node?.children?.find((c) => c.type === 'element' && c.tagName === 'code');
  if (!code) return null;
  const cls = code.properties?.className;
  const classes = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? cls.split(/\s+/) : [];
  if (!classes.includes('language-mermaid')) return null;
  return hastText(code).replace(/\n$/, '');
}

/** 명시적 컴포넌트 스타일 — typography 플러그인 없이 헤더 크기·테이블·리스트 렌더. */
function makeComponents(onWikilink?: (target: string) => void): Components {
  return {
    h1: ({ children }) => <h1 className="mb-3 mt-5 border-b border-border pb-1 text-2xl font-bold">{children}</h1>,
    h2: ({ children }) => <h2 className="mb-2 mt-5 text-xl font-bold">{children}</h2>,
    h3: ({ children }) => <h3 className="mb-2 mt-4 text-lg font-semibold">{children}</h3>,
    h4: ({ children }) => <h4 className="mb-1 mt-3 text-base font-semibold">{children}</h4>,
    h5: ({ children }) => <h5 className="mb-1 mt-2 text-sm font-semibold text-muted-foreground">{children}</h5>,
    h6: ({ children }) => <h6 className="mb-1 mt-2 text-xs font-semibold uppercase text-muted-foreground">{children}</h6>,
    p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-6">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-6">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    blockquote: ({ children }) => <blockquote className="my-3 border-l-4 border-primary/40 bg-muted/40 py-1 pl-3 text-muted-foreground">{children}</blockquote>,
    hr: () => <hr className="my-4 border-border" />,
    table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-sm">{children}</table></div>,
    thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
    th: ({ children }) => <th className="border border-border px-3 py-1.5 text-left font-semibold">{children}</th>,
    td: ({ children }) => <td className="border border-border px-3 py-1.5">{children}</td>,
    code: ({ className, children }) => {
      const inline = !className;
      return inline
        ? <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
        : <code className={`${className} font-mono`}>{children}</code>;
    },
    pre: ({ node, children }) => {
      const mermaidSource = mermaidSourceFromPre(node as HastLike | undefined);
      if (mermaidSource !== null) return <MermaidDiagram source={mermaidSource} />;
      return <pre className="my-3 overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-xs">{children}</pre>;
    },
    img: ({ src, alt }) => <img src={typeof src === 'string' ? src : ''} alt={alt ?? ''} className="my-2 max-w-full rounded" />,
    a: ({ href, children }) => {
      const h = href ?? '';
      if (h.startsWith(WIKILINK_HREF)) {
        const target = decodeURIComponent(h.slice(WIKILINK_HREF.length));
        return (
          <button type="button" onClick={() => onWikilink?.(target)} className="text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid">
            {children}
          </button>
        );
      }
      return <a href={h} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{children}</a>;
    },
  };
}

// remark-wiki-link 설정 — permalink=원본 target 유지(lowercase/space 변환 안 함) →
// hrefTemplate 이 wikilink:<target> 로 만들고 a 렌더러가 클릭 네비.
const WIKI_OPTS = {
  aliasDivider: '|',
  pageResolver: (name: string) => [name],
  hrefTemplate: (permalink: string) => `${WIKILINK_HREF}${encodeURIComponent(permalink)}`,
};

export function VaultMarkdown({ markdown, onWikilink }: { markdown: string; onWikilink?: (target: string) => void }) {
  return (
    <div className="text-sm text-foreground/90">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCallout, [remarkWikiLink, WIKI_OPTS]]}
        components={makeComponents(onWikilink)}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
