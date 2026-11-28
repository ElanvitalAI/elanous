// 대식세포 (macrophage) · 쓰레기 관측 — report only (Terra #40447 must-fix 4 · v2 report parity). The delegated body reaps
// through the guardian reaper (decision 11-27 «one reaper»); the v2 card also SAW finished one-shot launchd jobs, past-dated
// crontab lines, stale clean worktrees and old stash entries. Those observations stay here as fact lines — no subject, no
// action (bootout / prune were never granted: the card's rights are [reap]); acting on them is RES's / the guardian's call.
//
// 세 얼굴: 관측 = `launchctl list` ⊕ com.elanous.* / ai.elanous.* LaunchAgents plists ⊕ `crontab -l` ⊕ `git worktree list` of the
// HQ repo ⊕ `git stash list` (each null = «모름») / 판단 근거 = the same pure classifiers as the v2 card (one-shot fire time +
// 24 h grace · numeric-date cron lines · 14-day clean worktree under a known root · 14-day stash) / 수복과 인계 = none here —
// the lines go into the tick case, the voice and the KPI-breach card; the guardian's maintenance window owns the cleanup.
import { pn } from '../policy-context.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';


export interface LaunchdJob {
  readonly label: string;
  readonly plistPath: string;
  /** Calendar fire time of a one-shot job (ms) — null when the plist is not a one-shot. */
  readonly oneShotAtMs: number | null;
  readonly loaded: boolean;
}
export interface WorktreeInfo { readonly path: string; readonly branch: string | null; readonly head: string; readonly lastCommitMs: number | null; readonly clean: boolean | null }
export interface StashInfo { readonly ref: string; readonly atMs: number; readonly subject: string }

/** Read-only scrap readers (null = could not read → «모름»). */
export interface ScrapDeps {
  launchdJobs(nowMs: number): LaunchdJob[] | null;
  crontab(): string | null;
  worktrees(nowMs: number): WorktreeInfo[] | null;
  stashes(): StashInfo[] | null;
  knownWorktreePath(path: string): boolean;
}

const ELANOUS_LABEL = /^(?:com|ai)\.elanous\./u;

/**
 * Calendar fire time of a one-shot plist: a single StartCalendarInterval dict naming Month ⊕ Day, no KeepAlive /
 * RunAtLoad / StartInterval / WatchPaths. launchd has no year — the year is the one in which the plist was written
 * (mtime); a date before the write rolls to the next year.
 */
export function oneShotFireAt(plist: Record<string, unknown>, mtimeMs: number): number | null {
  const cal = plist.StartCalendarInterval;
  if (!cal || typeof cal !== 'object' || Array.isArray(cal)) return null;
  if (plist.KeepAlive || plist.RunAtLoad === true || plist.StartInterval !== undefined || plist.WatchPaths !== undefined || plist.QueueDirectories !== undefined) return null;
  const c = cal as Record<string, unknown>;
  if (typeof c.Month !== 'number' || typeof c.Day !== 'number') return null;
  const hour = typeof c.Hour === 'number' ? c.Hour : 0; const minute = typeof c.Minute === 'number' ? c.Minute : 0;
  const year = new Date(mtimeMs).getFullYear();
  let at = new Date(year, c.Month - 1, c.Day, hour, minute).getTime();
  if (at < mtimeMs - pn('oneshot_grace_h') * 3_600_000) at = new Date(year + 1, c.Month - 1, c.Day, hour, minute).getTime();
  return at;
}
export const pastOneShots = (jobs: readonly LaunchdJob[], nowMs: number): LaunchdJob[] =>
  jobs.filter(j => ELANOUS_LABEL.test(j.label) && j.oneShotAtMs !== null && nowMs - j.oneShotAtMs > pn('oneshot_grace_h') * 3_600_000);

/** Crontab lines pinned to one calendar date (numeric day-of-month AND month) whose date this year is more than a day past. */
export function pastCronLines(text: string, nowMs: number): Array<{ line: number; text: string; atMs: number }> {
  const out: Array<{ line: number; text: string; atMs: number }> = [];
  const year = new Date(nowMs).getFullYear();
  text.split('\n').forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith('#')) return;
    const m = /^(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+\S+\s+/u.exec(t);
    if (!m) return;
    const at = new Date(year, Number(m[4]) - 1, Number(m[3]), Number(m[2]), Number(m[1])).getTime();
    if (nowMs - at > pn('oneshot_grace_h') * 3_600_000) out.push({ line: i + 1, text: t.slice(0, 160), atMs: at });
  });
  return out;
}

/** Worktrees prune may remove: under a known root · on a branch (the undo re-adds it) · clean · last commit > 14 days. */
export function staleWorktrees(wts: readonly WorktreeInfo[], nowMs: number, known: (p: string) => boolean): WorktreeInfo[] {
  const cut = nowMs - pn('stale_worktree_days') * 86_400_000;
  return wts.filter(w => known(w.path) && w.branch !== null && w.clean === true && w.lastCommitMs !== null && w.lastCommitMs < cut)
    .sort((a, b) => (a.lastCommitMs ?? 0) - (b.lastCommitMs ?? 0));
}

/** Known worktree roots on the HQ host (OPS-RULES «가지·작업 트리 14일 정리» · seats' agent worktrees). */
export function knownWorktreePathFor(home: string): (path: string) => boolean {
  const roots = [join(home, 'elanous-hq', 'worktrees'), join(home, 'elanous-hq', 'work'), join(home, 'elanous-hq', 'repo.git', '.claude', 'wt')];
  const seatWt = new RegExp(`^${join(home, 'elanous-hq', 'seats').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/[^/]+/\\.claude/wt/[^/]+$`, 'u');
  return (path: string) => !path.includes('..') && (roots.some(r => path.startsWith(`${r}/`) && path.length > r.length + 1) || seatWt.test(path));
}


/** The v2 report lines: one-shot launchd ⊕ past cron · stale worktrees ⊕ old stashes (counts · «모름» when unreadable). */
export function scrapFacts(deps: ScrapDeps, nowMs: number): string[] {
  const safe = <T,>(fn: () => T | null): T | null => { try { return fn(); } catch { return null; } };
  const jobs = safe(() => deps.launchdJobs(nowMs)); const past = jobs ? pastOneShots(jobs, nowMs) : null;
  const cron = safe(() => deps.crontab()); const cronPast = cron === null ? null : pastCronLines(cron, nowMs);
  const wts = safe(() => deps.worktrees(nowMs));
  // an old worktree under a known root whose `git status` could not be read = the worktree observation «모름» (no partial count)
  const cut = nowMs - pn('stale_worktree_days') * 86_400_000;
  const unreadable = wts?.some(w => deps.knownWorktreePath(w.path) && w.branch !== null && w.lastCommitMs !== null && w.lastCommitMs < cut && w.clean === null) ?? false;
  const old = wts && !unreadable ? staleWorktrees(wts, nowMs, p => deps.knownWorktreePath(p)) : null;
  const st = safe(() => deps.stashes()); const oldStash = st ? st.filter(s => nowMs - s.atMs > pn('stale_stash_days') * 86_400_000) : null;
  const unk = (v: number | null): string => (v === null ? '모름' : String(v));
  return [
    `지난 일회성 launchd ${unk(past?.length ?? null)}${past?.length ? ` (${past.slice(0, 3).map(j => j.label).join(', ')}${past.length > 3 ? ` 외 ${past.length - 3}` : ''})` : ''} · 지난 날짜 크론 ${unk(cronPast?.length ?? null)}(보고만 · crontab 편집은 RES)`,
    `${pn('stale_worktree_days')}일 넘은 깨끗한 worktree ${unk(old?.length ?? null)} · ${pn('stale_stash_days')}일 넘은 stash ${unk(oldStash?.length ?? null)}(보고만 · 정리는 수호자 정비 창)`,
  ];
}

function sh(cmd: string, args: readonly string[], timeoutMs = 20_000): string | null {
  try {
    const r = spawnSync(cmd, [...args], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return r.status === 0 ? r.stdout ?? '' : null;
  } catch { return null; }
}

export function liveScrapDeps(opts: { home?: string; repo?: string } = {}): ScrapDeps {
  const home = opts.home ?? homedir();
  const repo = opts.repo ?? process.env.ELANOUS_HQ_REPO ?? join(home, 'elanous-hq', 'repo.git');
  const agentsDir = join(home, 'Library', 'LaunchAgents');
  const known = knownWorktreePathFor(home);
  const launchctlList = (): Map<string, number | null> | null => {
    const out = sh('launchctl', ['list']);
    if (out === null) return null;
    const m = new Map<string, number | null>();
    for (const line of out.split('\n').slice(1)) {
      const [pid, , label] = line.split('\t');
      if (label) m.set(label.trim(), pid && /^\d+$/u.test(pid.trim()) ? Number(pid.trim()) : null);
    }
    return m;
  };
  return {
    launchdJobs: () => {
      try {
        const loaded = launchctlList();
        if (!loaded || !existsSync(agentsDir)) return null;
        const jobs: LaunchdJob[] = [];
        for (const f of readdirSync(agentsDir)) {
          if (!/^(?:com|ai)\.elanous\.[\w.-]+\.plist$/u.test(f)) continue;
          const path = join(agentsDir, f);
          // one plist that cannot be read = the whole launchd observation «모름» (Terra #40447 r2 — never a partial 0)
          const json = sh('plutil', ['-convert', 'json', '-o', '-', path], 5_000);
          if (json === null) return null;
          let plist: Record<string, unknown>;
          try { plist = JSON.parse(json) as Record<string, unknown>; } catch { return null; }
          const label = typeof plist.Label === 'string' ? plist.Label : f.slice(0, -6);
          jobs.push({ label, plistPath: path, oneShotAtMs: oneShotFireAt(plist, statSync(path).mtimeMs), loaded: loaded.has(label) });
        }
        return jobs;
      } catch { return null; }
    },
    crontab: () => sh('crontab', ['-l']),
    worktrees: () => {
      const out = sh('git', ['-C', repo, 'worktree', 'list', '--porcelain']);
      if (out === null) return null;
      const raw: Array<{ path: string; head: string; branch: string | null }> = [];
      for (const block of out.split('\n\n')) {
        const path = /^worktree (.+)$/mu.exec(block)?.[1]; const head = /^HEAD ([0-9a-f]{7,64})$/mu.exec(block)?.[1];
        if (!path || !head || /^bare$/mu.test(block)) continue;
        const branch = /^branch refs\/heads\/(.+)$/mu.exec(block)?.[1] ?? null;
        raw.push({ path, head, branch });
      }
      const cand = raw.filter(r => known(r.path) && r.branch !== null);
      // one batched `git log --no-walk` for every head, then `git status` only for the old ones
      const times = new Map<string, number>();
      for (let i = 0; i < cand.length; i += 200) {
        const shas = [...new Set(cand.slice(i, i + 200).map(c => c.head))];
        const log = sh('git', ['-C', repo, 'log', '--no-walk=unsorted', '--format=%H %ct', ...shas], 60_000);
        if (log === null) return null;
        for (const l of log.split('\n')) { const [sha, ct] = l.split(' '); if (sha && ct) times.set(sha, Number(ct) * 1000); }
      }
      const cut = Date.now() - pn('stale_worktree_days') * 86_400_000;
      return raw.map(r => {
        const last = times.get(r.head) ?? null;
        let clean: boolean | null = null;
        if (cand.includes(r) && last !== null && last < cut) {
          // a registered worktree whose directory is gone is not a clean old tree (git calls it prunable) — not «모름» either
          if (!existsSync(r.path)) clean = false;
          else { const st = sh('git', ['-C', r.path, 'status', '--porcelain', '--untracked-files=normal'], 30_000); clean = st === null ? null : st.trim() === ''; }
        }
        return { path: r.path, branch: r.branch, head: r.head, lastCommitMs: last, clean };
      });
    },
    stashes: () => {
      const out = sh('git', ['-C', repo, 'stash', 'list', '--format=%gd %ct %gs']);
      if (out === null) return null;
      return out.split('\n').flatMap(l => { const m = /^(\S+) (\d+) (.*)$/u.exec(l); return m ? [{ ref: m[1]!, atMs: Number(m[2]) * 1000, subject: m[3]! }] : []; });
    },
    knownWorktreePath: known,
  };
}
