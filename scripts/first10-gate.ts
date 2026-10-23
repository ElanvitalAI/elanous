#!/usr/bin/env bun
// FIRST10-GATE (0.2.36 first measurable slice) — a local, one-record stopwatch for a
// fresh public install → first-run → first useful answer. UX runs this on an isolated
// Mac account against the exact PR head; the recorder never claims the full macOS card
// green by itself — a run without a real useful answer records `unmeasured`/`failed`,
// never `pass`.
//
// Wraps scripts/install.sh UNEDITED (--prefix/--source, ELANOUS_INSTALL_LANG, and
// ELANOUS_INSTALL_INTERACTIVE/--no-setup for non-interactive runs) and the installed
// CLI's non-TTY first-run path (src/onboarding/first-chat-gate.ts → runFirstRun,
// rc=2 on needs-llm). Phase boundaries are the runFirstRun outcomes
// ('ready'|'needs-llm'|'cancelled') and the onboarding.first-run/first-chat ledger events.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface IsolationInput {
  home: string;
  prefix: string;
  stateDir: string;
  realHome?: string;
  xdgDataHome?: string;
}

export type IsolationResult = { ok: true } | { ok: false; reason: string };

const under = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

/** Refuse operating default paths; only an isolated HOME/PREFIX/ELANOUS_STATE_DIR may run. */
export function validateIsolation(input: IsolationInput): IsolationResult {
  const realHome = resolve(input.realHome ?? process.env.FIRST10_GATE_REAL_HOME ?? process.env.HOME ?? '');
  if (!realHome) return { ok: false, reason: '⛔ real HOME is unknown — pass --home for an isolated home' };
  const home = resolve(input.home);
  const prefix = resolve(input.prefix);
  const stateDir = resolve(input.stateDir);
  const xdgDataHome = input.xdgDataHome ?? process.env.XDG_DATA_HOME;
  const operatingDefaultPrefixes = [
    resolve(xdgDataHome ?? `${realHome}/.local/share`, 'elanous'),
    resolve(`${realHome}/.local/share`, 'elanous'),
  ];
  // install.sh line 38: default PREFIX is ${XDG_DATA_HOME:-$HOME/.local/share}/elanous — refuse it.
  if (operatingDefaultPrefixes.some((p) => prefix === p)) {
    return { ok: false, reason: `⛔ refusing the operating default prefix ${prefix} — pass an isolated --prefix` };
  }
  if (home === realHome) return { ok: false, reason: `⛔ --home must be an isolated home, not the operating HOME ${realHome}` };
  // install.sh lines 243-246: a PATH block pointing at a different installation prefix must
  // never be silently reused — a prefix outside the isolated home is exactly that case.
  if (!under(prefix, home)) {
    return { ok: false, reason: `⛔ prefix ${prefix} is outside the isolated home ${home} (different installation prefix)` };
  }
  const operatingStateDirs = [resolve(`${realHome}/.elanous`), resolve(`${process.env.HOME ?? realHome}/.elanous`)];
  // The operating prod state dir (~/.elanous) must never receive measurement writes.
  if (operatingStateDirs.some((s) => stateDir === s)) {
    return { ok: false, reason: `⛔ refusing the operating state dir ${stateDir} — pass an isolated --state-dir` };
  }
  if (!under(stateDir, home)) {
    return { ok: false, reason: `⛔ state dir ${stateDir} is outside the isolated home ${home}` };
  }
  return { ok: true };
}

export type FirstRunOutcome = 'ready' | 'needs-llm' | 'cancelled' | 'unknown';

export type UsefulResult = 'measured' | 'unmeasured' | 'failed';

/** outcome ≠ ready → unmeasured/failed; ready alone is NOT a useful result without answer evidence. */
export function mapOutcomeToUsefulResult(
  { outcome, answerEvidence }: { outcome: FirstRunOutcome; answerEvidence?: string | null },
): UsefulResult {
  if (answerEvidence && outcome === 'ready') return 'measured';
  if (outcome === 'needs-llm') return 'failed';
  return 'unmeasured';
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /((?:api[_-]?key|token|secret|password|credential)["'=:\s]+)[^\s'"",}]+/gi,
];

/** Secret hygiene (first-run.test.ts: tokens never appear in captured output). */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, ...rest) => {
      const prefix = typeof rest[0] === 'string' ? rest[0] : '';
      return prefix ? `${prefix}[REDACTED]` : '[REDACTED]';
    });
  }
  return out;
}

export interface PhaseRecord {
  rc: number | null;
  stdout: string;
  stderr: string;
  elapsedMonotonicMs: number;
}

export interface RecordSource {
  kind: 'url' | 'tarball' | 'checkout';
  ref: string;
  tarballSha256?: string;
}

export interface RecorderRecord {
  schema: 'first10-gate/1';
  mode: 'dry' | 'real';
  createdAt: string;
  locale: 'ko' | 'en';
  source: RecordSource;
  cliVersion?: string;
  installMetadata?: { version?: string; versionDir?: string; source?: string; installedAt?: string; commit?: string };
  phases: { install: PhaseRecord; firstRun?: PhaseRecord };
  errorCount: number;
  /** 600-second decision: null when the phase timings are incomplete or the run is a dry rehearsal. */
  decision600s: 'within' | 'over' | null;
  missingFields: string[];
  /** Evidence reference for the first usable answer (a real reply line, never a fixture). */
  answerEvidence: string | null;
  usefulResult: UsefulResult;
}

export interface BuildRecordInput {
  locale: 'ko' | 'en';
  source: RecordSource;
  cliVersion?: string;
  installMetadata?: RecorderRecord['installMetadata'];
  phases: { install: PhaseRecord; firstRun?: PhaseRecord };
  answerEvidence?: string | null;
  createdAt?: string;
}

const ERROR_LINE = /⛔|error|failed|fatal|panic/i;

const countErrors = (phases: BuildRecordInput['phases']): number =>
  Object.values(phases).reduce(
    (n, phase) =>
      n + (phase
        ? phase.stderr.split('\n').filter((line) => ERROR_LINE.test(line)).length + (phase.rc !== 0 && phase.rc !== null ? 1 : 0)
        : 0),
    0,
  );

/** One JSON record: phase timings, rc/stdout/stderr, locale, source, CLI version, error count, 600s decision. */
export function buildRecord(input: BuildRecordInput): RecorderRecord {
  const missingFields: string[] = [];
  if (!input.cliVersion) missingFields.push('cliVersion');
  if (!input.phases.firstRun) missingFields.push('phases.firstRun');
  if (!input.phases.install.stdout && !input.phases.install.stderr) missingFields.push('phases.install.output');
  if (!input.answerEvidence) missingFields.push('answerEvidence');
  if (input.source.kind === 'tarball' && !input.source.tarballSha256) missingFields.push('source.tarballSha256');
  const firstRunRc = input.phases.firstRun?.rc;
  const outcome: FirstRunOutcome = !input.phases.firstRun
    ? 'unknown'
    : firstRunRc === 0 ? 'ready' : firstRunRc === 2 ? 'needs-llm' : firstRunRc === null ? 'cancelled' : 'unknown';
  const mode: RecorderRecord['mode'] =
    input.phases.install.rc === 0 && input.phases.install.stdout === '[dry-run]' ? 'dry' : 'real';
  // A dry rehearsal's 0 ms phase timings are placeholders, never measurements — a positive
  // 600 s decision ("within") must not be published from them (review ta-20261022-e0a4f8 mustFix 2).
  if (mode === 'dry') missingFields.push('decision600s');
  const totalMs =
    input.phases.install.elapsedMonotonicMs + (input.phases.firstRun?.elapsedMonotonicMs ?? 0);
  const decision600s: RecorderRecord['decision600s'] =
    mode === 'dry' ? null
      : input.phases.firstRun
        ? (totalMs <= 600_000 ? 'within' : 'over')
        : null;
  const record: RecorderRecord = {
    schema: 'first10-gate/1',
    mode,
    createdAt: input.createdAt ?? new Date().toISOString(),
    locale: input.locale,
    source: input.source,
    ...(input.cliVersion ? { cliVersion: input.cliVersion } : {}),
    ...(input.installMetadata ? { installMetadata: input.installMetadata } : {}),
    phases: input.phases as RecorderRecord['phases'],
    errorCount: countErrors(input.phases),
    decision600s,
    missingFields,
    answerEvidence: input.answerEvidence ? scrubSecrets(input.answerEvidence) : null,
    // A dry rehearsal never measures a real useful result — 'unmeasured', never 'pass'.
    usefulResult: mode === 'dry'
      ? 'unmeasured'
      : mapOutcomeToUsefulResult({ outcome, answerEvidence: input.answerEvidence }),
  };
  // Scrub each string field individually — never the serialized JSON, where an
  // escaped quote (stderr `token=abc"`) would leave a bare quote and break JSON.parse.
  const scrubPhase = (p: PhaseRecord): PhaseRecord =>
    ({ ...p, stdout: scrubSecrets(p.stdout), stderr: scrubSecrets(p.stderr) });
  return {
    ...record,
    source: { ...record.source, ref: scrubSecrets(record.source.ref) },
    phases: {
      install: scrubPhase(record.phases.install),
      ...(record.phases.firstRun ? { firstRun: scrubPhase(record.phases.firstRun) } : {}),
    },
  };
}

export interface CliArgs {
  record: string;
  home?: string;
  prefix: string;
  stateDir?: string;
  source?: string;
  lang: 'ko' | 'en';
  dry: boolean;
  answerEvidence?: string;
  help: boolean;
}

const HELP = `Usage: bun scripts/first10-gate.ts --record PATH --home PATH --prefix PATH --state-dir PATH [--source PATH.tgz|URL] [--lang ko|en] [--answer-evidence TEXT] [--dry] [--help]

FIRST10-GATE — one JSON stopwatch record for install → first-run → first useful answer.
  --record PATH        where to write the single JSON record (required)
  --home PATH          isolated HOME for the measurement run (required, must not be the operating HOME)
  --prefix PATH        isolated installation prefix (required; the operating default
                       \${XDG_DATA_HOME:-\$HOME/.local/share}/elanous is refused)
  --state-dir PATH     isolated ELANOUS_STATE_DIR (required; the operating ~/.elanous is refused)
  --source PATH.tgz|URL  passed through to scripts/install.sh (--source), recorded as provenance
  --lang ko|en         one locale per run (ELANOUS_INSTALL_LANG) — ko and en runs are recorded separately
  --answer-evidence TEXT  evidence reference for the first usable answer; without it the run is unmeasured
  --dry                dry rehearsal: no real install.sh spawn; the record is marked mode "dry" and
                       usefulResult stays unmeasured — never pass
  --help, -h           show this help

Wraps scripts/install.sh unedited with --prefix/--source, ELANOUS_INSTALL_LANG and
ELANOUS_INSTALL_INTERACTIVE=0/--no-setup for non-interactive measurement runs.
The first-run phase invokes the installed CLI's non-TTY first-chat gate
(src/onboarding/first-chat-gate.ts → runFirstRun): rc=0 outcome 'ready', rc=2 'needs-llm'.
This recorder never claims the full macOS 600 s card green — UX runs the exact PR head on
mbp in two fresh isolated homes (ko/en) and attaches the screen recording and answer evidence.
`;

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { record: '', prefix: '', lang: 'en', dry: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => { const v = argv[++i]; if (v === undefined) throw new Error(`⛔ ${a} needs a value`); return v; };
    switch (a) {
      case '--help': case '-h': args.help = true; return args;
      case '--record': args.record = next(); break;
      case '--home': args.home = next(); break;
      case '--prefix': args.prefix = next(); break;
      case '--state-dir': args.stateDir = next(); break;
      case '--source': args.source = next(); break;
      case '--lang': {
        const lang = next(); if (lang !== 'ko' && lang !== 'en') throw new Error('⛔ --lang must be ko or en'); args.lang = lang; break;
      }
      case '--answer-evidence': args.answerEvidence = next(); break;
      case '--dry': args.dry = true; break;
      default: throw new Error(`⛔ unknown argument: ${a}`);
    }
  }
  if (!args.record) throw new Error('⛔ --record is required');
  if (!args.prefix) throw new Error('⛔ --prefix is required');
  if (!args.home) throw new Error('⛔ --home is required');
  if (!args.stateDir) throw new Error('⛔ --state-dir is required');
  return args;
}

interface InstallJson {
  version?: string;
  versionDir?: string;
  source?: string;
  installedAt?: string;
  commit?: string;
}

const readInstallJson = (prefix: string): InstallJson | undefined => {
  const path = resolve(prefix, 'install.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InstallJson;
  } catch {
    return undefined;
  }
};

/** Repository root = parent of this script's own directory (<repo>/scripts → <repo>). */
export const repoRootOf = (): string => resolve(import.meta.dir, '..');

/** sha256 of a file, cross-platform: sha256sum, then macOS `shasum -a 256`; '' if neither exists. */
export const sha256 = (path: string): string => {
  // macOS has no sha256sum by default — fall back to `shasum -a 256` (and shasum
  // to shasum-compatible coreutils `sha256` no-op is not attempted).
  for (const cmd of ['sha256sum', 'shasum -a 256']) {
    const [bin, ...rest] = cmd.split(' ');
    const r = spawnSync(bin, [...rest, path], { encoding: 'utf8' });
    if (r.status === 0) {
      const sum = r.stdout.trim().split(/\s+/)[0] ?? '';
      if (sum) return sum;
    }
  }
  // Neither hasher exists: empty string — callers must record this as missing.
  return '';
};

function sourceOf(source: string | undefined, installMetadata: InstallJson | undefined): RecordSource {
  if (source) {
    if (/^https?:\/\//.test(source)) return { kind: 'url', ref: source };
    if (!existsSync(source)) return { kind: 'tarball', ref: resolve(source) };
    const tarballSha256 = sha256(source);
    return tarballSha256 ? { kind: 'tarball', ref: resolve(source), tarballSha256 } : { kind: 'tarball', ref: resolve(source) };
  }
  const metaSource = installMetadata?.source;
  if (metaSource && /^https?:\/\//.test(metaSource)) return { kind: 'url', ref: metaSource };
  return { kind: 'checkout', ref: metaSource ?? (process.cwd()) };
}

/** URL sources are passed through verbatim; only local file paths are resolve()d. */
export const installSourceArg = (source: string): string =>
  /^https?:\/\//.test(source) ? source : resolve(source);

export function runInstallPhase(args: CliArgs, repoRoot: string): PhaseRecord {
  if (args.dry) {
    // Dry rehearsal: no real spawn — the record is marked mode "dry" so it can never be
    // conflated with a real useful result.
    return { rc: 0, stdout: '[dry-run]', stderr: '', elapsedMonotonicMs: 0 };
  }
  if (!existsSync(resolve(repoRoot, 'scripts/install.sh'))) {
    return {
      rc: 127,
      stdout: '',
      stderr: `⛔ scripts/install.sh not found under ${repoRoot} — not a real install run`,
      elapsedMonotonicMs: 0,
    };
  }
  const installer = resolve(repoRoot, 'scripts/install.sh');
  const env = {
    ...process.env,
    HOME: resolve(args.home!),
    ELANOUS_STATE_DIR: resolve(args.stateDir!),
    ELANOUS_INSTALL_LANG: args.lang,
    ELANOUS_INSTALL_INTERACTIVE: '0',
  };
  const started = performance.now();
  const r = spawnSync('bash', [installer, '--prefix', resolve(args.prefix), '--no-setup', '--no-modify-path', ...(args.source ? ['--source', installSourceArg(args.source)] : [])], {
    encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024,
  });
  return {
    rc: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    elapsedMonotonicMs: Math.round(performance.now() - started),
  };
}

function runFirstRunPhase(args: CliArgs, install: PhaseRecord): PhaseRecord | undefined {
  if (args.dry) return { rc: 2, stdout: '[dry-run]', stderr: '[dry-run] first-run not measured', elapsedMonotonicMs: 0 };
  if (install.rc !== 0) return undefined;
  const cli = resolve(args.prefix, 'bin/elanous');
  if (!existsSync(cli)) return undefined;
  const env = {
    ...process.env,
    HOME: resolve(args.home!),
    ELANOUS_STATE_DIR: resolve(args.stateDir!),
    ELANOUS_INSTALL_LANG: args.lang,
  };
  const started = performance.now();
  // The installed CLI's non-TTY first-chat gate: rc=2 means runFirstRun outcome 'needs-llm'.
  const r = spawnSync('bash', [cli], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  return {
    rc: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    elapsedMonotonicMs: Math.round(performance.now() - started),
  };
}

export function main(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const isolation = validateIsolation({ home: args.home!, prefix: args.prefix, stateDir: args.stateDir! });
  if (!isolation.ok) {
    process.stderr.write(`${isolation.reason}\n`);
    return 2;
  }
  // Repository root = parent of this script's own directory (<repo>/scripts → <repo>),
  // so runInstallPhase spawns the real <repo>/scripts/install.sh, never <repo>/scripts/scripts/install.sh.
  const repoRoot = repoRootOf();
  const installPhase = runInstallPhase(args, repoRoot);
  const installMetadata = readInstallJson(args.prefix);
  const firstRunPhase = runFirstRunPhase(args, installPhase);
  const record = buildRecord({
    locale: args.lang,
    source: sourceOf(args.source, installMetadata),
    cliVersion: installMetadata?.version,
    installMetadata,
    phases: { install: installPhase, ...(firstRunPhase ? { firstRun: firstRunPhase } : {}) },
    answerEvidence: args.answerEvidence ?? null,
  });
  const out = resolve(args.record);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`${out}: usefulResult=${record.usefulResult} decision600s=${record.decision600s ?? 'n/a'} missingFields=${record.missingFields.join(',') || '-'}\n`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}

