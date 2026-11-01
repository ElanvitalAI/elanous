import { debug } from '../debug/log.js';

export interface ResearchFanoutAngle {
  id: 'primary-data' | 'news-filings' | 'counterevidence';
  label: string;
  instruction: string;
}

export interface ResearchFanoutSource {
  url: string;
  title?: string;
  excerpt?: string;
}

export interface ResearchFanoutWorkerResult {
  text: string;
  sources?: ResearchFanoutSource[];
  /** Production workers set false when claims do not cite observed search results. */
  verified?: boolean;
  verificationError?: string;
}

export interface ResearchFanoutAngleResult {
  angle: ResearchFanoutAngle;
  status: 'complete' | 'failed';
  text: string;
  sources: ResearchFanoutSource[];
  error?: string;
}

export interface ResearchFanoutResult {
  angles: ResearchFanoutAngleResult[];
  output: string;
}

export const RESEARCH_FANOUT_WORKER_TIMEOUT_MS = 90_000;

export type ResearchFanoutWorker = (
  angle: ResearchFanoutAngle,
  request: string,
  signal?: AbortSignal,
) => Promise<ResearchFanoutWorkerResult>;

export const RESEARCH_FANOUT_ANGLES: readonly ResearchFanoutAngle[] = [
  {
    id: 'primary-data',
    label: '1차 데이터',
    instruction: '공식 원문·공공 통계·기업/기관 발표에서 기준일, 기간, 분모, 수치와 상태를 확인한다.',
  },
  {
    id: 'news-filings',
    label: '뉴스·공시',
    instruction: '날짜가 확인되는 최신 뉴스와 공시를 조사하고 사건 시점, 보도 시점, 진행 상태를 구분한다.',
  },
  {
    id: 'counterevidence',
    label: '반대 근거',
    instruction: '주요 주장과 충돌하는 원문·데이터·반론을 찾아 어떤 조건에서 결론이 달라지는지 확인한다.',
  },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderAngleResult(result: ResearchFanoutAngleResult): string[] {
  const statusLabel = result.status === 'complete'
    ? '완료'
    : result.error === 'agent returned no verifiable sources' ? '보류(출처 없음)'
      : result.error?.includes('citations') || result.error?.includes('search result')
        ? '보류(근거 부족)' : '실패';
  const lines = [`### ${result.angle.label} (${result.angle.id}) · ${statusLabel}`];
  if (result.status === 'failed') lines.push(`조사 실패: ${result.error ?? 'unknown error'}`);
  if (result.status === 'complete' && result.text.trim()) lines.push(result.text.trim());
  if (result.sources.length > 0) {
    lines.push('출처:');
    for (const source of result.sources) {
      lines.push(`- ${source.title ? `[${source.title}](${source.url})` : source.url}${source.excerpt ? ` — ${source.excerpt}` : ''}`);
    }
  }
  return lines;
}

function parseSearchSources(output: string): ResearchFanoutSource[] {
  const sources: ResearchFanoutSource[] = [];
  for (const match of output.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    const [, title, url] = match;
    if (title && url) sources.push({ title, url });
  }
  return sources;
}

function hasOnlyVerifiedInlineCitations(output: string, sources: readonly ResearchFanoutSource[]): boolean {
  const knownUrls = new Set(sources.map(({ url }) => url));
  const contentLines = output.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !/^[-*_]{3,}$/.test(line));
  const citedUrls = new Set<string>();
  const everyClaimHasVerifiedCitations = contentLines.length > 0 && contentLines.every((line) => {
    const links = [...line.matchAll(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1]!);
    if (!links.length || links.some((url) => !knownUrls.has(url))) return false;
    links.forEach((url) => citedUrls.add(url));
    return true;
  });
  if (!everyClaimHasVerifiedCitations) return false;
  // One observed result cannot carry an entire multi-claim synthesis. Require
  // at least two independently retrieved URLs when the agent makes multiple claims.
  return contentLines.length === 1 || citedUrls.size > 1;
}

/** Run three independent research agents concurrently; each rejection is retained as a failed angle. */
export async function runResearchFanout(
  request: string,
  worker: ResearchFanoutWorker,
  options: { signal?: AbortSignal; runId?: string; workerTimeoutMs?: number } = {},
): Promise<ResearchFanoutResult> {
  const runId = options.runId ?? process.env.ELANOUS_RUN_ID;
  const startedAt = Date.now();
  debug.log('research.fanout', 'started', {
    ...(runId ? { runId } : {}), requestChars: request.length,
    angleIds: RESEARCH_FANOUT_ANGLES.map(({ id }) => id),
  });

  const settled = await Promise.allSettled(RESEARCH_FANOUT_ANGLES.map(async (angle) => {
    const timeout = AbortSignal.timeout(options.workerTimeoutMs ?? RESEARCH_FANOUT_WORKER_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason ?? new Error('research agent aborted'));
      else signal.addEventListener('abort', () => reject(signal.reason ?? new Error('research agent aborted')), { once: true });
    });
    return Promise.race([worker(angle, request, signal), aborted]);
  }));
  const angles = settled.map((result, index): ResearchFanoutAngleResult => {
    const angle = RESEARCH_FANOUT_ANGLES[index]!;
    if (result.status === 'rejected') {
      return { angle, status: 'failed', text: '', sources: [], error: errorText(result.reason) };
    }
    const sources = (result.value.sources ?? []).filter((source) => /^https?:\/\//i.test(source.url));
    const hasFindings = result.value.text.trim().length > 0;
    const hasSources = sources.length > 0;
    const verified = result.value.verified !== false;
    return {
      angle,
      status: hasFindings && hasSources && verified ? 'complete' : 'failed',
      text: result.value.text,
      sources,
      ...(!hasFindings ? { error: 'agent returned no findings' }
        : !hasSources ? { error: 'agent returned no verifiable sources' }
          : !verified ? { error: result.value.verificationError ?? 'agent claims did not cite observed search results' } : {}),
    };
  });
  const output = ['## Parallel research angles', ...angles.flatMap(renderAngleResult)].join('\n\n');
  const result: ResearchFanoutResult = { angles, output };
  debug.log('research.fanout', 'completed', {
    ...(runId ? { runId } : {}),
    requestChars: request.length,
    completeCount: angles.filter(({ status }) => status === 'complete').length,
    failedAngleIds: angles.filter(({ status }) => status === 'failed').map(({ angle }) => angle.id),
    sourceCount: angles.reduce((count, angle) => count + angle.sources.length, 0),
    elapsedMs: Date.now() - startedAt,
  });
  return result;
}

/** Production worker: a read-only general sub-agent with only the research web search tool. */
export const runResearchSubagent: ResearchFanoutWorker = async (angle, request, signal) => {
  const [{ dispatchAgent }, { buildOmniSearchTool, dispatchResearchOmniSearch }] = await Promise.all([
    import('../skills/tools/agent.js'),
    import('../skills/tools/omni-search.js'),
  ]);
  const prompt = [
    `Research this question from the angle “${angle.label}”: ${request}`,
    angle.instruction,
    'Use OmniSearch for web research. Return a concise synthesis with a precise date, denominator/time window and state when relevant.',
    'Attach a Markdown link for every factual claim. Clearly label unresolved conflicts and uncertainty. Never invent a source or date.',
  ].join('\n\n');
  const searchSources = new Map<string, ResearchFanoutSource>();
  const result = await dispatchAgent({
    description: `Research ${angle.label}`,
    prompt,
    subagent_type: 'general-purpose',
    max_turns: 5,
    mode: 'default',
  }, {
    cwd: process.cwd(), signal,
    hostTools: [buildOmniSearchTool()],
    dispatchTool: async (name, args) => {
      if (name !== 'OmniSearch') throw new Error(`research agent tool is not permitted: ${name}`);
      const search = await dispatchResearchOmniSearch(args, {
        signal,
        onSource: ({ url, title, snippet }) => searchSources.set(url, { url, title, excerpt: snippet }),
      });
      for (const source of parseSearchSources(search.output)) searchSources.set(source.url, source);
      return search.output;
    },
    resolveAgentDef: () => ({
      name: `research-${angle.id}`,
      description: `Research sub-agent for ${angle.label}`,
      role: angle.label,
      goal: angle.instruction,
      systemPrompt: 'You are a careful research analyst. Use web search, cite original URLs, preserve dates and uncertainty.',
      tools: ['OmniSearch'],
      permissionMode: 'read-only',
      maxTurns: 5,
    }),
  });
  const sources = [...searchSources.values()];
  const verified = hasOnlyVerifiedInlineCitations(result.output, sources);
  const hasSeveralClaims = result.output.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith('#')).length > 1;
  return {
    text: result.output,
    sources,
    verified,
    ...(!verified ? {
      verificationError: sources.length === 0
        ? 'agent claims lack citations because OmniSearch returned no source'
        : hasSeveralClaims && new Set([...result.output.matchAll(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1]!)).size < 2
          ? 'one OmniSearch result cannot support multiple claims'
          : 'agent claims lack verified inline citations to observed OmniSearch results',
    } : {}),
  };
};
