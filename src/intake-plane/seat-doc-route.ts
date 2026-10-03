import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MissionOrigin } from '../autopilot/mission-origin.js';
import { debug } from '../debug/log.js';
import { sendOutbound } from '../domains/outbound-alert.js';
import { defaultSpillUpload } from '../storage/content-spill.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import type { ExecRequest } from '../exec-requests/store.js';
import { resolveDaemonEndpoint } from '../nexus/daemon-endpoint.js';
import { parseSeatAddress, resolveSeat } from '../seat-address/seat-address.js';
import { answerAsSeat, isNoGraphFailure } from './seat-answer.js';

const POLL_MS = 5_000;
const TIMEOUT_MS = 30 * 60_000;
const DOC = /전략|한\s*장|원페이저|기획|보도자료|글|메모|초안|\b(?:one-pager|strategy|post|memo|draft)\b/i;
const CODE = /구현|버그|고쳐|\b(?:fix|implement)\b|\bPR\b(?!\s*#?\d+\b)/i;
const RESEARCH = /전략|시장|경쟁|\bstrategy\b/i;
/** EV12a — a question or a request for status / a report is answered, never turned into a code goal. */
const ASK = /상황|현황|진행|준비|어때|어떻게|알려|보고|정리|요약|공유|\?|？|\b(?:status|update|report|summary|summari[sz]e|how|what)\b/i;
/** Only an explicit build/fix verb makes a question a code request («버그 현황 알려줘» is still a report). */
const CODE_ACTION = /구현|고쳐|수정해|만들어\s*줘|\b(?:fix|implement)\b/i;

type ExecSnapshot = Pick<ExecRequest, 'status' | 'summary' | 'results'> & { seats?: ExecRequest['seats'] };
type Source = { title: string; url: string };

export interface SeatDocDeps {
  research?: (body: string) => Promise<Source[]>;
  submitExec?: (text: string) => Promise<{ id: string }>;
  getExec?: (id: string) => Promise<ExecSnapshot | null>;
  getFile?: (path: string) => Promise<string>;
  /** Resolve only references explicitly supplied in the request; null means their claims cannot be verified. */
  readSource?: (ref: string) => Promise<string | null>;
  publishFile?: (content: string, key: string) => string | null;
  sendOutbound?: typeof sendOutbound;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pwaUrl?: () => string | undefined;
  log?: (event: 'submitted' | 'research' | 'settled' | 'delivered' | 'delivery-failed' | 'seat-answer', data: Record<string, unknown>) => void;
  /** EV12d — the seat's own answer when no installed graph fits (default = role file ⊕ owned checklist ⊕ recent, one LLM call). */
  seatAnswer?: (seatAddress: string, question: string) => Promise<{ title: string; text: string } | null>;
}

export function isSeatDocRequest(text: string): boolean {
  const addressed = parseSeatAddress(text);
  if (!addressed || !addressed.seats.every(seat => !!resolveSeat(seat))) return false;
  if (DOC.test(addressed.body) && !CODE.test(addressed.body)) return true;
  return ASK.test(addressed.body) && !CODE_ACTION.test(addressed.body);
}

/** CO1 — anything addressed to the COO seat that is not a code request goes to the planner, which splits it across
 *  seats (the A5 exec-request path), instead of becoming a code goal. */
export function isCooPlannerRequest(text: string): boolean {
  const addressed = parseSeatAddress(text);
  return !!addressed && addressed.seats.some(seat => resolveSeat(seat)?.title === 'COO')
    && addressed.seats.every(seat => !!resolveSeat(seat)) && !!addressed.body.trim() && !CODE.test(addressed.body);
}

async function research(body: string): Promise<Source[]> {
  const cli = fileURLToPath(new URL('../../bin/elanous.mjs', import.meta.url));
  const child = Bun.spawn([process.execPath, cli, '--test', 'research', '--json', '--limit', '5', body], {
    stdout: 'pipe', stderr: 'ignore',
  });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error(`research exit ${code}`);
  const payload = JSON.parse(out) as { output?: unknown; metadata?: { totalHits?: number; perEngine?: Record<string, { error?: string }> } };
  if (typeof payload.output !== 'string') throw new Error('research JSON output missing');
  const sources = [...payload.output.matchAll(/^- \[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gm)]
    .slice(0, 5).map(([, title, url]) => ({ title: title!, url: url! }));
  if (!sources.length && (!payload.metadata?.totalHits || Object.values(payload.metadata.perEngine ?? {}).some(engine => engine.error))) {
    throw new Error('research unavailable');
  }
  return sources;
}

function daemonUrl(): string {
  const base = resolveDaemonEndpoint({ purpose: 'write' })?.baseUrl;
  if (!base) throw new Error('실행 요청 데몬을 찾을 수 없습니다');
  return base;
}

async function execResponse(path: string, text?: string): Promise<Response> {
  const token = readFileSync(join(getElanousConfigDir(), 'acp-token'), 'utf8').trim();
  const response = await fetch(`${daemonUrl()}/v1/exec-requests${path}`, {
    method: text === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(text === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(text === undefined ? {} : { body: JSON.stringify({ text }) }),
  });
  if (!response.ok) throw new Error(`실행 요청 HTTP ${response.status}`);
  return response;
}

async function execApi(path: string, text?: string): Promise<ExecRequest> {
  return await (await execResponse(path, text)).json() as ExecRequest;
}

async function execFile(path: string): Promise<string> {
  return (await execResponse(path.slice('/v1/exec-requests'.length))).text();
}

const SUPPLIED_REF = /https?:\/\/[^\s<>()[\]]+|\bPR\s*#?\d+\b|(?:\.?\.?\/|[\w.-]+\/)[\w./-]+\.(?:md|txt|csv|json|pdf)\b|\b[\w.-]+\.(?:md|txt|csv|json|pdf)\b/gi;
// Keep units and grammatical particles with the figure; never backtrack from 42% to 42.
const NUMBER = /(?<![\p{L}\p{N}_#.,])([+-]?\d+(?:[,.]\d+)*(?:(?:%|년|월|일|명|건|원|배)(?![\p{N}_%A-Za-z]|[.,]\d)|(?![\p{L}\p{N}_%]|[.,]\d)))(은|는|이|가|을|를|에|의|도|만|에서|으로|와|과)?/gu;

function suppliedReferences(text: string): string[] {
  return [...new Set([...text.matchAll(SUPPLIED_REF)].map(([ref]) => ref!.replace(/[.,;]+$/, '')))];
}

const SOURCE_TIMEOUT_MS = 5_000;
const MAX_SOURCE_BYTES = 200_000;
// The default resolver only reads repository-local files and these two public HTTPS hosts.
const SOURCE_URL_HOSTS = new Set(['github.com', 'raw.githubusercontent.com']);

function allowedSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SOURCE_URL_HOSTS.has(url.hostname)
      && !url.username && !url.password && !url.port;
  } catch { return false; }
}

async function readPublicSource(ref: string): Promise<string | null> {
  let url = ref;
  const signal = AbortSignal.timeout(SOURCE_TIMEOUT_MS);
  for (let redirects = 0; redirects < 3; redirects++) {
    if (!allowedSourceUrl(url)) return null;
    const response = await fetch(url, { signal, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !/^(?:text\/|application\/(?:json|xml))/.test(response.headers.get('content-type') ?? '')) return null;
    if (Number(response.headers.get('content-length') ?? 0) > MAX_SOURCE_BYTES) {
      await response.body?.cancel();
      return null;
    }
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_SOURCE_BYTES) return null;
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder().decode(bytes);
    } finally {
      if (size > MAX_SOURCE_BYTES) await reader.cancel();
      reader.releaseLock();
    }
  }
  return null;
}

async function defaultReadSource(ref: string): Promise<string | null> {
  try {
    if (/^https?:\/\//i.test(ref)) return await readPublicSource(ref);
    if (/^PR\s*#?\d+$/i.test(ref)) {
      const number = ref.match(/\d+/)![0];
      const child = Bun.spawn(['gh', 'pr', 'view', number, '--json', 'title,body'], { stdout: 'pipe', stderr: 'ignore' });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>(finish => {
        timer = setTimeout(() => { child.kill(9); finish(null); }, SOURCE_TIMEOUT_MS);
      });
      try {
        const result = await Promise.race([
          Promise.all([new Response(child.stdout).text(), child.exited]).then(([out, code]) => ({ out, code })),
          timeout,
        ]);
        if (!result || result.code !== 0 || result.out.length > MAX_SOURCE_BYTES) return null;
        const pr = JSON.parse(result.out) as { title?: string; body?: string };
        return `${pr.title ?? ''}\n${pr.body ?? ''}`;
      } finally { clearTimeout(timer); }
    }
    const root = realpathSync(process.cwd());
    const actual = realpathSync(resolve(root, ref));
    const within = relative(root, actual);
    if (isAbsolute(within) || within === '..' || within.startsWith('../')) return null;
    const file = statSync(actual);
    if (!file.isFile() || file.size > MAX_SOURCE_BYTES || /\.pdf$/i.test(actual)) return null;
    return readFileSync(actual, 'utf8');
  } catch { return null; }
}

function citationFor(ref: string): string {
  return /^PR\s*#?(\d+)$/i.test(ref) ? `PR #${ref.match(/\d+/)![0]}` : ref;
}

function claimLabel(line: string, offset: number, length: number): string | null {
  const before = line.slice(0, offset).split(/[,;:，；。.!?\n]/).at(-1) ?? '';
  const after = (line.slice(offset + length).split(/[,;:，；。.!?\n]/)[0] ?? '').replace(/^\s*(?:\[출처: [^\]]+\]|«확인 필요»)/, '');
  // Never borrow a label from another figure in the same clause.
  if ([...before.matchAll(NUMBER), ...after.matchAll(NUMBER)].length) return null;
  const left = before.trim().replace(/^(?:[#*>-]+\s*)+/, '');
  const right = after.match(/^\s*([\p{L}]{2,}(?:\s+[\p{L}]{2,})*)/u)?.[1];
  return /[\p{L}]{2,}/u.test(left) ? left : right ?? null;
}

const CLAIM_DIRECTION = /증가|상승|성장|확대|개선|감소|하락|축소|악화/g;
const CLAIM_FORECAST = /예상|전망|예측|추정|계획|예정|기대|목표|가능성/;
// Range and approximation words change what a figure claims («42%» ≠ «42% 미만»); both sides must carry the same set.
const CLAIM_QUALIFIER = /미만|이하|이상|초과|이내|약|최대|최소|가량|정도|내외|안팎|넘게|넘는|남짓|까지|부터|대략|거의|이상의|under|over|about|up to|at least|at most|less than|more than|nearly|almost/giu;

function claimDirection(segment: string): string | undefined {
  const directions = [...segment.matchAll(CLAIM_DIRECTION)];
  if (directions.length > 1) return undefined;
  const direction = directions[0];
  const after = direction ? segment.slice(direction.index + direction[0].length) : '';
  const negated = direction && /^\s*(?:하지\s*(?:않|못)|않|못|안\s*(?:했|함)|없|아니)/u.test(after);
  // Polarity outside the recognized predicate is ambiguous; do not use it to establish provenance.
  if (/않|못|안\s|없|아니/u.test(segment) && !negated) return undefined;
  const qualifiers = [...new Set([...segment.matchAll(CLAIM_QUALIFIER)].map(match => match[0].toLowerCase().replace(/^이상의$/, '이상')))].sort().join(',');
  return `${direction?.[0] ?? ''}|${negated ? 'negated' : 'affirmed'}|${CLAIM_FORECAST.test(segment) ? 'forecast' : 'observed'}|${qualifiers}`;
}

function hasClaimPair(source: string, number: string, label: string, direction: string | undefined): boolean {
  if (direction === undefined) return false;
  return source.split(/\n|,(?=\s)|[;:，；。!?]|\.(?!\d)/).some(segment => {
    const figures = [...segment.matchAll(NUMBER)];
    if (figures.length !== 1 || figures[0]![1] !== number) return false;
    return claimLabel(segment, figures[0]!.index, figures[0]![0].length) === label
      && claimDirection(segment) === direction;
  });
}

function citeDocumentNumbers(content: string, sources: Map<string, string | null>): string {
  let fenced = false;
  return content.split('\n').map(line => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return line; }
    if (fenced || /^\s*(?:참고 자료|출처:)/.test(line)) return line;
    const occupied = [...line.matchAll(/https?:\/\/\S+|\[출처: [^\]]+\]|(?:\.?\.?\/|[\w.-]+\/)[\w./-]+\.(?:md|txt|csv|json|pdf)|\b[\w.-]+\.(?:md|txt|csv|json|pdf)\b/g)]
      .map(match => [match.index, match.index + match[0].length] as const);
    const annotated = new RegExp(`${NUMBER.source}(?:\\s*(?:\\[출처: [^\\]]+\\]|«확인 필요»))?`, 'gu');
    return line.replace(annotated, (claim, number: string, particle: string | undefined, offset: number) => {
      if (occupied.some(([start, end]) => offset >= start && offset < end)) return claim;
      const figure = `${number}${particle ?? ''}`;
      const label = claimLabel(line, offset, claim.length);
      const before = line.slice(0, offset).split(/[,;:，；。.!?]/).at(-1) ?? '';
      const after = line.slice(offset + claim.length).split(/[,;:，；。.!?]/)[0] ?? '';
      const direction = claimDirection(`${before} ${after}`);
      const matches = label ? [...sources].filter(([, source]) => source && hasClaimPair(source, number, label, direction)) : [];
      return matches.length === 1 ? `${figure} [출처: ${citationFor(matches[0]![0])}]` : `${figure} «확인 필요»`;
    });
  }).join('\n');
}

function chatPwaUrl(): string | undefined {
  const endpoint = resolveDaemonEndpoint({ purpose: 'write' });
  return endpoint?.pwaUrl;
}

function accessiblePwaUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    // The owner opens the authenticated PWA, not the bearer-only /v1/exec-requests/files endpoint.
    // A loopback address works on the daemon host, not on the sender's phone.
    if (url.protocol !== 'https:' || !url.hostname || url.hostname === 'localhost'
      || url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0'
      || url.username || url.password || url.pathname !== '/app/' || url.search || url.hash) return undefined;
    return url.toString();
  } catch { return undefined; }
}

async function fileLinks(id: string, result: ExecSnapshot, deps: SeatDocDeps, sources: Map<string, string | null>): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  for (const entry of result.results) {
    if (entry.kind !== 'report' && entry.kind !== 'text') continue;
    if (!entry.url.startsWith(`/v1/exec-requests/${encodeURIComponent(id)}/files/`)) continue;
    try {
      // The authenticated daemon route is the only source of bytes; a raw file path is never trusted.
      const raw = await (deps.getFile ?? execFile)(entry.url);
      const content = sources.size ? citeDocumentNumbers(raw, sources) : raw;
      const ext = entry.kind === 'report' ? 'md' : 'txt';
      const digest = createHash('sha256').update(content).digest('hex');
      const key = `seat-doc/${encodeURIComponent(id)}/${digest}.${ext}`;
      const url = (deps.publishFile ?? ((value, path) => defaultSpillUpload(value, path, ext)))(content, key);
      if (url && /^https:\/\/[^/]+/.test(url)) links.set(entry.url, url);
      else links.set(entry.url, `\n${content}`);
    } catch (error) {
      debug.log('intake.seat-doc', 'file-link-failed', { id, reason: String(error).slice(0, 200) });
    }
  }
  return links;
}

function message(id: string, result: ExecSnapshot | null, withoutResearch: boolean, lookupAvailable: boolean, pwaUrl?: string, links = new Map<string, string>()): string {
  const suffix = withoutResearch ? '\n조사 없이 진행했습니다.' : '';
  const location = pwaUrl ? `PWA 에서 확인: ${pwaUrl} (접수번호 ${id})` : `PWA 에서 확인 (접수번호 ${id} · 외부 접속 주소 없음)`;
  if (!result) return `${lookupAvailable ? '아직 도는 중' : '상태를 확인할 수 없어 확인을 종료했습니다'} · ${location}${suffix}`;
  if (result.status === 'failed') {
    const reason = result.summary || result.seats?.find(seat => seat.reason)?.reason || '실행 요청 실패';
    return `문서 요청 실패 — ${reason.split('\n')[0]!.slice(0, 200)} · ${location}${suffix}`;
  }
  const summary = result.summary?.split('\n')[0]?.slice(0, 200) || '문서 요청 완료';
  // File endpoints require an Authorization header even when opened from the same origin.
  // Only send externally usable links for genuinely external artifacts; file names remain findable in the PWA.
  const artifacts = result.results.map(entry => `${entry.title} (${entry.kind})${links.has(entry.url) ? ` · ${links.get(entry.url)}` : entry.kind === 'link' && /^https?:\/\//i.test(entry.url) ? ` · ${entry.url}` : ''}`);
  return `${summary}\n${artifacts.join('\n')}${artifacts.length ? '\n' : ''}${location}${suffix}`;
}

export async function submitSeatDocRequest({ text, reportTo, deps = {} }: {
  text: string; reportTo?: MissionOrigin; deps?: SeatDocDeps;
}): Promise<{ id: string }> {
  const log = deps.log ?? ((event: Parameters<NonNullable<SeatDocDeps['log']>>[0], data: Record<string, unknown>) => debug.log('intake.seat-doc', event, data));
  const body = parseSeatAddress(text)?.body.trim() ?? text.trim();
  let withoutResearch = false;
  let requestText = text;
  const refs = suppliedReferences(body);
  const sources = new Map<string, string | null>();
  for (const ref of refs) {
    try { sources.set(ref, await (deps.readSource ?? defaultReadSource)(ref)); }
    catch { sources.set(ref, null); }
  }
  if (refs.length) requestText += '\n\n문서 수치 근거 규칙: 제공된 파일·URL·PR 번호의 실제 내용을 확인하고, 근거가 확인된 각 수치 바로 뒤에 [출처: <파일|PR|명령>] 형식으로 실물 참조를 붙이세요. 근거를 확인할 수 없는 수치는 삭제하거나 바꾸지 말고 «확인 필요»로 표시하세요. 서로 다른 출처에 같은 숫자가 있다는 이유만으로 출처를 추정하지 마세요.';
  if (RESEARCH.test(body)) {
    try {
      const sources = (await (deps.research ?? research)(body)).slice(0, 5);
      if (sources.length) requestText += `\n\n참고 자료\n${sources.map(source => `${source.title} · ${source.url}`).join('\n')}`;
      log('research', { count: sources.length });
    } catch (error) {
      withoutResearch = true;
      log('research', { failed: true, reason: String(error).slice(0, 200) });
    }
  }
  const { id } = await (deps.submitExec ?? ((value) => execApi('', value)))(requestText);
  if (!id) throw new Error('실행 요청 접수번호가 없습니다');
  log('submitted', { id });

  const watch = async () => {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const deadline = now() + TIMEOUT_MS;
    let result: ExecSnapshot | null = null;
    let lookupAvailable = false;
    let lastConfirmedStatus: ExecSnapshot['status'] | undefined;
    while (now() < deadline) {
      try {
        const snapshot = await (deps.getExec ?? ((key) => execApi(`/${encodeURIComponent(key)}`)))(id);
        if (!snapshot) throw new Error('실행 요청을 찾을 수 없습니다');
        lookupAvailable = true;
        lastConfirmedStatus = snapshot.status;
        if (snapshot.status === 'done' || snapshot.status === 'failed') {
          result = snapshot;
          break;
        }
      } catch (error) {
        lookupAvailable = false;
        debug.log('intake.seat-doc', 'poll-error', { id, reason: String(error).slice(0, 200) });
      }
      if (now() < deadline) await sleep(Math.min(POLL_MS, Math.max(0, deadline - now())));
    }
    log('settled', { id, status: result?.status ?? (lookupAvailable ? 'timeout' : 'lookup-unavailable'), lastConfirmedStatus });
    const links = result?.status === 'done' ? await fileLinks(id, result, deps, sources) : new Map<string, string>();
    let reply = message(id, result, withoutResearch, lookupAvailable, accessiblePwaUrl((deps.pwaUrl ?? chatPwaUrl)()), links);
    if (isNoGraphFailure(result)) {
      // EV12d — a question with no fitting graph gets the seat's own answer, not «문서 요청 실패».
      const seat = result!.seats![0]!.seat;
      try {
        const answer = await (deps.seatAnswer ?? answerAsSeat)(seat, body);
        if (answer) reply = `${answer.title} 답 (접수번호 ${id})\n${answer.text}`;
        log('seat-answer', { id, seat, answered: !!answer });
      } catch (error) {
        log('seat-answer', { id, seat, answered: false, reason: String(error).slice(0, 200) });
      }
    }
    try {
      const sent = await (deps.sendOutbound ?? sendOutbound)(reply, 'report', reportTo);
      log(sent ? 'delivered' : 'delivery-failed', { id });
    } catch (error) {
      log('delivery-failed', { id, reason: String(error).slice(0, 200) });
    }
  };
  void watch();
  return { id };
}
