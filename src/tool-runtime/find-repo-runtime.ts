import type { LLMToolSpec } from '../llm/tool-spec.js';
// ── FindRepo ToolRuntime (Coding Pipeline P5) ──
//
// Extracts GitHub / GitLab / Bitbucket repository URLs from a blob of
// text (typically the output of Skill(omni-crawl) or WebFetch) and
// ranks them by co-occurrence signals. Pure: no network, no I/O.
//
// Part of the web-search → repo-discovery → local-sync → consult
// cycle. This runtime is the FIRST HALF of the discovery step:
//
//   Skill(omni-crawl) returns markdown → FindRepo extracts candidates
//   → SyncRepo clones the chosen one → RefConsult reads it.
//
// The LLM drives the loop; this tool only produces structured URL
// candidates. No auto-clone, no auto-sync.
//
// IMPORTANT: Registered with shouldDefer=true — the tool's schema is
// surfaced only via ToolSearch. The base system prompt should stay
// lean; LLMs that don't need the discovery cycle shouldn't pay the
// schema token cost.


import type { ToolRuntime, ToolRuntimeContext } from './types.js';

const DEFAULT_MAX_RESULTS = 5;

/** Recognised host patterns. `https?` is required so we don't pick
 *  up `~/source/ref/claude-code-fork` — that's a local path,
 *  not a remote repo. */
// Match `https://<host>/owner/repo` optionally followed by `.git`, a
// slash (for deep links like `/tree/main`), or any non-path character
// (whitespace, comma, period, EOL). Path segments after owner/repo are
// discarded — we only care about the canonical repo identity.
const URL_PATTERNS: Array<{ host: string; re: RegExp }> = [
  { host: 'github',    re: /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\s/)\]}>"',.;!?]|$)/g },
  { host: 'gitlab',    re: /https?:\/\/gitlab\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\s/)\]}>"',.;!?]|$)/g },
  { host: 'bitbucket', re: /https?:\/\/bitbucket\.org\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\s/)\]}>"',.;!?]|$)/g },
];

export interface FindRepoArgs {
  /** Blob of text (e.g. omni-crawl markdown output). */
  text: string;
  /** Host preference. Default 'github'. */
  prefer?: 'github' | 'gitlab' | 'bitbucket' | 'any';
  /** Max candidates. Default 5, hard cap 25. */
  maxResults?: number;
}

export interface FindRepoCandidate {
  url: string;
  host: string;
  owner: string;
  repo: string;
  /** Mention count in the input text. */
  occurrences: number;
  /** Composite score — occurrences + host preference bonus. */
  score: number;
}

export interface FindRepoResult {
  output: string;
  candidates: FindRepoCandidate[];
}

export function buildFindRepoTool(): LLMToolSpec {
  return {
    name: 'FindRepo',
    description:
      'Extract GitHub / GitLab / Bitbucket repository URLs from a blob of text (typically an ' +
      'omni-crawl or WebFetch result) and rank them by co-occurrence. First step of the ' +
      'discovery cycle: FindRepo → SyncRepo → RefConsult. Pure: no network, no I/O. Use this ' +
      'when an earlier turn already pulled web content that might contain a canonical repo URL.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to scan. Omni-crawl markdown, WebFetch body, or any other blob.',
        },
        prefer: {
          type: 'string',
          enum: ['github', 'gitlab', 'bitbucket', 'any'],
          description: 'Preferred host (boosts ranking). Default "github".',
        },
        maxResults: {
          type: 'number',
          description: `Maximum candidates to return. Default ${DEFAULT_MAX_RESULTS}, hard cap 25.`,
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  };
}

export function dispatchFindRepo(args: FindRepoArgs): FindRepoResult {
  const text = String(args.text ?? '');
  const prefer = args.prefer ?? 'github';
  const maxResults = Math.min(Math.max(1, Math.floor(args.maxResults ?? DEFAULT_MAX_RESULTS)), 25);

  const candidates = new Map<string, FindRepoCandidate>();
  for (const { host, re } of URL_PATTERNS) {
    // Reset lastIndex because the regex has the 'g' flag and we
    // re-use it across calls.
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const owner = match[1]!;
      const repo = stripTrailingPunctuation(match[2]!);
      const url = `https://${hostDomain(host)}/${owner}/${repo}`;
      const key = url.toLowerCase();
      const existing = candidates.get(key);
      if (existing) {
        existing.occurrences += 1;
      } else {
        candidates.set(key, {
          url,
          host,
          owner,
          repo,
          occurrences: 1,
          score: 0,
        });
      }
    }
  }

  // Score = occurrences + host bonus.
  for (const cand of candidates.values()) {
    cand.score = cand.occurrences + (cand.host === prefer ? 2 : 0);
  }

  const ranked = [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))
    .slice(0, maxResults);

  const output = ranked.length === 0
    ? `# FindRepo: no repository URLs detected`
    : `# FindRepo: ${ranked.length} candidate${ranked.length === 1 ? '' : 's'}\n` +
      ranked
        .map((c, i) => `${i + 1}. ${c.url} · ${c.host} · ${c.occurrences} mention${c.occurrences === 1 ? '' : 's'}`)
        .join('\n');

  return { output, candidates: ranked };
}

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[.,;:!?)]+$/u, '');
}

function hostDomain(host: string): string {
  switch (host) {
    case 'github':    return 'github.com';
    case 'gitlab':    return 'gitlab.com';
    case 'bitbucket': return 'bitbucket.org';
    default:          return 'github.com';
  }
}

export const findRepoRuntime: ToolRuntime<FindRepoArgs, FindRepoResult> = {
  id: 'find_repo',
  spec: buildFindRepoTool(),
  async run(req: FindRepoArgs, _ctx: ToolRuntimeContext): Promise<FindRepoResult> {
    return dispatchFindRepo(req);
  },
};
