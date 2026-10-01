/**
 * vflow-collect — AI 영상 프롬프트 라이브러리(vflow.live)를 «참조 자료»로 수집한다.
 *
 * ⛔⭐ 왜 브라우저가 아니라 HTTP 인가 — 2026-09-23 실측
 *   `aside repl`(Playwright)로 «스키마를 찾았고», 수집은 `fetch` 로 한다.
 *   ⑴ 페이지가 «정적»이고 데이터가 전부 JSON-LD 에 있다(DOM 을 읽을 필요가 없다)
 *   ⑵ 브라우저 REPL 은 호출당 120초 제한이고 디스크에 못 쓴다 — 9,796장에 맞는 도구가 아니다
 *   ⇒ 🔑 ***도구를 「썼던 것」이 아니라 「그 일에 맞는 것」으로 고른다.***
 *
 * ⛔⭐ 예의 — 이 사이트는 robots.txt 에 스스로 이렇게 적었다:
 *   *"This file is a DECLARATION, not a defence. It cannot stop bulk scraping."*
 *   `Allow: /` 이므로 «허용»돼 있지만, 그렇다고 마음껏 두드릴 이유는 아니다.
 *   ⇒ 동시 4 · 요청 사이 간격 · 재개 가능(이미 받은 것은 «안» 다시 받는다).
 *
 * ⛔ 산출은 저장소 «밖»이다 — `~/docs/ref/vflow/`(약 30MB). 저장소에는 «증류된 분류축»만 넣는다.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const OUT_DIR = process.env.VFLOW_OUT ?? join(homedir(), 'docs', 'ref', 'vflow');
const NDJSON = join(OUT_DIR, 'prompts.ndjson');
const URLS = join(OUT_DIR, 'urls.txt');
// ⚠️ 2026-10-01 실측: 4병렬·120ms 로 전수를 돌리면 수백 건 뒤 사이트가 429 를 낸다(재수집 404건 중 158건).
// 기본을 낮추고, 429 는 «없다»가 아니라 «기다려라»로 읽는다(Retry-After 를 따른다).
const CONCURRENCY = Number(process.env.VFLOW_CONCURRENCY ?? 2);
const GAP_MS = Number(process.env.VFLOW_GAP_MS ?? 400);
const MAX_429_RETRIES = 5;

const argv = process.argv.slice(2);
const limitAt = argv.indexOf('--limit');
const LIMIT = limitAt >= 0 ? Number(argv[limitAt + 1]) : Infinity;

let throttled = 0;
async function get(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.status === 429 && attempt < MAX_429_RETRIES) {
      throttled++;
      const after = Number(r.headers.get('retry-after'));
      const waitMs = Number.isFinite(after) && after > 0 ? after * 1000 : 5000 * 2 ** attempt;
      await new Promise((res) => setTimeout(res, waitMs));
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  }
}

/** 사이트맵 전수 → 영문 `/prompts/` URL. ⛔ 번역판(`/{lang}/prompts/`)은 «같은 내용»이라 뺀다. */
async function collectUrls(): Promise<string[]> {
  if (existsSync(URLS)) {
    const cached = readFileSync(URLS, 'utf8').split('\n').filter(Boolean);
    console.log(`  URL 목록: 캐시 ${cached.length}개 (다시 받으려면 ${URLS} 를 지운다)`);
    return cached;
  }
  const idx = await get('https://vflow.live/sitemap.xml');
  const maps = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
  console.log(`  사이트맵 ${maps.length}장 — 전수를 돈다`);
  const urls: string[] = [];
  for (const m of maps) {
    try {
      const locs = [...(await get(m)).matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1]!);
      for (const l of locs) {
        const seg = new URL(l).pathname.split('/').filter(Boolean);
        if (seg[0] === 'prompts' && seg.length >= 4) urls.push(l);   // 모델/카테고리/슬러그
      }
    } catch (e) { console.log(`  ⚠️ 사이트맵 «못 읽었다» — ${m}: ${(e as Error).message}`); }
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(URLS, urls.join('\n'));
  return urls;
}

interface Row {
  url: string; model: string; category: string; slug: string;
  name: string; description: string; prompt: string;
  /** ⚠️ 축 라벨이 «없는» 납작한 배열이다 — 축이 필요하면 아래 `spec` 을 쓴다. */
  keywords: string[]; datePublished: string | null;
  author: string | null; authorUrl: string | null;
  sourcePost: string | null; thumb: string | null;
  /**
   * ⭐⭐ 페이지의 «Spec sheet» — ***사이트가 축을 «이미 갈라» 둔다.***
   * 🩸 초판은 이것을 안 읽고 `keywords` 만 받아 ***카메라·조명·무드를 한 배열로 뭉갰다.***
   *   그래서 「tracking 이 카메라인가 무드인가」를 «내가 추측»해야 했다 — 추측하면 반증할 자가 없다.
   */
  spec: {
    duration: string | null; camera: string[]; lighting: string[]; mood: string[];
    difficulty: string | null; promptLanguage: string | null; includes: string[];
  };
  /** ⭐ VideoObject — 실제 클립 URL ⊕ ISO 길이 ⊕ 경로에 박힌 해상도(aspect 를 여기서 얻는다). */
  video: { url: string | null; isoDuration: string | null; resolution: string | null; aspect: string | null };
}

/** `.../vid/avc1/1280x720/x.mp4` 의 `1280x720` → `16:9`. ⛔ 못 읽으면 null — 「없다」가 아니다. */
function aspectOf(res: string | null): string | null {
  if (!res) return null;
  const [w, h] = res.split('x').map(Number);
  if (!w || !h) return null;
  const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
  const d = g(w, h);
  return `${w / d}:${h / d}`;
}

/** Spec sheet 표 한 장을 축별로 가른다. ⛔ 행이 없으면 «빈 배열»이 아니라 그 축이 «없는» 것으로 둔다. */
function parseSpec(html: string): Row['spec'] {
  const at = html.indexOf('Spec sheet');
  const seg = at >= 0 ? html.slice(at, at + 3000) : '';
  const rows = [...seg.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!);
  const by = new Map<string, string>();
  for (const r of rows) {
    const cells = [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map((m) => m[1]!.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (cells.length >= 2) by.set(cells[0]!.toLowerCase(), cells[1]!);
  }
  const split = (k: string): string[] =>
    (by.get(k) ?? '').split(/[·,]/).map((x) => x.trim()).filter(Boolean);
  return {
    duration: by.get('duration') ?? null,
    camera: split('camera'), lighting: split('lighting'), mood: split('mood'),
    difficulty: by.get('difficulty') ?? null,
    promptLanguage: by.get('prompt language') ?? null,
    includes: split('includes'),
  };
}

/** ⛔ 한 장에서 «값»을 뽑는다. 못 뽑으면 null 을 돌려 «건너뛴 이유»를 세게 한다. */
function extract(url: string, html: string): Row | null {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  for (const b of blocks) {
    let j: unknown;
    try { j = JSON.parse(b); } catch { continue; }
    const graph = (j as { '@graph'?: unknown[] })['@graph'] ?? [j];
    const cw = (graph as Record<string, unknown>[]).find((n) => n['@type'] === 'CreativeWork');
    if (!cw) continue;
    const seg = new URL(url).pathname.split('/').filter(Boolean);
    const author = cw.author as { name?: string; url?: string } | undefined;
    // ⭐ VideoObject 는 «같은 @graph» 안에 있다 — CreativeWork 만 읽으면 길이·해상도·클립 URL 을 통째로 잃는다.
    const vo = (graph as Record<string, unknown>[]).find((n) => n['@type'] === 'VideoObject') ?? {};
    const contentUrl = (vo.contentUrl as string) ?? null;
    const resolution = contentUrl ? (contentUrl.match(/\/(\d{3,4}x\d{3,4})\//)?.[1] ?? null) : null;
    return {
      spec: parseSpec(html),
      video: { url: contentUrl, isoDuration: (vo.duration as string) ?? null, resolution, aspect: aspectOf(resolution) },
      url, model: seg[1] ?? '', category: seg[2] ?? '', slug: seg[3] ?? '',
      name: String(cw.name ?? ''), description: String(cw.description ?? ''),
      prompt: String(cw.text ?? ''),
      keywords: String(cw.keywords ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      datePublished: (cw.datePublished as string) ?? null,
      author: author?.name ?? null, authorUrl: author?.url ?? null,
      sourcePost: (cw.isBasedOn as string) ?? null,
      thumb: (cw.image as string) ?? null,
    };
  }
  return null;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const urls = await collectUrls();
  // ⛔ 재개 — 이미 받은 것은 «안» 다시 받는다(사이트에도 나에게도 싸다).
  const done = new Set<string>();
  if (existsSync(NDJSON)) {
    for (const line of readFileSync(NDJSON, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { done.add((JSON.parse(line) as Row).url); } catch { /* 깨진 줄은 «무시»하고 다시 받는다 */ }
    }
  }
  const todo = urls.filter((u) => !done.has(u)).slice(0, LIMIT === Infinity ? undefined : LIMIT);
  console.log(`  전체 ${urls.length} · 이미 받음 ${done.size} · 이번에 받을 것 ${todo.length}`);

  let ok = 0, noLd = 0, failed = 0;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY);
    const rows = await Promise.all(batch.map(async (u, k) => {
      await new Promise((r) => setTimeout(r, k * GAP_MS));
      try { return extract(u, await get(u)); }
      catch { failed++; return null; }                  // ⛔ 「없다」가 아니라 «못 받았다»
    }));
    for (const r of rows) { if (r) { appendFileSync(NDJSON, JSON.stringify(r) + '\n'); ok++; } else noLd++; }
    if ((i / CONCURRENCY) % 25 === 0) console.log(`  … ${ok + noLd}/${todo.length}  ok=${ok} 못받음=${failed} jsonld없음=${noLd - failed} 429대기=${throttled}`);
  }
  // ⛔ 수를 «도구가» 낸다 — 사람이 세지 않는다.
  writeFileSync(join(OUT_DIR, 'MANIFEST.txt'),
    [`source: https://vflow.live (robots: Allow: / · 2026-09-23 확인)`,
     `fetched: ${new Date().toISOString()}`,
     `urls_total: ${urls.length}`, `rows_ok: ${ok + done.size}`,
     `skipped_no_jsonld: ${noLd - failed}`, `failed_fetch: ${failed}`, `throttled_429_retries: ${throttled}`,
     `schema: url model category slug name description prompt keywords[] datePublished author authorUrl sourcePost thumb spec{duration,camera[],lighting[],mood[],difficulty,promptLanguage,includes[]} video{url,isoDuration,resolution,aspect}`,
     `refetch: bun scripts/vflow-collect.ts`, ''].join('\n'));
  console.log(`\n  ✅ ok ${ok} · 건너뜀 ${noLd - failed} · 못 받음 ${failed}  →  ${NDJSON}`);
}

await main();
