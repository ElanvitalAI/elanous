'use client';

// ── MermaidDiagram — 옵시디언 노트의 ```mermaid 블록을 SVG 로 그린다 (2026-10-08) ──
//
// 원인: VaultMarkdown 은 react-markdown 만 쓰고 mermaid 펜스를 «일반 코드»로 넘겼다 ⇒ 소스 글자가 그대로 보였다.
// 선택(omni-crawl 조사): 공식 `mermaid` 패키지를 «클라이언트에서» `mermaid.render()` 로 부른다.
//   - rehype-mermaid 는 기본 전략이 playwright(서버 headless 브라우저)라 정적 export PWA 에 안 맞는다.
//   - 래퍼 패키지(react-markdown-mermaid 등)는 결국 같은 `mermaid.render` 를 감싼다 — 의존 하나를 더 들일 이유가 없다.
// 번들: `import('mermaid')` 동적 import — mermaid 블록이 «있는» 노트를 열 때만 청크를 받는다(CDN 아님 · 자체 번들).
// 보안: `securityLevel: 'strict'` — 노트 본문은 사용자/외부 문서라 클릭 콜백·HTML 라벨을 막는다
//       (mermaid 는 출력 SVG 를 내장 DOMPurify 로 한 번 더 거른다).
// 테마: 각 PWA 테마가 `color-scheme` 을 선언한다(globals.css) ⇒ 그 값으로 dark/default 를 고르고,
//       `<html data-theme>` 가 바뀌면 다시 그린다.
// 실패: 문법 오류면 소스 코드 ⊕ 오류 한 줄을 보여 준다(조용히 사라지지 않는다).

import { useEffect, useId, useState } from 'react';

type MermaidModule = typeof import('mermaid');
type MermaidApi = MermaidModule['default'];

let mermaidPromise: Promise<MermaidApi> | null = null;
/** mermaid 는 전역 설정(initialize)을 쓰므로 렌더를 한 줄로 세운다 — 여러 도식이 동시에 테마를 바꾸지 않게. */
let renderQueue: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default).catch((err) => {
      mermaidPromise = null; // 청크 로드 실패는 다음 시도에서 다시 받는다
      throw err;
    });
  }
  return mermaidPromise;
}

/** 현재 PWA 테마가 어두운가 — 테마마다 globals.css 가 `color-scheme` 을 선언한다. */
export function isDarkColorScheme(colorScheme: string | null | undefined): boolean {
  return (colorScheme ?? '').trim().split(/\s+/)[0] === 'dark';
}

function currentColorSchemeIsDark(): boolean {
  if (typeof window === 'undefined') return false;
  return isDarkColorScheme(getComputedStyle(document.documentElement).colorScheme);
}

/** mermaid 가 렌더 실패 시 body 에 남기는 임시 노드를 치운다. */
function cleanupTempNode(id: string): void {
  if (typeof document === 'undefined') return;
  document.getElementById(id)?.remove();
  document.getElementById(`d${id}`)?.remove();
}

export async function renderMermaidSvg(id: string, source: string, dark: boolean): Promise<string> {
  const job = renderQueue.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      fontFamily: 'inherit',
    });
    try {
      const { svg } = await mermaid.render(id, source);
      return svg;
    } finally {
      cleanupTempNode(id);
    }
  });
  renderQueue = job.catch(() => undefined);
  return job;
}

type RenderState =
  | { status: 'loading' }
  | { status: 'ok'; svg: string }
  | { status: 'error'; message: string };

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  // mermaid 의 id 는 CSS 선택자로 쓰인다 — useId 의 «:» 를 걸러 낸다.
  const baseId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [state, setState] = useState<RenderState>({ status: 'loading' });
  const [dark, setDark] = useState<boolean>(() => currentColorSchemeIsDark());

  // 테마 추종 — <html data-theme> 이 바뀌면 color-scheme 을 다시 읽는다.
  useEffect(() => {
    setDark(currentColorSchemeIsDark());
    if (typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => setDark(currentColorSchemeIsDark()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => (prev.status === 'ok' ? prev : { status: 'loading' }));
    // 같은 id 로 겹쳐 그리지 않게 렌더마다 접미를 붙인다.
    const renderId = `${baseId}-${Date.now().toString(36)}`;
    renderMermaidSvg(renderId, source, dark)
      .then((svg) => { if (!cancelled) setState({ status: 'ok', svg }); })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', message: message.split('\n').filter(Boolean).slice(0, 3).join(' · ') || 'mermaid 렌더 실패' });
      });
    return () => { cancelled = true; };
  }, [baseId, source, dark]);

  if (state.status === 'ok') {
    return (
      <div
        className="my-3 flex justify-center overflow-x-auto rounded-lg border border-border bg-muted/20 p-3 [&_svg]:h-auto [&_svg]:max-w-full"
        data-elanous-mermaid="ok"
        // mermaid securityLevel:'strict' ⊕ 내장 DOMPurify 를 거친 SVG 다.
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    );
  }

  return (
    <div className="my-3" data-elanous-mermaid={state.status}>
      {state.status === 'error' && (
        <p className="mb-1 text-xs text-destructive">mermaid 도식을 그리지 못했습니다: {state.message}</p>
      )}
      {state.status === 'loading' && (
        <p className="mb-1 text-xs text-muted-foreground">mermaid 도식을 그리는 중…</p>
      )}
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 text-xs">
        <code className="language-mermaid font-mono">{source}</code>
      </pre>
    </div>
  );
}
