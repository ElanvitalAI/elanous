import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openMsgStore } from '../msg/msg-store.js';
import { CardStore, redactSecrets } from '../task-cards/card-store.js';
import { isGithubSpamText, PUBLIC_GITHUB_REPO } from './providers.js';
import type { QueuedHook } from './queue.js';

export type ShadowVerdict = 'accepted' | 'rejected' | 'human-check';
export interface ShadowJudgment { verdict: ShadowVerdict; reason: string }

const riskyPath = /(^|\/)(?:package\.json$|\.github\/(?:workflows\/|actions\/|CODEOWNERS$)|\.env(?:\.|$)|secrets?(?:\/|\.)|auth(?:\/|\.)|release(?:\/|\.)|scripts\/release-|src\/harness\/|src\/self-implement\/|src\/hooks\/)/i;

/** Webhook text is untrusted; a missing PR file list cannot be called safe. */
export function judgeGithubShadow(title: string, type: 'pull_request' | 'issue', files?: string[], spamSignal = false): ShadowJudgment {
  if (spamSignal || isGithubSpamText(title)) return { verdict: 'rejected', reason: 'spam signal in title or body' };
  if (type === 'pull_request' && (!files || !files.length || files.some(path => !path || riskyPath.test(path))))
    return { verdict: 'human-check', reason: !files?.length ? 'PR file list unavailable' : 'sensitive or invalid file path' };
  return { verdict: 'accepted', reason: 'public contribution candidate (shadow only)' };
}

/** Compare the current base tree against GitHub's PR test-merge tree, not the head tree.
 * The test merge includes only changes contributed by this PR onto the current base. Read tree metadata only (no patches). */
export async function publicPrFileNames(number: number, fetchFn: typeof fetch = fetch): Promise<string[] | undefined> {
  if (!Number.isSafeInteger(number) || number < 1) return undefined;
  const read = async (path: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const response = await fetchFn(`https://api.github.com/repos/${PUBLIC_GITHUB_REPO}${path}`, { method: 'GET',
        headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) return undefined;
      return object(await response.json());
    } catch { return undefined; }
  };
  const pull = await read(`/pulls/${number}`);
  const base = object(pull?.base);
  const head = object(pull?.head);
  const baseSha = base?.sha;
  const headSha = head?.sha;
  const mergeSha = pull?.merge_commit_sha;
  if (pull?.number !== number || object(base?.repo)?.full_name !== PUBLIC_GITHUB_REPO ||
      !gitSha(baseSha) || !gitSha(headSha) || !gitSha(mergeSha)) return undefined;
  const baseCommit = await read(`/git/commits/${baseSha}`);
  const mergeCommit = await read(`/git/commits/${mergeSha}`);
  const parents = mergeCommit?.parents;
  if (mergeCommit?.sha !== mergeSha || !Array.isArray(parents) || parents.length !== 2 ||
      object(parents[0])?.sha !== baseSha || object(parents[1])?.sha !== headSha) return undefined;
  const baseTreeSha = object(baseCommit?.tree)?.sha;
  const mergeTreeSha = object(mergeCommit?.tree)?.sha;
  if (!gitSha(baseTreeSha) || !gitSha(mergeTreeSha)) return undefined;
  const baseTree = await read(`/git/trees/${baseTreeSha}?recursive=1`);
  const mergeTree = await read(`/git/trees/${mergeTreeSha}?recursive=1`);
  const entries = (tree: Record<string, unknown> | undefined): Map<string, string> | undefined => {
    if (!tree || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 100_000) return undefined;
    const files = new Map<string, string>();
    for (const row of tree.tree) {
      const entry = object(row);
      if (!entry || typeof entry.path !== 'string' || !gitSha(entry.sha) ||
          !['blob', 'commit', 'tree'].includes(String(entry.type)) ||
          typeof entry.mode !== 'string' || !/^[0-7]{6}$/.test(entry.mode)) return undefined;
      if (entry.type === 'blob' || entry.type === 'commit')
        files.set(entry.path, `${entry.type}:${entry.mode}:${entry.sha}`);
    }
    return files;
  };
  const before = entries(baseTree);
  const after = entries(mergeTree);
  if (!before || !after || baseTree?.sha !== baseTreeSha || mergeTree?.sha !== mergeTreeSha) return undefined;
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function gitSha(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value); }

/** Separate shadow ledger/card path: never enter dispatchHook's seat wake or steward launch/report stages. */
export async function recordGithubShadow(event: QueuedHook, root: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const github = event.task.github;
  if (event.provider !== 'github' || !github || github.repository !== PUBLIC_GITHUB_REPO ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.eventId) ||
      !Number.isSafeInteger(github.number) || github.number < 1 || !['pull_request', 'issue'].includes(github.type))
    throw new Error('invalid GitHub shadow event');
  const files = github.type === 'pull_request' && !github.spamSignal && !isGithubSpamText(event.task.title)
    ? await publicPrFileNames(github.number, fetchFn) : undefined;
  const judgment = judgeGithubShadow(event.task.title, github.type, files, github.spamSignal);
  const key = `github:${event.eventId}`;
  const store = openMsgStore(join(root, 'msg', 'messages.db'));
  try {
    store.db.exec(`CREATE TABLE IF NOT EXISTS github_shadow_judgments (
      event_key TEXT PRIMARY KEY, repository TEXT NOT NULL, item_type TEXT NOT NULL, item_number INTEGER NOT NULL,
      verdict TEXT NOT NULL, reason TEXT NOT NULL, url TEXT NOT NULL
    )`);
    store.db.query(`INSERT OR IGNORE INTO github_shadow_judgments
      (event_key, repository, item_type, item_number, verdict, reason, url) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(key, github.repository, github.type, github.number, judgment.verdict, judgment.reason, event.task.external.url ?? '');
    const recorded = store.db.query('SELECT verdict, reason FROM github_shadow_judgments WHERE event_key = ?')
      .get(key) as ShadowJudgment;
    const cards = new CardStore(root);
    try {
      const goalId = `github:${github.repository}:${github.type}:${github.number}`;
      const card = cards.createCard({ goalId, title: redactSecrets(event.task.title).slice(0, 240) });
      const content = JSON.stringify({ event: key, source: goalId, url: event.task.external.url, verdict: recorded.verdict,
        reason: recorded.reason, candidate: recorded.verdict === 'rejected' ? 'intake-only' : 'decision-card' });
      const sectionKey = `intake:${createHash('sha256').update(key).digest('hex')}`;
      if (!card.sections.some(section => section.key === sectionKey))
        cards.appendSection(card.id, { key: sectionKey, owner: 'steward', content: redactSecrets(content) });
    } finally { cards.close(); }
  } finally { store.close(); }
}
