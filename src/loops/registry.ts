import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { hostname } from 'node:os';
import { parse as parseYaml } from 'yaml';
import type { Database } from 'bun:sqlite';
import { debug } from '../debug/log.js';
import { emitDecision } from '../live/detail-switch.js';
import { cronMatches } from '../domains/cron-match.js';
import { resolveTimeZone } from '../time/format.js';
import { inventoryCrontab, listSchedules, openSchedulesDb, type ScheduleRow } from '../domains/schedule-registry.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { getUserConfig, type UserConfig } from '../user-config.js';
import { runGraph, type GraphRunState } from '../graph-runner/runner.js';
import { FENCE_ROLES } from '../hq/hq.js';
import { dueBefore, type CheckEntry } from './checker.js';

export interface LoopRun {
  at: string;
  status: GraphRunState['status'];
  path: string;
  runId: string;
  failedNodes: string[];
  durationMs: number | null;
}
export interface LoopEntry {
  id: string;
  title: string;
  description: string | null;
  owner?: string | null;
  ownerSource?: 'header' | 'config' | 'seat' | 'default';
  mode?: string | null;
  file: string;
  trigger: { cron: string | null; events: string[] };
  jobs: Array<{ id: string; cron: string | null; enabled: boolean; entryScript?: boolean }>;
  enabled: boolean;
  lastRun: LoopRun | null;
  nextRun: string | null;
}
export interface LoopRegistryOptions {
  root?: string;
  stateRoot?: string;
  now?: Date;
  /** Inject a parsed config for isolated inventory checks. */
  config?: UserConfig;
  /** An already-inventoried registry; keeps focused tests isolated. */
  schedules?: ScheduleRow[];
  scheduleAction?: (action: 'create' | 'enable' | 'disable', args: Record<string, unknown>) => Promise<unknown>;
}

function graphFiles(dir: string): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap(e => e.isDirectory() ? graphFiles(join(dir, e.name)) : e.isFile() && /\.ya?ml$/.test(e.name) ? [join(dir, e.name)] : []).sort();
}

/** A wrapper cron that runs the graph itself declares its loop with a trailing `# elanous-loop=<graph_id>` comment. */
const LOOP_MARKER = /#\s*elanous-loop=([A-Za-z0-9][\w.-]*)\s*$/;

/** Match only the actual graph CLI invocation, not a filename mentioned in a shell argument. */
export function graphJobMatches(command: string | null, file: string, root: string, graphId?: string): boolean {
  if (!command) return false;
  if (graphId && command.match(LOOP_MARKER)?.[1] === graphId) return true;
  for (const segment of shellSegments(command)) {
    for (const words of launchedCommands(segment)) {
      const { script, args } = launchedScript(words);
      if (!isElanousExecutable(script)) continue;
      const graph = args[0]?.text === '--test' ? (args[1]?.text === 'graph' ? 1 : 2)
        : args[0]?.text.startsWith('--test=') ? 1 : 0;
      if (args[graph]?.text !== 'graph' || args[graph + 1]?.text !== 'run' || !args[graph + 2]) continue;
      const arg = args[graph + 2]!.text;
      if (resolve(root, arg) === file || (isAbsolute(arg) && resolve(arg) === file)) return true;
    }
  }
  return false;
}

/** `cron_entry` identifies the script actually launched by cron, not text in another command's arguments. */
function cronEntryMatches(command: string | null, entry: string): boolean {
  if (!command) return false;
  return shellSegments(command).some(segment => launchedCommands(segment).some(words => {
    let index = 0;
    if (/(?:^|\/)(?:bun|node)$/.test(words[0]?.text ?? '') && /(?:^|\/)cron-run\.ts$/.test(words[1]?.text ?? '')) {
      index = words.findIndex(word => word.text === '--shell') + 1;
      if (index === 0) return false;
    }
    if (/(?:^|\/)(?:sh|bash|zsh)$/.test(words[index]?.text ?? '')) index++;
    const script = words[index]?.text;
    return !!script && /\.sh$/.test(script) && (script === entry || script.endsWith(`/${entry}`));
  }));
}

function recentRuns(id: string, stateRoot: string, count = 5): LoopRun[] {
  const dir = join(stateRoot, 'graph-runs', id);
  let files: string[];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.decision.json')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return files.map(file => ({ file, at: statSync(join(dir, file)).mtimeMs }))
    .sort((a, b) => b.at - a.at).slice(0, count).map(({ file, at }) => {
      const path = join(dir, file);
      const state = JSON.parse(readFileSync(path, 'utf8')) as GraphRunState;
      if (state.graphId !== id) throw new Error(`graph run identity mismatch: ${path}`);
      const start = state.startedAt ? Date.parse(state.startedAt) : NaN;
      const end = state.finishedAt ? Date.parse(state.finishedAt) : NaN;
      return { at: state.startedAt ?? new Date(at).toISOString(), status: state.status, path, runId: state.runId,
        failedNodes: state.nodes.filter(n => !n.ok || !!n.error).map(n => n.nodeId),
        durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null };
    });
}

export function nextLoopFire(cron: string, now: Date): string | null {
  if (cron.trim().split(/\s+/).length !== 5) return null;
  let minute = Math.floor(now.getTime() / 60000) * 60000 + 60000;
  const timeZone = resolveTimeZone().timeZone;
  // Covers leap years and annual cron expressions; a nonmatching expression stays unknown.
  for (let i = 0; i < 527040; i++, minute += 60000) {
    if (cronMatches(cron, new Date(minute), { timeZone })) return new Date(minute).toISOString();
  }
  return null;
}

function schedules(opts: LoopRegistryOptions): ScheduleRow[] {
  if (opts.schedules) return opts.schedules;
  const db: Database = openSchedulesDb();
  try {
    inventoryCrontab(db);
    return listSchedules(db);
  } finally { db.close(); }
}

type OwnerSource = NonNullable<LoopEntry['ownerSource']>;
function resolveOwner(id: string, title: string, config: UserConfig, header?: unknown, seat?: string): { owner: string; ownerSource: OwnerSource } {
  if (typeof header === 'string' && /^(OP|TC|MK|UX)$/.test(header)) return { owner: header, ownerSource: 'header' };
  const owners = config.loops?.owners;
  const configured = owners && (Object.hasOwn(owners, id) ? owners[id] : Object.hasOwn(owners, title) ? owners[title] : undefined);
  if (configured) return { owner: configured, ownerSource: 'config' };
  if (seat) return { owner: seat, ownerSource: 'seat' };
  return { owner: config.loops?.defaultOwner ?? 'OP', ownerSource: 'default' };
}

/** An append redirection on the installed command is a run estimate, not a success record. */
function cronLogMtime(command: string): string | undefined {
  const match = command.match(/(?:^|\s)>>\s*(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/);
  if (!match) return undefined;
  const path = (match[1] ?? match[2] ?? match[3]!).replace(/^~(?=\/)/, homedir()).replace(/^\$HOME(?=\/)/, homedir());
  const cd = command.match(/^cd\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))\s*&&/);
  const cwd = (cd?.[1] ?? cd?.[2] ?? cd?.[3] ?? homedir()).replace(/^~(?=\/)/, homedir()).replace(/^\$HOME(?=\/)/, homedir());
  try {
    const stat = statSync(resolve(cwd, path));
    return stat.isFile() ? stat.mtime.toISOString() : undefined;
  } catch (error) {
    debug.log('loops.registry', 'cron-log-unavailable', { path: resolve(cwd, path), error: String(error) });
    return undefined;
  }
}

/** Where loop graphs live and where their cron line `cd`s — the same rule as the other elanous crons:
 *  the installed package when there is one, else this checkout. Never the caller's cwd: a loop started
 *  from a disposable worktree would schedule a cron into a directory that is about to disappear (🅣 09-29). */
export function defaultLoopRoot(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { installedCronRoot, repoRoot } = require('../domains/schedule-registry.js') as typeof import('../domains/schedule-registry.js');
  return installedCronRoot() ?? repoRoot();
}

export function listLoops(opts: LoopRegistryOptions = {}): LoopEntry[] {
  const root = resolve(opts.root ?? defaultLoopRoot());
  const stateRoot = opts.stateRoot ?? effectiveInstanceRoot();
  const rows = schedules(opts);
  const config = opts.config ?? getUserConfig();
  const loops: LoopEntry[] = [];
  for (const file of graphFiles(join(root, 'graphs'))) {
    let doc: Record<string, unknown> | null;
    try { doc = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown> | null; }
    catch (error) {
      debug.log('loops.registry', 'graph-read-failed', { file, error: String(error) });
      continue;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.graph_id !== 'string' || !doc.graph_id) continue;
    const header = doc.loop && typeof doc.loop === 'object' && !Array.isArray(doc.loop) ? doc.loop as Record<string, unknown> : null;
    const trigger = header?.trigger && typeof header.trigger === 'object' && !Array.isArray(header.trigger) ? header.trigger as Record<string, unknown> : null;
    const declaredCron = typeof trigger?.cron === 'string' ? trigger.cron : null;
    const events = Array.isArray(trigger?.events) ? trigger.events.filter((e): e is string => typeof e === 'string') : [];
    const cronEntry = typeof doc.cron_entry === 'string' && doc.cron_entry.length ? doc.cron_entry : null;
    const entryRows = cronEntry ? rows.filter(row => cronEntryMatches(row.command, cronEntry) && row.source === 'crontab' && row.run_via === 'crontab' && row.disabled_reason !== 'vanished') : [];
    const matched = rows.filter(row => (graphJobMatches(row.command, file, root, doc.graph_id as string) || entryRows.includes(row)) && row.source === 'crontab' && row.run_via === 'crontab' && row.disabled_reason !== 'vanished');
    if (entryRows.length) debug.log('loops.registry', 'cron-entry-match', { id: doc.graph_id, jobs: entryRows.map(row => row.id) });
    if (!declaredCron && !events.length && !matched.length) continue;
    if (!/^[a-zA-Z0-9][\w.-]*$/.test(doc.graph_id)) throw new Error(`unsafe loop graph_id: ${doc.graph_id}`);
    if (loops.some(loop => loop.id === doc.graph_id)) throw new Error(`duplicate loop graph_id: ${doc.graph_id}`);
    const jobs = matched.map(row => ({ id: row.id, cron: row.cron, enabled: !!row.enabled,
      ...(entryRows.includes(row) ? { entryScript: true } : {}) }));
    const active = matched.filter(row => !!row.enabled && !!row.cron);
    const next = active.map(row => nextLoopFire(row.cron!, opts.now ?? new Date())).filter((v): v is string => v !== null).sort()[0] ?? null;
    const title = typeof header?.title === 'string' ? header.title : doc.graph_id;
    const entry: LoopEntry = { id: doc.graph_id, title,
      description: typeof header?.description === 'string' ? header.description : null,
      ...resolveOwner(doc.graph_id, title, config, header?.owner),
      mode: typeof header?.mode === 'string' ? header.mode : null, file: relative(root, file),
      trigger: { cron: declaredCron, events }, jobs, enabled: matched.some(row => !!row.enabled),
      lastRun: recentRuns(doc.graph_id, stateRoot, 1)[0] ?? null, nextRun: next };
    loops.push(entry);
  }
  debug.log('loops.registry', 'list', { count: loops.length });
  return loops;
}

export interface AllLoopEntry extends CheckEntry {
  kind: 'graph' | 'seat' | 'cron-shell' | 'orchestrator';
  title: string;
  cron?: string;
  command?: string;
  /** True when the cron's fire gaps vary (e.g. `0 9,17 * * *`); `expectEveryMinutes` is then the longest gap. */
  cronIrregular?: boolean;
  fenceRole?: string;
  host?: string;
  observationCategory?: string;
}

/** Inspect only words of the launched command. Quoted arguments are kept whole, not searched for flags. */
function launchedWords(command: string): Array<{ text: string; quoted: boolean }> {
  const launched = command.replace(/^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*/, '');
  const words: Array<{ text: string; quoted: boolean }> = [];
  let text = '';
  let quoted = false;
  let quote: string | null = null;
  for (let i = 0; i < launched.length; i++) {
    const ch = launched[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < launched.length) text += launched[++i];
      else text += ch;
    } else if (ch === "'" || ch === '"') { quote = ch; quoted = true; }
    else if (ch === '\\' && i + 1 < launched.length) { text += launched[++i]; }
    else if (ch === ';' || ch === '|' || ch === '&') break;
    else if (/\s/.test(ch)) {
      if (text || quoted) { words.push({ text, quoted }); text = ''; quoted = false; }
    } else text += ch;
  }
  if (text || quoted) words.push({ text, quoted });
  return words;
}

type LaunchWord = { text: string; quoted: boolean };

function isElanousExecutable(script: string): boolean {
  return /^(?:eln|elanous|elanous\.mjs)$/.test(script.split('/').pop() ?? '');
}

/** Skip only leading global CLI options, leaving the action words untouched. */
function elanousActionStart(args: LaunchWord[]): number {
  let start = 0;
  while (args[start] && !args[start]!.quoted) {
    const option = args[start]!.text;
    if (option === '--test' || option.startsWith('--test=')) { start++; continue; }
    if (option === '--config-dir' || option === '--state-dir') { start += 2; continue; }
    if (option.startsWith('--config-dir=') || option.startsWith('--state-dir=')) { start++; continue; }
    break;
  }
  return start;
}

/** Include every launched segment of a wrapper's quoted shell payload, in execution order. */
function launchedCommands(command: string, onFence?: (role: string) => void): LaunchWord[][] {
  const launches: LaunchWord[][] = [];
  const last = launchedCommand(command, onFence, words => { if (words.length) launches.push(words); });
  if (last.length) launches.push(last);
  return launches;
}

/** Only executable-prefix wrappers are stripped; a quoted argument mentioning a loop is not a launch. */
function launchedCommand(command: string, onFence?: (role: string) => void, onLaunch?: (words: LaunchWord[]) => void): LaunchWord[] {
  const words = launchedWords(command);
  const wrappers: Record<string, { values: readonly string[]; positionals: number }> = {
    env: { values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], positionals: 0 },
    flock: { values: ['-w', '--wait', '-E', '--conflict-exit-code'], positionals: 1 },
    nice: { values: ['-n', '--adjustment'], positionals: 0 },
    timeout: { values: ['-s', '--signal', '-k', '--kill-after'], positionals: 1 },
    'hq-fence': { values: [], positionals: 0 },
  };
  let offset = 0;
  while (offset < words.length) {
    if (/(?:^|\/)(?:bun|node)$/.test(words[offset]?.text ?? '')
      && /(?:^|\/)cron-run\.ts$/.test(words[offset + 1]?.text ?? '')
      && words[offset + 2]?.text === '--schedule-id' && words[offset + 4]?.text === '--shell') {
      offset += 5;
      continue;
    }
    const name = words[offset]!.text.split('/').pop()!;
    const spec = wrappers[name];
    if (!spec || words[offset]!.quoted) {
      const { script, args } = launchedScript(words.slice(offset));
      if (!isElanousExecutable(script) || args[0]?.text !== 'hq' || args[1]?.text !== 'fence') break;
      const separator = args.findIndex(word => word.text === '--' && !word.quoted);
      if (separator < 0) break;
      for (let i = 2; i < separator; i++) {
        const role = args[i]?.text === '--role' && i + 1 < separator ? args[i + 1]?.text
          : args[i]?.text.startsWith('--role=') ? args[i]!.text.slice('--role='.length) : undefined;
        if (role) { onFence?.(role); break; }
      }
      offset = words.length - args.length + separator + 1;
      continue;
    }
    if (name === 'hq-fence') {
      let commandAt = offset + 1;
      if (words[commandAt]?.text === '--role' && !words[commandAt]?.quoted) {
        const role = words[commandAt + 1]?.text;
        if (role && FENCE_ROLES.includes(role as typeof FENCE_ROLES[number])) {
          onFence?.(role);
          commandAt += words[commandAt + 2]?.text === '--' ? 3 : 2;
        }
      } else if (FENCE_ROLES.includes(words[commandAt]?.text as typeof FENCE_ROLES[number]) && !words[commandAt]?.quoted) {
        onFence?.(words[commandAt]!.text);
        commandAt++;
      }
      if (words[commandAt]?.quoted && words[commandAt]!.text.includes(' ')) {
        const parts = shellSegments(words[commandAt]!.text);
        for (const part of parts.slice(0, -1)) {
          const launch = launchedCommand(part, onFence, onLaunch);
          if (launch.length) onLaunch?.(launch);
        }
        return launchedCommand(parts.at(-1) ?? '', onFence, onLaunch);
      }
      offset = commandAt;
      continue;
    }
    let index = offset + 1;
    while (index < words.length) {
      const word = words[index]!;
      if (word.text === '--' && !word.quoted) { index++; break; }
      if (name === 'env' && /^[A-Za-z_][A-Za-z_0-9]*=/.test(word.text)) { index++; continue; }
      if (name === 'nice' && /^-\d+$/.test(word.text) && !word.quoted) { index++; continue; }
      if (!word.text.startsWith('-') || word.quoted) break;
      const flag = word.text.split('=')[0]!;
      index += spec.values.includes(flag) && !word.text.includes('=') ? 2 : 1;
    }
    index += spec.positionals;
    if (name === 'flock' && words[index]?.text === '-c' && !words[index]?.quoted) {
      const payload = words[index + 1]?.text;
      if (!payload) return [];
      // The payload is its own shell line: each segment may launch a loop.
      const parts = shellSegments(payload);
      for (const part of parts.slice(0, -1)) {
        const launch = launchedCommand(part, onFence, onLaunch);
        if (launch.length) onLaunch?.(launch);
      }
      return launchedCommand(parts.at(-1) ?? '', onFence, onLaunch);
    }
    if (index >= words.length) break;
    offset = index;
  }
  return words.slice(offset);
}

/** Split a shell line at top-level `&&`, `||`, `;` and `|` only — separators inside quotes stay in their word. */
export function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) { current += command[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) { current += ch + command[++i]; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { segments.push(current); current = ''; i++; continue; }
    if (ch === ';' || ch === '|' || ch === '\n') { segments.push(current); current = ''; continue; }
    current += ch;
  }
  segments.push(current);
  return segments.map(segment => segment.trim()).filter(Boolean);
}

function cronFenceRole(command: string): string | undefined {
  for (const segment of shellSegments(command)) {
    let role: string | undefined;
    launchedCommand(segment, value => { role = value; });
    if (role) return role;
  }
  return undefined;
}

function fenceCommandTitle(command: string, role: string): string | undefined {
  const launches = shellSegments(command).flatMap(segment => launchedCommands(segment));
  const inner = launches.at(-1);
  if (!inner?.length) return undefined;
  const { script, args } = launchedScript(inner);
  const executable = script.split('/').pop();
  const action = elanousCronName(command) ?? (executable === 'git' ? [executable, args[0]?.text].filter(Boolean).join(' ')
    : /^(?:sh|bash|zsh)$/.test(executable ?? '') ? args[0]?.text.split('/').pop() : executable);
  return action ? `${action} (hq-fence ${role})` : undefined;
}

function launchedScript(words: LaunchWord[]): { script: string; args: LaunchWord[] } {
  const offset = /^(?:.*\/)?(?:bun|node)$/.test(words[0]?.text ?? '') ? 1 : 0;
  return { script: words[offset]?.text ?? '', args: words.slice(offset + 1) };
}

/** Recognize direct .sh execution or sh/bash/zsh with option flags and a script or -c payload. */
function isCronShellCommand(command: string): boolean {
  return shellSegments(command).some(segment => launchedCommands(segment).some(words => {
    const executable = words[0]?.text ?? '';
    if (/\.sh$/.test(executable)) return true;
    if (!/(?:^|\/)(?:sh|bash|zsh)$/.test(executable)) return false;
    let index = 1;
    let inline = false;
    while (words[index] && /^-[a-zA-Z]+$/.test(words[index]!.text) && !words[index]!.quoted) {
      inline ||= words[index]!.text.includes('c');
      index++;
    }
    if (words[index]?.text === '--') index++;
    return !!words[index] && (inline || /\.sh$/.test(words[index]!.text));
  }));
}

function launchedSeat(command: string): string | undefined {
  for (const segment of shellSegments(command)) {
    for (const words of launchedCommands(segment)) {
      const { script, args } = launchedScript(words);
      const named = script.match(/(?:^|\/)(op|tc|mk|ux)-seat(?:\.[\w-]+)?$/i)?.[1];
      if (named) return named.toUpperCase();
      if (!/(?:^|\/)seat-loop(?:\.[\w-]+)?$/i.test(script)) continue;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg.quoted) continue;
        const seat = arg.text === '--seat' ? (!args[i + 1]?.quoted ? args[i + 1]?.text : undefined)
          : arg.text.startsWith('--seat=') ? arg.text.slice('--seat='.length) : undefined;
        if (seat && /^(OP|TC|MK|UX)$/i.test(seat)) return seat.toUpperCase();
      }
    }
  }
  return undefined;
}

function launchedOrchestrator(command: string): boolean {
  return shellSegments(command).some(segment => launchedCommands(segment).some(words =>
    /(?:^|\/)(?:\w+-)?orchestrator(?:\.[\w-]+)?$/i.test(launchedScript(words).script)));
}

/** A launched two-word elanous action, not a mention in an argument or a read-only CLI query. */
function elanousCronName(command: string): string | undefined {
  for (const segment of shellSegments(command)) {
    for (const words of launchedCommands(segment)) {
      const { script, args } = launchedScript(words);
      if (!isElanousExecutable(script)) continue;
      const start = elanousActionStart(args);
      const first = args[start];
      const second = args[start + 1];
      if (!first || !second || first.quoted || second.quoted || first.text.startsWith('-') || second.text.startsWith('-')) continue;
      const actions: Record<string, readonly string[]> = {
        hq: ['heartbeat', 'arbiter-check'],
        harness: ['queue'],
        card: ['intake-scan'],
        loop: ['status', 'list'],
      };
      if (actions[first.text]?.includes(second.text)
        && (first.text !== 'harness' || args[start + 2]?.text === 'tick')) return `${first.text} ${second.text}`;
    }
  }
  return undefined;
}

/** Number only unclaimed named jobs, in installed schedule order, for inventory and warning lookup alike. */
function namedCronIds(rows: ScheduleRow[], graphClaimed: Set<string>): Map<string, string> {
  const counts = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const row of rows) {
    if (graphClaimed.has(row.id) || row.source !== 'crontab' || row.run_via !== 'crontab' || row.disabled_reason === 'vanished') continue;
    const command = row.command ?? '';
    if (launchedSeat(command) || launchedOrchestrator(command) || isCronShellCommand(command)) continue;
    const name = elanousCronName(command);
    if (!name) continue;
    const base = `elanous:${name.replace(/\s+/g, '-')}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    ids.set(row.id, `${base}${count > 1 ? `-${count}` : ''}`);
  }
  return ids;
}

/** Gaps between consecutive actual fires, rather than a guess based on cron text. A cron whose gaps vary
 *  (e.g. `0 9,17 * * *` = 8h then 16h) is irregular: report the longest gap so «late» never fires early. */
const CRON_PERIOD_SAMPLES = 8;
function cronPeriod(cron: string | null, now: Date): { minutes: number; irregular: boolean } | undefined {
  if (!cron) return undefined;
  const fires: number[] = [];
  let at = now;
  for (let i = 0; i <= CRON_PERIOD_SAMPLES; i++) {
    const next = nextLoopFire(cron, at);
    if (!next) break;
    fires.push(Date.parse(next));
    at = new Date(next);
  }
  if (fires.length < 2) return undefined;
  const gaps = fires.slice(1).map((fire, i) => (fire - fires[i]!) / 60_000);
  const longest = Math.max(...gaps);
  return { minutes: longest, irregular: gaps.some(gap => gap !== gaps[0]) };
}

function periodFields(period: { minutes: number; irregular: boolean } | undefined): Pick<AllLoopEntry, 'expectEveryMinutes' | 'cronIrregular'> {
  if (!period) return {};
  return { expectEveryMinutes: period.minutes, ...(period.irregular ? { cronIrregular: true } : {}) };
}

/** Inventory all installed loop agents without changing the graph-only `listLoops` contract. */
export function listAllLoops(opts: LoopRegistryOptions = {}): AllLoopEntry[] {
  const now = opts.now ?? new Date();
  const config = opts.config ?? getUserConfig();
  const rows = schedules(opts).filter(row => row.source === 'crontab' && row.run_via === 'crontab' && row.disabled_reason !== 'vanished');
  const graphOpts = { ...opts, now, schedules: rows };
  const graphLoops = listLoops(graphOpts);
  const claimed = new Set<string>();
  const all: AllLoopEntry[] = graphLoops.map(loop => {
    for (const job of loop.jobs) claimed.add(job.id);
    // The installed job's cron is what actually runs — a disabled install still beats the declared trigger.
    const cron = loop.jobs.find(job => job.enabled && job.cron)?.cron ?? loop.jobs.find(job => job.cron)?.cron ?? loop.trigger.cron;
    const runs = recentRuns(loop.id, opts.stateRoot ?? effectiveInstanceRoot());
    const lastRun = runs[0] ?? null;
    const period = cronPeriod(cron, now);
    const dueAt = cron ? dueBefore(cron, now) : null;
    const installed = rows.filter(row => loop.jobs.some(item => item.id === row.id));
    const fenceRole = installed.map(row => cronFenceRole(row.command ?? '')).find((role): role is string => !!role);
    const graphDoc = parseYaml(readFileSync(join(resolve(opts.root ?? defaultLoopRoot()), loop.file), 'utf8')) as Record<string, unknown> | null;
    const header = graphDoc?.loop && typeof graphDoc.loop === 'object' && !Array.isArray(graphDoc.loop)
      ? graphDoc.loop as Record<string, unknown> : {};
    const declaredHost = typeof header.host === 'string' && header.host ? header.host : undefined;
    const declaredCategory = typeof header.observationCategory === 'string' && header.observationCategory ? header.observationCategory : undefined;
    return { kind: 'graph', id: loop.id, title: loop.title, owner: loop.owner ?? undefined, ownerSource: loop.ownerSource,
      ...(declaredHost || installed.length ? { host: declaredHost ?? hostname() } : {}),
      observationCategory: declaredCategory ?? 'graph.runner',
      ...(fenceRole ? { fenceRole } : {}),
      mode: loop.mode ?? undefined, enabled: loop.enabled, registered: loop.jobs.length > 0,
      ...(cron ? { cron } : {}), ...periodFields(period),
      ...(dueAt ? { dueAt } : {}),
      ...(lastRun ? { lastRunAt: lastRun.at, lastStatus: lastRun.status } : {}),
      recentStatuses: runs.map(run => run.status) };
  });
  const namedIds = namedCronIds(rows, claimed);
  for (const row of rows) {
    if (claimed.has(row.id)) continue;
    const command = row.command ?? '';
    const seat = launchedSeat(command);
    const orchestrator = launchedOrchestrator(command);
    const shell = isCronShellCommand(command);
    const namedId = namedIds.get(row.id);
    const fenceRole = cronFenceRole(command);
    const fencedGitPush = fenceRole === 'git-push' && fenceCommandTitle(command, fenceRole) === 'git push (hq-fence git-push)';
    const kind: AllLoopEntry['kind'] = seat ? 'seat' : orchestrator ? 'orchestrator' : 'cron-shell';
    if (kind === 'cron-shell' && !shell && !namedId && !fencedGitPush) continue;
    const cron = row.cron;
    const period = cronPeriod(cron, now);
    const dueAt = cron ? dueBefore(cron, now) : null;
    const id = seat ? `${seat.toLowerCase()}-seat:${row.id}` : namedId ?? row.id;
    const title = seat ? `${seat} seat` : row.note || (fenceRole ? fenceCommandTitle(command, fenceRole) : undefined) || (namedId ? elanousCronName(command) : undefined) || row.name;
    const logMtime = kind === 'cron-shell' && command ? cronLogMtime(command) : undefined;
    all.push({ kind, id, title,
      ...resolveOwner(id, title, config, undefined, seat), ...(fenceRole ? { fenceRole } : {}),
      host: hostname(), observationCategory: row.category,
      enabled: !!row.enabled, registered: true,
      ...(cron ? { cron } : {}), ...(command ? { command } : {}),
      ...periodFields(period),
      ...(dueAt ? { dueAt } : {}),
      ...(logMtime ? { lastRunAt: logMtime, evidence: 'log-mtime' as const }
        : row.last_run && Number.isFinite(Date.parse(row.last_run)) ? { lastRunAt: row.last_run } : {}),
      ...(row.last_status ? { lastStatus: row.last_status } : {}),
      recentStatuses: row.last_status ? [row.last_status] : [] });
  }
  const bySource: Record<OwnerSource, number> = { header: 0, config: 0, seat: 0, default: 0 };
  for (const loop of all) bySource[loop.ownerSource!]++;
  debug.log('loop.check', 'ownership', { total: all.length, bySource });
  debug.log('loops.registry', 'list-all', { count: all.length });
  return all;
}

/** An unclaimed cron line with any elanous marker must surface as an unregistered warning. */
function looksElanousRelated(command: string): boolean {
  return /(?:^|[^\w.-])(?:elanous(?:\.mjs)?|eln|hq-fence)(?=$|[^\w.-])|(?:^|\/)\.elanous(?:\/|$)/i.test(command);
}

/** Crontab elanous loop launches not represented by any graph, seat, shell or orchestrator row. */
export function unregisteredCronLoops(entries: AllLoopEntry[], opts: LoopRegistryOptions = {}): ScheduleRow[] {
  const graphJobs = new Map(listLoops(opts).map(loop => [loop.id, loop.jobs.map(job => job.id)]));
  const rows = schedules(opts);
  const graphClaimed = new Set([...graphJobs.values()].flat());
  const namedRows = new Map([...namedCronIds(rows, graphClaimed)].map(([rowId, name]) => [name, rowId]));
  const claimed = new Set(entries.flatMap(entry => entry.kind === 'graph'
    ? graphJobs.get(entry.id) ?? []
    : [entry.kind === 'seat' ? entry.id.slice(entry.id.indexOf(':') + 1)
      : namedRows.get(entry.id) ?? entry.id]));
  return rows.filter(row => row.source === 'crontab' && row.run_via === 'crontab'
    && row.disabled_reason !== 'vanished' && !claimed.has(row.id)
    && looksElanousRelated(row.command ?? ''));
}

export function loopStatus(id: string, opts: LoopRegistryOptions = {}): LoopEntry & { recentRuns: LoopRun[] } {
  const loop = listLoops(opts).find(entry => entry.id === id);
  if (!loop) throw new Error(`loop not found: ${id}`);
  const recent = recentRuns(id, opts.stateRoot ?? effectiveInstanceRoot());
  debug.log('loops.registry', 'status', { id, runs: recent.length });
  return { ...loop, recentRuns: recent };
}

/** The crontab line a loop runs — same shape as the other elanous crons: cron starts in $HOME with a thin PATH,
 *  so a bare `elanous graph run <relative file>` fails silently every tick (09-29 steward). */
export function loopCronCommand(id: string, file: string, root: string, bun = process.execPath): string {
  // Quote only when needed: the other crons (and `graphJobMatches`) use bare absolute paths.
  const q = (value: string) => /^[\w./@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
  const log = `/tmp/elanous-loop-${id.replace(/[^\w.-]/g, '_')}.log`;
  return `cd ${q(root)} && ${q(bun)} bin/elanous.mjs graph run ${q(file)} >> ${log} 2>&1`;
}

export async function setLoopEnabled(id: string, enabled: boolean, yes = false, opts: LoopRegistryOptions = {}): Promise<unknown> {
  const loop = loopStatus(id, opts);
  const action = enabled ? 'start' : 'stop';
  if (!loop.jobs.length && (!enabled || !loop.trigger.cron)) throw new Error(`loop ${id} has no cron job to ${action}`);
  const pending = loop.jobs.filter(job => job.enabled !== enabled);
  const entryScript = loop.jobs.some(job => job.entryScript);
  const entryLabel = entryScript ? { entryScript: true } : {};
  if (!pending.length && loop.jobs.length) return { action, id, changed: false, enabled: loop.enabled, ...entryLabel };
  const changes = loop.jobs.length ? pending.map(job => ({ action: enabled ? 'enable' : 'disable', id: job.id })) :
    [{ action: 'create', cron: loop.trigger.cron, command: loopCronCommand(id, loop.file, resolve(opts.root ?? defaultLoopRoot())) }];
  if (!yes) return { action, id, dryRun: true, changes, ...entryLabel, note: 'Apply with --yes (crontab backup).' };
  const dispatch = opts.scheduleAction ?? (async (kind: 'create' | 'enable' | 'disable', args: Record<string, unknown>) => {
    const { dispatchScheduleManage } = await import('../domains/schedule-manage-tool.js');
    return dispatchScheduleManage({ action: kind, ...args });
  });
  const results = [];
  for (const change of changes) {
    const { action: kind, ...args } = change;
    const result = await dispatch(kind as 'create' | 'enable' | 'disable', args);
    if (result && typeof result === 'object' && 'error' in result) throw new Error(String(result.error));
    results.push(result);
  }
  debug.log('loops.registry', action, { id, changes });
  emitDecision({ kind: 'ROUTE', what: `루프 ${enabled ? '켬' : '끔'}: ${id}`, reason: enabled ? '사용자 요청으로 예약 발화 활성화' : '사용자 요청으로 예약 발화 일시 중지', purpose: '루프 라이프사이클 제어', target: id });
  return { action, id, changed: true, results, ...entryLabel };
}

export async function runLoop(id: string, dryRun = false, opts: LoopRegistryOptions = {}): Promise<GraphRunState> {
  const loop = loopStatus(id, opts);
  debug.log('loops.registry', 'run', { id, dryRun });
  return runGraph(join(resolve(opts.root ?? defaultLoopRoot()), loop.file), { dryRun, deps: { root: opts.stateRoot ?? effectiveInstanceRoot() } });
}
