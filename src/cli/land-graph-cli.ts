/**
 * `eln land …` — operator surface of the land graph (src/land-graph/land-graph.ts).
 *
 *   land graph status            mode · slots · holds · latest decision per PR · lands today
 *   land graph plan              decide every open PR now (no ledger, no cards, no merge)
 *   land graph tick              one pass (the trigger-registry graph graphs/triggers/land-graph.yaml calls this)
 *   land graph replay [--date]   graph decision vs the coach landings of that day (COACH-ACTIONS + coach-land-*.out/.log)
 *   land graph synth --seat X    shadow-only synthetic PR records (tagged synthetic) · cards go to seat X
 *   land hold <PR> --reason R    JUD/OP hold (re-checked right before the merge) · land unhold <PR>
 *
 * Mode is never a flag: live only when config `land.graph.mode` = live; otherwise shadow.
 */
import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { getElanousConfigDir, getElanousConfigDirOverride } from '../elanous-config-dir.js';
import { userConfigPath } from '../user-config.js';
import { landingOwner, mayRunLandOps } from '../org/land-authority.js';
import {
  clearHold, focusedCounts, isDocOnly, readHolds, readLedger, replayAttempt, SECURITY4, setHold, tickLand,
  type Focused, type LandDeps, type Mode, type PrInfo, type Receipt, type ReplayRow,
} from '../land-graph/land-graph.js';

interface LandConfig { orgPath?: unknown; repo?: unknown; mode?: unknown; slots?: unknown; cardSeat?: unknown; landCmd?: unknown; authors?: unknown }

function readConfig(): LandConfig {
  const path = getElanousConfigDirOverride() ? join(effectiveInstanceRoot(), 'config.json') : userConfigPath();
  try { return ((JSON.parse(readFileSync(path, 'utf8')) as { land?: { graph?: LandConfig } }).land?.graph) ?? {}; } catch { return {}; }
}
const seatState = () => process.env.ELANOUS_SEAT_STATE ?? join(homedir(), 'elanous-hq', 'seat-state');
const gh = () => process.env.LAND_GRAPH_GH ?? 'gh';
const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** owner/name from an origin URL (https or scp form) — same pattern as hq/repo-maintenance originRepoSlug. */
export function repoSlugFromUrl(url: string): string | null {
  const m = /(?:github\.com[:/])([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m?.[1] ?? null;
}

export interface LandRepo { root: string | null; slug: string | null }
/** Where the land graph's gh/git calls point — never the process cwd (the trigger runs from the installed package dir, not a git repo).
 *  root = config land.graph.repo, else the HQ repo clone when present. slug = GH_REPO, else root's origin URL. */
export function resolveLandRepo(o: { env?: NodeJS.ProcessEnv; cfgRepo?: unknown; defaultRoot?: string } = {}): LandRepo {
  const env = o.env ?? process.env;
  const cands = [typeof o.cfgRepo === 'string' ? o.cfgRepo : null, o.defaultRoot ?? null].filter((x): x is string => !!x);
  const root = cands.find(c => existsSync(c)) ?? null;
  const fromEnv = (env.GH_REPO ?? '').trim();
  if (fromEnv) return { root, slug: fromEnv };
  if (!root) return { root, slug: null };
  const out = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 10_000 });
  return { root, slug: out.status === 0 ? repoSlugFromUrl(out.stdout ?? '') : null };
}

/** gh argv + spawn cwd for one call: `--repo <slug>` when known, and cwd = repo root, so gh never depends on the caller's cwd. */
export function ghInvocation(args: string[], repo: LandRepo): { args: string[]; cwd?: string } {
  return { args: repo.slug ? [...args, '--repo', repo.slug] : args, ...(repo.root ? { cwd: repo.root } : {}) };
}

const hqRepo = () => join(homedir(), 'elanous-hq', 'repo.git');
const landTarget = (cfg: LandConfig = readConfig()) => resolveLandRepo({ cfgRepo: cfg.repo, defaultRoot: hqRepo() });

function ghJson(args: string[], repo: LandRepo): unknown {
  if (!repo.slug && !repo.root) throw new Error('no repo: set GH_REPO or config land.graph.repo (gh would read the cwd, which is the installed package)');
  const inv = ghInvocation(args, repo);
  const out = spawnSync(gh(), inv.args, { encoding: 'utf8', timeout: 60_000, ...(inv.cwd ? { cwd: inv.cwd } : {}) }); // Source: one gh call per PR list / re-read.
  if (out.status !== 0) throw new Error(`gh ${args[0]} ${args[1]} exit ${out.status}: ${(out.stderr || '').trim().slice(0, 160)}`);
  return JSON.parse(out.stdout);
}

interface GhPr { number: number; headRefOid: string; baseRefName: string; isDraft: boolean; state: string; title: string; author?: { login?: string }; files?: Array<{ path: string }> }
const FIELDS = 'number,headRefOid,baseRefName,isDraft,state,title,author,files';

function toPr(p: GhPr, authors: Record<string, string>): PrInfo {
  const login = p.author?.login ?? '';
  return { number: p.number, head: p.headRefOid, base: p.baseRefName, draft: p.isDraft, state: p.state as PrInfo['state'], title: p.title,
    author: authors[login] ?? 'OP', files: (p.files ?? []).map(f => f.path) };
}

function receiptDirs(pr: number): string[] {
  const root = join(seatState(), 'RES', 'evidence', 'PREGATE-GREEN');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(n => n.startsWith(`${pr}-`)).map(n => join(root, n));
}
interface RawReceipt { head?: unknown; host?: unknown; focused?: unknown; rawDir?: unknown; steps?: unknown; rawSha256?: unknown }
/** Receipt layout written by RES pregate.py (light and full): receipt.json with steps[] {name, exit} and rawSha256 {<stage>.raw: sha}. */
export function readReceipt(dir: string): Receipt | null {
  try {
    const r = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')) as RawReceipt;
    if (typeof r.head !== 'string') return null;
    const steps = Array.isArray(r.steps) ? r.steps as Array<{ name?: unknown; exit?: unknown }> : [];
    const step = steps.find(x => x && x.name === 'focused');
    const sha = r.rawSha256 && typeof r.rawSha256 === 'object' ? (r.rawSha256 as Record<string, unknown>)['focused.raw'] : undefined;
    return {
      dir, head: r.head,
      // `host` is the ssh alias (minim5 · node-b · gcp1); `actualHost` is the machine hostname and does not resolve over ssh.
      host: typeof r.host === 'string' && r.host ? r.host : 'minim5',
      focused: Array.isArray(r.focused) ? r.focused.filter((x): x is string => typeof x === 'string') : [],
      rawDir: typeof r.rawDir === 'string' ? r.rawDir : '',
      focusedExit: step && typeof step.exit === 'number' ? step.exit : null,
      ...(typeof sha === 'string' ? { focusedSha: sha } : {}),
    };
  } catch { return null; }
}

/** Local copies of focused.raw a receipt dir may carry (seat mirrors: <dir>/focused.raw · raws/ · raw/), then the host temp rawDir. */
export function localFocusedRaw(r: Receipt): string | null {
  const cands = [join(r.dir, 'focused.raw'), join(r.dir, 'raws', 'focused.raw'), join(r.dir, 'raw', 'focused.raw'), ...(r.rawDir ? [join(r.rawDir, 'focused.raw')] : [])];
  for (const p of cands) {
    try {
      if (!statSync(p).isFile()) continue;
      const buf = readFileSync(p);
      if (r.focusedSha && createHash('sha256').update(buf).digest('hex') !== r.focusedSha) continue; // a copy from another run is not this receipt's raw
      return buf.toString('utf8');
    } catch { /* missing → next */ }
  }
  return null;
}

/** Remote raw read: same command and 30 s bound as coach-land.sh. Returns stdout, or null when ssh/grep failed (raw gone, host down). */
export type RemoteGrep = (host: string, rawDir: string) => { ok: boolean; stdout: string; missing: boolean };
const sshGrep: RemoteGrep = (host, rawDir) => {
  const out = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host,
    `f='${rawDir}/focused.raw'; [ -f "$f" ] || { echo RAW-MISSING; exit 3; }; grep -hE '^ ?[0-9]+ (pass|fail)' "$f"`],
  { encoding: 'utf8', timeout: 30_000 }); // Source: coach-land.sh reads the raw the same way (30 s bound).
  return { ok: out.status === 0, stdout: out.stdout ?? '', missing: out.status === 3 && /RAW-MISSING/.test(out.stdout ?? '') };
};

/**
 * Focused pass/fail of a receipt: local raw (SHA-checked) → ssh to the receipt host → the receipt's own focused step exit.
 * pregate.py keeps raws only in a host temp dir (mkdtemp res-a161-*) that the host sweeps within hours; the GREEN lane
 * mirrors receipt.json + SUMMARY.json only. When the raw is gone the step exit is all that is left (`swept`).
 */
export function readFocused(r: Receipt, remote: RemoteGrep = sshGrep): Focused {
  const local = localFocusedRaw(r);
  if (local !== null) return parseFocused(local);
  if (r.rawDir) {
    const out = remote(r.host, r.rawDir);
    if (out.ok) return parseFocused(out.stdout);
    if (!out.missing) return 'unreadable'; // host unreachable: the raw may still be there
  }
  return typeof r.focusedExit === 'number' ? { swept: true, exit: r.focusedExit } : 'unreadable';
}

export function parseFocused(text: string): Focused {
  // bun summary lines: « 26 pass» / « 0 fail» (one leading space). Last match wins — a raw may hold a baseline run first.
  const last = (re: RegExp) => { let m: RegExpExecArray | null = null; for (const x of text.matchAll(re)) m = x; return m; };
  const pass = last(/^\s*(\d+) pass\s*$/gm); const fail = last(/^\s*(\d+) fail\s*$/gm);
  return pass ? { pass: Number(pass[1]), fail: fail ? Number(fail[1]) : 0 } : 'unreadable';
}

export function defaultLandDeps(over: Partial<LandDeps> = {}): LandDeps {
  const cfg = readConfig();
  const authors = (cfg.authors && typeof cfg.authors === 'object' ? cfg.authors : {}) as Record<string, string>;
  const mode: Mode = cfg.mode === 'live' ? 'live' : 'shadow';
  const slots = typeof cfg.slots === 'number' && cfg.slots > 0 ? cfg.slots : 1; // single-flight by default: one merge at a time
  const target = landTarget(cfg);
  const repoCwd = target.root ?? process.cwd();
  return {
    now: () => new Date(),
    stateRoot: effectiveInstanceRoot(),
    mode, slots,
    ...(typeof cfg.orgPath === 'string' ? { org: { path: cfg.orgPath } } : {}),
    ...(typeof cfg.cardSeat === 'string' ? { cardSeat: cfg.cardSeat } : {}),
    async listPrs() {
      return (ghJson(['pr', 'list', '--state', 'open', '--limit', '100', '--json', FIELDS], target) as GhPr[]).map(p => toPr(p, authors));
    },
    async prNow(n) { return toPr(ghJson(['pr', 'view', String(n), '--json', FIELDS], target) as GhPr, authors); },
    receipt(pr, head) {
      // Several hosts may hold a same-head receipt (…-minim5 · …-node-b): prefer one whose focused raw is still readable locally.
      const rs = receiptDirs(pr).filter(d => d.split('/').pop()!.startsWith(`${pr}-${head.slice(0, 12)}-`))
        .map(readReceipt).filter((r): r is Receipt => !!r && r.head === head);
      return rs.find(r => localFocusedRaw(r) !== null) ?? rs[0] ?? null;
    },
    olderReceiptHead(pr, head) {
      const rs = receiptDirs(pr).map(readReceipt).filter((r): r is Receipt => !!r && r.head !== head);
      return rs.length ? rs[rs.length - 1]!.head : null;
    },
    focused: r => readFocused(r),
    security(pr, head) {
      const f = join(getElanousConfigDir(), 'review-results', `pr-${pr}-${head.slice(0, 12)}.json`);
      try {
        const j = JSON.parse(readFileSync(f, 'utf8')) as { findings?: Array<{ category?: string; disposition?: string; title?: string }> };
        return (j.findings ?? []).filter(x => SECURITY4.includes(String(x.category ?? '').toLowerCase()) && !x.disposition).map(x => `${x.category}:${x.title ?? ''}`.slice(0, 80));
      } catch { return []; }
    },
    async land(pr, r, why) {
      const e = join(seatState(), 'OP', 'evidence', ymd(new Date())); mkdirSync(e, { recursive: true });
      const extra = join(e, `land-graph-extra-${pr.number}.json`);
      const focused = this.focused(r);
      const pass = focusedCounts(focused)?.pass ?? 0;
      writeFileSync(extra, JSON.stringify({ receipt: join(r.dir, 'receipt.json'), note: `land-graph (판정국 자치) · ${why}`,
        headTestRun: { sha: pr.head, command: `bun test ${r.focused.join(' ')}`, pass, fail: 0, exit: 0, receipt: join(r.dir, 'receipt.json') } }));
      const cmd = typeof cfg.landCmd === 'string' ? cfg.landCmd : join(seatState(), 'OP', 'tools', 'op-direct-land-v2.sh');
      const out = spawnSync('zsh', [cmd, String(pr.number), pr.head, `land-graph 착지 · ${why}`, extra],
        { encoding: 'utf8', cwd: repoCwd, env: { ...process.env, ...(target.slug ? { GH_REPO: target.slug } : {}), LAND_RATCHET_HOST: 'minim5', LAND_TSC_HOSTS: 'minim5' }, timeout: 40 * 60_000 }); // Source: v2 preflight ≤ ~30 min on minim5.
      const text = `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
      appendFileSync(join(e, `land-graph-${pr.number}.log`), text);
      return { rc: out.status ?? 99, text };
    },
    staleRevert(pr) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { detectStaleBaseRevert } = require('../land-guard/stale-base-revert.js') as typeof import('../land-guard/stale-base-revert.js');
      const cwd = repoCwd;
      const g = (args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 120_000 }); // Source: one fetch of main + the PR head.
      const f = g(['fetch', '-q', 'origin']);
      if (f.status !== 0) return { ok: false, why: `fetch failed: ${(f.stderr ?? '').trim().slice(0, 120)}` };
      if (g(['cat-file', '-e', `${pr.head}^{commit}`]).status !== 0) g(['fetch', '-q', 'origin', `pull/${pr.number}/head`]);
      const r = detectStaleBaseRevert(cwd, 'origin/main', pr.head);
      return r.ok ? { ok: true } : { ok: false, why: r.hits.map(h => `${h.file}←${h.commit.slice(0, 10)}`).join(', ').slice(0, 200) };
    },
    post(to, body) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { openMsgStore } = require('../msg/msg-store.js') as typeof import('../msg/msg-store.js');
      const store = openMsgStore();
      try { store.post({ from: 'land-graph', to, kind: 'info', body } as Parameters<typeof store.post>[0]); } finally { store.close(); }
    },
    record(line) {
      appendFileSync(join(seatState(), 'OP', `COACH-ACTIONS-${ymd(new Date())}.md`), `- ${line}\n`);
    },
    ...over,
  };
}

// ── Replay ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One row per recorded coach-land attempt (.out file) of `date`, in file order. */
export function replayDay(dir: string, files: (pr: number) => string[]): ReplayRow[] {
  if (!existsSync(dir)) return [];
  const outs = readdirSync(dir).filter(n => /^coach-land-\d+[a-z]?\.out$/.test(n)).sort();
  const rows: ReplayRow[] = [];
  for (const n of outs) {
    const m = /^coach-land-(\d+)([a-z]?)\.out$/.exec(n)!; const pr = Number(m[1]);
    const out = readFileSync(join(dir, n), 'utf8');
    const log = join(dir, `coach-land-${pr}${m[2]}.log`);
    // A later attempt (b/c…) rewrites the bare .log — use it only for the newest attempt of the PR.
    const newest = !outs.some(o => o > n && o.startsWith(`coach-land-${pr}`) && /^coach-land-\d+[a-z]?\.out$/.test(o) && Number(/\d+/.exec(o)![0]) === pr);
    const text = out + (existsSync(log) && (m[2] || newest) ? `\n${readFileSync(log, 'utf8')}` : '');
    const line = /· rc=(\d+) · (MERGED|OPEN|CLOSED)/.exec(out);
    const rc = line ? Number(line[1]) : Number(/^RC=(\d+)/m.exec(out)?.[1] ?? 1);
    const state = line ? line[2]! : 'OPEN';
    // A coach pre-check STOP prints only «STOP …» (no ledger line).
    if (!line && !/STOP/.test(out)) continue;
    rows.push(replayAttempt(pr, n.replace(/\.out$/, ''), rc, state, text, isDocOnly(files(pr))));
  }
  return rows;
}

export function replayMarkdown(rows: ReplayRow[]): string {
  const lines = ['| PR | attempt | actual | graph | class | match |', '|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| #${r.pr} | ${r.attempt} | ${r.actual} | ${r.graph} | ${r.cls ?? ''} | ${r.match ? '✓' : `✗ ${r.note ?? ''}`} |`);
  const m = rows.filter(r => r.match).length;
  lines.push('', `${m}/${rows.length} match · lands ${rows.filter(r => r.actual === 'MERGED').length} · STOPs ${rows.filter(r => r.actual !== 'MERGED').length}`);
  return lines.join('\n');
}

// ── Synthetic shadow injection ─────────────────────────────────────────────────────────────────────────────────

export const SYNTH_HEAD = (n: number) => `${String(n).padStart(4, '0')}${'5'.repeat(36)}`;
export function synthPrs(): { prs: PrInfo[]; receipts: Record<number, Receipt>; focused: Record<number, Focused>; older: Record<number, string>; security: Record<number, string[]> } {
  const base = { base: 'main', draft: false, state: 'OPEN' as const, author: 'SYNTH' };
  const prs: PrInfo[] = [
    { ...base, number: 990001, head: SYNTH_HEAD(1), title: 'synthetic: clean land', files: ['src/a.ts'] },
    { ...base, number: 990002, head: SYNTH_HEAD(2), title: 'synthetic: stale head', files: ['src/b.ts'] },
    { ...base, number: 990003, head: SYNTH_HEAD(3), title: 'synthetic: baseline-failing focused', files: ['src/c.ts'] },
    { ...base, number: 990004, head: SYNTH_HEAD(4), title: 'synthetic: doc-only', files: ['docs/x.md'] },
    { ...base, number: 990005, head: SYNTH_HEAD(5), title: 'synthetic: hot file', files: ['src/index.ts'] },
  ];
  const r = (n: number, focused: string[]): Receipt => ({ dir: `synthetic/${n}`, head: SYNTH_HEAD(n % 10), host: 'synthetic', focused, rawDir: '' });
  return {
    prs,
    receipts: { 990001: r(990001, ['src/a.test.ts']), 990003: r(990003, ['src/c.test.ts']), 990004: r(990004, []), 990005: r(990005, ['src/i.test.ts']) },
    focused: { 990001: { pass: 12, fail: 0 }, 990003: { pass: 40, fail: 3 }, 990005: { pass: 5, fail: 0 } },
    older: { 990002: 'f'.repeat(40) },
    security: {},
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────────

function emit(v: unknown, json: boolean, text: () => string): void { console.log(json ? JSON.stringify(v) : text()); }
function handle(fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(fn).catch(e => { console.error(`land: ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
}

export function registerLandCommands(program: Command, deps: () => LandDeps = () => defaultLandDeps()): void {
  const land = program.command('land').description('Land graph — judge → land under judge-kingdom autonomy (shadow by default)');
  const graph = land.command('graph').description('Land graph status · plan · tick · replay · synth');
  graph.command('status').option('--json').action((o: { json?: boolean }) => handle(() => {
    const d = deps(); const rows = readLedger(d.stateRoot).filter(r => !r.synthetic);
    const latest = new Map<number, (typeof rows)[number]>();
    for (const r of rows) if (r.event === 'decision' || r.event === 'refused' || r.event === 'landed') latest.set(r.pr, r);
    const today = new Date().toISOString().slice(0, 10);
    const v = { mode: d.mode, slots: d.slots, holds: readHolds(d.stateRoot), landedToday: rows.filter(r => r.event === 'landed' && r.at.startsWith(today)).map(r => r.pr), latest: [...latest.values()] };
    emit(v, !!o.json, () => [`land graph · mode ${v.mode} · slots ${v.slots} · landed today ${v.landedToday.length}`,
      ...Object.entries(v.holds).map(([pr, h]) => `HOLD #${pr} · ${h.reason} (${h.by})`),
      ...v.latest.map(r => `#${r.pr} @${r.head.slice(0, 12)} ${r.event === 'decision' ? r.action : r.event}${r.cls ? ` ${r.cls}` : ''} · ${r.why ?? ''}`)].join('\n'));
  }));
  graph.command('plan').option('--json').action((o: { json?: boolean }) => handle(async () => {
    const res = await tickLand({ ...deps(), dry: true });
    emit(res, !!o.json, () => [`plan · mode ${res.mode}${res.error ? ` · ${res.error}` : ''}`, ...res.decisions.map(x => `#${x.pr} ${x.action}${x.cls ? ` ${x.cls}` : ''} · ${x.why}`)].join('\n'));
    if (res.error) process.exitCode = 1;
  }));
  graph.command('tick').option('--json').action((o: { json?: boolean }) => handle(async () => {
    const d = deps();
    // Land ops: landing owner (org duty «landing») or the HQ seat; the trigger runs as the landing owner.
    const seat = process.env.ELANOUS_TRACK ?? landingOwner();
    const res = d.mode === 'live' && !mayRunLandOps(seat) ? { ...(await tickLand({ ...d, mode: 'shadow' })), error: `seat ${seat} may not run land ops (live → shadow)` } : await tickLand(d);
    emit(res, !!o.json, () => res.locked ? 'tick: another tick holds the lock' : [`tick · mode ${res.mode} · landed ${res.landed.join(',') || '—'}${res.error ? ` · ${res.error}` : ''}`,
      ...res.decisions.map(x => `#${x.pr} ${x.action}${x.cls ? ` ${x.cls}` : ''} · ${x.why}`)].join('\n'));
    if (res.error) process.exitCode = 1;
  }));
  graph.command('replay').option('--date <yyyymmdd>', 'evidence day', '20261125').option('--json').action((o: { date: string; json?: boolean }) => handle(() => {
    const dir = join(seatState(), 'OP', 'evidence', o.date);
    const cache = new Map<number, string[]>();
    const target = landTarget();
    const files = (pr: number) => {
      if (!cache.has(pr)) { try { cache.set(pr, ((ghJson(['pr', 'view', String(pr), '--json', 'files'], target) as GhPr).files ?? []).map(f => f.path)); } catch { cache.set(pr, []); } }
      return cache.get(pr)!;
    };
    const rows = replayDay(dir, files);
    emit(rows, !!o.json, () => replayMarkdown(rows));
  }));
  graph.command('synth').requiredOption('--seat <seat>', 'test seat that receives the shadow cards (never JUD)').option('--json').action((o: { seat: string; json?: boolean }) => handle(async () => {
    if (/^(JUD|OP)$/i.test(o.seat)) throw new Error('synth cards go to a test seat, not JUD/OP');
    const s = synthPrs(); const base = deps();
    const res = await tickLand({ ...base, mode: 'shadow', synthetic: true, cardSeat: o.seat,
      listPrs: async () => s.prs, prNow: async n => s.prs.find(p => p.number === n) ?? null,
      receipt: pr => s.receipts[pr] ?? null, olderReceiptHead: pr => s.older[pr] ?? null,
      focused: r => s.focused[Number(r.dir.split('/')[1])] ?? 'unreadable', security: pr => s.security[pr] ?? [],
      land: async () => { throw new Error('synthetic never lands'); } });
    emit(res, !!o.json, () => res.decisions.map(x => `[synthetic] #${x.pr} ${x.action}${x.cls ? ` ${x.cls}` : ''} · ${x.why}`).join('\n'));
  }));
  land.command('hold <pr>').requiredOption('--reason <text>').option('--by <seat>', 'who holds', process.env.ELANOUS_TRACK ?? 'JUD')
    .action((pr: string, o: { reason: string; by: string }) => handle(() => { setHold(deps().stateRoot, Number(pr), o.reason, o.by); console.log(`HOLD #${pr} · ${o.reason}`); }));
  land.command('unhold <pr>').action((pr: string) => handle(() => { console.log(clearHold(deps().stateRoot, Number(pr)) ? `unhold #${pr}` : `#${pr} was not held`); }));
}
