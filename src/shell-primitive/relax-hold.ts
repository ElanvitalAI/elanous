// CEO 11-23 ELS-ELN-SECURITY-RELAX (r2 RUNSHELL-HOLD-BIG-IRREVERSIBLE-ONLY) — the agent digests risk in context; a
// RunShell argv needs a human (signed one-use grant) only for BIG IRREVERSIBLE harm:
//   (a) broad deletion — recursive rm / find -delete / rsync --delete onto a non-temp path, or any rm of a root
//       (/, ~, the repo root, ~/elanous-hq, ~/.elanous, or a glob at one of those), disk formatting
//   (b) operational data-store destruction — SQL DROP/TRUNCATE/unbounded DELETE, kubectl delete (except pods),
//       gh repo delete, git push --force to main (explicit ref or current branch), eln/elanous delete/purge
//   (c) public exposure — ngrok, cloudflared, tailscale funnel, localtunnel
//   (d) secrets sent off the machine — a credential source and a network sink in the same command
//   (e) guardian switched off
// Everything else runs and is audited: local env/process reads, single-file rm, rm inside temp dirs, ssh -R,
// http.server, and shell bodies that cannot be parsed (no fail-closed).
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isGuardianDisabled } from '../ask-user-question/guardian.js';
import { elanousStateRoot } from '../autopilot/state-paths.js';

export type RelaxHoldClass = 'destructive' | 'secret' | 'exposure' | 'guardian-off' | 'empty';
export interface RelaxHold { readonly class: RelaxHoldClass; readonly reason: string }

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
// Prefix programs that run the rest of the argv as a command.
const WRAPPERS = new Set(['sudo', 'doas', 'exec', 'command', 'nohup', 'time', 'nice', 'env', 'xargs', 'builtin']);
const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
const BUILD_DIRS = new Set(['node_modules', 'dist', '.cache', 'build', '.next', '.turbo', 'coverage', 'target', '.parcel-cache']);
const ELN_DESTROY_VERBS = new Set(['delete', 'purge', 'wipe', 'drop', 'destroy']);

// (b) SQL statements are visible anywhere in the text (client argument or shell body).
const SQL_DESTROY: readonly RegExp[] = [
  /\b(?:DROP\s+(?:DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)\b/iu,
  // bare `TRUNCATE seats` (upper-case keyword, so the `truncate -s` file command is not matched)
  /\bTRUNCATE\s+(?!-)["`\[]?[A-Za-z_]/u,
  /\bDELETE\s+FROM\s+["`\[]?[\w.]+["`\]]?\s*(?:;|$|["'])/iu,
  /\bDELETE\s+FROM\s+["`\[]?[\w.]+["`\]]?\s+WHERE\s*\(*\s*(?:TRUE\b|([0-9]+)\s*=\s*\1(?=\s|[);"']|$))/iu,
];
// (c) public tunnels.
const EXPOSURE: readonly RegExp[] = [/\bngrok\b/u, /\bcloudflared\b/u, /\btailscale\s+funnel\b/u, /\blocaltunnel\b/u];
// (d) credential sources: printers and key/secret files.
const SECRET_SOURCES: readonly RegExp[] = [
  /\bgh\s+auth\s+token\b/u,
  /\bsecurity\s+(?:find-(?:generic|internet)-password|dump-keychain)\b/u,
  /\bprint-(?:access|identity)-token\b/u,
  /\.ssh\/id_[\w.-]*/u,
  /(?:^|[\s/'"=@<])\.env(?:\.[\w.-]+)?(?=$|[\s'"|;&)])/u,
  /(?:^|[\s/'"=@<])auth\.json\b/u,
  /[\w.-]+\.pem\b/u,
  /\.aws\/(?:credentials|config)\b/u, /(?:^|[\s/'"=@<])\.(?:netrc|npmrc|pypirc|pgpass|git-credentials)\b/u,
  /\.docker\/config\.json\b/u, /\.kube\/config\b/u, /\.config\/gh\/hosts\.yml\b/u,
  /\bprintenv\s+(?:[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)[A-Za-z0-9_]*|TOKEN|SECRET|PASSWORD|API_KEY)\b/iu,
  /\$(?:\{(?:[A-Za-z_][A-Za-z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)(?:_[A-Za-z0-9_]+)?\}|(?:[A-Za-z_][A-Za-z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)(?:_[A-Za-z0-9_]+)?)/iu,
];
// (d) network sinks.
const NETWORK_SINKS: readonly RegExp[] = [
  /(?:^|[\s|;&(/])(?:curl|wget|nc|ncat|netcat|socat|telnet|ssh|scp|sftp|mail|mailx|sendmail|mutt)(?=$|[\s'")])/u,
  /\bgh\s+api\b[^|;&]*(?:-X\s*POST|--method\s+POST|\s-[fF]\s|--field|--raw-field|--input)/u,
];
// ssh/scp identity options and curl --cacert name a file the client reads locally; they are not a leak.
const IDENTITY_OPTION = /(?:^|\s)(?:-i\s*\S+|-o\s*IdentityFile[=\s]\S+|--cacert[=\s]\S+)/gu;

interface Segment { readonly argv: string[]; readonly wrappedBy: string | undefined }

/** The `-c` body of `sh -c '…'`, `bash -lc '…'` and similar, or undefined when argv is not a shell-wrapped body. */
function shellBody(argv: readonly string[]): string | undefined {
  if (!SHELLS.has(basename(argv[0]!))) return undefined;
  const flag = argv.findIndex((token, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/u.test(token));
  return flag > 0 ? argv[flag + 1] ?? '' : undefined;
}

/** Quote-aware split of a shell body into simple-command argv. Best effort: anything odd just yields fewer words. */
function splitBody(body: string): string[][] {
  const out: string[][] = [];
  let argv: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | null = null;
  const endWord = () => { if (inWord) argv.push(word); word = ''; inWord = false; };
  const endSegment = () => { endWord(); if (argv.length) out.push(argv); argv = []; };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < body.length) { word += body[i + 1]!; i += 1; }
      else word += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < body.length) { word += body[i + 1]!; inWord = true; i += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; inWord = true; continue; }
    if (';&|\n()`{}'.includes(ch)) { endSegment(); continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { endWord(); continue; }
    word += ch;
    inWord = true;
  }
  endSegment();
  return out;
}

/** Drop leading VAR=value assignments and wrapper programs (sudo, env, xargs …) with their own flags. */
function unwrap(argv: readonly string[]): Segment {
  let rest = [...argv];
  let wrappedBy: string | undefined;
  for (;;) {
    while (rest.length > 1 && /^[A-Za-z_]\w*=/u.test(rest[0]!)) rest.shift();
    const program = rest[0] ? basename(rest[0]) : '';
    if (!WRAPPERS.has(program) || rest.length < 2) break;
    wrappedBy = program;
    rest = rest.slice(1);
    while (rest.length > 1 && (rest[0]!.startsWith('-') || /^[A-Za-z_]\w*=/u.test(rest[0]!))) rest.shift();
  }
  return { argv: rest, wrappedBy };
}

function expandPath(token: string, cwd: string): string {
  const home = process.env.HOME || homedir();
  const tmp = process.env.TMPDIR || tmpdir();
  let path = token
    .replace(/^~(?=$|\/)/u, home)
    .replace(/^\$\{?HOME\}?(?=$|\/)/u, home)
    .replace(/^\$\{?TMPDIR\}?(?=$|\/)/u, tmp);
  if (path.startsWith('$')) return path;
  if (isAbsolute(path)) return resolve(path); // normalizes `..`: /tmp/../srv is /srv
  // relative to an unknown directory (after `cd "$X"`): unknown, never temp
  return cwd.startsWith('$') ? `${cwd}/${path}` : resolve(cwd, path);
}

/** Resolve symlinks of the longest existing prefix (a /tmp/link to /srv is /srv); unknown paths unchanged. */
function realish(path: string): string {
  if (path.startsWith('$')) return path;
  let head = path;
  let rest = '';
  for (let i = 0; i < 64 && head !== dirname(head); i += 1) {
    try { if (existsSync(head)) return join(realpathSync(head), rest); } catch { return path; }
    rest = rest ? join(basename(head), rest) : basename(head);
    head = dirname(head);
  }
  try { return join(realpathSync(head), rest); } catch { return path; }
}

/** A broad root whose deletion is never routine: /, home, the elanous state dirs, a repository root. */
function isProtectedRoot(raw: string, cwd: string): boolean {
  const home = realish(process.env.HOME || homedir());
  const path = realish(expandPath(raw, cwd).replace(/\/\*+$/u, '').replace(/\/+$/u, '') || '/');
  if (path === '/' || path === home) return true;
  if (path === join(home, 'elanous-hq') || path === realish(elanousStateRoot())) return true;
  // Any top-level dot directory in home (config · credentials · agent state) is irreversible to wipe.
  if (dirname(path) === home && basename(path).startsWith('.')) return true;
  if (!path.includes('*') && !path.startsWith('$')) {
    try { if (existsSync(join(path, '.git'))) return true; } catch { /* unreadable: not a known root */ }
  }
  return false;
}

/** Strictly inside a temp dir or a build output dir; unknown ($VAR) paths are not temp. */
function isTempPath(raw: string, cwd: string): boolean {
  const path = realish(expandPath(raw, cwd));
  if (path.startsWith('$')) return false;
  const tmp = realish((process.env.TMPDIR || tmpdir()).replace(/\/+$/u, ''));
  for (const root of [...TEMP_ROOTS, tmp]) if (path.startsWith(`${root}/`) && path.length > root.length + 1) return true;
  // Build-output names count as temp only inside a git checkout (a repo's own node_modules/dist), never by name alone.
  const parts = path.split('/');
  const at = parts.findIndex(part => BUILD_DIRS.has(part));
  if (at <= 0) return false;
  const owner = parts.slice(0, at).join('/') || '/';
  try { return existsSync(join(owner, '.git')); } catch { return false; }
}

/** The checked-out branch for a directory (reads .git/HEAD, worktree gitdir files included), undefined if unknown. */
function currentBranch(dir: string): string | undefined {
  if (dir.startsWith('$')) return undefined;
  for (let at = resolve(dir), i = 0; i < 64; at = dirname(at), i += 1) {
    const dotGit = join(at, '.git');
    try {
      if (existsSync(dotGit)) {
        const gitDir = statSync(dotGit).isDirectory() ? dotGit
          : resolve(at, readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/u, '').trim());
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : 'HEAD';
      }
    } catch { return undefined; }
    if (at === dirname(at)) break;
  }
  return undefined;
}

/** Positional operands after flags (`--` ends flags). */
function operands(args: readonly string[]): { flags: string[]; targets: string[] } {
  const flags: string[] = [];
  const targets: string[] = [];
  let ended = false;
  for (const arg of args) {
    if (!ended && arg === '--') { ended = true; continue; }
    if (!ended && arg.startsWith('-') && arg.length > 1) flags.push(arg);
    else targets.push(arg);
  }
  return { flags, targets };
}

const broadTarget = (targets: readonly string[], cwd: string) =>
  targets.find(target => isProtectedRoot(target, cwd) || !isTempPath(target, cwd));

/** kubectl options with a separate value do not name the resource being deleted. */
const KUBECTL_VALUE_OPTIONS = new Set(['-n', '--namespace', '--context', '--cluster', '--user', '--kubeconfig', '--server', '-s', '--request-timeout', '--as', '--as-group', '-l', '--selector', '--field-selector', '-o', '--output', '--grace-period', '--timeout', '--cascade']);
const KUBECTL_BOOLEAN_OPTIONS = new Set(['--force', '--wait', '--now', '--ignore-not-found', '--dry-run']);
function kubectlDeleteKind(args: readonly string[]): string | undefined {
  if (args.some(arg => ['-f', '--filename', '-k', '--kustomize', '--all', '-A', '--all-namespaces'].includes(arg) || /^(?:--filename|--kustomize)=/u.test(arg))) return undefined;
  const start = args.indexOf('delete');
  for (let i = start + 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') return args[i + 1];
    if (KUBECTL_VALUE_OPTIONS.has(arg)) { if (args[++i] === undefined) return undefined; continue; }
    if (arg.startsWith('--') && arg.includes('=')) {
      const name = arg.slice(0, arg.indexOf('='));
      if (KUBECTL_VALUE_OPTIONS.has(name) || KUBECTL_BOOLEAN_OPTIONS.has(name)) continue;
      return undefined;
    }
    if (KUBECTL_BOOLEAN_OPTIONS.has(arg)) continue;
    if (arg.startsWith('-')) return undefined;
    return arg;
  }
  return undefined;
}

/** Remote command arguments follow the destination, after ssh options and their values. */
function sshRemoteBody(args: readonly string[]): string | undefined {
  const takesValue = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') return args.slice(i + 2).join(' ') || undefined;
    if (takesValue.has(arg)) { i++; continue; }
    if (arg.startsWith('-')) continue;
    return args.slice(i + 1).join(' ') || undefined;
  }
  return undefined;
}

/** (a)/(b) per simple command. */
function commandHold(segment: Segment, cwd: string): RelaxHold | null {
  const { argv, wrappedBy } = segment;
  if (!argv[0]) return null;
  const program = basename(argv[0]);
  const args = argv.slice(1);
  if (program === 'rm') {
    const { flags, targets } = operands(args);
    const recursive = flags.some(flag => flag === '--recursive' || (/^-[A-Za-z]+$/u.test(flag) && /[rR]/u.test(flag)));
    const root = targets.find(target => isProtectedRoot(target, cwd));
    if (root) return { class: 'destructive', reason: `rm of a protected root ${root}` };
    if (recursive && wrappedBy === 'xargs') return { class: 'destructive', reason: 'recursive rm on xargs targets' };
    const broad = recursive ? broadTarget(targets, cwd) : undefined;
    if (broad) return { class: 'destructive', reason: `recursive rm outside temp dirs (${broad})` };
    return null;
  }
  if (program === 'find') {
    const exec = args.findIndex(arg => arg === '-exec' || arg === '-execdir');
    const deletes = args.includes('-delete') || (exec >= 0 && basename(args[exec + 1] ?? '') === 'rm');
    if (!deletes) return null;
    const roots: string[] = [];
    for (const arg of args) { if (arg.startsWith('-') || arg === '(' || arg === '!') break; roots.push(arg); }
    const broad = broadTarget(roots.length ? roots : ['.'], cwd);
    return broad ? { class: 'destructive', reason: `find deletion outside temp dirs (${broad})` } : null;
  }
  if (program === 'rsync' && args.some(arg => arg.startsWith('--delete'))) {
    const { targets } = operands(args);
    const dest = targets[targets.length - 1];
    if (dest && (dest.includes(':') || isProtectedRoot(dest, cwd) || !isTempPath(dest, cwd)))
      return { class: 'destructive', reason: `rsync --delete onto ${dest}` };
    return null;
  }
  if (/^mkfs(?:\.|$)/u.test(program) || (program === 'dd' && args.some(arg => /^of=\/dev\//u.test(arg))))
    return { class: 'destructive', reason: `${program} overwrites a disk` };
  if (program === 'kubectl') {
    // Deleting deployed state (namespaces, deployments, volumes, services, -f manifests …) is irreversible; pods are
    // recreated by their controller, so `kubectl delete pod …` runs.
    if (!args.includes('delete')) return null;
    const kind = kubectlDeleteKind(args) ?? '';
    if (/^(?:po|pods?)(?:\/|$)/u.test(kind)) return null;
    return { class: 'destructive', reason: `kubectl delete ${kind || '(manifest)'}`.trim() };
  }
  if (program === 'gh' && args[0] === 'repo' && args[1] === 'delete') return { class: 'destructive', reason: 'gh repo delete' };
  // Cloud object-store bulk deletion (user data at rest).
  if (program === 'aws' && args[0] === 's3' && (args[1] === 'rb' || (args[1] === 'rm' && args.includes('--recursive'))))
    return { class: 'destructive', reason: 'aws s3 bulk delete' };
  if ((program === 'gsutil' && args[0] === 'rm' && args.some(a => a === '-r' || a === '-R' || a === '-rf'))
    || (program === 'gsutil' && args[0] === 'rb')
    || (program === 'gcloud' && args[0] === 'storage' && args[1] === 'rm' && args.some(a => a === '-r' || a === '--recursive')))
    return { class: 'destructive', reason: 'cloud storage bulk delete' };
  if (program === 'git' && args.includes('push')) {
    const after = args.slice(args.indexOf('push') + 1);
    const force = after.some(arg => arg === '-f' || arg.startsWith('--force') || (/^-[A-Za-z]+$/u.test(arg) && arg.includes('f')));
    // refspecs after the remote: `main`, `+main`, `HEAD:main`, `+x:refs/heads/main`
    const toMain = (ref: string) => /(?:^\+?|:)(?:refs\/heads\/)?(?:main|master)$/u.test(ref);
    const refs = after.filter(arg => !arg.startsWith('-')).slice(1);
    if (refs.some(ref => toMain(ref) && (force || ref.startsWith('+'))))
      return { class: 'destructive', reason: 'git push --force to main' };
    // No refspec: git pushes the current branch (or everything with --all/--mirror).
    if (force && (refs.length === 0 || after.includes('--all') || after.includes('--mirror'))) {
      const at = args.indexOf('-C');
      const branch = currentBranch(at >= 0 && args[at + 1] ? expandPath(args[at + 1]!, cwd) : cwd);
      if (branch === undefined || branch === 'main' || branch === 'master' || after.includes('--all') || after.includes('--mirror'))
        return { class: 'destructive', reason: `git push --force of ${branch ?? 'an unknown branch'}` };
    }
    return null;
  }
  const elnEntry = program === 'eln' || program === 'elanous'
    ? args
    : (program === 'bun' || program === 'node') && args[0] && /(?:^|\/)elanous\.mjs$/u.test(args[0]) ? args.slice(1) : undefined;
  if (elnEntry) {
    const verb = elnEntry.find(arg => !arg.startsWith('-') && ELN_DESTROY_VERBS.has(arg.toLowerCase()));
    if (verb) return { class: 'destructive', reason: `eln ${verb} on an operational store` };
  }
  return null;
}

/** (b) SQL, (c) exposure and (d) secret egress, judged on the whole command text. */
function textHold(text: string): RelaxHold | null {
  if (SQL_DESTROY.some(re => re.test(text))) return { class: 'destructive', reason: 'SQL DROP/TRUNCATE or unbounded DELETE' };
  if (EXPOSURE.some(re => re.test(text))) return { class: 'exposure', reason: 'public tunnel' };
  const scrubbed = text.replace(IDENTITY_OPTION, ' ');
  if (SECRET_SOURCES.some(re => re.test(scrubbed)) && NETWORK_SINKS.some(re => re.test(` ${scrubbed}`)))
    return { class: 'secret', reason: 'credential sent to a network command' };
  return null;
}

function holdFor(argv: readonly string[], cwd: string, depth: number): RelaxHold | null {
  // Wrappers first (`env sh -c …`, `sudo bash -lc …`), then a shell body if one is left.
  const segment = unwrap(argv);
  if (depth <= 4 && segment.argv[0] && basename(segment.argv[0]) === 'ssh') {
    const remote = sshRemoteBody(segment.argv.slice(1));
    if (remote) { const hold = holdFor(['sh', '-c', remote], '$REMOTE', depth + 1); if (hold) return hold; }
  }
  const body = segment.argv[0] ? shellBody(segment.argv) : undefined;
  if (body === undefined) return commandHold(segment, cwd) ?? textHold(argv.join(' '));
  if (depth > 4) return null;
  let dir = cwd;
  for (const words of splitBody(body)) {
    const inner = unwrap(words);
    // `cd` moves where later relative targets resolve.
    if (inner.argv[0] === 'cd') { dir = expandPath(inner.argv[1] ?? '~', dir); continue; }
    const hold = holdFor(words, dir, depth + 1);
    if (hold) return hold;
  }
  return textHold(body);
}

/** Why this argv still needs the signed grant, or null when it may run (audited) without one. */
export function relaxHold(argv: readonly string[], cwd: string = process.cwd()): RelaxHold | null {
  if (!argv[0]) return { class: 'empty', reason: 'empty argv' };
  // With the guardian switched off the operator asked for no automatic judgement: keep the grant.
  if (isGuardianDisabled()) return { class: 'guardian-off', reason: 'guardian disabled' };
  return holdFor(argv, cwd, 0);
}
