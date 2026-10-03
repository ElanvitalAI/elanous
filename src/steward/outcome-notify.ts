import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, extname, relative, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { notifyMissionDocument, notifyMissionOrigin } from '../autopilot/mission-notify.js';
import type { MissionOrigin } from '../autopilot/mission-origin.js';
import { redactSecrets } from '../task-cards/card-store.js';
import { loadDirectiveOrigins } from './directive.js';
import { saveLaunchLedger, type LaunchEntry, type LaunchLedger } from './launch.js';

export interface OutcomeNotifyDeps {
  root: string;
  ledger: LaunchLedger;
  shadow?: boolean;
  loadOrigin?: (root: string, issue: string) => MissionOrigin | null;
  loadOrigins?: typeof loadDirectiveOrigins;
  document?: typeof notifyMissionDocument;
  message?: typeof notifyMissionOrigin;
  worktreeCommand?: (args: string[]) => { exitCode: number; stdout: string };
}

const EXTENSIONS = new Set(['.md', '.pdf', '.png', '.jpg', '.csv', '.txt', '.html', '.json']);
const MAX_BYTES = 20 * 1024 * 1024;

function localArtifact(outcome: LaunchEntry, deps: OutcomeNotifyDeps): string | null {
  const ref = outcome.artifactRef;
  const branch = outcome.artifactBranch;
  if (!ref || !branch || isAbsolute(ref) || !EXTENSIONS.has(extname(ref).toLowerCase())) return null;
  const command = deps.worktreeCommand ?? ((args: string[]) => {
    const result = Bun.spawnSync(args, { cwd: resolve(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe' });
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  });
  try {
    const result = command(['git', 'worktree', 'list', '--porcelain']);
    if (result.exitCode !== 0) return null;
    for (const block of result.stdout.split(/\n\s*\n/)) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (!path || !block.split('\n').includes(`branch refs/heads/${branch}`) ||
          (outcome.artifactWorktree && !path.endsWith(outcome.artifactWorktree))) continue;
      try {
        const base = realpathSync(path);
        const file = realpathSync(resolve(base, ref));
        const inside = relative(base, file);
        if (!inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside)) continue;
        const stat = statSync(file);
        return stat.isFile() && stat.size <= MAX_BYTES ? file : null;
      } catch { /* Worktree or file is gone; try another matching worktree. */ }
    }
  } catch { /* No accessible worktree or artifact: use PR link instead. */ }
  return null;
}

/** Persist each conversation's delivery independently; only failed recipients retry (up to three times). */
export function notifyOutcome(outcome: LaunchEntry, deps: OutcomeNotifyDeps): LaunchEntry['notified'] {
  if (outcome.notified === 'shadow') return 'shadow';
  let origins: MissionOrigin[] = [];
  try {
    origins = deps.loadOrigin
      ? [deps.loadOrigin(deps.root, outcome.issue)].filter((item): item is MissionOrigin => item !== null)
      : (deps.loadOrigins ?? loadDirectiveOrigins)(deps.root, outcome.issue);
  } catch { /* Damaged or unavailable origin cannot route a result. */ }
  const recipients = new Map<string, MissionOrigin>();
  for (const origin of origins) {
    if (origin.channel !== 'telegram' || !Number.isSafeInteger(origin.chatId)) continue;
    const key = JSON.stringify([origin.chatId, origin.botId ?? null, origin.threadId ?? null]);
    recipients.set(key, origin);
  }
  if (outcome.notified === 'skipped-no-origin' && recipients.size === 0 && !deps.shadow) return outcome.notified;
  if (outcome.notified === 'sent' && !outcome.notifyRecipients) return 'sent';
  const file = outcome.status !== 'failed' && (recipients.size > 0 || deps.shadow) ? localArtifact(outcome, deps) : null;
  const kind = outcome.status === 'failed' ? 'failure' : file ? 'file' : 'link';
  let sent = false;
  if (deps.shadow) {
    outcome.notified = 'shadow';
    outcome.notifyPreview = { hasChatId: recipients.size > 0, kind: file ? 'file' : 'link' };
  } else if (recipients.size === 0) {
    outcome.notified = 'skipped-no-origin';
  } else {
    const title = redactSecrets(outcome.title).replace(/\s+/g, ' ').slice(0, 240);
    // Say what happened in plain words: an open PR is not a merge, and a run that left nothing is not a failure.
    const status = outcome.awaitingMerge ? 'PR 열림(병합 대기)' : outcome.status === 'merged' ? '병합됨'
      : outcome.status === 'completed' ? '완료(병합 없음)' : outcome.status;
    const pr = outcome.prNumber;
    const link = outcome.prUrl && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(outcome.prUrl) &&
      (pr === undefined || outcome.prUrl.endsWith(`/pull/${pr}`)) ? outcome.prUrl : undefined;
    const noOutput = outcome.status === 'completed' && !outcome.artifactRef && pr === undefined && !outcome.prUrl;
    const undeliverable = outcome.status !== 'failed' && !noOutput && !file && !link;
    const text = outcome.status === 'failed'
      ? `${title} · 실패 — ${redactSecrets(outcome.reason ?? '런 실패').split(/\r?\n/)[0]?.slice(0, 240) ?? '런 실패'}`
      : noOutput
        ? `${title} · ${status} — 남긴 파일·PR 없음`
        : undeliverable
        ? `${title} · ${status} · 산출물 전달 불가 — ${outcome.artifactRef ? '파일을 확인할 수 없습니다' : '검증된 PR 링크가 없습니다'}`
        : `${title} · ${status} · PR ${pr ?? '없음'} · ${link}`;
    const legacyAttempts = !outcome.notifyRecipients && outcome.notified === 'failed' ? outcome.notifyAttempts ?? 0 : 0;
    const progress = outcome.notifyRecipients ??= {};
    for (const [key, origin] of recipients) {
      const previous = progress[key] ?? (legacyAttempts ? { notified: 'failed' as const, attempts: legacyAttempts } : undefined);
      if (previous?.notified === 'sent' || (previous?.attempts ?? 0) >= 3) continue;
      let delivered = false;
      try {
        if (!undeliverable || !previous) {
          delivered = file ? (deps.document ?? notifyMissionDocument)(origin, file, redactSecrets(`${title} · ${status}`))
            : (deps.message ?? notifyMissionOrigin)(origin, redactSecrets(text));
        }
      } catch { /* A failed recipient remains eligible on a later tick. */ }
      progress[key] = { notified: delivered && !undeliverable ? 'sent' : 'failed', attempts: (previous?.attempts ?? 0) + 1 };
      sent ||= delivered && !undeliverable;
    }
    outcome.notifyAttempts = Math.max(0, ...Object.values(progress).map(item => item.attempts));
    outcome.notified = [...recipients.keys()].every(key => progress[key]?.notified === 'sent') ? 'sent' : 'failed';
  }
  saveLaunchLedger(deps.root, deps.ledger);
  debug.log('steward.outcome', 'notify', { cardId: `linear:${outcome.issue}`, issue: outcome.issue, kind, sent });
  return outcome.notified;
}
