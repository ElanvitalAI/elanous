import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
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

export interface ShadowReviewResult {
  reviewed: boolean;
  verdict: 'pass' | 'warn' | 'fail' | null;
  summary: string;
}

/** Runs the read-only self-review command from a detached, disposable worktree of trusted HEAD.
 * The PR is never checked out: only its remote diff enters the reviewer prompt. */
export async function runGithubShadowReview(number: number, repo = resolve(process.cwd())): Promise<ShadowReviewResult> {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('invalid PR number');
  const dir = mkdtempSync(join(tmpdir(), 'elanous-review-shadow-'));
  const worktree = join(dir, 'repo');
  let attached = false;
  try {
    const added = spawnSync('git', ['-C', repo, 'worktree', 'add', '--detach', worktree, 'HEAD'], { encoding: 'utf8', timeout: 30_000 });
    if (added.status !== 0) throw new Error('isolated worktree unavailable');
    attached = true;
    if (existsSync(join(repo, 'node_modules'))) symlinkSync(join(repo, 'node_modules'), join(worktree, 'node_modules'), 'dir');
    const output = await new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, [join(worktree, 'bin/elanous.mjs'), '--test', 'self', 'review', String(number), '--json'], {
        cwd: worktree, env: { ...process.env, GH_REPO: PUBLIC_GITHUB_REPO }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill(), 360_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 100_000) child.kill(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 100_000) child.kill(); });
      child.on('error', error => { clearTimeout(timer); fail(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? done(stdout) : fail(new Error(`self review exited ${code}: ${stderr.slice(0, 200)}`)); });
    });
    const parsed: unknown = JSON.parse(output);
    const result = object(parsed);
    if (!result) throw new Error('self review returned no result');
    const verdict = result.reviewed === true && ['pass', 'warn', 'fail'].includes(String(result.verdict))
      ? result.verdict as 'pass' | 'warn' | 'fail' : null;
    const findings = [...(Array.isArray(result.mustFix) ? result.mustFix : []), ...(Array.isArray(result.shouldFix) ? result.shouldFix : [])]
      .filter((item): item is string => typeof item === 'string').slice(0, 8);
    return { reviewed: result.reviewed === true && verdict !== null, verdict,
      summary: redactSecrets(verdict ? `${verdict}: ${findings.join('; ') || 'no findings'}` : `review unavailable: ${String(result.error ?? 'not reviewed')}`).slice(0, 2000) };
  } finally {
    if (attached) {
      rmSync(join(worktree, 'node_modules'), { force: true });
      spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree], { timeout: 30_000 });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Separate shadow ledger/card path: never enter dispatchHook's seat wake or steward launch/report stages. */
export async function recordGithubShadow(event: QueuedHook, root: string, fetchFn: typeof fetch = fetch,
  review: (number: number) => Promise<ShadowReviewResult> = runGithubShadowReview): Promise<void> {
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
    debug.log('steward.intake', 'judged', { eventKey: key, number: github.number, type: github.type, verdict: recorded.verdict, reason: recorded.reason });
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
    if (github.type === 'pull_request' && recorded.verdict === 'accepted') {
      store.db.exec(`CREATE TABLE IF NOT EXISTS github_shadow_reviews (
        event_key TEXT PRIMARY KEY, repository TEXT NOT NULL, item_number INTEGER NOT NULL,
        reviewed INTEGER NOT NULL, verdict TEXT, summary TEXT NOT NULL
      )`);
      if (!store.db.query('SELECT event_key FROM github_shadow_reviews WHERE event_key = ?').get(key)) {
        let result: ShadowReviewResult;
        try { result = await review(github.number); }
        catch (error) { result = { reviewed: false, verdict: null, summary: `review unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
        store.db.query(`INSERT OR IGNORE INTO github_shadow_reviews
          (event_key, repository, item_number, reviewed, verdict, summary) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(key, github.repository, github.number, result.reviewed ? 1 : 0, result.verdict,
            redactSecrets(result.summary).slice(0, 2000));
        debug.log('steward.review-shadow', 'recorded', { eventKey: key, number: github.number, reviewed: result.reviewed, verdict: result.verdict });
      }
    }
  } finally { store.close(); }
}
