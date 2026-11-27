// Actual Git in a disposable synthetic repository; review decisions below are pure helpers,
// not an invocation of the production review command or a provider.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeReviewEnd, planReviewStart } from '../../../llm-route/review-start.js';

export function checkRealGit(kind: 'merge-base' | 'range-diff' | 'head-moved'): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'sim-review-git-'));
  // Do not inherit the host's git config, hooks, identity or credentials.
  const env = { NODE_ENV: 'test' as const, PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Simulation', GIT_AUTHOR_EMAIL: 'sim@example.invalid', GIT_COMMITTER_NAME: 'Simulation', GIT_COMMITTER_EMAIL: 'sim@example.invalid' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (name: string, text: string) => { writeFileSync(join(dir, name), text); git('add', name); git('commit', '-m', text); return git('rev-parse', 'HEAD'); };
  try {
    git('init', '-q');
    const base = commit('base.txt', 'base');
    git('branch', 'main-sim');
    commit('feature.txt', 'feature one');
    const oldHead = git('rev-parse', 'HEAD');
    if (kind === 'merge-base') {
      git('checkout', 'main-sim');
      const mainHead = commit('main.txt', 'main only');
      git('checkout', '-');
      git('merge', '--no-ff', '-m', 'merge main', 'main-sim');
      const mergeBase = git('merge-base', mainHead, 'HEAD');
      const files = git('diff', '--name-only', `${mergeBase}..HEAD`);
      const plan = planReviewStart({ mainMerged: true, savedReviewHead: null, deltaChars: null, deltaBudgetChars: 100 });
      return mergeBase === mainHead && files === 'feature.txt' && plan.path === 'merge-base' ? null : `merge base ${mergeBase}, files ${files}, plan ${plan.path}`;
    }
    const head = commit('feature.txt', 'feature two');
    if (kind === 'range-diff') {
      const diff = git('range-diff', `${base}..${oldHead}`, `${base}..${head}`);
      const plan = planReviewStart({ mainMerged: false, savedReviewHead: oldHead, deltaChars: diff.length, deltaBudgetChars: 0 });
      return diff.includes('feature one') && diff.includes('feature two') && plan.path === 'full-rereview' ? null : `range-diff ${diff}, plan ${plan.path}`;
    }
    const verdict = { reviewed: true, verdict: 'pass', headCommit: oldHead };
    const moved = judgeReviewEnd({ headAtStart: oldHead, headNow: git('rev-parse', 'HEAD'), text: '', result: verdict });
    const stable = judgeReviewEnd({ headAtStart: oldHead, headNow: oldHead, text: '', result: verdict });
    return head !== oldHead && moved.action === 'requeue' && stable.action === 'record' ? null : `moved ${moved.action}, stable ${stable.action}`;
  } catch (error) { return `synthetic git failed: ${String(error)}`; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
