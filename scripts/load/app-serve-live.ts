/** OP-approved read-only load probe for one deployed lecture-scrap relay app. */
import { performance } from 'node:perf_hooks';

const rawUrl = process.argv.find(arg => arg.startsWith('--url='))?.slice('--url='.length);
const count = Number(process.argv.find(arg => arg.startsWith('--count='))?.split('=')[1] ?? 50);
if (!rawUrl || count !== 50) {
  throw new Error('use --url=https://lecture-scrap--<user>.elanous.app and --count=50');
}
const base = new URL(rawUrl);
if (base.protocol !== 'https:' || base.port || base.username || base.password || base.pathname !== '/'
  || base.search || base.hash || !/^lecture-scrap--[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])?\.elanous\.app$/.test(base.hostname)) {
  throw new Error('load probe accepts only a root lecture-scrap app URL on elanous.app');
}

const screens = [
  { path: '/', marker: '스크랩 목록' },
  { path: '/notes/new', marker: '노트 작성' },
  { path: '/search', marker: '검색' },
] as const;
type Result = { path: string; status: number; headersMs: number; totalMs: number; bytes: number; error?: string };
const elapsed = (at: number) => Math.round((performance.now() - at) * 100) / 100;
const percentile = (values: number[], fraction: number) => values.length
  ? values.slice().sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
const counts = (values: number[]) => Object.fromEntries([...new Set(values)].sort((a, b) => a - b)
  .map(value => [value, values.filter(item => item === value).length]));

async function readScreen(screen: typeof screens[number]): Promise<Result> {
  const at = performance.now();
  try {
    const response = await fetch(new URL(screen.path, base), {
      cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { 'cache-control': 'no-cache' },
    });
    const headersMs = elapsed(at);
    const body = await response.text();
    const totalMs = elapsed(at);
    const bytes = Buffer.byteLength(body);
    const valid = response.status === 200 && response.headers.get('content-type')?.includes('text/html')
      && body.includes(screen.marker);
    return { path: screen.path, status: response.status, headersMs, totalMs, bytes,
      ...(valid ? {} : { error: `expected HTML screen marker ${screen.marker}` }) };
  } catch (error) {
    return { path: screen.path, status: 0, headersMs: elapsed(at), totalMs: elapsed(at), bytes: 0, error: String(error) };
  }
}

// A catch-all Caddy placeholder returns 200; verify the deployed app before sending 50 requests.
const preflight = await readScreen(screens[0]);
if (preflight.error) {
  console.log(JSON.stringify({ universe: 'relay VM public HTTPS', url: base.origin, ready: false, preflight }, null, 2));
  process.exit(1);
}
const wallAt = performance.now();
const results = await Promise.all(Array.from({ length: count }, (_, index) => readScreen(screens[index % screens.length]!)));
const successful = results.filter(result => !result.error).length;
const summary = {
  universe: 'relay VM public HTTPS', url: base.origin, ready: true, count, successful,
  successRate: successful / count, wallMs: elapsed(wallAt),
  p95Ms: { headers: percentile(results.map(result => result.headersMs), 0.95),
    total: percentile(results.map(result => result.totalMs), 0.95) },
  statuses: counts(results.map(result => result.status)),
  http409: results.filter(result => result.status === 409).length,
  http429: results.filter(result => result.status === 429).length,
  bytes: results.reduce((total, result) => total + result.bytes, 0),
  errors: results.flatMap(result => result.error ? [`${result.path}: ${result.error}`] : []).slice(0, 5),
};
console.log(JSON.stringify(summary, null, 2));
if (successful !== count || (summary.p95Ms.total ?? Infinity) >= 500) process.exitCode = 1;
