import type { MergedPrRunner, MergedPrRunResult } from '../release-loop/landed-but-yellow.js';
import { createHash } from 'node:crypto';

/** GitHub data at the CLI boundary; sweep decisions remain in the production callers. */
export interface FakeGhPr {
  number: number;
  title: string;
  branch: string;
  draft?: boolean;
  closed?: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  mergeSha?: string;
  body?: string;
  head?: string;
  labels?: string[];
  files?: string[];
  comments?: string[];
}

export interface FakeGhFault {
  /** A matching invocation fails this many times, then succeeds. */
  kind: 'unexpected-eof' | 'rate-limit';
  match: RegExp;
  times: number;
}

export interface FakeGh {
  /** Same synchronous gh execution boundary as githubDraftSweepAdapters. */
  api(args: string[]): string;
  /** GitHub process-result boundary for callers that route git separately. */
  run(command: string, args: readonly string[], cwd?: string): MergedPrRunResult;
  /** Same async gh process boundary as fetchMergedChecklistPrs / release checklist. */
  runAsync: MergedPrRunner;
  readonly calls: string[][];
  readonly prs: FakeGhPr[];
}

export function createFakeGh(input: { prs: FakeGhPr[]; faults?: FakeGhFault[]; repository?: string; now?: () => Date }): FakeGh {
  const prs = input.prs.map((pr) => ({ ...pr, labels: [...(pr.labels ?? [])], files: [...(pr.files ?? [])], comments: [...(pr.comments ?? [])] }));
  const faults = (input.faults ?? []).map((fault) => ({ ...fault, remaining: fault.times }));
  const calls: string[][] = [];
  const repo = input.repository ?? 'example/repo';
  const now = input.now ?? (() => new Date());
  const find = (number: number) => {
    const pr = prs.find((entry) => entry.number === number);
    if (!pr) throw new Error(`fake-gh: unknown PR #${number}`);
    return pr;
  };
  const pull = (pr: FakeGhPr) => ({
    number: pr.number, title: pr.title, draft: pr.draft ?? false, state: pr.mergedAt || pr.closed ? 'closed' : 'open',
    head: { ref: pr.branch, sha: pr.head ?? `head${pr.number}` }, base: { ref: 'main' },
    labels: pr.labels!.map((name) => ({ name })), created_at: pr.createdAt, updated_at: pr.updatedAt,
    merged_at: pr.mergedAt ?? null, body: pr.body ?? null, merge_commit_sha: pr.mergeSha ?? null,
  });
  const slice = <T>(rows: T[], page: number, size = 100): T[] => rows.slice((page - 1) * size, page * size);
  const pageChunks = <T>(rows: T[], size: number): T[][] => Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => slice(rows, index + 1, size));
  const perPage = (url: URL): number => {
    const configured = url.searchParams.get('per_page');
    const size = configured === null ? 30 : Number(configured);
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error(`fake-gh: invalid per_page ${configured}`);
    return size;
  };
  const json = (value: unknown) => JSON.stringify(value);
  const api = (args: string[]): string => {
    calls.push([...args]);
    const call = args.join(' ');
    const fault = faults.find((candidate) => {
      if (candidate.remaining <= 0) return false;
      candidate.match.lastIndex = 0;
      return candidate.match.test(call);
    });
    if (fault) {
      fault.remaining--;
      const message = fault.kind === 'unexpected-eof' ? 'GraphQL: unexpected EOF' : 'API rate limit exceeded';
      const error = new Error(message) as Error & { stderr: string };
      error.stderr = message;
      throw error;
    }
    if (args[0] === 'api') {
      if (args[1] === 'graphql') {
        const query = args[3] ?? '';
        const repository: Record<string, unknown> = {};
        const connectionPageSize = (name: 'files' | 'comments' | 'reviews'): number => {
          const match = new RegExp(`${name}\\(first:\\s*(\\d+)\\)`).exec(query);
          return match ? Number(match[1]) : 100;
        };
        for (const match of query.matchAll(/p(\d+): pullRequest/g)) {
          const pr = find(Number(match[1]));
          const filePageSize = connectionPageSize('files');
          const commentPageSize = connectionPageSize('comments');
          const reviewPageSize = connectionPageSize('reviews');
          repository[`p${pr.number}`] = { number: pr.number, headRefOid: pr.head ?? `head${pr.number}`,
            headRef: { target: { committedDate: pr.updatedAt } },
            files: { totalCount: pr.files!.length, nodes: slice(pr.files!.map((path) => ({ path })), 1, filePageSize), pageInfo: { hasNextPage: pr.files!.length > filePageSize } },
            comments: { totalCount: pr.comments!.length, nodes: slice(pr.comments!.map((body) => ({ body })), 1, commentPageSize), pageInfo: { hasNextPage: pr.comments!.length > commentPageSize } },
            reviews: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
            mergeCommit: pr.mergeSha ? { oid: pr.mergeSha, message: pr.title } : null };
        }
        return json({ data: { repository } });
      }
      const endpoint = args.at(-1) ?? '';
      const url = new URL(endpoint, 'https://api.github.test/');
      const path = url.pathname;
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = perPage(url);
      let match: RegExpExecArray | null;
      if (/\/pulls$/.test(path)) {
        const state = url.searchParams.get('state');
        if (state !== 'open' && state !== 'closed') throw new Error(`fake-gh: invalid state ${state}`);
        return json(slice(prs.filter((pr) => (state === 'closed') === Boolean(pr.mergedAt || pr.closed)).map(pull), page, pageSize));
      }
      if ((match = /\/pulls\/(\d+)\/files$/.exec(path))) return json(slice(find(Number(match[1])).files!.map((filename) => ({ filename })), page, pageSize));
      if ((match = /\/issues\/(\d+)\/comments$/.exec(path))) {
        const createdAt = now().toISOString();
        const rows = find(Number(match[1])).comments!.map((body) => ({ body, created_at: createdAt }));
        if (args.includes('--paginate')) {
          const pages = pageChunks(rows, pageSize);
          return json(args.includes('--slurp') ? pages : pages.flat());
        }
        const rowsForPage = slice(rows, page, pageSize);
        return json(args.includes('--slurp') ? [rowsForPage] : rowsForPage);
      }
      if ((match = /\/pulls\/(\d+)\/reviews$/.exec(path))) return json(slice([], page, pageSize));
      if ((match = /\/pulls\/(\d+)\/commits$/.exec(path))) return json(slice([], page, pageSize));
      if ((match = /\/pulls\/(\d+)$/.exec(path))) return json(pull(find(Number(match[1]))));
      if ((match = /\/commits\/([^/]+)\/status$/.exec(path))) return json({ state: 'success' });
      if ((match = /\/commits\/([^/]+)\/check-runs$/.exec(path))) return json({ total_count: 1, check_runs: [{ conclusion: 'success' }] });
      if ((match = /\/commits\/([^/]+)$/.exec(path))) return json({ commit: { message: prs.find((pr) => pr.mergeSha === match![1])?.title ?? '' }, files: [] });
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      const limitIndex = args.indexOf('--limit');
      const limit = limitIndex === -1 ? 30 : Number(args[limitIndex + 1]);
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('fake-gh: invalid --limit');
      const since = /merged:>=(\d{4}-\d\d-\d\d)/.exec(args[args.indexOf('--search') + 1] ?? '')?.[1];
      const until = /merged:<([^ ]+)/.exec(args[args.indexOf('--search') + 1] ?? '')?.[1];
      return json(prs.filter((pr) => pr.mergedAt && (!since || pr.mergedAt >= since) && (!until || pr.mergedAt < until))
        .slice(0, limit).map((pr) => ({ number: pr.number, title: pr.title, body: pr.body ?? null, mergedAt: pr.mergedAt })));
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      const pr = find(Number(args[2]));
      return json({ number: pr.number, state: pr.mergedAt ? 'MERGED' : pr.closed ? 'CLOSED' : 'OPEN',
        mergeCommit: pr.mergeSha ? { oid: pr.mergeSha } : null, url: `https://github.com/${repo}/pull/${pr.number}` });
    }
    if (args[0] === 'pr' && args[1] === 'edit') {
      const pr = find(Number(args[2]));
      const add = args[args.indexOf('--add-label') + 1];
      if (args.includes('--add-label') && add && !pr.labels!.includes(add)) pr.labels!.push(add);
      args.forEach((value, index) => { if (value === '--remove-label') pr.labels = pr.labels!.filter((label) => label !== args[index + 1]); });
      return '';
    }
    if (args[0] === 'pr' && args[1] === 'close') { find(Number(args[2])).closed = true; return ''; }
    if (args[0] === 'pr' && args[1] === 'merge') {
      const pr = find(Number(args[2]));
      pr.mergedAt = now().toISOString();
      pr.mergeSha ??= createHash('sha1').update(`${repo}#${pr.number}:${pr.head ?? `head${pr.number}`}`).digest('hex');
      pr.closed = true;
      pr.draft = false;
      return '';
    }
    if (args[0] === 'label' && args[1] === 'create') return '';
    throw new Error(`fake-gh: unexpected command ${call}`);
  };
  const run: FakeGh['run'] = (command, args) => {
    if (command !== 'gh') throw new Error(`fake-gh: ${command} must use its own runner`);
    try { return { status: 0, stdout: api([...args]), stderr: '' }; }
    catch (error) {
      const failure = error as Error & { stderr?: string };
      return { status: 1, stdout: '', stderr: failure.stderr ?? failure.message ?? String(error) };
    }
  };
  return { api, run, runAsync: async (command, args, cwd) => run(command, args, cwd), calls, prs };
}
