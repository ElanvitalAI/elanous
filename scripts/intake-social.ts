import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { effectiveInstanceRoot } from '../src/instance/resolve.js';
import { canonicalUrl } from '../src/intake-plane/items.js';

export interface CommunityPoint { title: string; url: string; text: string }
export interface SocialCheck { items: { fact: string; line: string; verdict: string; current: string }[] }
export interface SocialDeps {
  now?: () => Date;
  crawl?: () => Promise<CommunityPoint[]>;
  check?: (facts: readonly string[]) => Promise<SocialCheck>;
  log?: (message: string) => void;
}

const QUERY = '최근 24시간 AI 코딩 에이전트·하니스·로컬 LLM 커뮤니티(X·Reddit) 화제와 반응';
const MAX_POINTS = 8;
// URL 을 뺀 뒤 남는 서술의 최소 길이 — «링크만 있는 줄» 같은 레이블은 내용 없는 동향이라 흡수하지 않는다.
const MIN_TREND_TEXT_LENGTH = 12;
const OMNI_JSON_BEGIN = '---BEGIN_OMNI_CRAWL_JSON---';
const OMNI_JSON_END = '---END_OMNI_CRAWL_JSON---';

/** grok-community rawText(마크다운 보고서)에서 불릿/번호 줄만 뽑아 링크 있는 동향 점으로 만든다. */
export function parseCommunityReport(rawText: string): CommunityPoint[] {
  const points: CommunityPoint[] = [];
  for (const rawLine of rawText.split('\n')) {
    const line = rawLine.trim();
    if (!/^(?:[-*•·]|\d{1,2}[.)])\s+/.test(line)) continue;
    const url = line.match(/https?:\/\/[^\s)\]]+/)?.[0];
    if (!url) continue;
    const text = line
      .replace(/^(?:[-*•·]|\d{1,2}[.)])\s+/, '')
      .replace(/\[([^\]]*)\]\(https?:\/\/[^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length < MIN_TREND_TEXT_LENGTH) continue;
    points.push({ title: text.slice(0, 120), url, text });
  }
  return points;
}

/** omni-crawl `--json` 페이로드(results[].items ⊕ results[].summary)에서 커뮤니티 동향 점을 합친다. URL 로 중복을 뺀다. */
export function parseOmniCrawlPayload(payload: { results?: { items?: { url?: unknown; title?: unknown; text?: unknown }[]; summary?: unknown }[] }): CommunityPoint[] {
  const points: CommunityPoint[] = [];
  const urls = new Set<string>();
  for (const result of payload.results ?? []) {
    const fromItems = (result.items ?? []).flatMap((item) => {
      const url = typeof item.url === 'string' && /^https?:\/\//.test(item.url) ? item.url : '';
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      return url && (title || text) ? [{ title: (title || text).slice(0, 120), url, text: text || title }] : [];
    });
    const fromSummary = parseCommunityReport(typeof result.summary === 'string' ? result.summary : '');
    for (const point of [...fromItems, ...fromSummary]) {
      const key = canonicalUrl(point.url) ?? point.url;
      if (urls.has(key)) continue;
      urls.add(key);
      points.push(point);
    }
  }
  return points;
}

/** omni-crawl 스킬의 grok-community 엔진을 실제로 돌린다(스킬 .env 를 엔진이 알아서 적재한다). */
async function crawlWithOmniCrawl(): Promise<CommunityPoint[]> {
  const dir = process.env.OMNI_CRAWL_DIR || join(homedir(), '.claude', 'skills', 'omni-crawl');
  if (!existsSync(dir)) throw new Error(`omni-crawl 스킬 디렉터리 없음: ${dir}`);
  const result = spawnSync('bun', ['scripts/main.ts', QUERY, '--engine', 'grok-community', '--json', '--no-save'], {
    cwd: dir, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr?.trim() ?? `omni-crawl exited ${result.status}`);
  const begin = result.stdout.indexOf(OMNI_JSON_BEGIN);
  const end = result.stdout.lastIndexOf(OMNI_JSON_END);
  if (begin < 0 || end <= begin) throw new Error('omni-crawl JSON 마커 없음');
  return parseOmniCrawlPayload(JSON.parse(result.stdout.slice(begin + OMNI_JSON_BEGIN.length, end)) as Parameters<typeof parseOmniCrawlPayload>[0]);
}

/** 함의 판정은 로컬 흉내가 아니라 CLI(intake check) 가 정본이다. 칸이나 판을 바꾸지 않는다. */
async function checkWithCli(facts: readonly string[]): Promise<SocialCheck> {
  const result = spawnSync('bun', ['bin/elanous.mjs', '--test', 'intake', 'check', ...facts.flatMap((fact) => ['--fact', fact]), '--json'], {
    cwd: resolve(import.meta.dir, '..'), encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr?.trim() ?? `intake check exited ${result.status}`);
  const start = result.stdout.indexOf('{');
  if (start < 0) throw new Error('intake check JSON 없음');
  const parsed = JSON.parse(result.stdout.slice(start)) as SocialCheck;
  if (!Array.isArray(parsed.items)) throw new Error('intake check items 없음');
  return parsed;
}

function splitSentences(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  return clean.split(/(?<=[.!?。])\s+/).map((sentence) => sentence.trim()).filter(Boolean)
    .map((sentence) => sentence.slice(0, 240)).slice(0, 5);
}

export async function runIntakeSocial(options: { root: string; deps?: SocialDeps }): Promise<{ written: number; failed: number }> {
  const { root, deps = {} } = options;
  const log = deps.log ?? ((message: string) => console.error(message));
  const now = (deps.now ?? (() => new Date()))();
  const day = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const state = join(root, 'intake', 'social-seen.jsonl');
  const lens = join(root, 'intake', 'outbox', 'lens', `${day}.jsonl`);
  const seen = new Set(existsSync(state) ? readFileSync(state, 'utf8').split('\n').filter(Boolean) : []);
  // 렌즈에 이미 쓴 동향도 «본 것» — 상태 기록이 죽어도 재실행이 같은 점을 다시 쓰지 않는다(24h 창이라 어제·오늘 파일).
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
  const crawl = deps.crawl ?? crawlWithOmniCrawl;
  let points: CommunityPoint[] = [];
  try {
    points = await crawl();
  } catch (error) {
    failed++;
    log(`못 모음: grok-community — ${error instanceof Error ? error.message : String(error)}`);
    return { written, failed };
  }
  for (const point of points) {
    if (written >= MAX_POINTS) break;
    if (!/^https?:\/\//.test(point.url)) continue;
    const id = createHash('sha256').update(canonicalUrl(point.url) ?? point.url).digest('hex').slice(0, 16);
    if (seen.has(id)) continue;
    try {
      const summary = splitSentences(point.text);
      if (!summary.length) throw new Error('요약 줄 없음');
      // 동향 자체는 기능 주장이 아니다. 제목과 본문에 실제로 적힌 제품 주장만 추가로 대조한다.
      const isProductClaim = (fact: string) => /^(?:elanous|엘라누스)\s*(?:는|은)\s+/i.test(fact);
      const facts = [...new Set([
        ...summary.slice(0, 2),
        ...splitSentences(point.title).filter(isProductClaim),
        ...summary.filter(isProductClaim),
      ])];
      const check = await (deps.check ?? checkWithCli)(facts);
      if (!check.items.length) throw new Error('intake check 항목 없음');
      const productClaims = new Set(facts.filter(isProductClaim));
      const judgedClaims = check.items.filter((item) => productClaims.has(item.fact));
      const suggestions = judgedClaims.filter((item) => item.verdict === '없음' || item.verdict === '판단 필요')
        .map((item) => ({ kind: '칸 제안', fact: item.fact, status: '제안', verdict: item.verdict }));
      const verdict = suggestions.length ? '보강'
        : judgedClaims.length && !judgedClaims.every((item) => item.verdict === '있음') ? '경쟁 대조' : '참고';
      const implication = facts.map((fact) => productClaims.has(fact)
        ? check.items.find((item) => item.fact === fact)?.line ?? `점검 결과 없음: ${fact}`
        : `커뮤니티 동향 참고: ${fact}`);
      const record = {
        id, at: now.toISOString(), source: 'grok-community', url: point.url, title: point.title.slice(0, 120),
        summary, implication, suggestions,
        lensVerdict: verdict, why: `${judgedClaims.length ? '엘라누스 대조' : '커뮤니티 동향 참고'}: ${implication.join(' · ')}`.slice(0, 500),
        target: point.text.match(/\b[A-Z][A-Z0-9]{2,}\b/)?.[0] ?? '커뮤니티',
      };
      mkdirSync(dirname(lens), { recursive: true });
      appendFileSync(lens, `${JSON.stringify(record)}\n`);
      mkdirSync(dirname(state), { recursive: true });
      appendFileSync(state, `${id}\n`);
      seen.add(id);
      written++;
    } catch (error) {
      failed++;
      log(`못 모음: ${point.url} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { written, failed };
}

if (import.meta.main) {
  const result = await runIntakeSocial({ root: effectiveInstanceRoot() });
  console.log(`intake-social: ${result.written}건 · 못 모음 ${result.failed}건`);
  if (result.failed) process.exitCode = 1;
}
