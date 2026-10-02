// Live sources for /v1/ops/seats: the coordination PR and merged PRs through gh (automation App identity, proxy variables
// removed — same rule as decision replies), the release checklist, and the decision ledger. Each failure becomes null upstream.
import { DecisionLedger } from '../../decisions/decision-ledger.js';
import { devVersion, listChecklist, type ChecklistItem } from '../../release-loop/checklist.js';
import { getUserConfig } from '../../user-config.js';
import { kstDayRange, type ChannelComment, type MergedPr, type SeatsSources } from './ops-seats.js';

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

function nextPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch! + 1}`;
}

export function liveSeatsSources(): SeatsSources {
  return {
    async channel(date) {
      const target = channelTarget();
      if (!target) return null;
      const lines = await ghLines(['api', '--paginate', `repos/${target.repo}/issues/${target.pr}/comments?since=${kstDayRange(date).start}&per_page=100`,
        '--jq', '.[] | {body: .body, createdAt: .created_at} | tojson']);
      return lines?.map((line) => JSON.parse(line) as ChannelComment) ?? null;
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
