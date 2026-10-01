import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MissionOrigin } from '../autopilot/mission-origin.js';
import { debug } from '../debug/log.js';
import { sendOutbound } from '../domains/outbound-alert.js';
import { defaultSpillUpload } from '../storage/content-spill.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import type { ExecRequest } from '../exec-requests/store.js';
import { resolveDaemonEndpoint } from '../nexus/daemon-endpoint.js';
import { parseSeatAddress, resolveSeat } from '../seat-address/seat-address.js';

const POLL_MS = 5_000;
const TIMEOUT_MS = 30 * 60_000;
const DOC = /전략|한\s*장|원페이저|기획|보도자료|글|메모|초안|\b(?:one-pager|strategy|post|memo|draft)\b/i;
const CODE = /구현|버그|고쳐|\b(?:fix|implement|PR)\b/i;
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
  publishFile?: (content: string, key: string) => string | null;
  sendOutbound?: typeof sendOutbound;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pwaUrl?: () => string | undefined;
  log?: (event: 'submitted' | 'research' | 'settled' | 'delivered' | 'delivery-failed', data: Record<string, unknown>) => void;
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

async function fileLinks(id: string, result: ExecSnapshot, deps: SeatDocDeps): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  for (const entry of result.results) {
    if (entry.kind !== 'report' && entry.kind !== 'text') continue;
    if (!entry.url.startsWith(`/v1/exec-requests/${encodeURIComponent(id)}/files/`)) continue;
    try {
      // The authenticated daemon route is the only source of bytes; a raw file path is never trusted.
      const content = await (deps.getFile ?? execFile)(entry.url);
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
    const links = result?.status === 'done' ? await fileLinks(id, result, deps) : new Map<string, string>();
    try {
      const sent = await (deps.sendOutbound ?? sendOutbound)(message(id, result, withoutResearch, lookupAvailable,
        accessiblePwaUrl((deps.pwaUrl ?? chatPwaUrl)()), links), 'report', reportTo);
      log(sent ? 'delivered' : 'delivery-failed', { id });
    } catch (error) {
      log('delivery-failed', { id, reason: String(error).slice(0, 200) });
    }
  };
  void watch();
  return { id };
}
