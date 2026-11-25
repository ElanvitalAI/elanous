import { debug, getScopedAmbientSessionId } from '../debug/log.js';

/** Structured failure: dispatch handed back a background receipt instead of a result. */
export const RESEARCH_FANOUT_DETACHED_REASON = 'agent-detached-no-result';

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
  /** Structured timing: `angle-deadline` = cut when the deadline (or the grace after it) ended;
   * `grace-late` = the first completed angle, finished after the deadline inside the first-result grace. */
  timing?: ResearchFanoutAngleTiming;
}

export type ResearchFanoutAngleTiming = 'angle-deadline' | 'grace-late' | 'post-axes-grace';

/** The fanout is supplementary: once the axis search has settled, the ladder waits for it at most this long, then cuts
 * the angles still running (timing 'post-axes-grace') and continues with what finished. Code default, no setting.
 * 출처: OP #114563 · RES 61266 타임라인 — axes done at ~34.5 s while the fanout ran to 40 s with completeCount 0 (~26 s idle). */
export const RESEARCH_FANOUT_POST_AXES_GRACE_MS = 6_000;

/** Structured reason when the post-axes grace cut a running angle. */
export const RESEARCH_FANOUT_POST_AXES_GRACE_REASON = 'post-axes-grace';

export interface ResearchFanoutResult {
  angles: ResearchFanoutAngleResult[];
  output: string;
}

/** 출처: OP #113782 · 실 핀 측정 86.1s RED — 각도 하나가 90 s까지 가던 직렬 꼬리를 25 s로 끊는다(코드 기본값, 설정 노브 없음). */
export const RESEARCH_FANOUT_ANGLE_DEADLINE_MS = 25_000;

/** When EVERY angle is still running at the deadline (nothing completed), wait this much longer, only until the first
 * angle completes (then the rest are cut at once), never beyond. Code default, no setting.
 * 출처: OP #113993 · RES WEBCHAT-A2DF-MK-113947 — Q2 fanout ended at the 25 s deadline with completeCount=0/3, sourceCount=0. */
export const RESEARCH_FANOUT_FIRST_RESULT_GRACE_MS = 15_000;

/** OP #114412: the fanout shares the research-phase deadline. The per-angle deadline never exceeds the time left to it,
 * and the first-result grace never extends past it. Pure: `remainingMs` is the time left (undefined = no turn budget). */
export function clampFanoutTimings(input: { angleDeadlineMs: number; graceMs: number; remainingMs?: number }): { deadlineMs: number; graceMs: number } {
  if (input.remainingMs === undefined || !Number.isFinite(input.remainingMs)) return { deadlineMs: input.angleDeadlineMs, graceMs: input.graceMs };
  const remainingMs = Math.max(0, input.remainingMs);
  const deadlineMs = Math.min(input.angleDeadlineMs, remainingMs);
  return { deadlineMs, graceMs: Math.max(0, Math.min(input.graceMs, remainingMs - deadlineMs)) };
}

/** Structured failure reason: the angle was still running at its deadline and was aborted. */
export const RESEARCH_FANOUT_ANGLE_DEADLINE_REASON = 'angle-deadline';

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
  const cutByPostAxes = result.error === RESEARCH_FANOUT_POST_AXES_GRACE_REASON;
  const statusLabel = result.status === 'complete'
    ? '완료'
    : result.error === RESEARCH_FANOUT_ANGLE_DEADLINE_REASON || cutByPostAxes ? '중단(시간 제한)'
    : result.error === 'agent returned no verifiable sources' ? '보류(출처 없음)'
      : result.error?.includes('citations') || result.error?.includes('search result')
        ? '보류(근거 부족)' : '실패';
  const lines = [`### ${result.angle.label} (${result.angle.id}) · ${statusLabel}`];
  if (result.status === 'failed') {
    lines.push(result.error === RESEARCH_FANOUT_ANGLE_DEADLINE_REASON
      ? `조사 중단: ${RESEARCH_FANOUT_ANGLE_DEADLINE_REASON} — 각도 기한 내 완료되지 않아 중단했다(이 각도의 근거는 없다).`
      : cutByPostAxes
        ? `조사 중단: ${RESEARCH_FANOUT_POST_AXES_GRACE_REASON} — 축 검색이 끝난 뒤 보조 조사 대기 시간이 지나 중단했다(이 각도의 근거는 없다).`
        : `조사 실패: ${result.error ?? 'unknown error'}`);
  }
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

/** Shared by the grace logic and the result mapping: one definition of "this angle completed". */
function classifyWorkerResult(value: ResearchFanoutWorkerResult): Omit<ResearchFanoutAngleResult, 'angle' | 'timing'> {
  const sources = (value.sources ?? []).filter((source) => /^https?:\/\//i.test(source.url));
  const hasFindings = value.text.trim().length > 0;
  const hasSources = sources.length > 0;
  const verified = value.verified !== false;
  return {
    status: hasFindings && hasSources && verified ? 'complete' : 'failed',
    text: value.text,
    sources,
    ...(!hasFindings ? { error: 'agent returned no findings' }
      : !hasSources ? { error: 'agent returned no verifiable sources' }
        : !verified ? { error: value.verificationError ?? 'agent claims did not cite observed search results' } : {}),
  };
}

/** Run three independent research agents concurrently; each rejection is retained as a failed angle. */
export async function runResearchFanout(
  request: string,
  worker: ResearchFanoutWorker,
  options: { signal?: AbortSignal; runId?: string; angleDeadlineMs?: number; firstResultGraceMs?: number; researchRemainingMs?: number; postAxesSignal?: AbortSignal; postAxesGraceMs?: number } = {},
): Promise<ResearchFanoutResult> {
  const runId = options.runId ?? process.env.ELANOUS_RUN_ID;
  const startedAt = Date.now();
  debug.log('research.fanout', 'started', {
    ...(runId ? { runId } : {}), requestChars: request.length,
    angleIds: RESEARCH_FANOUT_ANGLES.map(({ id }) => id),
  });

  const { deadlineMs, graceMs } = clampFanoutTimings({
    angleDeadlineMs: options.angleDeadlineMs ?? RESEARCH_FANOUT_ANGLE_DEADLINE_MS,
    graceMs: options.firstResultGraceMs ?? RESEARCH_FANOUT_FIRST_RESULT_GRACE_MS,
    remainingMs: options.researchRemainingMs,
  });
  const controllers = RESEARCH_FANOUT_ANGLES.map(() => new AbortController());
  const timings: Array<ResearchFanoutAngleTiming | undefined> = RESEARCH_FANOUT_ANGLES.map(() => undefined);
  const running = RESEARCH_FANOUT_ANGLES.map(() => true);
  let anyComplete = false;
  let graceOpen = false;
  // Own deadline controllers (not AbortSignal.timeout) so the reason is a structured value and the timers are cleared.
  const cutRunning = (timing: ResearchFanoutAngleTiming = 'angle-deadline', reason: string = RESEARCH_FANOUT_ANGLE_DEADLINE_REASON): void => controllers.forEach((controller, index) => {
    if (!running[index]) return;
    timings[index] = timing;
    controller.abort(new Error(reason));
  });
  // The ladder-owned post-axes signal reuses the per-angle abort path with its own structured reason.
  // OP #114584: when the axes settle, a fanout with NO completed angle ends at once; with at least one completed angle the
  // rest get the short grace to finish (never longer than the research phase allows).
  let postAxesTimer: ReturnType<typeof setTimeout> | undefined;
  const onPostAxes = (): void => {
    if (!anyComplete) { cutRunning('post-axes-grace', RESEARCH_FANOUT_POST_AXES_GRACE_REASON); return; }
    postAxesTimer = setTimeout(() => cutRunning('post-axes-grace', RESEARCH_FANOUT_POST_AXES_GRACE_REASON), options.postAxesGraceMs ?? RESEARCH_FANOUT_POST_AXES_GRACE_MS);
  };
  if (options.postAxesSignal?.aborted) onPostAxes();
  else options.postAxesSignal?.addEventListener('abort', onPostAxes, { once: true });
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlineTimer = setTimeout(() => {
    if (anyComplete) { cutRunning(); return; }
    graceOpen = true;
    graceTimer = setTimeout(() => cutRunning(), graceMs);
  }, deadlineMs);
  let settled: PromiseSettledResult<ResearchFanoutWorkerResult>[];
  try {
    settled = await Promise.allSettled(RESEARCH_FANOUT_ANGLES.map(async (angle, index) => {
      const deadline = controllers[index]!;
      const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason ?? new Error('research agent aborted'));
        else signal.addEventListener('abort', () => reject(signal.reason ?? new Error('research agent aborted')), { once: true });
      });
      try {
        const value = await Promise.race([worker(angle, request, signal), aborted]);
        if (classifyWorkerResult(value).status === 'complete') {
          anyComplete = true;
          if (graceOpen) {
            // The first angle to complete after the deadline ends the grace: keep it, cut the rest.
            graceOpen = false;
            timings[index] = 'grace-late';
            running[index] = false;
            cutRunning();
          }
        }
        return value;
      } finally {
        running[index] = false;
      }
    }));
  } finally {
    clearTimeout(deadlineTimer);
    options.postAxesSignal?.removeEventListener('abort', onPostAxes);
    if (postAxesTimer) clearTimeout(postAxesTimer);
    if (graceTimer) clearTimeout(graceTimer);
  }
  const angles = settled.map((result, index): ResearchFanoutAngleResult => {
    const angle = RESEARCH_FANOUT_ANGLES[index]!;
    const timing = timings[index];
    if (result.status === 'rejected') {
      return { angle, status: 'failed', text: '', sources: [], error: errorText(result.reason), ...(timing ? { timing } : {}) };
    }
    return { angle, ...classifyWorkerResult(result.value), ...(timing ? { timing } : {}) };
  });
  const output = ['## Parallel research angles', ...angles.flatMap(renderAngleResult)].join('\n\n');
  const result: ResearchFanoutResult = { angles, output };
  debug.log('research.fanout', 'completed', {
    ...(runId ? { runId } : {}),
    requestChars: request.length,
    completeCount: angles.filter(({ status }) => status === 'complete').length,
    failedAngleIds: angles.filter(({ status }) => status === 'failed').map(({ angle }) => angle.id),
    angleDeadlineMs: deadlineMs, graceMs,
    angleTimings: angles.filter(({ timing }) => timing !== undefined).map(({ angle, timing }) => ({ angleId: angle.id, timing })),
    sourceCount: angles.reduce((count, angle) => count + angle.sources.length, 0),
    elapsedMs: Date.now() - startedAt,
  });
  return result;
}

export interface ResearchSubagentDeps {
  dispatchAgent: typeof import('../skills/tools/agent.js').dispatchAgent;
  buildOmniSearchTool: typeof import('../skills/tools/omni-search.js').buildOmniSearchTool;
  dispatchResearchOmniSearch: typeof import('../skills/tools/omni-search.js').dispatchResearchOmniSearch;
  /** Read-only search toolkit (Read · Grep · Glob · ListDir · AstGrep · DirectiveSearch · DocsSearch). Omitted = the real one. */
  buildReadOnlySearchCatalog?: typeof import('../agent/search-toolkit.js').buildReadOnlySearchCatalog;
}

/** Production worker: a read-only general sub-agent with the research web search tool plus the read-only
 *  search toolkit (local code, docs and owner directives — src/agent/search-toolkit.ts).
 *  `deps` is a test seam; production lazily imports the real Agent/OmniSearch modules. */
export const createResearchSubagent = (deps?: ResearchSubagentDeps): ResearchFanoutWorker => async (angle, request, signal) => {
  const { dispatchAgent, buildOmniSearchTool, dispatchResearchOmniSearch } = deps ?? await (async () => {
    const [agent, omni] = await Promise.all([
      import('../skills/tools/agent.js'),
      import('../skills/tools/omni-search.js'),
    ]);
    return { dispatchAgent: agent.dispatchAgent, buildOmniSearchTool: omni.buildOmniSearchTool, dispatchResearchOmniSearch: omni.dispatchResearchOmniSearch };
  })();
  const buildLocal = deps?.buildReadOnlySearchCatalog
    ?? (await import('../agent/search-toolkit.js')).buildReadOnlySearchCatalog;
  let local: ReturnType<typeof buildLocal> | undefined;
  try { local = buildLocal(process.cwd()); } catch { local = undefined; /* fail-soft — web research still runs */ }
  const localNames = new Set((local?.specs ?? []).map((t) => t.name));
  const prompt = [
    `Research this question from the angle “${angle.label}”: ${request}`,
    angle.instruction,
    'Use OmniSearch for web research; read-only local search tools (Read, Grep, Glob, ListDir, DocsSearch, DirectiveSearch, AstGrep when present) cover this repo, its docs and what the owner said. Return a concise synthesis with a precise date, denominator/time window and state when relevant.',
    'Attach a Markdown link for every factual claim. Clearly label unresolved conflicts and uncertainty. Never invent a source or date.',
  ].join('\n\n');
  const searchSources = new Map<string, ResearchFanoutSource>();
  const parentSessionId = getScopedAmbientSessionId();
  const result = await dispatchAgent({
    description: `Research ${angle.label}`,
    prompt,
    subagent_type: 'general-purpose',
    max_turns: 5,
    mode: 'default',
  }, {
    cwd: process.cwd(), signal,
    // Awaited foreground run: the worker needs the child's real answer, not the
    // background receipt (#38772), and must not be detached by the 10 s sync cap.
    awaitResult: true,
    ...(parentSessionId ? { parentSessionId } : {}),
    hostTools: [buildOmniSearchTool(), ...(local?.specs ?? [])],
    dispatchTool: async (name, args) => {
      if (local && localNames.has(name)) return local.dispatch(name, args);
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
      tools: ['OmniSearch', ...localNames],
      permissionMode: 'read-only',
      maxTurns: 5,
    }),
  });
  if (result.background === true) {
    throw new Error(RESEARCH_FANOUT_DETACHED_REASON);
  }
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

export const runResearchSubagent: ResearchFanoutWorker = createResearchSubagent();
