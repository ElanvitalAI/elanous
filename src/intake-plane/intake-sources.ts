import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import cron from 'node-cron';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { findTrack } from '../autopilot/mission-phase-track.js';
import { appendGithubStarSnapshots, collectGithubStars, ghApiSearchRepos, type SearchGithubRepos } from './collect-github.js';
import { ingestIntakeItems, parseRawIntakeJsonl, type IntakeSource, type RegisteredIntakeSourceKind, type RawIntakeItem } from './items.js';

export type SourceKind = 'github-query' | 'rss' | 'command' | 'topic-search';
export interface RegisteredIntakeSource {
  id: string;
  seat: string;
  kind: SourceKind;
  spec: string;
  every: string;
  /** Per-topic recurring fire time, interpreted by the existing schedule registry/daemon path. */
  scheduleCron?: string;
  until?: string;
  why?: string;
  /** Existing Linear secretary issue identifier; absent for ordinary sources. */
  issueRef?: string;
  /** Parent Linear issue UUID; never replace with the display identifier. */
  linearIssueId?: string;
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
  if (!['github-query', 'rss', 'command', 'topic-search'].includes(input.kind)) throw new Error(`알 수 없는 원천 종류: ${input.kind}`);
  cadenceMs(input.every);
  if (input.until !== undefined) untilMs(input.until);
  if (!input.id?.trim() || !/^[\w.-]+$/.test(input.id)) throw new Error('원천 id 는 영문·숫자·_·-·. 만 허용한다');
  if (!input.spec?.trim()) throw new Error('원천 spec 이 비었다');
  if (input.linearIssueId !== undefined && (input.kind !== 'topic-search'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.linearIssueId))) {
    throw new Error('topic-search linearIssueId 는 부모 Linear issue UUID여야 한다');
  }
  if (input.kind === 'topic-search' && (!input.linearIssueId || !input.scheduleCron || !cron.validate(input.scheduleCron))) {
    throw new Error('topic-search 는 부모 Linear UUID와 유효한 개별 schedule cron 이 필요하다');
  }
  if (input.kind !== 'topic-search' && input.scheduleCron !== undefined) throw new Error('scheduleCron 은 topic-search 원천만 가질 수 있다');
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

export function dueSources(now: Date = new Date(), stateDir = effectiveInstanceRoot(), sourceId?: string): RegisteredIntakeSource[] {
  return listSources({}, stateDir).filter((source) => (sourceId === undefined || source.id === sourceId)
    && (sourceId !== undefined && source.kind === 'topic-search'
      ? !expiredSource(source, now)
      : sourceIsDue(source, now)));
}

export interface RunDueDeps {
  stateDir?: string;
  searchGithub?: SearchGithubRepos;
  fetchFeed?: (url: string) => Promise<string>;
  runCommand?: (command: string) => Promise<string>;
  searchTopic?: (topic: string) => Promise<RawIntakeItem[]>;
  addBriefItem?: (input: import('../briefing/brief-items.js').AddBriefItem) => unknown;
  projectTopicBriefing?: (source: RegisteredIntakeSource, items: import('../briefing/brief-items.js').BriefItem[], stateDir?: string) => Promise<void>;
  ingest?: typeof ingestIntakeItems;
  onCollected?: (source: RegisteredIntakeSource, raws: RawIntakeItem[], now: Date) => Promise<void> | void;
}

async function searchTopicWithResearchBridge(topic: string): Promise<RawIntakeItem[]> {
  const { invokeResearchAxes } = await import('../research-bridge/index.js');
  const fanout = await invokeResearchAxes([{ id: 'intake-topic', prompt: topic, level: 3, searchTerms: [topic] }]);
  const evidence = fanout.axes.find((axis) => axis.questionId === 'intake-topic')?.evidence ?? [];
  return evidence.filter((entry) => entry.outcome !== 'failed' && /^https?:\/\//i.test(entry.source))
    .map((entry) => {
      const [title, ...summary] = entry.content.split(' — ');
      return { url: entry.source, title, text: summary.join(' — ') || entry.content, kind: 'article' };
    });
}

async function addTopicBriefItems(stateDir: string, source: RegisteredIntakeSource, items: readonly RawIntakeItem[], createdAt: string,
  addBriefItem?: RunDueDeps['addBriefItem']): Promise<void> {
  const ledger = addBriefItem ? null : new (await import('../briefing/brief-items.js')).BriefItemsLedger({ stateDir });
  for (const item of items) {
    if (!item.url) continue;
    const text = `새 토픽 자료: ${(item.title ?? item.text ?? item.url).replace(/[\r\n]+/g, ' ').trim()}`;
    const input = {
      text, domain: '흡수' as const, priority: 'P1' as const, source: `intake.topic-search:${source.id}`,
      evidence: item.url, createdAt,
      ...(source.linearIssueId ? { linearIssueId: source.linearIssueId } : {}),
      dedupeKey: `${source.linearIssueId ?? source.id}:${item.url}`, dedupeWithinMs: Math.max(86_400_000, cadenceMs(source.every)),
    };
    if (addBriefItem) addBriefItem(input);
    else ledger!.add(input);
  }
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

export async function runDue({ now = new Date(), seat, sourceId, deps = {} }: { now?: Date; seat?: string; sourceId?: string; deps?: RunDueDeps } = {}): Promise<{ ran: Array<{ id: string; items: number; error?: string }> }> {
  const stateDir = deps.stateDir ?? effectiveInstanceRoot();
  const selectedSeat = seat === undefined ? undefined : canonicalSeat(seat);
  const ran: Array<{ id: string; items: number; error?: string }> = [];
  for (const source of dueSources(now, stateDir, sourceId).filter((source) =>
    (selectedSeat === undefined || source.seat === selectedSeat)
      && (source.kind !== 'topic-search' || !!deps.projectTopicBriefing))) {
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
      } else if (source.kind === 'topic-search') {
        raws = await (deps.searchTopic ?? searchTopicWithResearchBridge)(source.spec);
        intakeSource = 'topic-search';
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
      raws = raws.map((raw) => ({ ...raw, seat: source.seat,
        ...(source.kind === 'topic-search' && source.linearIssueId ? { linearIssueId: source.linearIssueId } : {}) }));
      const items = (deps.ingest ?? ingestIntakeItems)(stateDir, intakeSource, raws, now.toISOString()).shaped;
      if (source.kind === 'topic-search') await addTopicBriefItems(stateDir, source, raws, now.toISOString(), deps.addBriefItem);
      await deps.onCollected?.(source, raws, now);
      if (githubSnapshots) appendGithubStarSnapshots(stateDir, githubSnapshots);
      if (source.kind === 'topic-search' && source.linearIssueId && deps.projectTopicBriefing) {
        const { BriefItemsLedger } = await import('../briefing/brief-items.js');
        const ledger = new BriefItemsLedger({ stateDir });
        const pending = ledger.list().filter(item => item.source === `intake.topic-search:${source.id}`
          && item.linearIssueId?.toLowerCase() === source.linearIssueId!.toLowerCase() && item.sent_at === null);
        if (pending.length) {
          await deps.projectTopicBriefing(source, pending, stateDir);
          // This dedicated issue card/comment is the delivery for these brief items.
          ledger.markSent(pending.map(item => item.id), 'realtime');
        }
      }
      // A projection failure must remain retryable; advance cadence only after delivery succeeds.
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
