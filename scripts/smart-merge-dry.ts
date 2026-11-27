// SMART-MERGE dry probe: what would the finisher's smart refresh do to these PRs right now (rerere → structural → ladder
// result, nothing pushed)? usage: bun scripts/smart-merge-dry.ts <repo> <parentHeadsCsv> <pr:head:branch>...
import { smartRefreshSync } from '../src/git-smart/smart-refresh.js';

const [repo, parentsCsv, ...items] = process.argv.slice(2);
if (!repo || !items.length) { console.error('usage: smart-merge-dry.ts <repo> <parentHeadsCsv> <pr:head:branch>...'); process.exit(2); }
const parentHeads = (parentsCsv ?? '').split(',').filter(Boolean);
for (const it of items) {
  const [pr, head, branch] = it.split(':');
  const r = smartRefreshSync({ repo, pr: Number(pr), head: head!, branch: branch!, parentHeads, push: false });
  const extra = 'resolved' in r ? ` resolved=${JSON.stringify(r.resolved)}` : 'files' in r ? ` files=${r.files.join(',')}` : 'why' in r ? ` why=${r.why}` : 'card' in r ? ` card=${r.card.split('\n')[0]}` : '';
  console.log(`#${pr} ${r.result}${'method' in r ? ` method=${r.method}` : ''}${extra}`);
}
