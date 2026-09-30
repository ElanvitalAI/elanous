#!/usr/bin/env bun
/**
 * docs/site/dist/ — 공개 문서 정적 사이트 빌더.
 *
 * ⛔ 은퇴 (2026-09-26): 공개 매뉴얼은 website/(Docusaurus) → GitHub Pages 다. Vercel 프로젝트는
 *    docs/site/redirect/ 넘김 쪽만 싣는다 — 이 산출을 다시 배포하면 넘김이 덮인다.
 *    트랙 표식 검사(coord-tracks.json)만 website/scripts/sync-docs.mjs 와 같은 규칙으로 남는다.
 *
 * ⛔ 이 스크립트는 «공개» 산출을 만든다. 그래서 두 가지를 fail-closed 로 막는다:
 *   ① 내부 트랙 표식(🅢🅣🅕 · [S][T][F]) 이 한 글자라도 남으면 rc=1 — 공진화 규칙 ④.
 *   ② 사이트에 «없는» 문서로 가는 링크는 링크를 벗기고 «몇 건인지 센다».
 *
 * 📏 돌리는 법:  bun scripts/build-docs-site.ts [--out <dir>]
 * 📏 배포:       vercel deploy --prod docs/site/dist
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// ① 실을 것 — 공개해도 되는 문서만. PRFAQ·RFC·ROADMAP 은 «내부 워킹백워드 산출»이라 뺐다.
// ─────────────────────────────────────────────────────────────────────────────
export type Page = {
  /** 출력 파일명 */ slug: string;
  /** 원본 markdown 경로 (repo 기준) */ source: string;
  /** 좌측 레일에 뜨는 이름 */ nav: string;
  /** 한 줄 설명 — index 카드에 쓴다 */ blurb: string;
  /** 레일 그룹 */ group: string;
};

export const PAGES: Page[] = [
  { slug: 'getting-started', source: 'docs/site/getting-started.md', nav: '시작하기',
    blurb: '빈 기계에서 첫 한 줄까지 — 설치·자격·첫 발사.', group: '쓰기' },
  { slug: 'cli-reference', source: 'docs/site/cli-reference.md', nav: 'CLI 레퍼런스',
    blurb: '`--help` 에서 «생성»된다 — 손으로 적은 수가 없다.', group: '쓰기' },
  { slug: 'architecture', source: 'docs/architecture.md', nav: '아키텍처',
    blurb: '한 문장이 병합된 변경이 되기까지 — 칸마다 「재는 명령」이 붙어 있다.', group: '알기' },
  { slug: 'graph-terms', source: 'docs/manual/MANUAL-graph-term-disambiguation-2026-09-22.md', nav: '「그래프」 세 세대',
    blurb: '같은 낱말이 «셋»을 덮는다 — 어느 것을 말하는지 가르는 표.', group: '알기' },
  { slug: 'faq', source: 'docs/FAQ.md', nav: 'FAQ',
    blurb: '답마다 「재는 명령」이 붙는다 — 수를 인용하지 말고 다시 재라.', group: '알기' },
];

// ─────────────────────────────────────────────────────────────────────────────
// ② 트랙 표식 제거 — «문장을 다시 써서» 지운다(지우고 남은 부스러기를 두지 않는다)
// ─────────────────────────────────────────────────────────────────────────────
export const TRACK_SCRUBS: { pattern: RegExp; replace: string; why: string }[] = [
  { pattern: /^---\r?\n[\s\S]*?\r?\n---\r?\n/, replace: '', why: 'YAML frontmatter (owner: "[S]" 포함)' },
  { pattern: /\(🅢🅣🅕\)/g, replace: '(내부 트랙 표식)', why: '표식 목록을 뜻만 남기고 바꾼다' },
  { pattern: /\s*·\s*🅢\)/g, replace: ')', why: '괄호 안 소유 표식' },
  { pattern: /\s*\(🅢\)\s*$/gm, replace: '', why: '줄 끝 소유 표식' },
  { pattern: /🅢 가 /g, replace: '한 트랙이 ', why: '주어 자리의 표식' },
  { pattern: /^(>\s*)[🅢🅣🅕]\s*·\s*/gmu, replace: '$1', why: '머리말 서명' },
];

/** 잔여 표식 — 하나라도 남으면 rc=1 */
const TRACK_REGISTRY = JSON.parse(
  readFileSync(join(import.meta.dir, 'coord-tracks.json'), 'utf8'),
) as { tracks: { id: string; mark: string; alias?: string }[] };
const TRACK_MARKS = TRACK_REGISTRY.tracks.map((t) => t.mark).join('');
/** 2글자 신원(OP·MK·TC·UX) ⊕ 옛 한 글자 별칭(S·T·O·F) — 둘 다 공개 문서에 남으면 안 된다. */
const TRACK_NAMES = [...new Set(TRACK_REGISTRY.tracks.flatMap((t) => [t.id, t.alias ?? '']).filter(Boolean))].join('|');
/** 잔여 표식 — 트랙 정본(`coord-tracks.json`)에서 파생한다. 트랙을 더해도 여기는 고치지 않는다. */
export const TRACK_RESIDUE = new RegExp(`[${TRACK_MARKS}]|(?<![\\w\\]])\\[(?:${TRACK_NAMES})\\](?!\\()`, 'gu');

export function scrubTrackMarks(md: string): { text: string; applied: string[] } {
  let text = md;
  const applied: string[] = [];
  for (const { pattern, replace, why } of TRACK_SCRUBS) {
    const before = text;
    text = text.replace(pattern, replace);
    if (text !== before) applied.push(why);
  }
  return { text, applied };
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 트리 걷기 — 의존성을 늘리지 않으려고 손으로 쓴다(unist-util-visit 은 «전이» 의존이다)
// ─────────────────────────────────────────────────────────────────────────────
type AnyNode = { type: string; tagName?: string; properties?: Record<string, unknown>;
                 value?: string; children?: AnyNode[]; [k: string]: unknown };

export function walk(node: AnyNode, fn: (n: AnyNode) => void): void {
  fn(node);
  for (const child of node.children ?? []) walk(child, fn);
}

export function textOf(node: AnyNode): string {
  let out = '';
  walk(node, (n) => { if (n.type === 'text' && typeof n.value === 'string') out += n.value; });
  return out;
}

/** 제목 → 앵커 id. 한글을 살린다(github-slugger 를 안 쓰는 이유). */
export function slugify(text: string): string {
  return text.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '') || 'section';
}

export type Heading = { depth: number; text: string; id: string };

// ─────────────────────────────────────────────────────────────────────────────
// ④ 렌더
// ─────────────────────────────────────────────────────────────────────────────
export type RenderResult = { html: string; headings: Heading[]; unlinked: string[] };

export function renderMarkdown(md: string, knownTargets: Map<string, string>): RenderResult {
  const headings: Heading[] = [];
  const unlinked: string[] = [];
  const seen = new Map<string, number>();

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(() => (tree: AnyNode) => {
      walk(tree, (n) => {
        if (n.type !== 'element') return;
        // 제목에 앵커를 심고 목차를 모은다
        if (/^h[1-6]$/.test(n.tagName ?? '')) {
          const depth = Number((n.tagName ?? 'h1').slice(1));
          const text = textOf(n);
          let id = slugify(text);
          const n0 = seen.get(id) ?? 0;
          seen.set(id, n0 + 1);
          if (n0 > 0) id = `${id}-${n0}`;
          n.properties = { ...(n.properties ?? {}), id };
          if (depth === 2) headings.push({ depth, text, id });
        }
        // 링크: 사이트 안이면 .html 로, 밖이면 링크를 «벗긴다»
        if (n.tagName === 'a') {
          const href = String((n.properties as { href?: string })?.href ?? '');
          if (!href || /^(https?:|mailto:|#)/.test(href)) return;
          // ⚠️ remark 는 비 ASCII href 를 퍼센트 인코딩한다 — 풀지 않으면 한글 파일명이 «영영» 안 맞는다
          let path = href.replace(/^\.\//, '').split('#')[0];
          try { path = decodeURIComponent(path); } catch { /* 깨진 인코딩은 원문 그대로 본다 */ }
          const target = knownTargets.get(path);
          if (target) {
            const hash = href.includes('#') ? `#${href.split('#')[1]}` : '';
            n.properties = { ...(n.properties ?? {}), href: `${target}.html${hash}` };
          } else {
            unlinked.push(path);
            n.tagName = 'span';
            n.properties = { className: ['unpublished'], title: `이 사이트에 없는 문서: ${href}` };
          }
        }
      });
    })
    .use(rehypeStringify);

  return { html: String(processor.processSync(md)), headings, unlinked };
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 껍데기
// ─────────────────────────────────────────────────────────────────────────────
const STYLE = `
:root{
  --paper:#F6F7F9; --surface:#FFFFFF; --ink:#13171D; --muted:#5C6672;
  --accent:#0E7C6B; --accent-soft:#E4F0ED; --signal:#B03A0B; --signal-soft:#FBEDE6;
  --line:#DDE2E8; --line-soft:#EBEEF2; --code-bg:#F1F3F6; --rail:#FAFBFC;
  --serif:"IBM Plex Serif","Iowan Old Style",Georgia,serif;
  --sans:"IBM Plex Sans KR","IBM Plex Sans","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif;
  --mono:"IBM Plex Mono","SFMono-Regular",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){
  --paper:#0E1114; --surface:#151A1F; --ink:#E4E9EF; --muted:#8B96A3;
  --accent:#43BFA7; --accent-soft:#12302B; --signal:#E4834F; --signal-soft:#331C11;
  --line:#242B33; --line-soft:#1C2228; --code-bg:#11161A; --rail:#11151A;
}}
:root[data-theme="dark"]{
  --paper:#0E1114; --surface:#151A1F; --ink:#E4E9EF; --muted:#8B96A3;
  --accent:#43BFA7; --accent-soft:#12302B; --signal:#E4834F; --signal-soft:#331C11;
  --line:#242B33; --line-soft:#1C2228; --code-bg:#11161A; --rail:#11151A;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);
  font-size:15.5px;line-height:1.75;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}

/* ── 틀 ── */
.shell{display:grid;grid-template-columns:230px minmax(0,1fr);gap:0;max-width:1120px;margin:0 auto;
  padding-inline:16px}
.rail{position:sticky;top:env(safe-area-inset-top,0px);align-self:start;max-height:100vh;overflow-y:auto;
  padding-block:34px 40px;padding-inline-end:26px;border-inline-end:1px solid var(--line-soft)}
.main{min-width:0;padding-block:34px 96px;padding-inline-start:38px}
@media (max-width:820px){
  .shell{grid-template-columns:minmax(0,1fr)}
  .rail{position:static;max-height:none;border-inline-end:0;border-block-end:1px solid var(--line-soft);
    padding-inline-end:0;padding-block:24px}
  .main{padding-inline-start:0;padding-block-start:26px}
}

/* ── 레일 ── */
.wordmark{font-family:var(--mono);font-size:19px;font-weight:600;letter-spacing:-.02em;
  color:var(--ink);text-decoration:none;display:block}
.wordmark .dot{color:var(--accent)}
.tagline{font-size:12.5px;color:var(--muted);line-height:1.5;margin:8px 0 26px}
.rail h4{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--muted);margin:22px 0 8px;font-weight:500}
.rail ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
.rail li a{display:block;padding:5px 9px;margin-inline-start:-9px;border-radius:5px;
  font-size:14px;color:var(--ink);text-decoration:none}
.rail li a:hover{background:var(--line-soft)}
.rail li a[aria-current="page"]{background:var(--accent-soft);color:var(--accent);font-weight:600}
.toc{margin-top:26px;padding-top:20px;border-top:1px solid var(--line-soft)}
.toc ul{gap:0}
.toc a{font-size:12.8px;color:var(--muted);padding:3px 0;display:block;text-decoration:none;
  line-height:1.45}
.toc a:hover{color:var(--accent)}
.toc .d3{padding-inline-start:13px;font-size:12.2px}

/* ── 본문 ── */
.main h1{font-family:var(--serif);font-size:clamp(29px,4.4vw,40px);line-height:1.18;font-weight:600;
  letter-spacing:-.018em;margin:0 0 22px;text-wrap:balance}
.main h2{font-family:var(--serif);font-size:24px;font-weight:600;line-height:1.3;margin:52px 0 14px;
  padding-top:22px;border-top:1px solid var(--line-soft);text-wrap:balance}
.main h2:first-of-type{border-top:0;padding-top:0;margin-top:34px}
/* 원본이 「---」 로 이미 칸을 갈랐으면 h2 는 제 줄을 다시 긋지 않는다 */
hr + h2{border-top:0!important;padding-top:0!important;margin-top:30px!important}
.main h3{font-size:16.5px;font-weight:650;margin:32px 0 10px;letter-spacing:-.005em}
.main h4{font-family:var(--mono);font-size:12px;letter-spacing:.09em;text-transform:uppercase;
  color:var(--muted);margin:26px 0 8px;font-weight:500}
.main p{margin:0 0 15px;max-width:66ch}
.main ul,.main ol{max-width:66ch;padding-inline-start:22px;margin:0 0 15px}
.main li{margin-bottom:5px}
.main li::marker{color:var(--muted)}
.main strong{font-weight:650}
hr{border:0;border-top:1px solid var(--line-soft);margin:40px 0}

/* ── 인용: 이 저장소는 머리말에 «규율»을 적는다. 그래서 인용을 「계기판 쪽지」로 그린다 ── */
blockquote{margin:0 0 22px;padding:14px 18px;background:var(--surface);
  border:1px solid var(--line);border-inline-start:3px solid var(--accent);border-radius:0 6px 6px 0;
  font-size:14.2px;line-height:1.65}
blockquote p{margin:0 0 8px;max-width:none}
blockquote p:last-child{margin-bottom:0}

/* ── 코드: 여기의 블록은 대부분 «ASCII 도면»이다 — 접지 않고 가로로 민다 ── */
code{font-family:var(--mono);font-size:.885em;background:var(--code-bg);padding:1.5px 5px;
  border-radius:4px;border:1px solid var(--line-soft)}
pre{background:var(--code-bg);border:1px solid var(--line);border-radius:7px;padding:15px 17px;
  overflow-x:auto;margin:0 0 20px;font-size:12.9px;line-height:1.58}
pre code{background:none;border:0;padding:0;font-size:inherit;white-space:pre;display:block}

/* ── 표 ── */
.tablewrap{overflow-x:auto;margin:0 0 22px;border:1px solid var(--line);border-radius:7px}
table{border-collapse:collapse;width:100%;font-size:13.8px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:8px 13px;border-bottom:1px solid var(--line-soft);vertical-align:top}
th{font-family:var(--mono);font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--muted);font-weight:500;background:var(--rail);white-space:nowrap}
tr:last-child td{border-bottom:0}
td code{white-space:nowrap}

/* ── 사이트에 없는 문서로 가던 링크 ── */
.unpublished{border-bottom:1px dotted var(--muted);color:var(--muted);cursor:help}

/* ── index 전용 ── */
.lede{font-family:var(--serif);font-size:clamp(18px,2.4vw,21.5px);line-height:1.55;
  color:var(--ink);max-width:30ch;margin:0 0 8px;text-wrap:balance}
.sub{color:var(--muted);font-size:15px;max-width:62ch;margin:0 0 38px}
.docmap{list-style:none;margin:0 0 44px;padding:0;border:1px solid var(--line);border-radius:8px;
  background:var(--surface);overflow:hidden}
.docmap li + li{border-top:1px solid var(--line-soft)}
.docmap a{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:0 16px;align-items:baseline;
  padding:15px 19px;text-decoration:none;color:inherit}
.docmap a:hover{background:var(--accent-soft)}
.docmap .n{font-family:var(--mono);font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.docmap .t{font-family:var(--serif);font-size:17.5px;font-weight:600;color:var(--ink)}
.docmap .b{grid-column:2;font-size:13.4px;color:var(--muted);line-height:1.55;margin:3px 0 0;
  max-width:54ch}
.docmap .b code{font-size:.9em}
.docmap .g{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;
  color:var(--muted)}
@media (max-width:520px){.docmap .g{display:none}.docmap a{grid-template-columns:30px minmax(0,1fr)}}
.legend{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;align-items:baseline;
  font-size:13.6px;max-width:58ch;margin:0 0 10px}
.legend dt{font-family:var(--mono);font-size:15px;text-align:center}
.legend dd{margin:0;color:var(--muted)}
footer{margin-top:64px;padding-top:20px;border-top:1px solid var(--line-soft);
  font-family:var(--mono);font-size:11.5px;color:var(--muted);line-height:1.8}
`;

export function shell(opts: { title: string; slug: string; body: string; headings: Heading[]; built: string }): string {
  const groups = [...new Set(PAGES.map((p) => p.group))];
  const rail = groups.map((g) => `      <h4>${g}</h4>
      <ul>
${PAGES.filter((p) => p.group === g).map((p) =>
  `        <li><a href="./${p.slug}.html"${p.slug === opts.slug ? ' aria-current="page"' : ''}>${p.nav}</a></li>`).join('\n')}
      </ul>`).join('\n');

  const toc = opts.headings.length
    ? `      <nav class="toc" aria-label="이 문서 안">
        <h4>이 문서 안</h4>
        <ul>
${opts.headings.map((h) => `          <li><a class="d${h.depth}" href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join('\n')}
        </ul>
      </nav>`
    : '';

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(opts.title)} · elanous</title>
<meta name="description" content="말 한 줄에 눈·손·기억이 한꺼번에 도는 자기치유 코딩 하니스.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+KR:wght@400;500;600&family=IBM+Plex+Serif:wght@400;600&display=swap">
<style>${STYLE}</style>
</head>
<body>
<div class="shell">
  <aside class="rail">
    <a class="wordmark" href="./index.html">elanous<span class="dot">.</span></a>
    <p class="tagline">말 한 줄에 눈·손·기억이<br>한꺼번에 도는 자기치유 하니스</p>
    <nav aria-label="문서">
${rail}
    </nav>
${toc}
  </aside>
  <main class="main">
${opts.body}
    <footer>
      생성 ${opts.built} · bun scripts/build-docs-site.ts<br>
      원본은 저장소의 markdown 이다 — 이 페이지는 그것의 «파생»이고, 다시 돌 때만 최신이다.
    </footer>
  </main>
</div>
</body>
</html>
`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 표를 가로 스크롤 상자에 담는다 — 본문이 옆으로 밀리지 않게 */
export function wrapTables(html: string): string {
  return html.replace(/<table>/g, '<div class="tablewrap"><table>').replace(/<\/table>/g, '</table></div>');
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ index
// ─────────────────────────────────────────────────────────────────────────────
export function indexBody(): string {
  const cards = PAGES.map((p, i) => `      <li><a href="./${p.slug}.html">
        <span class="n">${String(i + 1).padStart(2, '0')}</span>
        <span class="t">${p.nav}</span>
        <span class="g">${p.group}</span>
        <p class="b">${p.blurb.replace(/`([^`]+)`/g, '<code>$1</code>')}</p>
      </a></li>`).join('\n');

  return `    <h1>elanous 문서</h1>
    <p class="lede">말 한 줄에 눈·손·기억이 한꺼번에 도는 자기치유 코딩 하니스.</p>
    <p class="sub">목표를 문서로 받아 격리된 워크트리에서 구현하고, 게이트를 돌리고,
    무인 리뷰를 거쳐 병합까지 간다. 사람은 <strong>시스템이 못 할 때만</strong> 불린다.</p>

    <ol class="docmap">
${cards}
    </ol>

    <h2>이 문서들이 지키는 규율</h2>
    <p>elanous 의 문서는 «수»를 자랑하지 않는다. 수는 하루면 늙기 때문이다.
    그래서 칸마다 <strong>그 수를 다시 얻는 명령</strong>을 같이 둔다. 아래 표식이 그 규율의 문법이다.</p>
    <dl class="legend">
      <dt>📏</dt><dd>재는 명령 — 이 줄을 쳐서 그 수를 <em>지금</em> 다시 얻는다.</dd>
      <dt>⛔</dt><dd>안 지키면 «조용히» 깨진다. 실패가 에러로 안 나온다는 뜻이다.</dd>
      <dt>⚠️</dt><dd>읽어라 — 함정이지만 소리는 난다.</dd>
      <dt>🔲</dt><dd><strong>안 쟀다.</strong> 「없다」가 아니다. 빈 칸을 이름으로 남긴 것이다.</dd>
      <dt>⬜</dt><dd>아직 참이 아닌 주장 — 워킹 백워드로 «먼저 쓴» 문장이 여기 걸려 있다.</dd>
    </dl>

    <h2>여기 없는 것</h2>
    <p>워킹 백워드(Amazon) 방식으로 <strong>보도자료·RFC·로드맵을 먼저 썼고</strong>,
    그 셋이 이 문서들의 결손을 드러냈다. 그 세 문서는 내부 산출이라 이 사이트에 싣지 않는다 —
    저장소의 <code>docs/</code> 에 있다.</p>
    <p>이 사이트가 <strong>아직 답하지 못하는 것</strong>도 이름으로 남긴다:
    빈 기계에서 처음부터 끝까지 돌려 본 기록(🔲), 공개 설치 URL(⬜), 컨테이너 이미지(⬜).</p>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑦ 배포 신선도 — 「인터넷에 떠 있는 것이 지금 저장소와 같은 시대인가」
//    ⛔ 이 검사는 «망»을 탄다. 그래서 test:deterministic 에 «안» 넣는다 — --check-deployed 로만.
//    ⚠️ 이 검사가 «못 보는 것»은 그 산출이 스스로 말한다(아래 BLIND 참조).
// ─────────────────────────────────────────────────────────────────────────────
export const DEPLOYED_URL = 'https://elanous-docs-three.vercel.app/';

export const FRESHNESS_BLIND = [
  '커밋 시각으로 잰다 — 아직 커밋 안 한 작업 트리 편집은 «안 보인다»',
  'PAGES 의 원본 ⊕ 빌더만 «입력»으로 센다 — index 문면을 손으로 고치면 빌더가 바뀌므로 잡히지만, 그 밖의 것은 모른다',
  '「최신이다」가 「내용이 맞다」를 뜻하지 않는다 — 시대만 본다',
];

/**
 * 배포본 footer 의 「생성 YYYY-MM-DD HH:MM[:SS] Z」.
 * ⛔ «초»가 없는 옛 배포본이 있다 — 그때는 그 분 안 어디인지 «모른다». 그래서 해상도를 같이 낸다.
 */
export type BuiltAt = { at: number; resolutionMs: number };
export function parseBuiltAt(html: string): BuiltAt | null {
  const m = html.match(/생성\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(:\d{2})?Z/u);
  if (!m) return null;
  const at = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ':00'}Z`);
  if (Number.isNaN(at)) return null;
  return { at, resolutionMs: m[3] ? 1_000 : 60_000 };
}

/** 이 사이트의 «입력» — 실린 원본 ⊕ 빌더 자신(껍데기·문면을 정한다) */
export function freshnessInputs(): string[] {
  return [...PAGES.map((p) => p.source), 'scripts/build-docs-site.ts'];
}

export type Freshness =
  | { verdict: 'fresh' | 'stale' | 'indeterminate'; builtAt: number; newestInput: number;
      newestPath: string; resolutionMs: number }
  | { verdict: 'unreadable'; reason: string };

export function judgeFreshness(built: BuiltAt | null, inputs: { path: string; at: number }[]): Freshness {
  if (built === null) return { verdict: 'unreadable', reason: '배포본에서 「생성 …」 줄을 «못 읽었다»' };
  const dated = inputs.filter((i) => Number.isFinite(i.at));
  // ⛔ 「못 쟀다」를 «0» 으로 접지 않는다 — 0 이면 무엇과 견줘도 「신선」이 나온다
  if (dated.length !== inputs.length) {
    const missing = inputs.filter((i) => !Number.isFinite(i.at)).map((i) => i.path);
    return { verdict: 'unreadable', reason: `입력 ${missing.length}개의 시각을 «못 쟀다»: ${missing.join(', ')}` };
  }
  const newest = dated.reduce((a, b) => (b.at > a.at ? b : a));
  const { at: builtAt, resolutionMs } = built;
  // ⛔ 「모른다」를 «아는 둘 중 하나»로 접지 않는다 — 배포 시각의 해상도 «안»에 답이 들면 못 가른다.
  //    (분까지만 찍던 옛 배포본에서 같은 분 착지가 최대 59초 «거짓 낡음»을 냈다 — 2026-09-22 실측)
  const verdict = builtAt >= newest.at ? 'fresh'
    : builtAt + resolutionMs > newest.at ? 'indeterminate'
    : 'stale';
  return { verdict, builtAt, newestInput: newest.at, newestPath: newest.path, resolutionMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑧ 러너
// ─────────────────────────────────────────────────────────────────────────────
export function buildDocsSite(outDir: string): { written: string[]; scrubbed: number; unlinked: string[] } {
  // ⛔ 디렉토리를 통째로 지우지 않는다 — 여기에 배포 링크(.vercel)가 산다.
  //    지우면 프로젝트 이름이 매번 디렉토리 basename 으로 되돌아간다(실측 2026-09-22).
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.endsWith('.html')) rmSync(join(outDir, f));

  const targets = new Map<string, string>();
  for (const p of PAGES) {
    targets.set(p.source, p.slug);                                  // 내부 문서 `architecture`
    targets.set(p.source.replace(/^docs\//, ''), p.slug);           // architecture.md (docs/ 안에서 본 상대경로)
    targets.set(p.source.split('/').pop()!, p.slug);                // architecture.md
  }

  // ⛔ «초»까지 낸다 — git 커밋 시각이 초 단위라, 분까지만 내면 같은 분 안에서 «거짓 낡음»이 난다
  const built = new Date().toISOString().slice(0, 19).replace('T', ' ') + 'Z';
  const written: string[] = [];
  const allUnlinked: string[] = [];
  let scrubbed = 0;

  for (const page of PAGES) {
    const raw = readFileSync(page.source, 'utf8');
    const { text, applied } = scrubTrackMarks(raw);
    if (applied.length) {
      scrubbed += applied.length;
      console.log(`  🧹 ${page.source}`);
      for (const why of applied) console.log(`       − ${why}`);
    }
    const { html, headings, unlinked } = renderMarkdown(text, targets);
    allUnlinked.push(...unlinked);
    const out = shell({ title: page.nav, slug: page.slug, body: wrapTables(html), headings, built });

    const residue = out.match(TRACK_RESIDUE);
    if (residue) throw new Error(`⛔ ${page.slug}.html 에 트랙 표식이 남았다: ${[...new Set(residue)].join(' ')}`);

    const file = join(outDir, `${page.slug}.html`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, out, 'utf8');
    written.push(file);
  }

  const idx = join(outDir, 'index.html');
  writeFileSync(idx, shell({ title: '문서', slug: 'index', body: indexBody(), headings: [], built }), 'utf8');
  written.push(idx);

  return { written, scrubbed, unlinked: allUnlinked };
}

async function checkDeployedCli(): Promise<number> {
  console.log(`🌐 배포 신선도 — ${DEPLOYED_URL}`);
  let html: string;
  try {
    const res = await fetch(DEPLOYED_URL, { redirect: 'follow' });
    if (!res.ok) { console.log(`⛔ HTTP ${res.status} — 「낡았다」가 아니라 «못 쟀다»`); return 2; }
    html = await res.text();
  } catch (e) {
    console.log(`⛔ 못 받았다 (${e instanceof Error ? e.message : String(e)}) — «못 쟀다»`);
    return 2;
  }
  const inputs = freshnessInputs().map((path) => {
    const r = Bun.spawnSync(['git', 'log', '-1', '--format=%cI', '--', path]);
    const iso = new TextDecoder().decode(r.stdout).trim();
    return { path, at: iso ? Date.parse(iso) : Number.NaN };
  });
  const f = judgeFreshness(parseBuiltAt(html), inputs);
  if (f.verdict === 'unreadable') { console.log(`🔲 ${f.reason}`); return 2; }
  const fmt = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ') + 'Z';
  console.log(`   배포 생성 ${fmt(f.builtAt)}  (해상도 ${f.resolutionMs / 1000}초)`);
  console.log(`   최신 입력 ${fmt(f.newestInput)}  ${f.newestPath}`);
  console.log(
    f.verdict === 'fresh' ? '\n✅ 신선하다 — 배포본이 모든 입력보다 «뒤»다'
    : f.verdict === 'indeterminate'
      ? `\n🔲 «못 가른다» — 차이가 배포 시각의 해상도(${f.resolutionMs / 1000}초) 안이다.\n`
        + '   ⛔ 「낡았다」가 «아니다». 초까지 찍는 판을 한 번 배포하면 갈린다.'
    : '\n⛔ 낡았다 — 다시 지어 배포하라 (docs/site/README.md 의 세 줄)');
  console.log('\n🔲 이 검사가 «못 보는 것»:');
  for (const b of FRESHNESS_BLIND) console.log(`     · ${b}`);
  return f.verdict === 'fresh' ? 0 : f.verdict === 'indeterminate' ? 2 : 1;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes('--check-deployed')) process.exit(await checkDeployedCli());
  const oi = argv.indexOf('--out');
  const outDir = oi >= 0 ? argv[oi + 1] : 'docs/site/dist';
  console.log(`📦 docs → ${outDir}`);
  const { written, scrubbed, unlinked } = buildDocsSite(outDir);
  console.log(`\n✅ ${written.length}쪽 · 트랙 표식 제거 ${scrubbed}건`);
  if (unlinked.length) {
    const uniq = [...new Set(unlinked)];
    console.log(`🔲 사이트에 «없는» 문서로 가던 링크 ${unlinked.length}건(고유 ${uniq.length}) — 링크를 벗겼다:`);
    for (const u of uniq.slice(0, 12)) console.log(`     ${u}`);
    if (uniq.length > 12) console.log(`     … 외 ${uniq.length - 12}`);
  }
  console.log('\n⛔ 이 산출은 「파생」이다 — 원본 markdown 이 바뀌면 다시 돌려야 한다.');
}
