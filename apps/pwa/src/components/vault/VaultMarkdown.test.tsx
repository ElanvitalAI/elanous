// VaultMarkdown — ```mermaid 펜스는 «코드 상자»가 아니라 MermaidDiagram 으로 간다 (2026-10-08).
// renderToStaticMarkup 은 effect 를 안 돌리므로 MermaidDiagram 은 «그리는 중» 자리(소스 보존)로 찍힌다 —
// 여기서 재는 것은 «배선»이다(실제 SVG 는 브라우저 실물 확인 몫).

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { VaultMarkdown, mermaidSourceFromPre } from './VaultMarkdown';
import { isDarkColorScheme, mermaidCardClassName } from './MermaidDiagram';

const MERMAID_NOTE = ['# 노트', '', '```mermaid', 'graph TD', '  A[시작] --> B[끝]', '```', ''].join('\n');

describe('VaultMarkdown mermaid 배선', () => {
  test('```mermaid 펜스는 MermaidDiagram 자리로 렌더된다(일반 <pre> 상자 아님)', () => {
    const html = renderToStaticMarkup(<VaultMarkdown markdown={MERMAID_NOTE} />);
    expect(html).toContain('data-elanous-mermaid="loading"');
    expect(html).toContain('language-mermaid');
    expect(html).toContain('A[시작] --&gt; B[끝]');
    // 바깥 코드 상자(<pre class="my-3 ...">)에 갇히지 않는다
    expect(html).not.toContain('<pre class="my-3');
  });

  test('노트 안 init 지시는 MermaidDiagram 소스로 그대로 전달된다', () => {
    const directive = "%%{init: {theme: 'forest'}}%%";
    const html = renderToStaticMarkup(<VaultMarkdown markdown={`\`\`\`mermaid\n${directive}\ngraph TD\nA-->B\n\`\`\``} />);
    expect(html).toContain(directive.replaceAll("'", '&#x27;'));
    expect(html).toContain('data-elanous-mermaid="loading"');
  });

  test('다른 언어 펜스·인라인 코드는 그대로다', () => {
    const md = ['```ts', 'const a = 1;', '```', '', '인라인 `mermaid` 글자'].join('\n');
    const html = renderToStaticMarkup(<VaultMarkdown markdown={md} />);
    expect(html).toContain('<pre class="my-3');
    expect(html).toContain('language-ts');
    expect(html).not.toContain('data-elanous-mermaid');
  });

  test('mermaidSourceFromPre — 끝 개행만 떼고 소스를 그대로 낸다', () => {
    const node = {
      type: 'element',
      tagName: 'pre',
      children: [{
        type: 'element',
        tagName: 'code',
        properties: { className: ['language-mermaid'] },
        children: [{ type: 'text', value: 'sequenceDiagram\n  A->>B: hi\n' }],
      }],
    };
    expect(mermaidSourceFromPre(node)).toBe('sequenceDiagram\n  A->>B: hi');
    expect(mermaidSourceFromPre({ ...node, children: [{ ...node.children[0], properties: { className: ['language-js'] } }] })).toBeNull();
    expect(mermaidSourceFromPre(undefined)).toBeNull();
  });

  test('다크 화면에서 밝은 Mermaid 테마는 도식 카드만 밝게 만든다', () => {
    expect(mermaidCardClassName(true, 'default')).toContain('bg-white');
    expect(mermaidCardClassName(true, 'forest')).toContain('bg-white');
    expect(mermaidCardClassName(true, 'dark')).not.toContain('bg-white');
    expect(mermaidCardClassName(false, 'default')).not.toContain('bg-white');
  });

  test('isDarkColorScheme — 테마의 color-scheme 첫 값으로 가른다', () => {
    expect(isDarkColorScheme('dark')).toBe(true);
    expect(isDarkColorScheme('dark light')).toBe(true);
    expect(isDarkColorScheme('light')).toBe(false);
    expect(isDarkColorScheme('normal')).toBe(false);
    expect(isDarkColorScheme('')).toBe(false);
    expect(isDarkColorScheme(undefined)).toBe(false);
  });
});
