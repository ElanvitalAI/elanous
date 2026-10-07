import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { findTrack } from '../autopilot/mission-phase-track.js';
import { appendGithubStarSnapshots, collectGithubStars, ghApiSearchRepos, type SearchGithubRepos } from './collect-github.js';
import { ingestIntakeItems, parseRawIntakeJsonl, type IntakeSource, type RegisteredIntakeSourceKind, type RawIntakeItem } from './items.js';

export type SourceKind = 'github-query' | 'rss' | 'command';
export interface RegisteredIntakeSource {
  id: string;
  seat: string;
  kind: SourceKind;
  spec: string;
  every: string;
  until?: string;
  why?: string;
  lastRunAt?: string;
}

export function canonicalSeat(value: string): string {
  if (value.trim() === 'user') return 'user';
  const seat = findTrack(value.trim());
  if (!seat) throw new Error(`알 수 없는 자리: ${value}`);
  return seat.id;
}

export function cadenceMs(every: string): number {
  const match = /^([1-9]\d*)([hdw])$/.exec(every);
  if (!match) throw new Error(`--every 는 Nh · Nd · Nw 형식이어야 한다: ${every}`);
  const ms = Number(match[1]) * ({ h: 3600_000, d: 86_400_000, w: 604_800_000 }[match[2]!] ?? 0);
  if (!Number.isSafeInteger(ms)) throw new Error(`--every 가 너무 크다: ${every}`);
  return ms;
}

function untilMs(until: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || !Number.isFinite(Date.parse(`${until}T00:00:00Z`))
    || new Date(`${until}T00:00:00Z`).toISOString().slice(0, 10) !== until) throw new Error(`--until 날짜 형식 오류: ${until}`);
  return Date.parse(`${until}T00:00:00Z`);
}

export function expiredSource(source: RegisteredIntakeSource, now: Date): boolean {
  return source.until !== undefined && now.getTime() >= untilMs(source.until);
}

export function sourceIsDue(source: RegisteredIntakeSource, now: Date): boolean {
  return !expiredSource(source, now) && (source.lastRunAt === undefined
    || Date.parse(source.lastRunAt) + cadenceMs(source.every) <= now.getTime());
}

export function sourcesFile(stateDir: string): string { return join(stateDir, 'intake', 'sources.json'); }

function readSources(stateDir: string): RegisteredIntakeSource[] {
  const file = sourcesFile(stateDir);
  if (!existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`원천 등록부 모양 오류: ${file}`);
  return parsed as RegisteredIntakeSource[];
}

function saveSources(stateDir: string, sources: RegisteredIntakeSource[]): void {
  const file = sourcesFile(stateDir);
  mkdirSync(join(stateDir, 'intake'), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(sources, null, 2) + '\n'); } finally { closeSync(fd); }
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

function commandArgv(spec: string): string[] {
  // Shell syntax and interpreter wrappers are rejected; the allowed invocation uses execFileSync without a shell.
  if (!spec.trim() || /["'\\`$;|&<>(){}\[\]*?\r\n]/.test(spec)) throw new Error('command spec 은 셸 구문 없이 실행 파일과 인자만 허용한다');
  const argv = spec.trim().split(/\s+/);
  // Allow-list, not deny-list (review R3): any other program (`nodejs scripts/x.ts`, a renamed wrapper) could emit
  // private memos without a privacy mark. 1st edition: only the elanous CLI itself, whose intake commands mark privacy.
  const executable = argv[0]!.split('/').pop()!.toLowerCase();
  if (executable !== 'elanous' && executable !== 'eln') throw new Error('command 원천은 1판에서 elanous CLI(elanous·eln)만 받는다');
  if (argv.some((arg) => /collect-telegram-saved/i.test(arg))) throw new Error('개인 메모(collect-telegram-saved)는 command 원천으로 등록할 수 없다');
  return argv;
}

export function addSource(input: RegisteredIntakeSource, stateDir = effectiveInstanceRoot()): RegisteredIntakeSource {
  const seat = canonicalSeat(input.seat);
  if (!['github-query', 'rss', 'command'].includes(input.kind)) throw new Error(`알 수 없는 원천 종류: ${input.kind}`);
  cadenceMs(input.every);
  if (input.until !== undefined) untilMs(input.until);
  if (!input.id?.trim() || !/^[\w.-]+$/.test(input.id)) throw new Error('원천 id 는 영문·숫자·_·-·. 만 허용한다');
  if (!input.spec?.trim()) throw new Error('원천 spec 이 비었다');
  if (input.kind === 'rss') {
    let protocol = '';
    try { protocol = new URL(input.spec).protocol; } catch { /* validation below */ }
    if (protocol !== 'http:' && protocol !== 'https:') throw new Error('RSS spec 은 HTTP(S) URL 이어야 한다');
  }
  if (input.kind === 'command') commandArgv(input.spec);
  const sources = readSources(stateDir);
  if (sources.some((source) => source.id === input.id)) throw new Error(`이미 등록된 원천 id: ${input.id}`);
  const source = { ...input, seat };
  saveSources(stateDir, [...sources, source]);
  return source;
}

export function listSources(filter: { seat?: string } = {}, stateDir = effectiveInstanceRoot()): RegisteredIntakeSource[] {
  const seat = filter.seat === undefined ? undefined : canonicalSeat(filter.seat);
  return readSources(stateDir).filter((source) => seat === undefined || source.seat === seat);
}

export function removeSource(id: string, stateDir = effectiveInstanceRoot()): boolean {
  const sources = readSources(stateDir);
  if (!sources.some((source) => source.id === id)) return false;
  saveSources(stateDir, sources.filter((source) => source.id !== id));
  return true;
}

export function dueSources(now: Date = new Date(), stateDir = effectiveInstanceRoot()): RegisteredIntakeSource[] {
  return listSources({}, stateDir).filter((source) => sourceIsDue(source, now));
}

export interface RunDueDeps {
  stateDir?: string;
  searchGithub?: SearchGithubRepos;
  fetchFeed?: (url: string) => Promise<string>;
  runCommand?: (command: string) => Promise<string>;
  ingest?: typeof ingestIntakeItems;
}

function xmlText(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|#(\d+)|#x([a-f\d]+));/gi, (entity, dec: string | undefined, hex: string | undefined) => {
      if (dec || hex) return String.fromCodePoint(Number.parseInt(dec ?? hex!, dec ? 10 : 16));
      return ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" } as Record<string, string>)[entity.toLowerCase()] ?? entity;
    }).trim();
}

export function parseFeed(xml: string): RawIntakeItem[] {
  // A login page or broken XML is a failure, not «0 items» — otherwise lastRunAt moves and the retry waits a whole cycle (review R3).
  const head = xml.replace(/^\uFEFF/, '').replace(/<\?xml[^>]*\?>/i, '').replace(/<!--[\s\S]*?-->/g, '').trimStart();
  if (!/^<(?:rss|feed|rdf:RDF)\b/i.test(head)) throw new Error('RSS/Atom 피드가 아니다(루트가 rss·feed·rdf:RDF 아님)');
  const entries = xml.match(/<(?:item|entry)\b[^>]*>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  return entries.map((entry) => {
    const field = (name: string): string => xmlText(entry.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] ?? '');
    const link = entry.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1] ?? field('link');
    return { url: xmlText(link), title: field('title'), text: field('description') || field('summary') || field('content'), kind: 'rss' as const };
  }).filter((entry) => !!entry.url);
}

export async function runDue({ now = new Date(), seat, deps = {} }: { now?: Date; seat?: string; deps?: RunDueDeps } = {}): Promise<{ ran: Array<{ id: string; items: number; error?: string }> }> {
  const stateDir = deps.stateDir ?? effectiveInstanceRoot();
  const selectedSeat = seat === undefined ? undefined : canonicalSeat(seat);
  const ran: Array<{ id: string; items: number; error?: string }> = [];
  for (const source of dueSources(now, stateDir).filter((source) => selectedSeat === undefined || source.seat === selectedSeat)) {
    try {
      let raws: RawIntakeItem[];
      let githubSnapshots: { day: string; repo: string; stars: number }[] | undefined;
      let intakeSource: IntakeSource | RegisteredIntakeSourceKind;
      if (source.kind === 'github-query') {
        const collected = await collectGithubStars(stateDir, deps.searchGithub ?? ghApiSearchRepos, {
          queries: [source.spec], day: now.toISOString().slice(0, 10), dryRun: true,
        });
        githubSnapshots = collected.repos.map((repo) => ({ day: collected.day, repo: repo.repo, stars: repo.stars }));
        raws = collected.repos.map((repo) => ({ url: repo.url, title: repo.title, text: repo.text, kind: 'repo',
          signals: { stars: repo.stars, ...(repo.starsDelta === undefined ? {} : { starsDelta: repo.starsDelta }),
            ...(repo.starsPerDay === undefined ? {} : { starsPerDay: repo.starsPerDay }) } }));
        intakeSource = 'github';
      } else if (source.kind === 'rss') {
        const feed = await (deps.fetchFeed ?? (async (url: string) => {
          const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error(`RSS HTTP ${response.status}`);
          return response.text();
        }))(source.spec);
        raws = parseFeed(feed);
        intakeSource = 'rss';
      } else {
        const argv = commandArgv(source.spec);
        const stdout = await (deps.runCommand ?? (async () => execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })))(source.spec);
        const parsed = parseRawIntakeJsonl(stdout);
        if (parsed.bad) throw new Error(`잘못된 JSONL ${parsed.bad}줄`);
        if (parsed.raws.some((raw) => (raw as RawIntakeItem & { privacy?: string; source?: string }).privacy === 'user-private'
          || ['memo', 'telegram-saved'].includes((raw as RawIntakeItem & { source?: string }).source ?? ''))) {
          throw new Error('개인 메모(user-private)는 command 원천에서 받을 수 없다');
        }
        raws = parsed.raws;
        intakeSource = 'command';
      }
      const items = (deps.ingest ?? ingestIntakeItems)(stateDir, intakeSource, raws.map((raw) => ({ ...raw, seat: source.seat })), now.toISOString()).shaped;
      if (githubSnapshots) appendGithubStarSnapshots(stateDir, githubSnapshots);
      // Re-read after each run so one failure cannot overwrite another source's successful timestamp.
      const current = readSources(stateDir);
      const found = current.find((entry) => entry.id === source.id);
      if (found) saveSources(stateDir, current.map((entry) => entry.id === source.id ? { ...entry, lastRunAt: now.toISOString() } : entry));
      ran.push({ id: source.id, items });
    } catch (error) {
      ran.push({ id: source.id, items: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ran };
}
