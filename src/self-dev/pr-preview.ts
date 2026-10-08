import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface PreviewOptions {
  target: string;
  repoRoot: string;
  scenario?: string;
  /** Main-based combined preview: only existing config paths may be enabled. */
  flags?: readonly string[];
  /** PR heads to preview together on main when no feature flags exist. */
  bundlePrs?: readonly number[];
  commentPr?: number;
}
export interface PreviewResult {
  target: string;
  head: string;
  scenario: string;
  status: 'passed' | 'friction';
  report: string;
  prNumber?: number;
  commented: boolean;
}
export function readPreviewResult(directory: string): PreviewResult | null {
  try {
    const value = JSON.parse(readFileSync(join(directory, 'preview-result.json'), 'utf8')) as PreviewResult;
    return value && (value.status === 'passed' || value.status === 'friction') && typeof value.head === 'string' ? value : null;
  } catch { return null; }
}

export interface PreviewDeps {
  run?: (command: string, args: readonly string[], cwd: string, timeoutMs?: number) => { status: number | null; stdout: string; stderr: string };
  makeDir?: () => string;
  dispose?: (directory: string) => void;
  wait?: (ms: number) => Promise<void>;
  /** Probe a test-mode daemon without injecting a global HTTP client into the command runner. */
  probePwa?: (url: string) => Promise<boolean>;
}

const SCENARIOS: Record<string, { input: string; expected: string; matches: (snapshot: string) => boolean }> = {
  // GOODHART (#24844 review): a group head (`▸ 시작`) or the echoed `/help` is not the list. The /help modal
  // (help-from-registry.ts) prints one `/name  description` row per command; the «시작» group alone has six.
  // Pass only when at least three other start-group commands are listed as rows.
  S2: { input: '/help', expected: 'help command list (/status, /model, /clear ... rows)', matches: (s) =>
    ['status', 'model', 'clear', 'new', 'resume'].filter((name) => new RegExp(`(?:^|\\s)/${name}(?: \\([^)]*\\))?\\s{2,}\\S`, 'mu').test(s)).length >= 3 },
  S3: { input: '/status', expected: 'model and connection', matches: (s) => /모델|model/iu.test(s) && /연결|connection/iu.test(s) },
  S6: { input: '/now', expected: 'current runs or schedules', matches: (s) => /지금|도는 런|스케줄|running|schedule/iu.test(s) },
  S7: { input: '/term list', expected: 'terminal/PTY list', matches: (s) => /terminal|pty|터미널/iu.test(s) },
  S8: { input: '/model', expected: 'model choices', matches: (s) => /빠름|보통|깊음|terra|sol|luna|선택/iu.test(s) },
  S9: { input: '/harness', expected: 'harness usage or stages', matches: (s) => /usage:.*harness|저작|구현|리뷰|착지/iu.test(s) },
};

/**
 * Lines of `after` that were not already on `before`'s screen (multiset by line, trailing spaces ignored).
 * A prefix check is not enough: the PTY re-renders and scrolls, so the previous scenario's answer can
 * reappear anywhere on the next screen (#24844 review). A repeated line is conservatively treated as old.
 */
export function previewFreshLines(before: string, after: string): string {
  const seen = new Map<string, number>();
  for (const line of before.split('\n')) {
    const key = line.trimEnd();
    if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return after.split('\n').filter((line) => {
    const key = line.trimEnd();
    if (!key) return false;
    const left = seen.get(key) ?? 0;
    if (left > 0) { seen.set(key, left - 1); return false; }
    return true;
  }).join('\n');
}

/** Whether a fresh screen region shows the scenario's expected answer (exported for the preview tests). */
export function previewScenarioMatches(scenario: string, fresh: string): boolean {
  const entry = Object.hasOwn(SCENARIOS, scenario) ? SCENARIOS[scenario] : undefined;
  if (!entry) throw new Error(`TUI-COMFORT §4: unsupported scenario ${scenario}`);
  return entry.matches(fresh);
}

export function previewScenarioInput(scenario: string): string {
  const text = Object.hasOwn(SCENARIOS, scenario) ? SCENARIOS[scenario] : undefined;
  if (!text) throw new Error(`TUI-COMFORT §4: unsupported scenario ${scenario}; available: ${Object.keys(SCENARIOS).join(', ')}`);
  return text.input;
}

const defaultRun: NonNullable<PreviewDeps['run']> = (command, args, cwd, timeoutMs = 120_000) => {
  const r = spawnSync(command, [...args], { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
};

/** Build and exercise a detached head, never the caller's checkout. The report is posted only after measurement. */
export async function runPrPreview(options: PreviewOptions, deps: PreviewDeps = {}): Promise<PreviewResult> {
  const run = deps.run ?? defaultRun;
  const root = resolve(options.repoRoot);
  const target = options.target.trim();
  if (!target || target.startsWith('-') || /[\s\x00-\x1f]/u.test(target)) throw new Error('preview: invalid PR number or branch');
  const isPr = /^[1-9]\d*$/u.test(target);
  if (isPr && !Number.isSafeInteger(Number(target))) throw new Error('preview: invalid PR number');
  if (/^\d+$/u.test(target) && !isPr) throw new Error('preview: invalid PR number');
  if (options.commentPr !== undefined && (!Number.isSafeInteger(options.commentPr) || options.commentPr <= 0)) throw new Error('preview: invalid --comment-pr');
  const bundlePrs = options.bundlePrs ?? [];
  if (bundlePrs.length && (target !== 'main' || (options.flags?.length ?? 0) > 0)) throw new Error('preview: --bundle-pr requires main without feature flags');
  if (bundlePrs.length && (new Set(bundlePrs).size !== bundlePrs.length || bundlePrs.some((pr) => !Number.isSafeInteger(pr) || pr <= 0))) throw new Error('preview: invalid or duplicate --bundle-pr');
  if (target === 'main' && options.commentPr === undefined) throw new Error('preview: main ⊕ flags requires --comment-pr <PR number> to publish the result');
  if (isPr && options.commentPr !== undefined && options.commentPr !== Number(target)) throw new Error('preview: --comment-pr must match the target PR');
  const flags = options.flags ?? [];
  if (flags.length && target !== 'main') throw new Error('preview: --flag requires main (main ⊕ feature flags)');
  if (flags.some((flag) => !/^[a-zA-Z][\w-]*(?:\.[a-zA-Z][\w-]*)+$/u.test(flag))) throw new Error('preview: --flag expects an existing dotted config path');
  const scenarios = (options.scenario ?? 'S2').split(',').map((id) => id.trim());
  if (scenarios.length === 0 || new Set(scenarios).size !== scenarios.length) throw new Error('preview: duplicate or empty scenario');
  for (const id of scenarios) previewScenarioInput(id);
  const scenario = scenarios.join(',');
  const check = (command: string, args: readonly string[], cwd: string, timeout?: number): string => {
    const r = run(command, args, cwd, timeout);
    if (r.status !== 0) throw new Error(`preview: ${command} ${args.join(' ')} failed: ${(r.stdout + '\n' + r.stderr).slice(-600)}`);
    return r.stdout.trim();
  };
  let prNumber = isPr ? Number(target) : options.commentPr;
  let branchPrHead: string | undefined;
  let ref = target;
  if (isPr) {
    const pr = JSON.parse(check('gh', ['pr', 'view', target, '--json', 'number,headRefOid'], root)) as { number?: number; headRefOid?: string };
    if (pr.number !== Number(target) || !/^[0-9a-f]{40}$/iu.test(pr.headRefOid ?? '')) throw new Error('preview: PR head is unavailable');
    ref = pr.headRefOid!;
  } else if (target !== 'main') {
    check('git', ['check-ref-format', '--branch', target], root);
    if (options.commentPr === undefined) {
      const matching = JSON.parse(check('gh', ['pr', 'list', '--head', target, '--state', 'open', '--json', 'number,headRefOid'], root)) as Array<{ number?: number; headRefOid?: string }>;
      if (matching.length !== 1 || !Number.isSafeInteger(matching[0]?.number)) throw new Error('preview: branch has no unique open PR; use --comment-pr <PR number>');
      prNumber = matching[0]!.number;
      branchPrHead = matching[0]!.headRefOid;
    }
  }
  if (isPr && run('git', ['cat-file', '-e', `${ref}^{commit}`], root).status !== 0) {
    check('git', ['fetch', '--no-tags', 'origin', `pull/${target}/head`], root, 120_000);
    const fetched = check('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], root);
    if (fetched !== ref) throw new Error('preview: PR head changed while fetching; retry');
  }
  const head = check('git', ['rev-parse', '--verify', `${ref}^{commit}`], root);
  if (!/^[0-9a-f]{40}$/iu.test(head)) throw new Error('preview: unresolved commit');
  if (target !== 'main' && !isPr) {
    const pr = JSON.parse(check('gh', ['pr', 'view', String(prNumber), '--json', 'headRefOid,headRefName'], root)) as { headRefOid?: string; headRefName?: string };
    if (pr.headRefName !== target || pr.headRefOid !== head || (branchPrHead !== undefined && branchPrHead !== head)) throw new Error('preview: branch does not match the target PR head; use the PR number');
  }
  const bundleHeads = bundlePrs.map((number) => {
    const pr = JSON.parse(check('gh', ['pr', 'view', String(number), '--json', 'number,headRefOid'], root)) as { number?: number; headRefOid?: string };
    if (pr.number !== number || !/^[0-9a-f]{40}$/iu.test(pr.headRefOid ?? '')) throw new Error(`preview: PR #${number} head is unavailable`);
    const oid = pr.headRefOid!;
    if (run('git', ['cat-file', '-e', `${oid}^{commit}`], root).status !== 0) {
      check('git', ['fetch', '--no-tags', 'origin', `pull/${number}/head`], root, 120_000);
      if (check('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], root) !== oid) throw new Error(`preview: PR #${number} head changed while fetching; retry`);
    }
    return { number, oid };
  });
  const directory = (deps.makeDir ?? (() => {
    const previews = join(root, '.elanous-test', 'previews');
    mkdirSync(previews, { recursive: true });
    return mkdtempSync(join(previews, 'preview-'));
  }))();
  const worktree = join(directory, 'checkout');
  let added = false;
  let heldPty: string | undefined;
  let report = '';
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  try {
    check('git', ['worktree', 'add', '--detach', worktree, head], root);
    added = true;
    for (const { number, oid } of bundleHeads) {
      const current = JSON.parse(check('gh', ['pr', 'view', String(number), '--json', 'number,headRefOid'], root)) as { number?: number; headRefOid?: string };
      if (current.number !== number || current.headRefOid !== oid) throw new Error(`preview: PR #${number} head changed while preparing bundle; retry`);
      check('git', ['-c', 'user.name=elanous-preview', '-c', 'user.email=preview@localhost', 'merge', '--no-ff', '--no-edit', oid], worktree, 120_000);
    }
    check('bun', ['install', '--frozen-lockfile'], worktree, 300_000);
    check('bun', ['install', '--frozen-lockfile'], join(worktree, 'apps/pwa'), 300_000);
    for (const flag of flags) {
      const existing = check('bun', ['bin/elanous.mjs', '--test', 'config', 'get', flag], worktree);
      if (existing !== 'true' && existing !== 'false') throw new Error(`preview: ${flag} is not a boolean feature flag`);
      check('bun', ['bin/elanous.mjs', '--test', 'config', 'set', flag, 'true'], worktree);
    }
    check('bun', ['bin/elanous.mjs', '--test', 'nexus', 'build', '--cwd', join(worktree, 'apps/pwa')], worktree, 300_000);
    const pwa = check('bun', ['bin/elanous.mjs', '--test', 'nexus', 'run', '--test', '--tool-cwd', worktree], worktree, 120_000);
    const port = /\bnexus\s+:(314[5-9]\d)\b/u.exec(pwa)?.[1];
    const endpoint = port ? `http://127.0.0.1:${port}` : undefined;
    if (!endpoint) throw new Error('preview: P-1 has no local test endpoint');
    const probeOnce = deps.probePwa ?? (async (url: string) => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        return response.ok && (await response.text()).includes('<');
      } catch { return false; }
    });
    // `nexus run` detaches and returns before the daemon listens — its exit is not readiness. Poll.
    let probe = false;
    for (let attempt = 0; attempt < 60 && !probe; attempt++) {
      probe = await probeOnce(`${endpoint}/app/`);
      if (!probe) await wait(1000);
    }
    if (!probe) throw new Error('preview: P-1 did not serve the built PWA');
    const version = check('bun', ['bin/elanous.mjs', '--version'], worktree);
    if (!version) throw new Error('preview: B-1 version probe returned no output');
    const held = check('bun', ['bin/elanous.mjs', '--test', 'dev', '--elanous', '--hold', '--cwd', worktree, '--isolated-root', join(directory, 'tui'), '--json'], worktree, 120_000);
    const last = held.split('\n').reverse().find((line: string) => line.trim().startsWith('{'));
    const pty = last ? JSON.parse(last) as { held?: boolean; ptyId?: string } : {};
    if (pty.held !== true || !/^pty_[\w-]+$/u.test(pty.ptyId ?? '')) throw new Error('preview: B-1 held TUI did not return a PTY reference');
    heldPty = pty.ptyId;
    const snapshotArgs = ['bin/elanous.mjs', '--test', 'pty', 'snapshot', pty.ptyId!] as const;
    const rows: string[] = [];
    const snapshots: string[] = [];
    for (const id of scenarios) {
      const { input, expected, matches } = SCENARIOS[id]!;
      const before = check('bun', snapshotArgs, worktree);
      check('bun', ['bin/elanous.mjs', '--test', 'pty', 'text', pty.ptyId!, input, '--enter'], worktree);
      // A constant sleep misses slow frames under load — poll until this scenario's expected response (≤ 20s).
      let snapshot = '';
      let matched = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        await wait(1000);
        snapshot = check('bun', snapshotArgs, worktree);
        const fresh = previewFreshLines(before, snapshot);
        matched = snapshot !== 'ok' && snapshot !== before && matches(fresh);
        if (matched) break;
      }
      const observed = snapshot && snapshot !== 'ok' && snapshot !== before;
      rows.push(`| TUI-COMFORT §4 ${id} | \`${input}\` → ${matched ? `expected ${expected} matched` : `friction: expected ${expected} not found${observed ? '' : ' (no response within 20s)'}`} |`);
      snapshots.push(`<details><summary>Inner PTY snapshot ${id}</summary>\n\n\`\`\`text\n${snapshot.slice(-3000).replaceAll('```', "'''")}\n\`\`\`\n</details>`);
    }
    report = `| Check | Observation |\n|---|---|\n| head | \`${head}\` |${bundleHeads.length ? `\n| bundled PR heads | ${bundleHeads.map(({ number, oid }) => `#${number} \`${oid}\``).join(' ⊕ ')} |` : ''}\n| B-1 version | ${version.slice(0, 120)} |\n| P-1 PWA | \`${endpoint}/app/\` served the built PWA |\n${rows.join('\n')}\n\n${snapshots.join('\n\n')}`;
  } catch (error) {
    report = `| Check | Friction |\n|---|---|\n| head | \`${head}\` |\n| TUI-COMFORT §4 ${scenario} | ${String(error).replaceAll('|', '\\|').slice(0, 700)} |`;
  } finally {
    if (added) {
      if (heldPty) run('bun', ['bin/elanous.mjs', '--test', 'pty', 'key', heldPty, 'ctrl+c'], worktree, 30_000);
      run('bun', ['bin/elanous.mjs', '--test', 'nexus', 'run', '--test', '--stop'], worktree, 30_000);
      const removed = run('git', ['worktree', 'remove', '--force', worktree], root, 30_000);
      if (removed.status !== 0) throw new Error(`preview: failed to remove isolated worktree: ${removed.stderr}`);
    }
    (deps.dispose ?? ((dir) => rmSync(dir, { recursive: true, force: true })))(directory);
  }
  const status = report.includes('| Friction |') || report.includes('→ friction:') ? 'friction' : 'passed';
  const body = `## PR preview — ${target} (${status})\n\n${report}`;
  if (prNumber === undefined) throw new Error('preview: cannot comment without a PR number');
  check('gh', ['pr', 'comment', String(prNumber), '--body', body], root);
  const result: PreviewResult = { target, head, scenario, status, report: body, prNumber, commented: true };
  const resultDir = join(root, '.elanous-test');
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(join(resultDir, 'preview-result.json'), JSON.stringify(result), { mode: 0o600 });
  return result;
}
