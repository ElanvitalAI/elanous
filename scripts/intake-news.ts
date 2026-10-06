import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { judge } from '../src/llm/judge-layer.js';
import { effectiveInstanceRoot } from '../src/instance/resolve.js';
import { canonicalUrl } from '../src/intake-plane/items.js';

export interface NewsSource { name: string; rss: string }
export interface NewsArticle { title: string; description: string; url: string; published: string }
export interface NewsCheck { items: { fact: string; line: string; verdict: string; current: string }[] }
export interface NewsDeps {
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  check?: (facts: readonly string[]) => Promise<NewsCheck>;
  classify?: (article: NewsArticle) => Promise<boolean>;
  log?: (message: string) => void;
}

const AXES = /하니스|harness|에이전트|agent|코딩\s*(?:에이전트|agent)|coding\s*agent|로컬\s*(?:llm|언어모델)|local\s*llm|기업.{0,12}ai\s*도입|enterprise\s*ai|ai\s*투자|인공지능\s*투자|ai\s*investment/i;
const AMBIGUOUS = /\bAI\b|인공지능|생성형|\bLLM\b/i;
const entity = (text: string): string => text.replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp|lsquo|rsquo|ldquo|rdquo|middot|hellip|ndash|mdash);/gi, (match, numeric: string | undefined, named: string | undefined) => {
  if (numeric) {
    const code = numeric[0]?.toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', hellip: '…', ndash: '–', mdash: '—' } as Record<string, string>)[named?.toLowerCase() ?? ''] ?? match;
});
const plain = (text: string): string => entity(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const field = (xml: string, tag: string): string => plain(xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] ?? '');

/** RSS 2.0 items, including CDATA, escaped HTML and pubDate. */
export function parseNewsRss(xml: string): NewsArticle[] {
  if (!/<rss\b|<rdf:RDF\b/i.test(xml)) throw new Error('RSS 응답이 아님');
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].flatMap((match) => {
    const item = match[1] ?? '';
    const url = field(item, 'link');
    const published = field(item, 'pubDate');
    return /^https?:\/\//i.test(url) && Number.isFinite(Date.parse(published))
      ? [{ title: field(item, 'title'), description: field(item, 'description'), url, published }]
      : [];
  });
}

export function newsInterest(article: NewsArticle): 'yes' | 'no' | 'ambiguous' {
  const text = `${article.title} ${article.description}`;
  if (AXES.test(text)) return 'yes';
  return AMBIGUOUS.test(text) ? 'ambiguous' : 'no';
}

async function classifyAmbiguous(article: NewsArticle): Promise<boolean> {
  const decision = await judge({
    site: 'intake.news.interest',
    prompt: `제목·요약만 보고 하니스·에이전트·코딩 에이전트·로컬 LLM·기업 AI 도입·AI 투자 관련 기사인지 판정한다. JSON {"relevant":true|false} 만 답하라.\n제목: ${article.title}\n요약: ${article.description}`,
    schema: (value) => value && typeof value === 'object' && typeof (value as { relevant?: unknown }).relevant === 'boolean'
      ? (value as { relevant: boolean }).relevant : null,
  });
  if (!decision.ok) throw new Error('관심 축 판정 실패');
  return decision.value;
}

/** The CLI, not a local imitation of the checker, is the implication authority. No --author or release mutation. */
async function checkWithCli(facts: readonly string[]): Promise<NewsCheck> {
  const result = spawnSync('bun', ['bin/elanous.mjs', '--test', 'intake', 'check', ...facts.flatMap((fact) => ['--fact', fact]), '--json'], {
    cwd: resolve(import.meta.dir, '..'), encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr?.trim() ?? `intake check exited ${result.status}`);
  // Standalone notifications may precede JSON on stdout.
  const start = result.stdout.indexOf('{');
  if (start < 0) throw new Error('intake check JSON 없음');
  const parsed = JSON.parse(result.stdout.slice(start)) as NewsCheck;
  if (!Array.isArray(parsed.items)) throw new Error('intake check items 없음');
  return parsed;
}

function summarize(html: string): string[] {
  const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const paragraphs = [...body.matchAll(/<(?:p|h[1-4])\b[^>]*>([\s\S]*?)<\/(?:p|h[1-4])>/gi)]
    .map((match) => plain(match[1] ?? '')).filter((text) => text.length >= 25 && !/무단전재|저작권|기자\s*=/.test(text));
  if (!paragraphs.length) throw new Error('본문을 읽지 못함');
  const text = paragraphs.join(' ');
  const sentences = text.split(/(?<=[.!?。])\s+/).map((s) => s.trim()).filter(Boolean);
  // 앞 문장 요약(최대 다섯 줄) — 짧은 기사는 있는 문장만 남긴다. 낱말을 잘라 줄 수를 채우지 않는다(사실을 지어내지 않는다).
  return sentences.slice(0, 5).map((sentence) => sentence.slice(0, 240));
}

export async function runIntakeNews(options: { root: string; sources: readonly NewsSource[]; deps?: NewsDeps }): Promise<{ written: number; failed: number }> {
  const { root, sources, deps = {} } = options;
  const request = deps.fetch ?? fetch;
  const log = deps.log ?? ((message: string) => console.error(message));
  const now = (deps.now ?? (() => new Date()))();
  const day = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const state = join(root, 'intake', 'news-seen.jsonl');
  const lens = join(root, 'intake', 'outbox', 'lens', `${day}.jsonl`);
  const seen = new Set(existsSync(state) ? readFileSync(state, 'utf8').split('\n').filter(Boolean) : []);
  // 렌즈에 이미 쓴 기사도 «본 것» — 렌즈 기록과 상태 기록 사이에서 죽어도 재실행이 같은 기사를 다시 쓰지 않는다(24h 창이라 어제·오늘 파일).
  const yesterday = new Date(now.getTime() + 9 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
  for (const lensDay of [yesterday, day]) {
    const file = join(root, 'intake', 'outbox', 'lens', `${lensDay}.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      try { const id = (JSON.parse(line) as { id?: unknown }).id; if (typeof id === 'string') seen.add(id); } catch { /* 깨진 줄은 건너뛴다 */ }
    }
  }
  let written = 0;
  let failed = 0;
  for (const source of sources) {
    try {
      const response = await request(source.rss, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      for (const article of parseNewsRss(await response.text())) {
        const published = Date.parse(article.published);
        if (published > now.getTime() || published < now.getTime() - 86_400_000) continue;
        const id = createHash('sha256').update(canonicalUrl(article.url) ?? article.url).digest('hex').slice(0, 16);
        if (seen.has(id)) continue;
        const interest = newsInterest(article);
        if (interest === 'no') continue;
        try {
          if (interest === 'ambiguous' && !(await (deps.classify ?? classifyAmbiguous)(article))) continue;
          const page = await request(article.url, { signal: AbortSignal.timeout(30_000) });
          if (!page.ok) throw new Error(`본문 HTTP ${page.status}`);
          const summary = summarize(await page.text());
          const name = article.title.match(/\b[A-Z][A-Z0-9]{2,}\b/)?.[0] ?? article.title;
          // 함의는 기사 하나에서 셋까지 — 제목 ⊕ 요약 앞 두 문장을 각각 «엘라누스가 이걸 하나»로 대조한다(판정선: 함의 3).
          const facts = [
            `elanous는 \`${name}\` 관련 ${article.title} 기능을 지원한다`,
            ...summary.slice(0, 2).map((line) => `elanous는 다음 일을 한다: ${line.slice(0, 160)}`),
          ];
          const check = await (deps.check ?? checkWithCli)(facts);
          if (!check.items.length) throw new Error('intake check 항목 없음');
          // «판단 필요» is a review suggestion, not an asserted absence; keep the check verdict attached.
          const suggestions = check.items.filter((item) => item.verdict === '없음' || item.verdict === '판단 필요')
            .map((item) => ({ kind: '칸 제안', fact: item.fact, status: '제안', verdict: item.verdict }));
          const verdict = suggestions.length ? '보강'
            : check.items.every((item) => item.verdict === '있음') ? '참고' : '경쟁 대조';
          const record = {
            id, at: now.toISOString(), source: source.name, url: article.url, title: article.title,
            summary, implication: check.items.map((item) => item.line), suggestions,
            lensVerdict: verdict, why: `엘라누스 대조: ${check.items.map((item) => item.line).join(' · ')}`.slice(0, 500), target: name,
          };
          mkdirSync(dirname(lens), { recursive: true });
          appendFileSync(lens, `${JSON.stringify(record)}\n`);
          mkdirSync(dirname(state), { recursive: true });
          appendFileSync(state, `${id}\n`);
          seen.add(id);
          written++;
        } catch (error) {
          failed++;
          log(`못 모음: ${article.url} — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      failed++;
      log(`못 모음: ${source.name} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { written, failed };
}

if (import.meta.main) {
  const config = parseYaml(readFileSync(resolve(import.meta.dir, '../graphs/intake/news-sources.yaml'), 'utf8')) as { sources?: NewsSource[] };
  if (!Array.isArray(config.sources) || !config.sources.every((source) => source && typeof source.name === 'string' && source.name.trim() && typeof source.rss === 'string' && /^https?:\/\//.test(source.rss))) {
    throw new Error('news-sources.yaml: sources 배열 필요');
  }
  const result = await runIntakeNews({ root: effectiveInstanceRoot(), sources: config.sources });
  console.log(`intake-news: ${result.written}건 · 못 모음 ${result.failed}건`);
  if (result.failed) process.exitCode = 1;
}
