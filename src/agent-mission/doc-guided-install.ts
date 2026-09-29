import { debug } from '../debug/log.js';
import { emitDecision, type DecisionEvent } from '../live/detail-switch.js';
import { getFirecrawlConfig } from '../registry/discovery/config.js';
import { dispatchOmniSearch } from '../skills/tools/omni-search.js';
import type { DistroFamily } from '../cli/doctor-distro.js';
import { executeInstallInPty, probeInPty, type ToolInstallDeps } from './tool-install.js';

export interface DocInstallDeps extends Pick<ToolInstallDeps, 'typeLine' | 'waitIdle'> {
  search?: typeof dispatchOmniSearch;
  scrape?: (url: string) => Promise<string>;
  jina?: (url: string) => Promise<string>;
  decision?: (event: DecisionEvent) => void;
  log?: (event: 'searched' | 'picked-source' | 'fetched' | 'extracted' | 'chosen' | 'escalated' | 'installed' | 'failed', data: Record<string, unknown>) => void;
}

export interface DocInstallResult {
  outcome: 'installed' | 'escalate' | 'failed' | 'dry-run';
  reason: string;
  line?: string;
  url?: string;
  candidates: string[];
  decisions: DecisionEvent[];
}

async function fetchText(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function firecrawlScrape(url: string): Promise<string> {
  const { apiKey } = getFirecrawlConfig();
  if (!apiKey) throw new Error('Firecrawl API key unavailable');
  const response = await fetchText('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
  });
  const payload = await response.json() as { success?: boolean; data?: { markdown?: string } };
  if (payload.success === false || !payload.data?.markdown) throw new Error('Firecrawl empty markdown');
  return payload.data.markdown;
}

async function jinaScrape(url: string): Promise<string> {
  const text = await (await fetchText(`https://r.jina.ai/${url}`)).text();
  if (!text.trim()) throw new Error('Jina empty markdown');
  return text;
}

function rankedSources(output: string, tool: string): Array<{ url: string; host: string; reason: string }> {
  const name = tool.toLowerCase();
  const sources = [...output.matchAll(/^- \[[^\n]*?\]\((https:\/\/[^\s)]+)\)/gm)].flatMap((match) => {
    try {
      const parsed = new URL(match[1]!);
      const host = parsed.hostname.toLowerCase();
      const segments = parsed.pathname.toLowerCase().split('/').filter(Boolean);
      const mentioned = host.includes(name) || segments.some((part) => part === name || part.includes(name));
      const docs = host.endsWith('.readthedocs.io') || host === 'readthedocs.io' || host.startsWith('docs.') || host.includes('.docs.');
      const github = host === 'github.com' && segments.length >= 2 && segments[1] === name;
      const ownDomain = [`.org`, `.dev`, `.io`].some((suffix) => host === `${name}${suffix}` || host === `www.${name}${suffix}`);
      const community = /(^|\.)(stackoverflow\.com|medium\.com|reddit\.com)$/.test(host);
      // A documentation host outranks a blog that merely names the tool: a CLI's package name
      // often differs from its binary (mlr → miller.readthedocs.io), so the docs host alone counts.
      const score = (mentioned ? 10 : 0) + (docs ? 60 : 0) + (docs && mentioned ? 40 : 0) + (github ? 100 : 0) + (ownDomain ? 100 : 0) - (community ? 100 : 0);
      return [{ url: parsed.href, host, score, reason: `host=${host}; tool-name=${mentioned}; docs=${docs}; github-repo=${github}; own-domain=${ownDomain}; community=${community}; score=${score}` }];
    } catch { return []; }
  });
  const unique = new Map(sources.map((source) => [source.url, source]));
  return [...unique.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url)).slice(0, 2);
}

const ARG = '[A-Za-z0-9@][A-Za-z0-9@._/+=-]*';
const ARGS = `${ARG}(?: +${ARG})*`;
const INSTALL = new RegExp(`^(?:brew install +${ARGS}|cargo install +${ARG}|pipx install +${ARG}|go install +[A-Za-z0-9][A-Za-z0-9._/+=-]*@[A-Za-z0-9][A-Za-z0-9._/+=-]*|npm install +-g +${ARG}|(?:sudo +)?(?:apt|apt-get|dnf) install +(?!-)(?:-y +)?${ARGS}|(?:sudo +)?pacman +-S +${ARGS}|(?:sudo +)?apk add +${ARGS})$`);

/** Only complete, standalone commands from fenced code or shell-prompt lines are candidates. */
export function extractInstallLines(markdown: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  const candidates: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (/^```/.test(trimmed)) { fenced = !fenced; continue; }
    if (fenced || /^\$ /.test(trimmed)) { candidates.push(trimmed.replace(/^\$ /, '').trim()); continue; }
    // Many official install pages give the command as inline code in prose
    // (Miller: "`brew install miller`"). Each span still has to pass the same strict grammar.
    for (const span of trimmed.matchAll(/`([^`\n]+)`/g)) candidates.push(span[1]!.trim());
  }
  for (const line of candidates) {
    const withoutAllowedFlags = line.replace(/^npm install -g /, 'npm install ')
      .replace(/^(?:sudo )?(?:apt|apt-get|dnf) install -y /, 'apt install ')
      .replace(/^(?:sudo )?pacman -S /, 'pacman install ');
    if (INSTALL.test(line) && !/\s-/.test(withoutAllowedFlags) && !lines.includes(line)) lines.push(line);
  }
  return lines;
}

const manager = (line: string): string | undefined => /^(brew|cargo|pipx|go|npm) install /.exec(line)?.[1];
const distro = (line: string): boolean => /^(?:sudo +)?(?:apt|apt-get|dnf|pacman|apk) /.test(line);

export async function installFromDocs(
  { tool, smoke, ptyRef, family, dryRun = false }: { tool: string; smoke: string; ptyRef?: string; family?: DistroFamily; dryRun?: boolean },
  deps: DocInstallDeps = {},
): Promise<DocInstallResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(tool) || !smoke.trim()) throw new Error('tool and smoke are required');
  if (!dryRun && !ptyRef) throw new Error('--pty required unless --dry-run');
  const decisions: DecisionEvent[] = [];
  const decide = (event: DecisionEvent) => { decisions.push(event); (deps.decision ?? emitDecision)(event); };
  const log = (event: Parameters<NonNullable<DocInstallDeps['log']>>[0], data: Record<string, unknown>) =>
    (deps.log ?? ((name, details) => debug.log('agent-mission.doc-install', name, details)))(event, { tool, family, ...data });
  const finish = (outcome: DocInstallResult['outcome'], reason: string, candidates: string[], url?: string, line?: string): DocInstallResult =>
    ({ outcome, reason, candidates, decisions, ...(url ? { url } : {}), ...(line ? { line } : {}) });
  let readUrl: string | undefined;
  const readUrls: string[] = [];
  const seenCandidates: string[] = [];
  let privilegedRemedy: { url: string; line: string } | undefined;
  try {
    const search = await (deps.search ?? dispatchOmniSearch)({ query: `${tool} install`, limit: 5 });
    const sources = rankedSources(search.output, tool);
    log('searched', { count: sources.length });
    for (const source of sources) {
      readUrl = source.url;
      decide({ kind: 'ROUTE', what: `공식 문서 = ${source.host}`, reason: source.reason, refs: { url: source.url }, purpose: '설치 문서 원문 확인', target: source.host });
      log('picked-source', { url: source.url, reason: source.reason });
      let body = '';
      let via: 'firecrawl' | 'jina' = 'firecrawl';
      try { body = await (deps.scrape ?? firecrawlScrape)(source.url); } catch { /* Try the reader fallback. */ }
      if (!body.trim()) {
        via = 'jina';
        try { body = await (deps.jina ?? jinaScrape)(source.url); } catch { continue; }
      }
      if (!body.trim()) continue;
      readUrls.push(source.url);
      log('fetched', { url: source.url, bytes: Buffer.byteLength(body), via });
      const candidates = extractInstallLines(body);
      for (const candidate of candidates) if (!seenCandidates.includes(candidate)) seenCandidates.push(candidate);
      log('extracted', { url: source.url, count: candidates.length });
      const available = new Set<string>();
      if (ptyRef) {
        for (const name of ['brew', 'cargo', 'pipx', 'go', 'npm']) {
          const probe = await probeInPty(ptyRef, `command -v ${name}`, deps);
          if (probe.status === 'ok' && probe.exitCode === 0) available.add(name);
        }
      }
      const line = candidates.find((candidate) => manager(candidate) && available.has(manager(candidate)!))
        ?? (dryRun && !ptyRef ? candidates.find((candidate) => manager(candidate)) : undefined);
      if (line) {
        const reason = ptyRef ? `이 기계에 ${manager(line)} 있음` : `${manager(line)} 존재 미확인 (--pty 없이 dry-run, 실행 불가)`;
        decide({ kind: 'ROUTE', what: `${tool} 설치 줄 선택`, reason, refs: { url: source.url }, purpose: '사용 가능한 관리자만 실행', target: ptyRef ?? 'dry-run' });
        log('chosen', { url: source.url, line, reason });
        if (dryRun) return finish('dry-run', reason, candidates, source.url, line);
        const result = await executeInstallInPty(ptyRef!, line, deps);
        const verified = await probeInPty(ptyRef!, smoke, deps);
        const ok = result.exitCode === 0 && verified.status === 'ok' && verified.exitCode === 0;
        const verification = verified.status === 'unavailable' ? verified.detail : `install exit ${result.exitCode}; smoke exit ${verified.exitCode}: ${verified.output}`;
        decide({ kind: 'VERIFY', what: `${tool} 설치 확인`, reason: verification, refs: { url: source.url }, purpose: '사용자 smoke 명령 확인', target: ptyRef! });
        log(ok ? 'installed' : 'failed', { url: source.url, line, reason: verification });
        return finish(ok ? 'installed' : 'failed', verification, candidates, source.url, line);
      }
      const privileged = candidates.find((candidate) => distro(candidate) || candidate.startsWith('sudo '));
      if (privileged && !privilegedRemedy) privilegedRemedy = { url: source.url, line: privileged };
    }
    if (privilegedRemedy) {
      const { url, line } = privilegedRemedy;
      const reason = `sudo-is-human: ${line}`;
      decide({ kind: 'ESCALATE', what: `${tool} 설치는 사람이 필요`, reason, refs: { url }, purpose: '권한 상승은 사람에게 넘긴다', target: 'human' });
      log('escalated', { url, reason });
      return finish('escalate', reason, seenCandidates, url, line);
    }
    const reason = seenCandidates.length
      ? `사용 가능한 관리자가 확인되지 않음: ${readUrls.join(', ')}`
      : `no-doc-remedy: ${readUrls.join(', ') || readUrl || '검색된 URL 없음'}`;
    if (seenCandidates.length && dryRun) {
      log('chosen', { reason });
      return finish('dry-run', reason, seenCandidates, readUrls[0]);
    }
    decide({ kind: 'ESCALATE', what: `${tool} 설치 줄 없음`, reason, ...(readUrl ? { refs: { url: readUrl } } : {}), purpose: '사람이 문서 검토', target: 'human' });
    log('escalated', { reason });
    return finish('escalate', reason, seenCandidates, readUrls[0] ?? readUrl);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log('failed', { reason });
    return finish('failed', reason, [], readUrl);
  }
}
