// Live sources for /v1/ops/seats: the coordination PR and merged PRs through gh (automation App identity, proxy variables
// removed — same rule as decision replies), the release checklist, and the decision ledger. Each failure becomes null upstream.
import { DecisionLedger } from '../../decisions/decision-ledger.js';
import { listCoordEvents, type CoordEvent } from '../../context-bus/coord-events.js';
import { devVersion, listChecklist, type ChecklistItem } from '../../release-loop/checklist.js';
import { getUserConfig } from '../../user-config.js';
import { SEATS, kstDayRange, type ChannelComment, type ChannelSource, type MergedPr, type SeatsSources } from './ops-seats.js';

const GH_TIMEOUT_MS = 20_000;

async function ghLines(args: string[]): Promise<string[] | null> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(https?|all|no)_proxy$/i.test(k)) env[k] = v;
  try {
    const { githubAutomationToken } = await import('../../auth/github-app-token.js');
    const token = githubAutomationToken();
    if (token) env.GH_TOKEN = token;
  } catch { /* machine login */ }
  const proc = Bun.spawn(['gh', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env });
  const timer = setTimeout(() => proc.kill(), GH_TIMEOUT_MS);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.split('\n').filter(Boolean) : null;
  } finally { clearTimeout(timer); }
}

function channelTarget(): { repo: string; pr: string } | null {
  const raw = (getUserConfig().raw?.decisions as { replyGhPr?: unknown } | undefined)?.replyGhPr;
  const m = typeof raw === 'string' ? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(raw.trim()) : null;
  return m ? { repo: m[1]!, pr: m[2]! } : null;
}

export async function channelCommentsSince(sinceIso: string): Promise<Array<{ body: string; createdAt: string; url: string }> | null> {
  const target = channelTarget();
  if (!target) return null;
  const lines = await ghLines(['api', '--paginate', `repos/${target.repo}/issues/${target.pr}/comments?since=${sinceIso}&per_page=100`,
    '--jq', '.[] | {body: .body, createdAt: .created_at, url: .html_url} | tojson']);
  return lines?.map((line) => JSON.parse(line) as { body: string; createdAt: string; url: string }) ?? null;
}

function nextPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch! + 1}`;
}

export function liveSeatsSources(deps: { listEvents?: typeof listCoordEvents; githubChannel?: typeof channelCommentsSince } = {}): SeatsSources {
  return {
    async channel(date) {
      const since = kstDayRange(date).start;
      let events: CoordEvent[] = [];
      try { events = (deps.listEvents ?? listCoordEvents)({ since }); } catch { /* GitHub fallback */ }
      const latest = new Map<string, CoordEvent>();
      for (const event of events) {
        if (!SEATS.some(({ seat }) => seat === event.refs.seat)) continue;
        const prior = latest.get(event.refs.seat);
        if (!prior || event.at > prior.at) latest.set(event.refs.seat, event);
      }
      const seatSources: Partial<Record<(typeof SEATS)[number]['seat'], ChannelSource>> = {};
      if (latest.size) {
        const comments: ChannelComment[] = [];
        for (const { seat } of SEATS) {
          const event = latest.get(seat);
          if (!event) { seatSources[seat] = 'unknown'; continue; }
          comments.push({ body: `**[${seat}]** ${event.text}`, createdAt: event.at, url: event.refs.url ?? '' });
          seatSources[seat] = 'ledger';
        }
        return { source: 'ledger', comments, seatSources };
      }
      let github: ChannelComment[] | null;
      try { github = await (deps.githubChannel ?? channelCommentsSince)(since); }
      catch { github = null; }
      if (github === null) return null;
      for (const { seat } of SEATS) seatSources[seat] = 'github';
      return { source: 'github', comments: github, seatSources };
    },
    async merged(date) {
      const target = channelTarget();
      if (!target) return null;
      const { start, end } = kstDayRange(date);
      const lines = await ghLines(['pr', 'list', '--repo', target.repo, '--state', 'merged', '--limit', '300',
        '--search', `merged:${start.slice(0, 19)}Z..${end.slice(0, 19)}Z`, '--json', 'number,title,body,mergedAt', '--jq', '.[] | tojson']);
      return lines?.map((line) => JSON.parse(line) as MergedPr) ?? null;
    },
    checklist() {
      const dev = devVersion();
      const next = listChecklist(nextPatch(dev)).items;
      const current = listChecklist(dev).items;
      const all: ChecklistItem[] = [...current, ...next];
      return { current: next.length ? next : current, all };
    },
    openDecisionRaisers() {
      return new DecisionLedger().list({ status: 'open' }).map((entry) => entry.raisedBy.agent);
    },
  };
}
